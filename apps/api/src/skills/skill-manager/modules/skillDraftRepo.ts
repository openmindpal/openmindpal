/**
 * Skill Draft Repository
 *
 * 存储和管理用户生成的Skill草稿
 */
import type { Pool, PoolClient } from "pg";

type Q = Pool | PoolClient;

export interface SkillDraftRow {
  draftId: string;
  tenantId: string;
  skillName: string;
  description: string;
  manifest: object;
  indexCode: string;
  routesCode: string;
  status: "draft" | "reviewing" | "approved" | "rejected" | "published";
  createdBy: string;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDraftRow(r: any): SkillDraftRow {
  return {
    draftId: r.draft_id,
    tenantId: r.tenant_id,
    skillName: r.skill_name,
    description: r.description ?? "",
    manifest: r.manifest ?? {},
    indexCode: r.index_code ?? "",
    routesCode: r.routes_code ?? "",
    status: r.status ?? "draft",
    createdBy: r.created_by,
    approvedBy: r.approved_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 创建Skill草稿
 */
export async function createSkillDraft(params: {
  pool: Q;
  tenantId: string;
  skillName: string;
  description: string;
  manifest: object;
  indexCode: string;
  routesCode: string;
  createdBy: string;
}): Promise<SkillDraftRow> {
  const res = await params.pool.query(
    `INSERT INTO skill_drafts (tenant_id, skill_name, description, manifest, index_code, routes_code, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7)
     RETURNING *`,
    [
      params.tenantId,
      params.skillName,
      params.description,
      JSON.stringify(params.manifest),
      params.indexCode,
      params.routesCode,
      params.createdBy,
    ],
  );
  return toDraftRow(res.rows[0]);
}

/**
 * 获取Skill草稿
 */
export async function getSkillDraft(params: {
  pool: Q;
  tenantId: string;
  draftId: string;
}): Promise<SkillDraftRow | null> {
  const res = await params.pool.query(
    "SELECT * FROM skill_drafts WHERE tenant_id = $1 AND draft_id = $2 LIMIT 1",
    [params.tenantId, params.draftId],
  );
  if (res.rowCount === 0) return null;
  return toDraftRow(res.rows[0]);
}

/**
 * 列出用户的Skill草稿
 */
export async function listSkillDrafts(params: {
  pool: Q;
  tenantId: string;
  createdBy?: string;
  status?: string;
  limit?: number;
}): Promise<SkillDraftRow[]> {
  const args: any[] = [params.tenantId];
  let where = "tenant_id = $1";

  if (params.createdBy) {
    args.push(params.createdBy);
    where += ` AND created_by = $${args.length}`;
  }
  if (params.status) {
    args.push(params.status);
    where += ` AND status = $${args.length}`;
  }

  const limit = Math.min(params.limit ?? 50, 200);
  args.push(limit);

  const res = await params.pool.query(
    `SELECT * FROM skill_drafts WHERE ${where} ORDER BY updated_at DESC LIMIT $${args.length}`,
    args,
  );
  return res.rows.map(toDraftRow);
}

/**
 * 更新Skill草稿代码
 */
export async function updateSkillDraftCode(params: {
  pool: Q;
  tenantId: string;
  draftId: string;
  indexCode?: string;
  routesCode?: string;
  manifest?: object;
}): Promise<SkillDraftRow | null> {
  const updates: string[] = ["updated_at = now()"];
  const args: any[] = [params.tenantId, params.draftId];

  if (params.indexCode !== undefined) {
    args.push(params.indexCode);
    updates.push(`index_code = $${args.length}`);
  }
  if (params.routesCode !== undefined) {
    args.push(params.routesCode);
    updates.push(`routes_code = $${args.length}`);
  }
  if (params.manifest !== undefined) {
    args.push(JSON.stringify(params.manifest));
    updates.push(`manifest = $${args.length}`);
  }

  const res = await params.pool.query(
    `UPDATE skill_drafts SET ${updates.join(", ")} WHERE tenant_id = $1 AND draft_id = $2 RETURNING *`,
    args,
  );
  if (res.rowCount === 0) return null;
  return toDraftRow(res.rows[0]);
}

/**
 * 更新Skill草稿状态
 */
export async function updateSkillDraftStatus(params: {
  pool: Q;
  tenantId: string;
  draftId: string;
  status: "draft" | "reviewing" | "approved" | "rejected" | "published";
  approvedBy?: string;
}): Promise<SkillDraftRow | null> {
  const args: any[] = [params.tenantId, params.draftId, params.status];
  let sql = "UPDATE skill_drafts SET status = $3, updated_at = now()";

  if (params.approvedBy) {
    args.push(params.approvedBy);
    sql += `, approved_by = $${args.length}`;
  }

  sql += " WHERE tenant_id = $1 AND draft_id = $2 RETURNING *";

  const res = await params.pool.query(sql, args);
  if (res.rowCount === 0) return null;
  return toDraftRow(res.rows[0]);
}

/**
 * 删除Skill草稿
 */
export async function deleteSkillDraft(params: {
  pool: Q;
  tenantId: string;
  draftId: string;
}): Promise<boolean> {
  const res = await params.pool.query(
    "DELETE FROM skill_drafts WHERE tenant_id = $1 AND draft_id = $2",
    [params.tenantId, params.draftId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 按技能名称查找草稿
 */
export async function getSkillDraftByName(params: {
  pool: Q;
  tenantId: string;
  skillName: string;
}): Promise<SkillDraftRow | null> {
  const res = await params.pool.query(
    "SELECT * FROM skill_drafts WHERE tenant_id = $1 AND skill_name = $2 ORDER BY updated_at DESC LIMIT 1",
    [params.tenantId, params.skillName],
  );
  if (res.rowCount === 0) return null;
  return toDraftRow(res.rows[0]);
}
