import { Queue, Worker } from "bullmq";
import "./otel";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import { loadConfig } from "./config";
import { createPool } from "./db/pool";
import { attachJobTraceCarrier, extractJobTraceContext } from "./lib/tracing";
import { processKnowledgeIndexJob } from "./knowledge/processor";
import { processKnowledgeEmbeddingJob } from "./knowledge/embedding";
import { processKnowledgeIngestJob } from "./knowledge/ingest";
import { processAuditExport } from "./audit/exportProcessor";
import { processMediaJob } from "./media/processor";
import { reencryptSecrets } from "./keyring/reencrypt";
import { processStep } from "./workflow/processor";
import { markWorkflowStepDeadletter } from "./workflow/deadletter";
import { tickSubscriptions } from "./subscriptions/ticker";
import { tickWebhookDeliveries } from "./channels/webhookDelivery";
import { tickChannelOutboxDeliveries } from "./channels/outboxDelivery";
import { tickEmailDeliveries } from "./notifications/smtpDelivery";
import { tickWorkflowStepPayloadPurge } from "./workflow/payloadPurge";
import { tickAuditSiemWebhookExport } from "./audit/siemWebhook";
import { tickTriggers } from "./triggers/ticker";
import { processGovernanceEvalRun } from "./governance/evalExecutor";
import { scanAndEnqueueRegressionEvals } from "./governance/regressionScheduler";
import { tickRetiredSecretsCleanup } from "./secrets/retiredCleanup";
import { tickDeviceExecutionResume } from "./devices/resumeTicker";
import { appendCollabEventOnce } from "./lib/collabEvents";
import { initWorkerSkills } from "./skills/registry";

const tracer = trace.getTracer("openslin-worker");

async function main() {
  const cfg = loadConfig(process.env);
  const masterKey = cfg.secrets.masterKey;
  const pool = createPool(cfg);

  /* ─── P0-3: 激活 Worker Skill 贡献（knowledge-rag / channel-gateway / notification-outbox 等 8 个） ─── */
  try {
    initWorkerSkills();
    console.log("[worker] initWorkerSkills: 8 worker skill contributions registered");
  } catch (e: any) {
    console.error("[worker] initWorkerSkills FAILED — worker skill contributions will be unavailable", { error: String(e?.message ?? e) });
  }
  const connection = { host: cfg.redis.host, port: cfg.redis.port };
  const queue = new Queue("workflow", { connection });
  const origAdd = queue.add.bind(queue);
  (queue as any).add = (name: string, data: any, opts: any) => origAdd(name, attachJobTraceCarrier(data ?? {}), opts);
  const redis = await queue.client;

  setInterval(() => {
    redis.set("worker:heartbeat:ts", String(Date.now()), "PX", 60_000).catch((e) => {
      console.warn("[worker] heartbeat write failed", { error: String(e?.message ?? e) });
    });
  }, 10_000).unref();

  async function stopRunWithBudget(p: {
    jobId: string; runId: string; phase: string;
    collab?: { tenantId: string; spaceIdHint: string; collabRunId: string; taskId: string; reason: string };
  }) {
    await pool.query("UPDATE runs SET status = 'stopped', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [p.runId]);
    await pool.query("UPDATE jobs SET status = 'stopped', updated_at = now() WHERE job_id = $1", [p.jobId]);
    await pool.query("UPDATE steps SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1 AND status = 'pending'", [p.runId]);
    const spaceRes = await pool.query("SELECT (input->>'spaceId') AS space_id, r.tenant_id FROM steps s JOIN runs r ON r.run_id = s.run_id WHERE s.run_id = $1 AND s.seq = 1 LIMIT 1", [p.runId]);
    if (spaceRes.rowCount) {
      const spaceId = String(spaceRes.rows[0].space_id ?? "");
      const tenantId2 = String(spaceRes.rows[0].tenant_id ?? "");
      if (tenantId2 && spaceId) {
        await pool.query(
          "UPDATE memory_task_states SET phase = $4, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
          [tenantId2, spaceId, p.runId, p.phase],
        );
      }
    }
    if (p.collab) {
      await pool.query("UPDATE collab_runs SET status = 'stopped', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2", [p.collab.tenantId, p.collab.collabRunId]);
      await appendCollabEventOnce({
        pool,
        tenantId: p.collab.tenantId, spaceId: p.collab.spaceIdHint || null, collabRunId: p.collab.collabRunId,
        taskId: p.collab.taskId, type: "collab.budget.exceeded", actorRole: null,
        runId: p.runId, stepId: null, payloadDigest: { reason: p.collab.reason },
      });
    }
  }

  async function scheduleNextAgentRunStep(params: { jobId: string; runId: string }) {
    const runRes = await pool.query("SELECT tenant_id, status, input_digest, started_at, created_at FROM runs WHERE run_id = $1 LIMIT 1", [params.runId]);
    if (!runRes.rowCount) return;
    const tenantId = String(runRes.rows[0].tenant_id ?? "");
    const status = String(runRes.rows[0].status ?? "");
    if (["succeeded", "failed", "canceled", "stopped"].includes(status)) return;
    if (status === "needs_approval") return;
    if (status === "needs_arbiter") return;
    if (status === "needs_device") return;

    const inputDigest = (runRes.rows[0].input_digest as any) ?? null;
    const limits = (inputDigest?.limits as any) ?? null;
    const maxSteps = limits?.maxSteps ? Number(limits.maxSteps) : null;
    const maxWallTimeMs = limits?.maxWallTimeMs ? Number(limits.maxWallTimeMs) : null;
    const maxTokens = limits?.maxTokens ? Number(limits.maxTokens) : null;
    const maxCostUsd = limits?.maxCostUsd ? Number(limits.maxCostUsd) : null;
    const collabRunId = typeof inputDigest?.collabRunId === "string" ? String(inputDigest.collabRunId) : "";
    const taskId = typeof inputDigest?.taskId === "string" ? String(inputDigest.taskId) : "";
    const isCollab = String(inputDigest?.kind ?? "") === "collab.run" && collabRunId && taskId;

    const candidatesRes = await pool.query(
      `
        SELECT step_id, seq, tool_ref, input, policy_snapshot_ref, input_digest
        FROM steps
        WHERE run_id = $1 AND status = 'pending' AND (queue_job_id IS NULL OR queue_job_id = '')
        ORDER BY seq ASC
        LIMIT 20
      `,
      [params.runId],
    );
    if (!candidatesRes.rowCount) return;

    const spaceIdHint = (candidatesRes.rows[0]?.input as any)?.spaceId ? String((candidatesRes.rows[0].input as any).spaceId) : "";

    if (maxSteps && candidatesRes.rows[0] && Number(candidatesRes.rows[0].seq ?? 0) > maxSteps) {
      await stopRunWithBudget({
        jobId: params.jobId, runId: params.runId, phase: "stopped.limit_exceeded",
        collab: isCollab && tenantId ? { tenantId, spaceIdHint: spaceIdHint || "", collabRunId, taskId, reason: "maxSteps" } : undefined,
      });
      return;
    }

    if (maxWallTimeMs) {
      const startedAt = (runRes.rows[0].started_at as string | null) ?? (runRes.rows[0].created_at as string | null) ?? null;
      if (startedAt && Date.now() - new Date(startedAt).getTime() > maxWallTimeMs) {
        await stopRunWithBudget({
          jobId: params.jobId, runId: params.runId, phase: "stopped.timeout",
          collab: isCollab && tenantId ? { tenantId, spaceIdHint: spaceIdHint || "", collabRunId, taskId, reason: "timeout" } : undefined,
        });
        return;
      }
    }

    if (maxTokens && isCollab && tenantId) {
      const prefix = `collab:${collabRunId}:%`;
      const usedRes = await pool.query(
        `
          SELECT COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::bigint AS total
          FROM model_usage_events
          WHERE tenant_id = $1
            AND ($2::text IS NULL OR space_id = $2)
            AND purpose LIKE $3
            AND created_at >= (now() - interval '14 days')
        `,
        [tenantId, spaceIdHint || null, prefix],
      );
      const used = Number(usedRes.rowCount ? usedRes.rows[0].total : 0) || 0;
      if (used >= maxTokens) {
        await stopRunWithBudget({
          jobId: params.jobId, runId: params.runId, phase: "stopped.limit_exceeded",
          collab: { tenantId, spaceIdHint: spaceIdHint || "", collabRunId, taskId, reason: "maxTokens" },
        });
        return;
      }
    }

    if (maxCostUsd && isCollab && tenantId) {
      const usdPer1kTokens = Number(String(process.env.MODEL_USD_PER_1K_TOKENS ?? "").trim());
      if (Number.isFinite(usdPer1kTokens) && usdPer1kTokens > 0) {
        const prefix = `collab:${collabRunId}:%`;
        const usedRes = await pool.query(
          `
            SELECT COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::bigint AS total
            FROM model_usage_events
            WHERE tenant_id = $1
              AND ($2::text IS NULL OR space_id = $2)
              AND purpose LIKE $3
              AND created_at >= (now() - interval '14 days')
          `,
          [tenantId, spaceIdHint || null, prefix],
        );
        const usedTokens = Number(usedRes.rowCount ? usedRes.rows[0].total : 0) || 0;
        const usedCostUsd = (usedTokens / 1000) * usdPer1kTokens;
        if (usedCostUsd >= maxCostUsd) {
          await stopRunWithBudget({
            jobId: params.jobId, runId: params.runId, phase: "stopped.limit_exceeded",
            collab: { tenantId, spaceIdHint: spaceIdHint || "", collabRunId, taskId, reason: "maxCostUsd" },
          });
          return;
        }
      }
    }

    const completedPlanStepIds = new Set<string>();
    if (isCollab) {
      const doneRes = await pool.query("SELECT (input->>'planStepId') AS plan_step_id FROM steps WHERE run_id = $1 AND status = 'succeeded'", [params.runId]);
      for (const r of doneRes.rows) {
        const v = r.plan_step_id ? String(r.plan_step_id) : "";
        if (v) completedPlanStepIds.add(v);
      }
    }

    let roleAllowed: Record<string, Set<string> | null> = {};
    let roleBudget: Record<string, { maxSteps?: number }> = {};
    if (isCollab && tenantId && spaceIdHint) {
      const ts = await pool.query("SELECT plan FROM memory_task_states WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL LIMIT 1", [
        tenantId,
        spaceIdHint,
        params.runId,
      ]);
      const plan = ts.rowCount ? ((ts.rows[0] as any).plan as any) : null;
      const roles = Array.isArray(plan?.roles) ? plan.roles : [];
      roleAllowed = {};
      roleBudget = {};
      for (const r of roles) {
        const rn = typeof r?.roleName === "string" ? String(r.roleName) : "";
        const allowed = Array.isArray(r?.toolPolicy?.allowedTools) ? r.toolPolicy.allowedTools.map((x: any) => String(x)) : null;
        if (rn) roleAllowed[rn] = allowed ? new Set<string>(allowed) : null;
        const rbMaxSteps = r?.budget?.maxSteps ? Number(r.budget.maxSteps) : null;
        if (rn && rbMaxSteps && Number.isFinite(rbMaxSteps) && rbMaxSteps > 0) roleBudget[rn] = { maxSteps: Math.max(1, Math.min(100, Math.floor(rbMaxSteps))) };
      }
    }

    let usedStepsByRole: Record<string, number> | null = null;
    const roleBudgetRoles = Object.keys(roleBudget);
    if (isCollab && roleBudgetRoles.length) {
      usedStepsByRole = {};
      const usedRes = await pool.query(
        `
          SELECT (input->>'actorRole') AS role_name, COUNT(*)::int AS cnt
          FROM steps
          WHERE run_id = $1 AND status = 'succeeded'
          GROUP BY (input->>'actorRole')
        `,
        [params.runId],
      );
      for (const r of usedRes.rows) {
        const rn = r.role_name ? String(r.role_name) : "";
        if (!rn) continue;
        usedStepsByRole[rn] = Number(r.cnt ?? 0) || 0;
      }
    }

    const ready: Array<{ stepId: string; seq: number; toolRef: string | null; metaInput: any; policySnapshotRef: any; inputDigest: any }> = [];
    for (const row of candidatesRes.rows) {
      const stepId = String(row.step_id ?? "");
      const seq = Number(row.seq ?? 0);
      if (!stepId || !seq) continue;
      if (maxSteps && seq > maxSteps) continue;
      const toolRef = row.tool_ref ? String(row.tool_ref) : null;
      const metaInput = (row.input as any) ?? null;
      if (isCollab) {
        const dependsOn = Array.isArray(metaInput?.dependsOn) ? metaInput.dependsOn.map((x: any) => String(x)) : [];
        const ok = dependsOn.every((d: string) => completedPlanStepIds.has(d));
        if (!ok) continue;
        const actorRole = metaInput?.actorRole ? String(metaInput.actorRole) : "";
        const allowedSet = actorRole ? roleAllowed[actorRole] ?? null : null;
        if (allowedSet && toolRef && !allowedSet.has(toolRef)) {
          await pool.query("UPDATE runs SET status = 'stopped', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [params.runId]);
          await pool.query("UPDATE jobs SET status = 'stopped', updated_at = now() WHERE job_id = $1", [params.jobId]);
          await pool.query("UPDATE steps SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1 AND status = 'pending'", [params.runId]);
          if (tenantId && spaceIdHint) {
            await pool.query(
              "UPDATE memory_task_states SET phase = $4, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
              [tenantId, spaceIdHint, params.runId, "stopped.policy_denied"],
            );
          }
          await pool.query("UPDATE collab_runs SET status = 'stopped', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2", [tenantId, collabRunId]);
          await appendCollabEventOnce({
            pool,
            tenantId, spaceId: spaceIdHint || null, collabRunId, taskId,
            type: "collab.policy.denied", actorRole: actorRole || null,
            runId: params.runId, stepId, payloadDigest: { toolRef, reason: "tool_not_allowed" },
          });
          return;
        }

        const rb = actorRole ? roleBudget[actorRole] ?? null : null;
        if (rb?.maxSteps && usedStepsByRole) {
          const used = Number(usedStepsByRole[actorRole] ?? 0) || 0;
          if (used + 1 > rb.maxSteps) {
            await stopRunWithBudget({
              jobId: params.jobId,
              runId: params.runId,
              phase: "stopped.limit_exceeded",
              collab: tenantId ? { tenantId, spaceIdHint: spaceIdHint || "", collabRunId, taskId, reason: `role.maxSteps:${actorRole}` } : undefined,
            });
            return;
          }
        }
      }
      ready.push({ stepId, seq, toolRef, metaInput, policySnapshotRef: row.policy_snapshot_ref ?? null, inputDigest: row.input_digest ?? null });
    }
    if (!ready.length) return;

    const first = ready[0]!;
    const tc = first.metaInput?.toolContract ?? null;
    const approvalRequired = Boolean(tc?.approvalRequired) || tc?.riskLevel === "high";
    if (approvalRequired) {
      const spaceId = first.metaInput?.spaceId ? String(first.metaInput.spaceId) : null;
      const subjectId = first.metaInput?.subjectId ? String(first.metaInput.subjectId) : null;
      await pool.query(
        `
          INSERT INTO approvals (tenant_id, space_id, run_id, step_id, status, requested_by_subject_id, tool_ref, policy_snapshot_ref, input_digest)
          VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8)
          ON CONFLICT (tenant_id, run_id) DO UPDATE SET status = 'pending', step_id = EXCLUDED.step_id, tool_ref = EXCLUDED.tool_ref, policy_snapshot_ref = EXCLUDED.policy_snapshot_ref, input_digest = EXCLUDED.input_digest, updated_at = now()
        `,
        [tenantId, spaceId, params.runId, first.stepId, subjectId ?? "unknown", first.toolRef, first.policySnapshotRef, first.inputDigest],
      );
      await pool.query("UPDATE runs SET status = 'needs_approval', updated_at = now() WHERE run_id = $1", [params.runId]);
      await pool.query("UPDATE jobs SET status = 'needs_approval', updated_at = now() WHERE job_id = $1", [params.jobId]);
      if (tenantId && spaceId) {
        await pool.query(
          "UPDATE memory_task_states SET phase = $4, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
          [tenantId, spaceId, params.runId, "needs_approval"],
        );
      }
      if (isCollab && tenantId) {
        await pool.query("UPDATE collab_runs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2", [tenantId, collabRunId]);
        await appendCollabEventOnce({
          pool,
          tenantId, spaceId: spaceIdHint || null, collabRunId, taskId,
          type: "collab.run.needs_approval", actorRole: first.metaInput?.actorRole ? String(first.metaInput.actorRole) : null,
          runId: params.runId, stepId: first.stepId, payloadDigest: { toolRef: first.toolRef },
        });
      }
      return;
    }

    const maxParallel = isCollab ? 3 : 1;
    for (const n of ready.slice(0, maxParallel)) {
      const bj = await queue.add("step", { jobId: params.jobId, runId: params.runId, stepId: n.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
      await pool.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2 AND (queue_job_id IS NULL OR queue_job_id = '')", [
        String((bj as any).id),
        n.stepId,
      ]);
    }
  }

  const worker = new Worker(
    "workflow",
    async (job) => {
      const data = job.data as any;
      const jobCtx = extractJobTraceContext(data);
      return await context.with(jobCtx, async () => {
        if (data?.kind === "governance.evalrun.execute") {
          await processGovernanceEvalRun({ pool, tenantId: String(data.tenantId), evalRunId: String(data.evalRunId) });
          return;
        }
        if (data?.kind === "audit.export") {
          await processAuditExport({ pool, tenantId: String(data.tenantId), exportId: String(data.exportId), subjectId: String(data.subjectId), spaceId: data.spaceId ? String(data.spaceId) : null });
          return;
        }
        if (data?.kind === "media.process") {
          await processMediaJob({ pool, tenantId: String(data.tenantId), jobId: String(data.jobId), fsRootDir: cfg.media.fsRootDir });
          return;
        }
        if (data?.kind === "keyring.reencrypt") {
          await reencryptSecrets({
            pool,
            tenantId: String(data.tenantId),
            masterKey,
            scopeType: String(data.scopeType),
            scopeId: String(data.scopeId),
            limit: Number(data.limit ?? 500),
          });
          return;
        }
        if (data?.kind === "knowledge.index") {
          const out = await processKnowledgeIndexJob({ pool, indexJobId: data.indexJobId });
          if (out && out.chunkCount > 0) {
            const embeddingModelRef = String(process.env.KNOWLEDGE_EMBEDDING_MODEL_REF ?? "").trim() || "minhash:16@1";
            const ins = await pool.query(
              `
                INSERT INTO knowledge_embedding_jobs (tenant_id, space_id, document_id, document_version, embedding_model_ref, status)
                VALUES ($1,$2,$3,$4,$5,'queued')
                ON CONFLICT (tenant_id, space_id, document_id, document_version, embedding_model_ref)
                DO UPDATE SET updated_at = now()
                RETURNING id
              `,
              [out.tenantId, out.spaceId, out.documentId, out.documentVersion, embeddingModelRef],
            );
            const embeddingJobId = ins.rowCount ? String(ins.rows[0].id) : "";
            if (embeddingJobId) {
              await queue.add("knowledge.embed", { kind: "knowledge.embed", embeddingJobId }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
            }
          }
          return;
        }
        if (data?.kind === "knowledge.embed") {
          await processKnowledgeEmbeddingJob({ pool, embeddingJobId: data.embeddingJobId });
          return;
        }
        if (data?.kind === "knowledge.ingest") {
          const out = await processKnowledgeIngestJob({ pool, ingestJobId: data.ingestJobId });
          if (out?.indexJobId) {
            await queue.add("knowledge.index", { kind: "knowledge.index", indexJobId: out.indexJobId }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
          }
          return;
        }
      let collabMeta: { tenantId: string; spaceId: string | null; collabRunId: string; taskId: string; actorRole: string | null; stepId: string; runId: string } | null = null;
      try {
        const metaRes = await pool.query(
          `
            SELECT r.tenant_id, (s.input->>'spaceId') AS space_id, (s.input->>'collabRunId') AS collab_run_id, (s.input->>'taskId') AS task_id, (s.input->>'actorRole') AS actor_role
            FROM steps s
            JOIN runs r ON r.run_id = s.run_id
            WHERE s.step_id = $1
            LIMIT 1
          `,
          [String(data.stepId ?? "")],
        );
        if (metaRes.rowCount) {
          const collabRunId = String(metaRes.rows[0].collab_run_id ?? "");
          const taskId = String(metaRes.rows[0].task_id ?? "");
          if (collabRunId && taskId) {
            collabMeta = {
              tenantId: String(metaRes.rows[0].tenant_id ?? ""),
              spaceId: metaRes.rows[0].space_id ? String(metaRes.rows[0].space_id) : null,
              collabRunId,
              taskId,
              actorRole: metaRes.rows[0].actor_role ? String(metaRes.rows[0].actor_role) : null,
              stepId: String(data.stepId ?? ""),
              runId: String(data.runId ?? ""),
            };
            const ex = await pool.query("SELECT 1 FROM collab_run_events WHERE tenant_id = $1 AND collab_run_id = $2 AND type = $3 AND step_id = $4 LIMIT 1", [
              collabMeta.tenantId,
              collabMeta.collabRunId,
              "collab.step.started",
              collabMeta.stepId,
            ]);
            if (!ex.rowCount) {
              const tool = await pool.query("SELECT tool_ref, seq, (input->>'planStepId') AS plan_step_id FROM steps WHERE step_id = $1 LIMIT 1", [collabMeta.stepId]);
              const toolRef = tool.rowCount ? (tool.rows[0].tool_ref ? String(tool.rows[0].tool_ref) : null) : null;
              const seq = tool.rowCount ? Number(tool.rows[0].seq ?? 0) : 0;
              const planStepId = tool.rowCount ? (tool.rows[0].plan_step_id ? String(tool.rows[0].plan_step_id) : null) : null;
              await appendCollabEventOnce({
                pool,
                tenantId: collabMeta.tenantId, spaceId: collabMeta.spaceId, collabRunId: collabMeta.collabRunId,
                taskId: collabMeta.taskId, type: "collab.step.started", actorRole: collabMeta.actorRole,
                runId: collabMeta.runId, stepId: collabMeta.stepId, payloadDigest: { toolRef, seq, planStepId },
                dedupeKeys: ["stepId"],
              });
            }
          }
        }
      } catch (e: any) {
        console.warn("[worker] collab step.started event failed", { jobId: String(data?.jobId ?? ""), runId: String(data?.runId ?? ""), stepId: String(data?.stepId ?? ""), error: String(e?.message ?? e) });
      }
      try {
        const span = tracer.startSpan("workflow.step.process", { attributes: { jobId: String(data.jobId ?? ""), runId: String(data.runId ?? ""), stepId: String(data.stepId ?? ""), kind: "step" } });
        try {
          await context.with(trace.setSpan(context.active(), span), async () => {
            await processStep({ pool, jobId: data.jobId, runId: data.runId, stepId: data.stepId, masterKey });
          });
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (e: any) {
          span.recordException(e);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw e;
        } finally {
          span.end();
        }
        redis.incr("worker:workflow:step:success").catch((e) => {
          console.warn("[worker] redis incr step:success failed", { error: String(e?.message ?? e) });
        });
        redis.incr("worker:tool_execute:success").catch((e) => {
          console.warn("[worker] redis incr tool_execute:success failed", { error: String(e?.message ?? e) });
        });
      } catch (e) {
        redis.incr("worker:workflow:step:error").catch((e2) => {
          console.warn("[worker] redis incr step:error failed", { error: String(e2?.message ?? e2) });
        });
        redis.incr("worker:tool_execute:error").catch((e2) => {
          console.warn("[worker] redis incr tool_execute:error failed", { error: String(e2?.message ?? e2) });
        });
        throw e;
      }
      try {
        if (collabMeta) {
          const st = await pool.query("SELECT status, tool_ref, seq, error_category, last_error_digest, output_digest, (input->>'planStepId') AS plan_step_id FROM steps WHERE step_id = $1 LIMIT 1", [
            collabMeta.stepId,
          ]);
          if (st.rowCount) {
            const s = String(st.rows[0].status ?? "");
            const toolRef = st.rows[0].tool_ref ? String(st.rows[0].tool_ref) : null;
            const seq = Number(st.rows[0].seq ?? 0);
            const planStepId = st.rows[0].plan_step_id ? String(st.rows[0].plan_step_id) : null;
            const type = s === "succeeded" ? "collab.step.completed" : s === "failed" ? "collab.step.failed" : "";
            if (type) {
              const payload =
                type === "collab.step.completed"
                  ? { toolRef, seq, planStepId, outputDigest: st.rows[0].output_digest ?? null }
                  : { toolRef, seq, planStepId, errorCategory: st.rows[0].error_category ?? null, lastErrorDigest: st.rows[0].last_error_digest ?? null };
              await appendCollabEventOnce({
                pool,
                tenantId: collabMeta.tenantId, spaceId: collabMeta.spaceId, collabRunId: collabMeta.collabRunId,
                taskId: collabMeta.taskId, type, actorRole: collabMeta.actorRole,
                runId: collabMeta.runId, stepId: collabMeta.stepId, payloadDigest: payload,
                dedupeKeys: ["stepId"],
              });
            }
          }
        }
      } catch (e: any) {
        console.warn("[worker] collab step completed/failed event failed", { runId: String(data?.runId ?? ""), error: String(e?.message ?? e) });
      }
      try {
        const jobTypeRes = await pool.query("SELECT job_type FROM jobs WHERE job_id = $1 LIMIT 1", [String(data.jobId ?? "")]);
        const jobType = jobTypeRes.rowCount ? String(jobTypeRes.rows[0].job_type ?? "") : "";
        if (jobType === "agent.run") {
          await scheduleNextAgentRunStep({ jobId: String(data.jobId ?? ""), runId: String(data.runId ?? "") });
        }
      } catch (e: any) {
        console.warn("[worker] scheduleNextAgentRunStep failed", { jobId: String(data?.jobId ?? ""), runId: String(data?.runId ?? ""), error: String(e?.message ?? e) });
      }
      try {
        const r = await pool.query("SELECT status, input_digest, tenant_id FROM runs WHERE run_id = $1 LIMIT 1", [String(data.runId ?? "")]);
        if (r.rowCount) {
          const st = String(r.rows[0].status ?? "");
          const inputDigest = (r.rows[0].input_digest as any) ?? null;
          const collabRunId = typeof inputDigest?.collabRunId === "string" ? String(inputDigest.collabRunId) : "";
          const taskId = typeof inputDigest?.taskId === "string" ? String(inputDigest.taskId) : "";
          const kind = String(inputDigest?.kind ?? "");
          const tenantId = String(r.rows[0].tenant_id ?? "");
          if (kind === "collab.run" && collabRunId && taskId && ["succeeded", "failed", "canceled", "stopped"].includes(st)) {
            await pool.query("UPDATE collab_runs SET status = $3, updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2", [tenantId, collabRunId, st]);
            await appendCollabEventOnce({
              pool,
              tenantId, spaceId: collabMeta?.spaceId ?? null, collabRunId, taskId,
              type: `collab.run.${st}`, actorRole: null,
              runId: String(data.runId ?? ""), stepId: null, payloadDigest: null,
            });
          }
        }
      } catch (e: any) {
        console.warn("[worker] collab run status sync failed", { runId: String(data?.runId ?? ""), error: String(e?.message ?? e) });
      }
      });
    },
    { connection, concurrency: 5 },
  );

  worker.on("failed", async (job, err) => {
    console.error("job failed", job?.id, err);
    try {
      if (!job) return;
      if (job.name !== "step") return;
      const data = job.data as any;
      const stepId = data?.stepId ? String(data.stepId) : null;
      const runId = data?.runId ? String(data.runId) : null;
      const jobId = data?.jobId ? String(data.jobId) : null;
      if (!stepId || !runId || !jobId) return;

      const maxAttempts = Number(job.opts.attempts ?? 1);
      const attemptsMade = Number(job.attemptsMade ?? 0);
      if (attemptsMade < maxAttempts) return;
      await markWorkflowStepDeadletter({ pool, jobId, runId, stepId, queueJobId: String(job.id), err });
    } catch (e) {
      console.error("deadletter mark failed", e);
    }
  });

  setInterval(() => {
    tickSubscriptions({ pool, masterKey }).catch((err) => console.error("subscription tick failed", err));
  }, 5_000);

  setInterval(() => {
    tickTriggers({ pool, queue }).catch((err) => console.error("trigger tick failed", err));
  }, 5_000);

  setInterval(() => {
    (async () => {
      const pendingRes = await pool.query(
        "SELECT count(*)::int AS c FROM knowledge_ingest_jobs WHERE status IN ('queued','running')",
      );
      const pending = Number(pendingRes.rows[0]?.c ?? 0);
      if (pending > 200) return;

      const res = await pool.query(
        `
          WITH candidates AS (
            SELECT e.tenant_id, e.space_id, e.provider, e.workspace_id, e.event_id, e.id AS source_event_pk
            FROM channel_ingress_events e
            WHERE e.created_at > now() - interval '7 days'
              AND e.status = 'received'
              AND e.provider IN ('imap','exchange','mock')
              AND e.space_id IS NOT NULL
            ORDER BY e.created_at DESC
            LIMIT 50
          )
          INSERT INTO knowledge_ingest_jobs (tenant_id, space_id, provider, workspace_id, event_id, source_event_pk, status)
          SELECT c.tenant_id, c.space_id, c.provider, c.workspace_id, c.event_id, c.source_event_pk, 'queued'
          FROM candidates c
          ON CONFLICT (tenant_id, provider, workspace_id, event_id)
          DO NOTHING
          RETURNING id
        `,
        [],
      );
      for (const r of res.rows as any[]) {
        const ingestJobId = String(r.id ?? "");
        if (!ingestJobId) continue;
        await queue.add("knowledge.ingest", { kind: "knowledge.ingest", ingestJobId }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
      }
    })().catch((err) => console.error("knowledge ingest tick failed", err));
  }, 10_000);

  setInterval(() => {
    tickWebhookDeliveries({ pool }).catch((err) => console.error("webhook delivery tick failed", err));
  }, 2_000);

  setInterval(() => {
    tickChannelOutboxDeliveries({ pool, masterKey }).catch((err) => console.error("channel outbox delivery tick failed", err));
  }, 2_000);

  setInterval(() => {
    tickEmailDeliveries({ pool }).catch((err) => console.error("email delivery tick failed", err));
  }, 2_000);

  setInterval(() => {
    tickWorkflowStepPayloadPurge({ pool }).catch((err) => console.error("workflow step payload purge tick failed", err));
  }, 60_000);

  let auditSiemExportTickInFlight = false;
  setInterval(() => {
    if (auditSiemExportTickInFlight) return;
    auditSiemExportTickInFlight = true;
    tickAuditSiemWebhookExport({ pool, masterKey })
      .catch((err) => console.error("audit siem export tick failed", err))
      .finally(() => {
        auditSiemExportTickInFlight = false;
      });
  }, 2_000);

  setInterval(() => {
    tickRetiredSecretsCleanup({ pool }).catch((err) => console.error("secret retired cleanup tick failed", err));
  }, 60_000);

  /* ─── Device execution completion ticker (endpoint-side integration) ─── */
  setInterval(() => {
    tickDeviceExecutionResume({ pool, queue }).catch((err) => console.error("device execution resume tick failed", err));
  }, 3_000);

  /* ─── Regression eval scheduler (§15.13) ─── */
  const regressionIntervalMs = Math.max(Number(process.env.REGRESSION_EVAL_INTERVAL_MS) || 5 * 60_000, 30_000);
  setInterval(() => {
    scanAndEnqueueRegressionEvals({ pool, queue }).catch((err) => console.error("regression eval scan failed", err));
  }, regressionIntervalMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
