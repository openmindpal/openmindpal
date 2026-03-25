import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { getCollabRun } from "../../skills/collab-runtime/modules/collabRepo";
import { deriveCollabState } from "../../skills/collab-runtime/modules/reducer";
import { getFederationGatewayStatus } from "../../skills/collab-runtime/modules/federationGateway";

export const governanceCollabRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/collab-runs/:collabRunId/diagnostics", async (req, reply) => {
    const params = z.object({ collabRunId: z.string().uuid() }).parse(req.params);
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    setAuditContext(req, { resourceType: "agent_runtime", action: "collab.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "agent_runtime", action: "collab.read" });

    const collab = await getCollabRun({ pool: app.db, tenantId: subject.tenantId, collabRunId: params.collabRunId });
    if (!collab) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "CollabRun 不存在", "en-US": "CollabRun not found" }, traceId: req.ctx.traceId });
    if (collab.spaceId && collab.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const q = req.query as any;
    const correlationId = z.string().min(1).max(200).optional().parse(q?.correlationId) ?? null;

    const agg = await app.db.query(
      `
        SELECT COALESCE(actor_role,'') AS actor_role, type, COUNT(*)::int AS c
        FROM collab_run_events
        WHERE tenant_id = $1 AND collab_run_id = $2
        GROUP BY COALESCE(actor_role,''), type
      `,
      [subject.tenantId, collab.collabRunId],
    );

    const byRole = new Map<string, any>();
    function ensureRole(roleName: string) {
      const k = roleName || "(none)";
      const cur = byRole.get(k);
      if (cur) return cur;
      const v = { roleName: k, stepsStarted: 0, stepsCompleted: 0, stepsFailed: 0, blocked: 0, needsApproval: 0, singleWriterViolations: 0 };
      byRole.set(k, v);
      return v;
    }

    for (const r of agg.rows as any[]) {
      const role = String(r.actor_role ?? "");
      const type = String(r.type ?? "");
      const c = Number(r.c ?? 0);
      const slot = ensureRole(role);
      if (type === "collab.step.started") slot.stepsStarted += c;
      if (type === "collab.step.completed") slot.stepsCompleted += c;
      if (type === "collab.step.failed") slot.stepsFailed += c;
      if (type === "collab.policy.denied" || type === "collab.budget.exceeded") slot.blocked += c;
      if (type === "collab.run.needs_approval") slot.needsApproval += c;
      if (type === "collab.single_writer.violation") slot.singleWriterViolations += c;
    }

    const issues = await app.db.query(
      `
        SELECT type, actor_role, payload_digest, policy_snapshot_ref, correlation_id, created_at
        FROM collab_run_events
        WHERE tenant_id = $1 AND collab_run_id = $2
          AND type IN ('collab.step.failed','collab.policy.denied','collab.budget.exceeded','collab.single_writer.violation')
        ORDER BY created_at DESC
        LIMIT 20
      `,
      [subject.tenantId, collab.collabRunId],
    );

    const recentIssues = (issues.rows as any[]).map((x) => ({
      type: String(x.type ?? ""),
      actorRole: x.actor_role ? String(x.actor_role) : null,
      payloadDigest: x.payload_digest ?? null,
      policySnapshotRef: x.policy_snapshot_ref ? String(x.policy_snapshot_ref) : null,
      correlationId: x.correlation_id ? String(x.correlation_id) : null,
      createdAt: String(x.created_at ?? ""),
    }));

    let runStatus: string | null = null;
    let steps: Array<{ stepId: string; status: string; toolRef: string | null; seq: number }> = [];
    if (collab.primaryRunId) {
      const r = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, collab.primaryRunId]);
      runStatus = r.rowCount ? String((r.rows[0] as any).status ?? "") : null;
      const s = await app.db.query("SELECT step_id, seq, status, tool_ref FROM steps WHERE run_id = $1 ORDER BY seq ASC LIMIT 200", [collab.primaryRunId]);
      steps = (s.rows as any[]).map((x) => ({ stepId: String(x.step_id), seq: Number(x.seq ?? 0), status: String(x.status ?? ""), toolRef: x.tool_ref ? String(x.tool_ref) : null }));
    }

    const ev = await app.db.query(
      `
        SELECT type, actor_role, run_id, step_id, correlation_id, created_at
        FROM collab_run_events
        WHERE tenant_id = $1 AND collab_run_id = $2
        ORDER BY created_at DESC
        LIMIT 500
      `,
      [subject.tenantId, collab.collabRunId],
    );
    const events = (ev.rows as any[]).map((x) => ({
      type: String(x.type ?? ""),
      actorRole: x.actor_role ? String(x.actor_role) : null,
      runId: x.run_id ? String(x.run_id) : null,
      stepId: x.step_id ? String(x.step_id) : null,
      correlationId: x.correlation_id ? String(x.correlation_id) : null,
      createdAt: String(x.created_at ?? ""),
    }));

    const { derived, invariants } = deriveCollabState({
      collabStatus: collab.status,
      primaryRunId: collab.primaryRunId ?? null,
      runStatus,
      steps,
      events: events.map((e) => ({ type: e.type, stepId: e.stepId, runId: e.runId, createdAt: e.createdAt })),
    });

    const roles = Array.from(byRole.values()).sort((a, b) => String(a.roleName).localeCompare(String(b.roleName)));
    req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, roleCount: roles.length, issueCount: recentIssues.length, invariantCount: invariants.length, phase: derived.phase };

    if (correlationId) {
      const corrEvents = await app.db.query(
        `
          SELECT type, actor_role, run_id, step_id, payload_digest, policy_snapshot_ref, correlation_id, created_at
          FROM collab_run_events
          WHERE tenant_id = $1 AND collab_run_id = $2 AND correlation_id = $3
          ORDER BY created_at DESC
          LIMIT 50
        `,
        [subject.tenantId, collab.collabRunId, correlationId],
      );
      const correlatedEvents = (corrEvents.rows as any[]).map((x) => ({
        type: String(x.type ?? ""),
        actorRole: x.actor_role ? String(x.actor_role) : null,
        runId: x.run_id ? String(x.run_id) : null,
        stepId: x.step_id ? String(x.step_id) : null,
        payloadDigest: x.payload_digest ?? null,
        policySnapshotRef: x.policy_snapshot_ref ? String(x.policy_snapshot_ref) : null,
        correlationId: x.correlation_id ? String(x.correlation_id) : null,
        createdAt: String(x.created_at ?? ""),
      }));

      const corrEnvs = await app.db.query(
        `
          SELECT envelope_id, task_id, from_role, to_role, broadcast, kind, payload_digest, policy_snapshot_ref, correlation_id, created_at
          FROM collab_envelopes
          WHERE tenant_id = $1 AND collab_run_id = $2 AND correlation_id = $3
          ORDER BY created_at DESC
          LIMIT 50
        `,
        [subject.tenantId, collab.collabRunId, correlationId],
      );
      const correlatedEnvelopes = (corrEnvs.rows as any[]).map((x) => ({
        envelopeId: String(x.envelope_id ?? ""),
        taskId: String(x.task_id ?? ""),
        fromRole: String(x.from_role ?? ""),
        toRole: x.to_role ? String(x.to_role) : null,
        broadcast: Boolean(x.broadcast),
        kind: String(x.kind ?? ""),
        payloadDigest: x.payload_digest ?? null,
        policySnapshotRef: x.policy_snapshot_ref ? String(x.policy_snapshot_ref) : null,
        correlationId: x.correlation_id ? String(x.correlation_id) : null,
        createdAt: String(x.created_at ?? ""),
      }));

      return {
        collabRunId: collab.collabRunId,
        status: collab.status,
        federation: getFederationGatewayStatus(),
        derived,
        invariants,
        roles,
        recentIssues,
        correlation: { correlationId, correlatedEnvelopeCount: correlatedEnvelopes.length, correlatedEventCount: correlatedEvents.length },
        correlatedEnvelopes,
        correlatedEvents,
      };
    }

    return { collabRunId: collab.collabRunId, status: collab.status, federation: getFederationGatewayStatus(), derived, invariants, roles, recentIssues };
  });
};
