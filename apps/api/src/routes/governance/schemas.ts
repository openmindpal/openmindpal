import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { createSchemaMigration, createSchemaMigrationRun, getSchemaMigrationRun, listSchemaMigrations, setSchemaMigrationRunCanceled, setSchemaMigrationStatus } from "../../modules/metadata/schemaMigrationRepo";
import { createJobRunStepWithoutToolRef } from "../../modules/workflow/jobRepo";
import { SUPPORTED_SCHEMA_MIGRATION_KINDS } from "@openslin/shared";

export const governanceSchemasRoutes: FastifyPluginAsync = async (app) => {
  app.post("/governance/schemas/:name/set-active", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        version: z.number().int().positive(),
        scopeType: z.enum(["tenant", "space"]).optional(),
      })
      .parse(req.body ?? {});
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "schema.set_active" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "schema.set_active" });
    const scopeType = body.scopeType ?? "tenant";
    req.ctx.audit!.inputDigest = { name: params.name, version: body.version, scopeType, requestedBy: subject.subjectId };
    req.ctx.audit!.outputDigest = { ok: false, requiredFlow: "changeset.release", supportedKind: "schema.set_active" };
    throw Errors.schemaChangesetRequired("set_active");
  });

  app.post("/governance/schemas/:name/rollback", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        scopeType: z.enum(["tenant", "space"]).optional(),
      })
      .parse(req.body ?? {});
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "schema.rollback" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "schema.rollback" });
    const scopeType = body.scopeType ?? "tenant";
    req.ctx.audit!.inputDigest = { name: params.name, scopeType, requestedBy: subject.subjectId };
    req.ctx.audit!.outputDigest = { ok: false, requiredFlow: "changeset.release", supportedKind: "schema.rollback" };
    throw Errors.schemaChangesetRequired("rollback");
  });

  app.post("/governance/schema-migrations", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "schema.migration.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "schema.migration.write" });
    req.ctx.audit!.policyDecision = decision;

    const body = z
      .object({
        scopeType: z.enum(["tenant", "space"]),
        scopeId: z.string().min(1),
        schemaName: z.string().min(1),
        targetVersion: z.number().int().positive(),
        kind: z.enum(SUPPORTED_SCHEMA_MIGRATION_KINDS),
        plan: z.any(),
      })
      .parse(req.body);

    if (body.scopeType === "tenant" && body.scopeId !== subject.tenantId) throw Errors.forbidden();
    if (body.scopeType === "space") {
      const spaceRes = await app.db.query("SELECT tenant_id FROM spaces WHERE id = $1 LIMIT 1", [body.scopeId]);
      if (!spaceRes.rowCount) throw Errors.badRequest("Space 不存在");
      if (String(spaceRes.rows[0].tenant_id) !== subject.tenantId) throw Errors.forbidden();
    }

    const mig = await createSchemaMigration({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType: body.scopeType,
      scopeId: body.scopeId,
      schemaName: body.schemaName,
      targetVersion: body.targetVersion,
      kind: body.kind,
      plan: body.plan,
      createdBySubjectId: subject.subjectId,
    });

    const runToolRef = `schema.migration:${mig.schemaName}:${mig.migrationId}`;
    const { job, run, step } = await createJobRunStepWithoutToolRef({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "schema.migration",
      runToolRef,
      policySnapshotRef: decision.snapshotRef,
      input: {
        kind: "schema.migration",
        migrationId: mig.migrationId,
        tenantId: subject.tenantId,
        scopeType: mig.scopeType,
        scopeId: mig.scopeId,
        schemaName: mig.schemaName,
        targetVersion: mig.targetVersion,
        traceId: req.ctx.traceId,
        subjectId: subject.subjectId,
      },
      createdBySubjectId: subject.subjectId,
      trigger: "manual",
    });

    const migRun = await createSchemaMigrationRun({
      pool: app.db,
      tenantId: subject.tenantId,
      migrationId: mig.migrationId,
      jobId: job.jobId,
      runId: run.runId,
      stepId: step.stepId,
    });

    await setSchemaMigrationStatus({ pool: app.db, tenantId: subject.tenantId, migrationId: mig.migrationId, status: "queued" });
    await app.queue.add("step", { jobId: job.jobId, runId: run.runId, stepId: step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });

    req.ctx.audit!.outputDigest = { migrationId: mig.migrationId, migrationRunId: migRun.migrationRunId, jobId: job.jobId, runId: run.runId, stepId: step.stepId, kind: mig.kind };
    return { migration: mig, migrationRun: migRun, receipt: { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: run.runId, stepId: step.stepId }, status: "queued" as const } };
  });

  app.get("/governance/schema-migrations", async (req) => {
    const subject = req.ctx.subject!;
    const q = z.object({ schemaName: z.string().min(1).optional(), limit: z.coerce.number().int().positive().max(200).optional() }).parse(req.query);
    setAuditContext(req, { resourceType: "governance", action: "schema.migration.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "schema.migration.read" });
    const items = await listSchemaMigrations({ pool: app.db, tenantId: subject.tenantId, schemaName: q.schemaName, limit: q.limit ?? 50 });
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.get("/governance/schema-migration-runs/:id", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "schema.migration.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "schema.migration.read" });
    const run = await getSchemaMigrationRun({ pool: app.db, tenantId: subject.tenantId, migrationRunId: params.id });
    if (!run) throw Errors.notFound("migrationRun");
    req.ctx.audit!.outputDigest = { migrationRunId: run.migrationRunId, status: run.status };
    return { run };
  });

  app.post("/governance/schema-migration-runs/:id/cancel", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "schema.migration.write" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "schema.migration.write" });
    const run = await getSchemaMigrationRun({ pool: app.db, tenantId: subject.tenantId, migrationRunId: params.id });
    if (!run) throw Errors.notFound("migrationRun");
    const updated = await setSchemaMigrationRunCanceled({ pool: app.db, tenantId: subject.tenantId, migrationRunId: params.id });
    await setSchemaMigrationStatus({ pool: app.db, tenantId: subject.tenantId, migrationId: run.migrationId, status: "canceled" });
    req.ctx.audit!.outputDigest = { migrationRunId: params.id, canceled: true };
    return { run: updated };
  });
};

