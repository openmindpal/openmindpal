import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { buildEffectiveEntitySchema } from "../modules/metadata/effectiveSchema";
import { getEffectiveSchema, getSchemaEffectiveCacheVersion } from "../modules/metadata/schemaRepo";

type CacheKey = string;
const effectiveCache = new Map<CacheKey, unknown>();

export const effectiveSchemaRoutes: FastifyPluginAsync = async (app) => {
  app.get("/schemas/:entity/effective", async (req) => {
    const params = z.object({ entity: z.string() }).parse(req.params);
    const query = z.object({ schemaName: z.string().optional() }).parse(req.query);
    const schemaName = query.schemaName ?? "core";

    setAuditContext(req, { resourceType: "schema", action: "read" });
    await requirePermission({ req, resourceType: "schema", action: "read" });

    const decision = await requirePermission({ req, resourceType: "entity", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const schema = await getEffectiveSchema({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: schemaName });
    if (!schema) throw Errors.badRequest(`Schema 未发布：${schemaName}`);
    const schemaCacheVersion = getSchemaEffectiveCacheVersion({ tenantId: subject.tenantId, spaceId: subject.spaceId, name: schema.name });
    const policyRef = (decision as any).policyRef ?? null;
    const policyName = typeof policyRef?.name === "string" ? policyRef.name : "";
    const policyVersion = Number(policyRef?.version);
    const policyCacheEpoch = (decision as any).policyCacheEpoch ?? null;
    const policyEpochToken = (() => {
      if (policyCacheEpoch === null || policyCacheEpoch === undefined) return "";
      if (typeof policyCacheEpoch === "string" || typeof policyCacheEpoch === "number" || typeof policyCacheEpoch === "boolean") return String(policyCacheEpoch);
      try {
        return JSON.stringify(policyCacheEpoch, (_, v) => (typeof v === "bigint" ? v.toString() : v));
      } catch {
        return String(policyCacheEpoch);
      }
    })();
    const key = [
      subject.tenantId,
      subject.spaceId ?? "",
      subject.subjectId,
      schema.name,
      schema.version,
      `schemaCv:${schemaCacheVersion}`,
      params.entity,
      `policy:${policyName}@${Number.isFinite(policyVersion) ? policyVersion : ""}`,
      `policyEpoch:${policyEpochToken}`,
      `snapshot:${decision.snapshotRef ?? ""}`,
    ].join("|");

    const cached = effectiveCache.get(key);
    if (cached) return cached;

    const effective = buildEffectiveEntitySchema({
      schema: schema.schema,
      entityName: params.entity,
      decision,
    });
    if (!effective) throw Errors.badRequest(`实体不存在：${params.entity}`);

    effectiveCache.set(key, effective);
    return effective;
  });
};
