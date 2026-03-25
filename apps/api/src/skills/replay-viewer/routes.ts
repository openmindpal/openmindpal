import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";

export const replayRoutes: FastifyPluginAsync = async (app) => {
  function digestObject(body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body;
    const keys = Object.keys(body as any);
    return { keys: keys.slice(0, 50), keyCount: keys.length };
  }

  app.post("/replay/resolve", async (req, reply) => {
    setAuditContext(req, { resourceType: "workflow", action: "workflow:replay_resolve" });
    const decision = await requirePermission({ req, resourceType: "workflow", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const body = z
      .object({
        toolRef: z.string().min(1),
        policySnapshotRef: z.string().min(1),
        inputDigest: z.object({
          sha256_8: z.string().length(8),
          keyCount: z.number().int().nonnegative().optional(),
          keys: z.array(z.string()).optional(),
        }),
        limit: z.number().int().positive().max(50).optional(),
      })
      .parse(req.body);

    const limit = body.limit ?? 20;
    const res = await app.db.query(
      `
        SELECT
          s.run_id,
          s.step_id,
          s.tool_ref,
          r.policy_snapshot_ref,
          s.input_digest,
          r.created_at
        FROM steps s
        JOIN runs r ON r.run_id = s.run_id
        WHERE r.tenant_id = $1
          AND s.input->>'spaceId' = $2
          AND s.tool_ref = $3
          AND r.policy_snapshot_ref = $4
          AND s.input_digest->>'sha256_8' = $5
        ORDER BY r.created_at DESC
        LIMIT $6
      `,
      [subject.tenantId, subject.spaceId, body.toolRef, body.policySnapshotRef, body.inputDigest.sha256_8, limit],
    );

    const matches = res.rows.map((r) => ({
      runId: r.run_id as string,
      stepId: r.step_id as string,
      toolRef: r.tool_ref as string,
      policySnapshotRef: r.policy_snapshot_ref as string,
      inputDigest: r.input_digest,
      createdAt: r.created_at as string,
    }));

    req.ctx.audit!.outputDigest = { matchCount: matches.length };

    if (!matches.length) {
      return reply.status(404).send({
        errorCode: "NOT_FOUND",
        message: { "zh-CN": "未找到匹配的回放记录", "en-US": "No replay match found" },
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
      });
    }

    return { matches };
  });

  app.post("/replay/fetch", async (req, reply) => {
    setAuditContext(req, { resourceType: "workflow", action: "workflow:replay_fetch" });
    const decision = await requirePermission({ req, resourceType: "workflow", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const body = z
      .object({
        runId: z.string().min(3),
        stepId: z.string().min(3),
      })
      .parse(req.body);

    const sealModeRaw = String(process.env.WORKFLOW_SEAL_MODE ?? "").trim().toLowerCase();
    const sealRequired = sealModeRaw === "deny";

    const res = await app.db.query(
      `
        SELECT
          r.run_id,
          r.policy_snapshot_ref,
          s.step_id,
          s.tool_ref,
          s.sealed_at,
          s.sealed_input_digest,
          s.sealed_output_digest,
          s.input_digest,
          s.output_digest
        FROM runs r
        JOIN steps s ON s.run_id = r.run_id
        WHERE r.tenant_id = $1
          AND r.run_id = $2
          AND s.step_id = $3
          AND s.input->>'spaceId' = $4
        LIMIT 1
      `,
      [subject.tenantId, body.runId, body.stepId, subject.spaceId],
    );
    if (!res.rowCount) {
      return reply.status(404).send({
        errorCode: "NOT_FOUND",
        message: { "zh-CN": "回放记录不存在或无权限", "en-US": "Replay record not found or not allowed" },
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
      });
    }
    const row = res.rows[0] as any;
    const sealedAt = row.sealed_at ? new Date(String(row.sealed_at)).toISOString() : null;
    const sealStatus = sealedAt ? "sealed" : "legacy";
    if (sealRequired && sealStatus !== "sealed") {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.replaySealRequired();
    }

    const replay = {
      runId: String(row.run_id),
      stepId: String(row.step_id),
      toolRef: row.tool_ref ? String(row.tool_ref) : null,
      policySnapshotRef: row.policy_snapshot_ref ? String(row.policy_snapshot_ref) : null,
      sealStatus,
      sealedAt,
      sealedInputDigest: row.sealed_input_digest ?? null,
      sealedOutputDigest: row.sealed_output_digest ?? null,
      inputDigest: digestObject(row.input_digest ?? null),
      outputDigest: digestObject(row.output_digest ?? null),
    };
    req.ctx.audit!.outputDigest = { runId: replay.runId, stepId: replay.stepId, sealStatus: replay.sealStatus };
    return { replay };
  });
};
