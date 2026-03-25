import type { Pool } from "pg";

export type ToolNetworkPolicy = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  toolRef: string;
  allowedDomains: string[];
  rules: Array<{ host: string; pathPrefix?: string; methods?: string[] }>;
  updatedAt: string;
};

function toRow(r: any): ToolNetworkPolicy {
  const allowedDomains = Array.isArray(r.allowed_domains) ? r.allowed_domains.filter((x: any) => typeof x === "string" && x.trim()) : [];
  const rulesRaw = Array.isArray(r.rules_json) ? r.rules_json : [];
  const rules = rulesRaw
    .filter((x: any) => x && typeof x === "object" && !Array.isArray(x))
    .map((x: any) => {
      const host = typeof x.host === "string" ? x.host.trim() : "";
      const pathPrefix0 = typeof x.pathPrefix === "string" ? x.pathPrefix.trim() : "";
      const pathPrefix = pathPrefix0 ? (pathPrefix0.startsWith("/") ? pathPrefix0 : `/${pathPrefix0}`) : undefined;
      const methods0 = Array.isArray(x.methods) ? x.methods.filter((m: any) => typeof m === "string" && m.trim()) : undefined;
      const methods = methods0?.length ? methods0.map((m: string) => m.trim().toUpperCase()) : undefined;
      return host ? { host, pathPrefix, methods } : null;
    })
    .filter(Boolean) as Array<{ host: string; pathPrefix?: string; methods?: string[] }>;
  return {
    tenantId: String(r.tenant_id),
    scopeType: String(r.scope_type) === "tenant" ? "tenant" : "space",
    scopeId: String(r.scope_id),
    toolRef: String(r.tool_ref),
    allowedDomains,
    rules,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function getToolNetworkPolicy(params: { pool: Pool; tenantId: string; scopeType: "tenant" | "space"; scopeId: string; toolRef: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM tool_network_policies
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND tool_ref = $4
      LIMIT 1
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.toolRef],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function getEffectiveToolNetworkPolicy(params: { pool: Pool; tenantId: string; spaceId?: string; toolRef: string }) {
  if (params.spaceId) {
    const space = await getToolNetworkPolicy({ pool: params.pool, tenantId: params.tenantId, scopeType: "space", scopeId: params.spaceId, toolRef: params.toolRef });
    if (space) return space;
  }
  const tenant = await getToolNetworkPolicy({ pool: params.pool, tenantId: params.tenantId, scopeType: "tenant", scopeId: params.tenantId, toolRef: params.toolRef });
  return tenant;
}

export async function upsertToolNetworkPolicy(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  toolRef: string;
  allowedDomains: string[];
  rules?: Array<{ host: string; pathPrefix?: string; methods?: string[] }>;
}) {
  const allowed = Array.isArray(params.allowedDomains) ? params.allowedDomains.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [];
  const rules = Array.isArray(params.rules)
    ? params.rules
        .filter((r) => r && typeof r === "object" && !Array.isArray(r))
        .map((r) => {
          const host = typeof (r as any).host === "string" ? String((r as any).host).trim() : "";
          const pathPrefix0 = typeof (r as any).pathPrefix === "string" ? String((r as any).pathPrefix).trim() : "";
          const pathPrefix = pathPrefix0 ? (pathPrefix0.startsWith("/") ? pathPrefix0 : `/${pathPrefix0}`) : null;
          const methods0 = Array.isArray((r as any).methods) ? (r as any).methods : null;
          const methods = methods0 ? methods0.map((m: any) => String(m).trim().toUpperCase()).filter(Boolean) : null;
          if (!host) return null;
          return { host, pathPrefix, methods };
        })
        .filter(Boolean)
    : [];
  await params.pool.query(
    `
      INSERT INTO tool_network_policies (tenant_id, scope_type, scope_id, tool_ref, allowed_domains, rules_json)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, scope_type, scope_id, tool_ref) DO UPDATE
      SET allowed_domains = EXCLUDED.allowed_domains,
          rules_json = EXCLUDED.rules_json,
          updated_at = now()
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.toolRef, JSON.stringify(allowed), JSON.stringify(rules)],
  );
  return { ok: true as const };
}

export async function listToolNetworkPolicies(params: { pool: Pool; tenantId: string; scopeType: "tenant" | "space"; scopeId: string; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM tool_network_policies
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3
      ORDER BY updated_at DESC, tool_ref ASC
      LIMIT $4
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.limit],
  );
  return res.rows.map(toRow);
}
