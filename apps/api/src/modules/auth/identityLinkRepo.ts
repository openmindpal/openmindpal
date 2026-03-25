import type { Pool, PoolClient } from "pg";

// ─── Types ──────────────────────────────────────────────────────────────────

export type IdentityLinkRow = {
  linkId: string;
  tenantId: string;
  primarySubjectId: string;
  linkedSubjectId: string;
  identityLabel: string;
  providerType: string | null;
  providerRef: string | null;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
};

type Q = Pool | PoolClient;

function toLink(r: any): IdentityLinkRow {
  return {
    linkId: r.link_id,
    tenantId: r.tenant_id,
    primarySubjectId: r.primary_subject_id,
    linkedSubjectId: r.linked_subject_id,
    identityLabel: r.identity_label ?? "default",
    providerType: r.provider_type ?? null,
    providerRef: r.provider_ref ?? null,
    status: r.status === "disabled" ? "disabled" : "active",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function createIdentityLink(params: {
  pool: Q;
  tenantId: string;
  primarySubjectId: string;
  linkedSubjectId: string;
  identityLabel?: string;
  providerType?: string;
  providerRef?: string;
}): Promise<IdentityLinkRow> {
  const res = await params.pool.query(
    `INSERT INTO subject_identity_links (tenant_id, primary_subject_id, linked_subject_id, identity_label, provider_type, provider_ref)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, primary_subject_id, linked_subject_id)
     DO UPDATE SET identity_label = COALESCE(EXCLUDED.identity_label, subject_identity_links.identity_label),
                   provider_type = COALESCE(EXCLUDED.provider_type, subject_identity_links.provider_type),
                   provider_ref = COALESCE(EXCLUDED.provider_ref, subject_identity_links.provider_ref),
                   status = 'active',
                   updated_at = now()
     RETURNING *`,
    [
      params.tenantId,
      params.primarySubjectId,
      params.linkedSubjectId,
      params.identityLabel ?? "default",
      params.providerType ?? null,
      params.providerRef ?? null,
    ],
  );
  return toLink(res.rows[0]);
}

export async function listIdentityLinks(params: {
  pool: Q;
  tenantId: string;
  primarySubjectId: string;
  status?: "active" | "disabled";
}): Promise<IdentityLinkRow[]> {
  const args: any[] = [params.tenantId, params.primarySubjectId];
  let where = "tenant_id=$1 AND primary_subject_id=$2";
  if (params.status) {
    args.push(params.status);
    where += ` AND status=$${args.length}`;
  }
  const res = await params.pool.query(
    `SELECT * FROM subject_identity_links WHERE ${where} ORDER BY created_at ASC`,
    args,
  );
  return res.rows.map(toLink);
}

export async function getIdentityLink(params: {
  pool: Q;
  tenantId: string;
  linkId: string;
}): Promise<IdentityLinkRow | null> {
  const res = await params.pool.query(
    "SELECT * FROM subject_identity_links WHERE tenant_id=$1 AND link_id=$2 LIMIT 1",
    [params.tenantId, params.linkId],
  );
  if (!res.rowCount) return null;
  return toLink(res.rows[0]);
}

export async function getLinkedSubjectIds(params: {
  pool: Q;
  tenantId: string;
  primarySubjectId: string;
}): Promise<string[]> {
  const res = await params.pool.query(
    "SELECT linked_subject_id FROM subject_identity_links WHERE tenant_id=$1 AND primary_subject_id=$2 AND status='active'",
    [params.tenantId, params.primarySubjectId],
  );
  return res.rows.map((r: any) => String(r.linked_subject_id));
}

export async function findPrimarySubjectId(params: {
  pool: Q;
  tenantId: string;
  linkedSubjectId: string;
}): Promise<string | null> {
  const res = await params.pool.query(
    "SELECT primary_subject_id FROM subject_identity_links WHERE tenant_id=$1 AND linked_subject_id=$2 AND status='active' LIMIT 1",
    [params.tenantId, params.linkedSubjectId],
  );
  if (!res.rowCount) return null;
  return String(res.rows[0].primary_subject_id);
}

export async function disableIdentityLink(params: {
  pool: Q;
  tenantId: string;
  linkId: string;
}): Promise<IdentityLinkRow | null> {
  const res = await params.pool.query(
    "UPDATE subject_identity_links SET status='disabled', updated_at=now() WHERE tenant_id=$1 AND link_id=$2 RETURNING *",
    [params.tenantId, params.linkId],
  );
  if (!res.rowCount) return null;
  return toLink(res.rows[0]);
}

export async function deleteIdentityLink(params: {
  pool: Q;
  tenantId: string;
  linkId: string;
}): Promise<boolean> {
  const res = await params.pool.query(
    "DELETE FROM subject_identity_links WHERE tenant_id=$1 AND link_id=$2",
    [params.tenantId, params.linkId],
  );
  return Boolean(res.rowCount);
}

/**
 * Switch identity: validate that `targetSubjectId` is linked to `currentSubjectId`,
 * returning the target subject ID if allowed.
 */
export async function switchIdentity(params: {
  pool: Q;
  tenantId: string;
  currentSubjectId: string;
  targetSubjectId: string;
}): Promise<{ allowed: boolean; targetSubjectId: string }> {
  // Check if current is primary and target is linked
  const forwardRes = await params.pool.query(
    `SELECT link_id FROM subject_identity_links
     WHERE tenant_id=$1 AND primary_subject_id=$2 AND linked_subject_id=$3 AND status='active'
     LIMIT 1`,
    [params.tenantId, params.currentSubjectId, params.targetSubjectId],
  );
  if (forwardRes.rowCount) return { allowed: true, targetSubjectId: params.targetSubjectId };

  // Check if current is linked and target is its primary
  const reverseRes = await params.pool.query(
    `SELECT link_id FROM subject_identity_links
     WHERE tenant_id=$1 AND primary_subject_id=$3 AND linked_subject_id=$2 AND status='active'
     LIMIT 1`,
    [params.tenantId, params.currentSubjectId, params.targetSubjectId],
  );
  if (reverseRes.rowCount) return { allowed: true, targetSubjectId: params.targetSubjectId };

  // Check if they share the same primary
  const myPrimary = await findPrimarySubjectId({ pool: params.pool, tenantId: params.tenantId, linkedSubjectId: params.currentSubjectId });
  if (myPrimary) {
    const siblingRes = await params.pool.query(
      `SELECT link_id FROM subject_identity_links
       WHERE tenant_id=$1 AND primary_subject_id=$2 AND linked_subject_id=$3 AND status='active'
       LIMIT 1`,
      [params.tenantId, myPrimary, params.targetSubjectId],
    );
    if (siblingRes.rowCount) return { allowed: true, targetSubjectId: params.targetSubjectId };
    // Also allow switching to the primary itself
    if (myPrimary === params.targetSubjectId) return { allowed: true, targetSubjectId: params.targetSubjectId };
  }

  return { allowed: false, targetSubjectId: params.targetSubjectId };
}
