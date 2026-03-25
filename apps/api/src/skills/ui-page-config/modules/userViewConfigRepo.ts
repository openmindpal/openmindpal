import type { Pool, PoolClient } from "pg";

// ─── Types ──────────────────────────────────────────────────────────────────

export type UserViewConfigRow = {
  configId: string;
  tenantId: string;
  subjectId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  targetType: string;
  targetId: string;
  variant: "desktop" | "mobile";
  layout: any | null;
  visibleFields: any | null;
  sortConfig: any | null;
  filterConfig: any | null;
  shortcuts: any | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DashboardShortcutRow = {
  shortcutId: string;
  tenantId: string;
  subjectId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  targetType: string;
  targetId: string;
  displayName: any | null;
  icon: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type Q = Pool | PoolClient;

// ─── Mappers ────────────────────────────────────────────────────────────────

function toViewConfig(r: any): UserViewConfigRow {
  return {
    configId: r.config_id,
    tenantId: r.tenant_id,
    subjectId: r.subject_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    targetType: r.target_type,
    targetId: r.target_id,
    variant: r.variant === "mobile" ? "mobile" : "desktop",
    layout: r.layout ?? null,
    visibleFields: r.visible_fields ?? null,
    sortConfig: r.sort_config ?? null,
    filterConfig: r.filter_config ?? null,
    shortcuts: r.shortcuts ?? null,
    version: Number(r.version ?? 1),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toShortcut(r: any): DashboardShortcutRow {
  return {
    shortcutId: r.shortcut_id,
    tenantId: r.tenant_id,
    subjectId: r.subject_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    targetType: r.target_type,
    targetId: r.target_id,
    displayName: r.display_name ?? null,
    icon: r.icon ?? null,
    sortOrder: Number(r.sort_order ?? 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─── UserViewConfig CRUD ────────────────────────────────────────────────────

export async function upsertUserViewConfig(params: {
  pool: Q;
  tenantId: string;
  subjectId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  targetType: string;
  targetId: string;
  variant: "desktop" | "mobile";
  layout?: any;
  visibleFields?: any;
  sortConfig?: any;
  filterConfig?: any;
  shortcuts?: any;
}): Promise<UserViewConfigRow> {
  const res = await params.pool.query(
    `
      INSERT INTO user_view_configs (tenant_id, subject_id, scope_type, scope_id, target_type, target_id, variant, layout, visible_fields, sort_config, filter_config, shortcuts)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (tenant_id, subject_id, scope_type, scope_id, target_type, target_id, variant)
      DO UPDATE SET
        layout = COALESCE(EXCLUDED.layout, user_view_configs.layout),
        visible_fields = COALESCE(EXCLUDED.visible_fields, user_view_configs.visible_fields),
        sort_config = COALESCE(EXCLUDED.sort_config, user_view_configs.sort_config),
        filter_config = COALESCE(EXCLUDED.filter_config, user_view_configs.filter_config),
        shortcuts = COALESCE(EXCLUDED.shortcuts, user_view_configs.shortcuts),
        version = user_view_configs.version + 1,
        updated_at = now()
      RETURNING *
    `,
    [
      params.tenantId,
      params.subjectId,
      params.scopeType,
      params.scopeId,
      params.targetType,
      params.targetId,
      params.variant,
      params.layout ? JSON.stringify(params.layout) : null,
      params.visibleFields ? JSON.stringify(params.visibleFields) : null,
      params.sortConfig ? JSON.stringify(params.sortConfig) : null,
      params.filterConfig ? JSON.stringify(params.filterConfig) : null,
      params.shortcuts ? JSON.stringify(params.shortcuts) : null,
    ],
  );
  return toViewConfig(res.rows[0]);
}

export async function getUserViewConfig(params: {
  pool: Q;
  tenantId: string;
  subjectId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  targetType: string;
  targetId: string;
  variant: "desktop" | "mobile";
}): Promise<UserViewConfigRow | null> {
  const res = await params.pool.query(
    `SELECT * FROM user_view_configs
     WHERE tenant_id=$1 AND subject_id=$2 AND scope_type=$3 AND scope_id=$4 AND target_type=$5 AND target_id=$6 AND variant=$7
     LIMIT 1`,
    [params.tenantId, params.subjectId, params.scopeType, params.scopeId, params.targetType, params.targetId, params.variant],
  );
  if (!res.rowCount) return null;
  return toViewConfig(res.rows[0]);
}

export async function listUserViewConfigs(params: {
  pool: Q;
  tenantId: string;
  subjectId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  targetType?: string;
}): Promise<UserViewConfigRow[]> {
  const args: any[] = [params.tenantId, params.subjectId, params.scopeType, params.scopeId];
  let where = "tenant_id=$1 AND subject_id=$2 AND scope_type=$3 AND scope_id=$4";
  if (params.targetType) {
    args.push(params.targetType);
    where += ` AND target_type=$${args.length}`;
  }
  const res = await params.pool.query(`SELECT * FROM user_view_configs WHERE ${where} ORDER BY updated_at DESC`, args);
  return res.rows.map(toViewConfig);
}

export async function deleteUserViewConfig(params: {
  pool: Q;
  tenantId: string;
  subjectId: string;
  configId: string;
}): Promise<boolean> {
  const res = await params.pool.query(
    "DELETE FROM user_view_configs WHERE tenant_id=$1 AND subject_id=$2 AND config_id=$3",
    [params.tenantId, params.subjectId, params.configId],
  );
  return Boolean(res.rowCount);
}

// ─── Dashboard Shortcuts CRUD ───────────────────────────────────────────────

export async function addDashboardShortcut(params: {
  pool: Q;
  tenantId: string;
  subjectId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  targetType: string;
  targetId: string;
  displayName?: any;
  icon?: string;
  sortOrder?: number;
}): Promise<DashboardShortcutRow> {
  const res = await params.pool.query(
    `INSERT INTO user_dashboard_shortcuts (tenant_id, subject_id, scope_type, scope_id, target_type, target_id, display_name, icon, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      params.tenantId,
      params.subjectId,
      params.scopeType,
      params.scopeId,
      params.targetType,
      params.targetId,
      params.displayName ? JSON.stringify(params.displayName) : null,
      params.icon ?? null,
      params.sortOrder ?? 0,
    ],
  );
  return toShortcut(res.rows[0]);
}

export async function listDashboardShortcuts(params: {
  pool: Q;
  tenantId: string;
  subjectId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
}): Promise<DashboardShortcutRow[]> {
  const res = await params.pool.query(
    `SELECT * FROM user_dashboard_shortcuts
     WHERE tenant_id=$1 AND subject_id=$2 AND scope_type=$3 AND scope_id=$4
     ORDER BY sort_order ASC, created_at ASC`,
    [params.tenantId, params.subjectId, params.scopeType, params.scopeId],
  );
  return res.rows.map(toShortcut);
}

export async function updateDashboardShortcutOrder(params: {
  pool: Q;
  tenantId: string;
  subjectId: string;
  shortcutId: string;
  sortOrder: number;
}): Promise<DashboardShortcutRow | null> {
  const res = await params.pool.query(
    `UPDATE user_dashboard_shortcuts SET sort_order=$4, updated_at=now()
     WHERE tenant_id=$1 AND subject_id=$2 AND shortcut_id=$3
     RETURNING *`,
    [params.tenantId, params.subjectId, params.shortcutId, params.sortOrder],
  );
  if (!res.rowCount) return null;
  return toShortcut(res.rows[0]);
}

export async function deleteDashboardShortcut(params: {
  pool: Q;
  tenantId: string;
  subjectId: string;
  shortcutId: string;
}): Promise<boolean> {
  const res = await params.pool.query(
    "DELETE FROM user_dashboard_shortcuts WHERE tenant_id=$1 AND subject_id=$2 AND shortcut_id=$3",
    [params.tenantId, params.subjectId, params.shortcutId],
  );
  return Boolean(res.rowCount);
}

export async function reorderDashboardShortcuts(params: {
  pool: Q;
  tenantId: string;
  subjectId: string;
  orderedIds: string[];
}): Promise<void> {
  for (let i = 0; i < params.orderedIds.length; i++) {
    await params.pool.query(
      "UPDATE user_dashboard_shortcuts SET sort_order=$4, updated_at=now() WHERE tenant_id=$1 AND subject_id=$2 AND shortcut_id=$3",
      [params.tenantId, params.subjectId, params.orderedIds[i], i],
    );
  }
}
