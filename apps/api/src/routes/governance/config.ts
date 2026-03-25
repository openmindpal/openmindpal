/**
 * governance/config.ts — runtime 配置治理 API 路由
 *
 * 端点：
 * - GET    /governance/config/registry     — 查看可配置项注册表
 * - GET    /governance/config/overrides    — 列出当前 governance 覆盖
 * - GET    /governance/config/resolved     — 解析所有 runtime 配置有效值
 * - GET    /governance/config/resolve/:key — 解析单个配置有效值
 * - PUT    /governance/config/overrides/:key — 设置覆盖
 * - DELETE /governance/config/overrides/:key — 删除覆盖
 * - GET    /governance/config/audit-log    — 查询变更审计日志
 */

import type { FastifyPluginAsync } from "fastify";
import {
  getRegistryInfo,
  listConfigOverrides,
  setConfigOverride,
  deleteConfigOverride,
  resolveConfig,
  resolveAllConfigs,
  getConfigChangeAuditLog,
} from "../../modules/governance/configGovernanceRepo";

export const governanceConfigRoutes: FastifyPluginAsync = async (app) => {
  // -----------------------------------------------------------------------
  // 注册表查询（所有 runtime-mutable 配置元信息）
  // -----------------------------------------------------------------------
  app.get("/governance/config/registry", async (req, reply) => {
    const items = getRegistryInfo();
    return reply.send({ items, total: items.length });
  });

  // -----------------------------------------------------------------------
  // 列出 governance 覆盖
  // -----------------------------------------------------------------------
  app.get("/governance/config/overrides", async (req, reply) => {
    const subject = (req as any).subject ?? {};
    const tenantId = String(subject.tenantId ?? "");
    if (!tenantId) return reply.status(400).send({ error: "missing_tenant_id" });

    const pool = (req.server as any).pg;
    const overrides = await listConfigOverrides({ pool, tenantId });
    return reply.send({ items: overrides, total: overrides.length });
  });

  // -----------------------------------------------------------------------
  // 解析所有 runtime 配置有效值
  // -----------------------------------------------------------------------
  app.get("/governance/config/resolved", async (req, reply) => {
    const subject = (req as any).subject ?? {};
    const tenantId = String(subject.tenantId ?? "");
    if (!tenantId) return reply.status(400).send({ error: "missing_tenant_id" });

    const pool = (req.server as any).pg;
    const resolved = await resolveAllConfigs({ pool, tenantId });
    const items = Array.from(resolved.values()).map((r) => ({
      envKey: r.envKey,
      value: r.value,
      source: r.source,
    }));
    return reply.send({ items, total: items.length });
  });

  // -----------------------------------------------------------------------
  // 解析单个配置
  // -----------------------------------------------------------------------
  app.get("/governance/config/resolve/:key", async (req, reply) => {
    const subject = (req as any).subject ?? {};
    const tenantId = String(subject.tenantId ?? "");
    if (!tenantId) return reply.status(400).send({ error: "missing_tenant_id" });

    const configKey = String((req.params as any).key ?? "");
    if (!configKey) return reply.status(400).send({ error: "missing_config_key" });

    const pool = (req.server as any).pg;
    const resolved = await resolveConfig({ pool, tenantId, configKey });
    return reply.send(resolved);
  });

  // -----------------------------------------------------------------------
  // 设置覆盖
  // -----------------------------------------------------------------------
  app.put("/governance/config/overrides/:key", async (req, reply) => {
    const subject = (req as any).subject ?? {};
    const tenantId = String(subject.tenantId ?? "");
    if (!tenantId) return reply.status(400).send({ error: "missing_tenant_id" });

    const configKey = String((req.params as any).key ?? "");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const configValue = String(body.value ?? "");
    const description = String(body.description ?? "");

    if (!configKey) return reply.status(400).send({ error: "missing_config_key" });

    const pool = (req.server as any).pg;
    try {
      const result = await setConfigOverride({
        pool,
        tenantId,
        configKey,
        configValue,
        description,
        changedBy: String(subject.subjectId ?? ""),
      });
      return reply.send(result);
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      if (msg.startsWith("config_not_registered:") || msg.startsWith("config_not_runtime_mutable:") || msg.startsWith("config_validation_failed:")) {
        return reply.status(400).send({ error: msg });
      }
      throw err;
    }
  });

  // -----------------------------------------------------------------------
  // 删除覆盖
  // -----------------------------------------------------------------------
  app.delete("/governance/config/overrides/:key", async (req, reply) => {
    const subject = (req as any).subject ?? {};
    const tenantId = String(subject.tenantId ?? "");
    if (!tenantId) return reply.status(400).send({ error: "missing_tenant_id" });

    const configKey = String((req.params as any).key ?? "");
    if (!configKey) return reply.status(400).send({ error: "missing_config_key" });

    const pool = (req.server as any).pg;
    const result = await deleteConfigOverride({
      pool,
      tenantId,
      configKey,
      changedBy: String(subject.subjectId ?? ""),
    });
    return reply.send(result);
  });

  // -----------------------------------------------------------------------
  // 变更审计日志
  // -----------------------------------------------------------------------
  app.get("/governance/config/audit-log", async (req, reply) => {
    const subject = (req as any).subject ?? {};
    const tenantId = String(subject.tenantId ?? "");
    if (!tenantId) return reply.status(400).send({ error: "missing_tenant_id" });

    const query = (req.query ?? {}) as Record<string, unknown>;
    const configKey = query.configKey ? String(query.configKey) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;

    const pool = (req.server as any).pg;
    const items = await getConfigChangeAuditLog({ pool, tenantId, configKey, limit });
    return reply.send({ items, total: items.length });
  });
};
