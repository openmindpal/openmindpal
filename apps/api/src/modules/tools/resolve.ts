import type { Pool } from "pg";
import { getActiveToolOverride, getActiveToolRef } from "../governance/toolGovernanceRepo";
import { getLatestReleasedToolVersion } from "./toolRepo";

export async function resolveEffectiveToolRef(params: { pool: Pool; tenantId: string; spaceId?: string | null; name: string }) {
  if (params.spaceId) {
    const o = await getActiveToolOverride({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, name: params.name });
    if (o?.activeToolRef) return o.activeToolRef;
  }
  const a = await getActiveToolRef({ pool: params.pool, tenantId: params.tenantId, name: params.name });
  if (a?.activeToolRef) return a.activeToolRef;
  const latest = await getLatestReleasedToolVersion(params.pool, params.tenantId, params.name);
  return latest?.toolRef ?? null;
}

