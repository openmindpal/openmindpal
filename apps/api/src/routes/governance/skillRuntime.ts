import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { sha256Hex } from "../../lib/digest";
import { createSkillRuntimeRunner, getSkillRuntimeRunner, listSkillRuntimeRunners, listSkillTrustedKeys, rotateSkillTrustedKey, setSkillRuntimeRunnerCapabilities, setSkillRuntimeRunnerEnabled, upsertSkillTrustedKey } from "../../modules/governance/skillRuntimeRepo";
import { decryptSecretPayload } from "../../modules/secrets/envelope";

export const governanceSkillRuntimeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/skill-runtime/runners", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.runner.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.read" });
    const items = await listSkillRuntimeRunners({ pool: app.db as any, tenantId: subject.tenantId });
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.post("/governance/skill-runtime/runners", async (req) => {
    const subject = req.ctx.subject!;
    const body = z
      .object({
        endpoint: z.string().url(),
        enabled: z.boolean().optional(),
        authSecretId: z.string().min(3).optional(),
        capabilities: z.any().optional(),
      })
      .parse(req.body ?? {});
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.runner.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.enable" });
    const runnerId = crypto.randomUUID();
    const created = await createSkillRuntimeRunner({
      pool: app.db as any,
      tenantId: subject.tenantId,
      runnerId,
      endpoint: body.endpoint,
      enabled: body.enabled ?? true,
      authSecretId: body.authSecretId ?? null,
      capabilities: body.capabilities ?? null,
    });
    req.ctx.audit!.outputDigest = { runnerId: created.runnerId, enabled: created.enabled };
    return { runner: created };
  });

  app.post("/governance/skill-runtime/runners/:runnerId/enable", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ runnerId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.runner.enable" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.enable" });
    const runner = await setSkillRuntimeRunnerEnabled({ pool: app.db as any, tenantId: subject.tenantId, runnerId: params.runnerId, enabled: true });
    if (!runner) throw Errors.notFound("runner");
    req.ctx.audit!.outputDigest = { runnerId: runner.runnerId, enabled: runner.enabled };
    return { runner };
  });

  app.post("/governance/skill-runtime/runners/:runnerId/disable", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ runnerId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.runner.disable" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.disable" });
    const runner = await setSkillRuntimeRunnerEnabled({ pool: app.db as any, tenantId: subject.tenantId, runnerId: params.runnerId, enabled: false });
    if (!runner) throw Errors.notFound("runner");
    req.ctx.audit!.outputDigest = { runnerId: runner.runnerId, enabled: runner.enabled };
    return { runner };
  });

  app.post("/governance/skill-runtime/runners/:runnerId/test", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ runnerId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.runner.test" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.read" });

    const runner = await getSkillRuntimeRunner({ pool: app.db as any, tenantId: subject.tenantId, runnerId: params.runnerId });
    if (!runner) throw Errors.notFound("runner");

    const baseUrl = (() => {
      try {
        const u = new URL(runner.endpoint);
        const p = u.pathname || "/";
        if (p.endsWith("/v1/execute")) {
          u.pathname = p.slice(0, -"/v1/execute".length) || "/";
        }
        if (u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1) || "/";
        return u.toString().replace(/\/$/, "");
      } catch {
        return runner.endpoint;
      }
    })();

    let bearerToken: string | null = null;
    if (runner.authSecretId) {
      const sr = await app.db.query(
        `
          SELECT scope_type, scope_id, status, key_version, enc_format, encrypted_payload
          FROM secret_records
          WHERE tenant_id = $1 AND id = $2
          LIMIT 1
        `,
        [subject.tenantId, runner.authSecretId],
      );
      if (sr.rowCount) {
        const row = sr.rows[0] as any;
        if (String(row.status) === "active") {
          const decrypted = await decryptSecretPayload({
            pool: app.db,
            tenantId: subject.tenantId,
            masterKey: app.cfg.secrets.masterKey,
            scopeType: String(row.scope_type),
            scopeId: String(row.scope_id),
            keyVersion: Number(row.key_version),
            encFormat: String(row.enc_format ?? "legacy.a256gcm"),
            encryptedPayload: row.encrypted_payload,
          });
          const obj = decrypted && typeof decrypted === "object" ? (decrypted as Record<string, unknown>) : {};
          const token = typeof obj.bearerToken === "string" ? obj.bearerToken : typeof obj.token === "string" ? obj.token : "";
          bearerToken = token || null;
        }
      }
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl}/healthz`, {
        method: "GET",
        headers: {
          ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
        },
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      const txt = await res.text().catch(() => "");
      const ok = res.ok;
      let capabilities: any = null;
      if (ok) {
        try {
          const capRes = await fetch(`${baseUrl}/v1/capabilities`, {
            method: "GET",
            headers: {
              ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
            },
            signal: controller.signal,
          });
          if (capRes.ok) {
            const capTxt = await capRes.text().catch(() => "");
            try {
              capabilities = capTxt ? JSON.parse(capTxt) : null;
            } catch {
              capabilities = null;
            }
            if (capabilities) {
              await setSkillRuntimeRunnerCapabilities({ pool: app.db as any, tenantId: subject.tenantId, runnerId: runner.runnerId, capabilities });
            }
          }
        } catch {
        }
      }
      req.ctx.audit!.outputDigest = { runnerId: runner.runnerId, ok, status: res.status, latencyMs, capabilitiesDigest8: capabilities ? sha256Hex(JSON.stringify(capabilities)).slice(0, 8) : null };
      return { ok, status: res.status, latencyMs, capabilities, bodyDigest: { sha256_8: sha256Hex(txt).slice(0, 8), length: txt.length } };
    } catch (e: any) {
      const latencyMs = Date.now() - startedAt;
      const msg = String(e?.message ?? e ?? "runner_unreachable");
      req.ctx.audit!.outputDigest = { runnerId: runner.runnerId, ok: false, error: msg, latencyMs };
      return { ok: false, status: 0, latencyMs, error: msg };
    } finally {
      clearTimeout(timeout);
    }
  });

  app.get("/governance/skill-runtime/trusted-keys", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.trusted_key.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.read" });
    const items = await listSkillTrustedKeys({ pool: app.db as any, tenantId: subject.tenantId });
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.post("/governance/skill-runtime/trusted-keys", async (req) => {
    const subject = req.ctx.subject!;
    const body = z
      .object({
        keyId: z.string().min(1).max(128),
        publicKeyPem: z.string().min(16),
        status: z.enum(["active", "disabled"]).optional(),
      })
      .parse(req.body ?? {});
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.trusted_key.upsert" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.enable" });
    const key = await upsertSkillTrustedKey({
      pool: app.db as any,
      tenantId: subject.tenantId,
      keyId: body.keyId,
      publicKeyPem: body.publicKeyPem,
      status: body.status ?? "active",
    });
    req.ctx.audit!.outputDigest = { keyId: key.keyId, status: key.status };
    return { key };
  });

  app.post("/governance/skill-runtime/trusted-keys/:keyId/rotate", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ keyId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "skill_runtime.trusted_key.rotate" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "tool.enable" });
    const key = await rotateSkillTrustedKey({ pool: app.db as any, tenantId: subject.tenantId, keyId: params.keyId });
    if (!key) throw Errors.notFound("key");
    req.ctx.audit!.outputDigest = { keyId: key.keyId, status: key.status, rotatedAt: key.rotatedAt };
    return { key };
  });
};

