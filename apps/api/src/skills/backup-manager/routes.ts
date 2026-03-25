import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { getArtifactContent } from "../artifact-manager/modules/artifactRepo";
import { createBackup, getBackup, listBackups } from "./modules/backupRepo";
import { getEffectiveSchema } from "../../modules/metadata/schemaRepo";
import { applyWriteFieldRules } from "../../modules/data/fieldRules";
import { validateEntityPayload } from "../../modules/data/validate";
import { createJobRunStepWithoutToolRef } from "../../modules/workflow/jobRepo";

export const backupRoutes: FastifyPluginAsync = async (app) => {
  app.get("/spaces/:spaceId/backups", async (req) => {
    const params = z.object({ spaceId: z.string() }).parse(req.params);
    setAuditContext(req, { resourceType: "backup", action: "list" });
    await requirePermission({ req, resourceType: "backup", action: "list" });
    const subject = req.ctx.subject!;
    if (subject.spaceId && subject.spaceId !== params.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    const limit = z.coerce.number().int().positive().max(200).optional().parse((req.query as any)?.limit) ?? 50;
    const items = await listBackups({ pool: app.db, tenantId: subject.tenantId, spaceId: params.spaceId, limit });
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.get("/backups/:backupId", async (req) => {
    const params = z.object({ backupId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "backup", action: "get" });
    await requirePermission({ req, resourceType: "backup", action: "get" });
    const subject = req.ctx.subject!;
    const b = await getBackup({ pool: app.db, tenantId: subject.tenantId, backupId: params.backupId });
    if (!b) throw Errors.badRequest("Backup 不存在");
    if (subject.spaceId && subject.spaceId !== b.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    req.ctx.audit!.outputDigest = { backupId: b.backupId, status: b.status, hasArtifact: Boolean(b.backupArtifactId) };
    return { backup: b };
  });

  app.post("/spaces/:spaceId/backups", async (req) => {
    const params = z.object({ spaceId: z.string() }).parse(req.params);
    setAuditContext(req, { resourceType: "backup", action: "create" });
    const decision = await requirePermission({ req, resourceType: "backup", action: "create" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    if (subject.spaceId && subject.spaceId !== params.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const body = z
      .object({
        schemaName: z.string().min(1).optional(),
        entityNames: z.array(z.string().min(1)).max(200).optional(),
        format: z.enum(["jsonl", "json"]).optional(),
      })
      .parse(req.body);

    const schemaName = body.schemaName ?? "core";
    const schema = await getEffectiveSchema({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: schemaName });
    if (!schema) throw Errors.badRequest(`Schema 未发布：${schemaName}`);

    const runToolRef = `space.backup:${params.spaceId}`;
    const { job, run, step } = await createJobRunStepWithoutToolRef({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "space.backup",
      runToolRef,
      policySnapshotRef: decision.snapshotRef,
      input: {
        kind: "space.backup",
        spaceId: params.spaceId,
        schemaName,
        entityNames: body.entityNames ?? null,
        format: body.format ?? "jsonl",
        fieldRules: decision.fieldRules ?? null,
        rowFilters: decision.rowFilters ?? null,
        tenantId: subject.tenantId,
        subjectId: subject.subjectId,
        traceId: req.ctx.traceId,
      },
      createdBySubjectId: subject.subjectId,
      trigger: "manual",
    });

    const backup = await createBackup({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: params.spaceId,
      status: "created",
      schemaName,
      entityNames: body.entityNames ?? null,
      format: body.format ?? "jsonl",
      policySnapshotRef: decision.snapshotRef,
      runId: run.runId,
      stepId: step.stepId,
      createdBySubjectId: subject.subjectId,
    });

    await app.queue.add("step", { jobId: job.jobId, runId: run.runId, stepId: step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: run.runId, stepId: step.stepId }, status: "queued" as const };
    req.ctx.audit!.outputDigest = { backupId: backup.backupId, runId: run.runId, stepId: step.stepId, format: backup.format };
    return { backupId: backup.backupId, receipt };
  });

  app.post("/spaces/:spaceId/restores", async (req) => {
    const params = z.object({ spaceId: z.string() }).parse(req.params);
    setAuditContext(req, { resourceType: "backup", action: "restore" });
    const decision = await requirePermission({ req, resourceType: "backup", action: "restore" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    if (subject.spaceId && subject.spaceId !== params.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const body = z
      .object({
        backupArtifactId: z.string().min(3),
        mode: z.enum(["dry_run", "commit"]).optional(),
        conflictStrategy: z.enum(["fail", "upsert"]).optional(),
        schemaName: z.string().min(1).optional(),
      })
      .parse(req.body);

    const mode = body.mode ?? "dry_run";
    const schemaName = body.schemaName ?? "core";
    const schema = await getEffectiveSchema({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: schemaName });
    if (!schema) throw Errors.badRequest(`Schema 未发布：${schemaName}`);

    const artifact = await getArtifactContent(app.db, subject.tenantId, body.backupArtifactId);
    if (!artifact) throw Errors.badRequest("backupArtifactId 不存在");
    if (artifact.spaceId !== params.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    const raw = artifact.contentText ?? "";
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes > 2 * 1024 * 1024) throw Errors.badRequest("backupArtifactId 过大");

    const parseItems = () => {
      if (artifact.format === "json") return JSON.parse(raw || "[]") as any[];
      const lines = raw
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      return lines.map((l) => JSON.parse(l));
    };

    if (mode === "dry_run") {
      const lines = parseItems();
      let accepted = 0;
      let rejected = 0;
      let conflicts = 0;
      const reasons: Record<string, number> = {};

      for (const it of lines) {
        try {
          const entityName = String(it.entityName ?? "");
          if (!entityName || !schema.schema.entities?.[entityName]) throw new Error("entity_not_found");
          const payload = applyWriteFieldRules(it.payload ?? {}, decision);
          const v = validateEntityPayload({ schema: schema.schema, entityName, payload });
          if (!v.ok) throw new Error(v.reason);
          if (it.id) {
            const exists = await app.db.query(
              "SELECT 1 FROM entity_records WHERE tenant_id = $1 AND space_id = $2 AND id = $3 LIMIT 1",
              [subject.tenantId, params.spaceId, it.id],
            );
            if (exists.rowCount) conflicts += 1;
          }
          accepted += 1;
        } catch (e: any) {
          rejected += 1;
          const key = String(e?.message ?? e ?? "invalid");
          reasons[key] = (reasons[key] ?? 0) + 1;
        }
      }

      const conflictsDigest = crypto.createHash("sha256").update(JSON.stringify({ conflicts, reasons })).digest("hex");
      req.ctx.audit!.outputDigest = { mode, accepted, rejected, conflicts, conflictsDigest };
      return { mode, acceptedCount: accepted, rejectedCount: rejected, conflicts, conflictsDigest };
    }

    const runToolRef = `space.restore:${params.spaceId}`;
    const { job, run, step } = await createJobRunStepWithoutToolRef({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "space.restore",
      runToolRef,
      policySnapshotRef: decision.snapshotRef,
      input: {
        kind: "space.restore",
        spaceId: params.spaceId,
        schemaName,
        backupArtifactId: body.backupArtifactId,
        conflictStrategy: body.conflictStrategy ?? "fail",
        fieldRules: decision.fieldRules ?? null,
        rowFilters: decision.rowFilters ?? null,
        tenantId: subject.tenantId,
        subjectId: subject.subjectId,
        traceId: req.ctx.traceId,
      },
      createdBySubjectId: subject.subjectId,
      trigger: "manual",
    });

    await app.queue.add("step", { jobId: job.jobId, runId: run.runId, stepId: step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: run.runId, stepId: step.stepId }, status: "queued" as const };
    req.ctx.audit!.outputDigest = { mode, runId: run.runId, stepId: step.stepId, conflictStrategy: body.conflictStrategy ?? "fail" };
    return { receipt, runId: run.runId, stepId: step.stepId, jobId: job.jobId };
  });
};
