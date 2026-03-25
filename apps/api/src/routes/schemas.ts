import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { enqueueAuditOutboxForRequest } from "../modules/audit/requestOutbox";
import { checkSchemaCompatibility } from "../modules/metadata/compat";
import { ensureSchemaI18nFallback } from "../modules/metadata/i18n";
import { schemaDefSchema } from "../modules/metadata/schemaModel";
import {
  getByNameVersion,
  getEffectiveSchema,
  listLatestReleased,
  listVersionsByName,
  publishNewReleased,
  setActiveSchemaVersion,
  validateSchemaExtensionNamespaces,
} from "../modules/metadata/schemaRepo";

export const schemaRoutes: FastifyPluginAsync = async (app) => {
  app.get("/schemas", async (req) => {
    setAuditContext(req, { resourceType: "schema", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "schema", action: "read" });
    const list = await listLatestReleased(app.db);
    return { schemas: list };
  });

  app.get("/schemas/:name/latest", async (req, reply) => {
    setAuditContext(req, { resourceType: "schema", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "schema", action: "read" });
    const params = z.object({ name: z.string() }).parse(req.params);
    const subject = req.ctx.subject!;
    const schema = await getEffectiveSchema({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: params.name });
    if (!schema) return reply.status(404).send({ errorCode: "SCHEMA_NOT_FOUND", message: { "zh-CN": "Schema 不存在", "en-US": "Schema not found" }, traceId: req.ctx.traceId });
    return schema;
  });

  app.get("/schemas/:name/:version", async (req, reply) => {
    setAuditContext(req, { resourceType: "schema", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "schema", action: "read" });
    const params = z.object({ name: z.string(), version: z.coerce.number().int().positive() }).parse(req.params);
    const schema = await getByNameVersion(app.db, params.name, params.version);
    if (!schema) return reply.status(404).send({ errorCode: "SCHEMA_NOT_FOUND", message: { "zh-CN": "Schema 不存在", "en-US": "Schema not found" }, traceId: req.ctx.traceId });
    return schema;
  });

  app.get("/schemas/:name/versions", async (req) => {
    setAuditContext(req, { resourceType: "schema", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "schema", action: "read" });
    const params = z.object({ name: z.string() }).parse(req.params);
    const q = req.query as any;
    const limit = z.coerce.number().int().positive().max(200).optional().parse(q?.limit) ?? 50;
    const versions = await listVersionsByName({ pool: app.db, name: params.name, limit });
    req.ctx.audit!.outputDigest = { name: params.name, count: versions.length };
    return { versions };
  });

  app.post("/schemas/:name/publish", async (req, reply) => {
    setAuditContext(req, { resourceType: "schema", action: "publish", requireOutbox: true });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "schema", action: "publish" });
    const params = z.object({ name: z.string() }).parse(req.params);
    schemaDefSchema.parse(req.body);
    const body = req.body as any;
    if (body.name !== params.name) throw Errors.badRequest("name 不一致");
    const nsValidation = validateSchemaExtensionNamespaces(body);
    if (!nsValidation.ok) throw Errors.badRequest(`扩展命名空间校验失败：${nsValidation.reason}`);

    ensureSchemaI18nFallback(body);

    const subject = req.ctx.subject!;
    const prev = await getEffectiveSchema({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: body.name });
    const compat = checkSchemaCompatibility(prev?.schema ?? null, body);
    if (!compat.ok) throw Errors.badRequest(`兼容性检查失败[${compat.code}]：${compat.reason}`);

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const stored = await publishNewReleased(client, body);
      await setActiveSchemaVersion({ pool: client, tenantId: subject.tenantId, name: stored.name, version: stored.version });
      req.ctx.audit!.outputDigest = { name: stored.name, version: stored.version };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      reply.header("x-openslin-deprecated", "use-governance-changeset");
      reply.header("x-openslin-deprecation-doc", "/governance/changesets");
      return stored;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      const msg = String((e as any)?.message ?? "");
      if (msg.startsWith("schema_extension_namespace_invalid:")) {
        throw Errors.badRequest(`扩展命名空间校验失败：${msg.slice("schema_extension_namespace_invalid:".length)}`);
      }
      throw Errors.auditOutboxWriteFailed();
    } finally {
      client.release();
    }
  });
};
