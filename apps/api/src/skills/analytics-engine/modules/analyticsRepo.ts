import type { Pool } from "pg";

// ---- Materialized View Definitions ----

export type AnalyticsViewRow = {
  viewId: string;
  tenantId: string;
  viewName: string;
  sourceSchema: string;
  sourceEntity: string;
  dimensions: any[];
  measures: any[];
  timeGranularity: string;
  filterExpr: any;
  refreshStrategy: string;
  refreshCron: string | null;
  lastRefreshedAt: string | null;
  rowCount: number;
  status: string;
  createdAt: string;
  updatedAt: string;
};

function toView(r: any): AnalyticsViewRow {
  return {
    viewId: String(r.view_id),
    tenantId: String(r.tenant_id),
    viewName: String(r.view_name),
    sourceSchema: String(r.source_schema),
    sourceEntity: String(r.source_entity),
    dimensions: Array.isArray(r.dimensions) ? r.dimensions : [],
    measures: Array.isArray(r.measures) ? r.measures : [],
    timeGranularity: String(r.time_granularity ?? "day"),
    filterExpr: r.filter_expr ?? null,
    refreshStrategy: String(r.refresh_strategy ?? "incremental"),
    refreshCron: r.refresh_cron ? String(r.refresh_cron) : null,
    lastRefreshedAt: r.last_refreshed_at ? String(r.last_refreshed_at) : null,
    rowCount: Number(r.row_count ?? 0),
    status: String(r.status ?? "active"),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function createAnalyticsView(params: {
  pool: Pool;
  tenantId: string;
  viewName: string;
  sourceSchema: string;
  sourceEntity: string;
  dimensions?: any[];
  measures?: any[];
  timeGranularity?: string;
  filterExpr?: any;
  refreshStrategy?: string;
  refreshCron?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO analytics_materialized_views (tenant_id, view_name, source_schema, source_entity, dimensions, measures, time_granularity, filter_expr, refresh_strategy, refresh_cron)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9,$10)
      RETURNING *
    `,
    [
      params.tenantId,
      params.viewName,
      params.sourceSchema,
      params.sourceEntity,
      JSON.stringify(params.dimensions ?? []),
      JSON.stringify(params.measures ?? []),
      params.timeGranularity ?? "day",
      params.filterExpr ? JSON.stringify(params.filterExpr) : null,
      params.refreshStrategy ?? "incremental",
      params.refreshCron ?? null,
    ],
  );
  return toView(res.rows[0]);
}

export async function getAnalyticsView(params: { pool: Pool; tenantId: string; viewId: string }) {
  const res = await params.pool.query("SELECT * FROM analytics_materialized_views WHERE tenant_id = $1 AND view_id = $2 LIMIT 1", [params.tenantId, params.viewId]);
  if (!res.rowCount) return null;
  return toView(res.rows[0]);
}

export async function listAnalyticsViews(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query("SELECT * FROM analytics_materialized_views WHERE tenant_id = $1 AND status = 'active' ORDER BY view_name ASC", [params.tenantId]);
  return res.rows.map(toView);
}

export async function updateAnalyticsViewRefreshed(params: { pool: Pool; tenantId: string; viewId: string; rowCount: number }) {
  await params.pool.query(
    "UPDATE analytics_materialized_views SET last_refreshed_at = now(), row_count = $3, updated_at = now() WHERE tenant_id = $1 AND view_id = $2",
    [params.tenantId, params.viewId, params.rowCount],
  );
}

export async function deleteAnalyticsView(params: { pool: Pool; tenantId: string; viewId: string }) {
  await params.pool.query("UPDATE analytics_materialized_views SET status = 'deleted', updated_at = now() WHERE tenant_id = $1 AND view_id = $2", [params.tenantId, params.viewId]);
}

// ---- Metric Definitions (Semantic Layer) ----

export type MetricDefinitionRow = {
  metricId: string;
  tenantId: string;
  metricName: string;
  displayName: any;
  description: any;
  viewId: string | null;
  expression: string;
  dimensions: any[];
  unit: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

function toMetric(r: any): MetricDefinitionRow {
  return {
    metricId: String(r.metric_id),
    tenantId: String(r.tenant_id),
    metricName: String(r.metric_name),
    displayName: r.display_name,
    description: r.description,
    viewId: r.view_id ? String(r.view_id) : null,
    expression: String(r.expression),
    dimensions: Array.isArray(r.dimensions) ? r.dimensions : [],
    unit: r.unit ? String(r.unit) : null,
    version: Number(r.version ?? 1),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function createMetricDefinition(params: {
  pool: Pool;
  tenantId: string;
  metricName: string;
  displayName?: any;
  description?: any;
  viewId?: string | null;
  expression: string;
  dimensions?: any[];
  unit?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO analytics_metric_definitions (tenant_id, metric_name, display_name, description, view_id, expression, dimensions, unit)
      VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7::jsonb,$8)
      RETURNING *
    `,
    [
      params.tenantId,
      params.metricName,
      params.displayName ? JSON.stringify(params.displayName) : null,
      params.description ? JSON.stringify(params.description) : null,
      params.viewId ?? null,
      params.expression,
      JSON.stringify(params.dimensions ?? []),
      params.unit ?? null,
    ],
  );
  return toMetric(res.rows[0]);
}

export async function listMetricDefinitions(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query("SELECT * FROM analytics_metric_definitions WHERE tenant_id = $1 ORDER BY metric_name ASC", [params.tenantId]);
  return res.rows.map(toMetric);
}

export async function getMetricDefinition(params: { pool: Pool; tenantId: string; metricId: string }) {
  const res = await params.pool.query("SELECT * FROM analytics_metric_definitions WHERE tenant_id = $1 AND metric_id = $2 LIMIT 1", [params.tenantId, params.metricId]);
  if (!res.rowCount) return null;
  return toMetric(res.rows[0]);
}

// ---- Refresh Jobs ----

export type AnalyticsRefreshJobRow = {
  refreshJobId: string;
  tenantId: string;
  viewId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  rowCount: number;
  errorMessage: string | null;
  createdAt: string;
};

function toRefreshJob(r: any): AnalyticsRefreshJobRow {
  return {
    refreshJobId: String(r.refresh_job_id),
    tenantId: String(r.tenant_id),
    viewId: String(r.view_id),
    status: String(r.status ?? "pending"),
    startedAt: r.started_at ? String(r.started_at) : null,
    finishedAt: r.finished_at ? String(r.finished_at) : null,
    rowCount: Number(r.row_count ?? 0),
    errorMessage: r.error_message ? String(r.error_message) : null,
    createdAt: String(r.created_at),
  };
}

export async function createRefreshJob(params: { pool: Pool; tenantId: string; viewId: string }) {
  const res = await params.pool.query(
    "INSERT INTO analytics_refresh_jobs (tenant_id, view_id) VALUES ($1,$2) RETURNING *",
    [params.tenantId, params.viewId],
  );
  return toRefreshJob(res.rows[0]);
}

export async function updateRefreshJobStatus(params: { pool: Pool; refreshJobId: string; status: string; rowCount?: number; errorMessage?: string | null }) {
  const fields: string[] = ["status = $2", "finished_at = CASE WHEN $2 IN ('succeeded','failed') THEN now() ELSE finished_at END"];
  const args: any[] = [params.refreshJobId, params.status];
  if (params.rowCount !== undefined) {
    args.push(params.rowCount);
    fields.push(`row_count = $${args.length}`);
  }
  if (params.errorMessage !== undefined) {
    args.push(params.errorMessage);
    fields.push(`error_message = $${args.length}`);
  }
  const res = await params.pool.query(
    `UPDATE analytics_refresh_jobs SET ${fields.join(", ")} WHERE refresh_job_id = $1 RETURNING *`,
    args,
  );
  if (!res.rowCount) return null;
  return toRefreshJob(res.rows[0]);
}

export async function listRefreshJobs(params: { pool: Pool; tenantId: string; viewId: string; limit?: number }) {
  const limit = Math.max(1, Math.min(100, params.limit ?? 20));
  const res = await params.pool.query(
    "SELECT * FROM analytics_refresh_jobs WHERE tenant_id = $1 AND view_id = $2 ORDER BY created_at DESC LIMIT $3",
    [params.tenantId, params.viewId, limit],
  );
  return res.rows.map(toRefreshJob);
}

// ---- Query Helper: Build aggregation SQL from view definition ----

export function buildAggregationQuery(view: AnalyticsViewRow): string {
  const dims = view.dimensions.map((d: any) => `payload->>'${String(d.field ?? d)}' AS "${String(d.alias ?? d.field ?? d)}"`);
  const meas = view.measures.map((m: any) => {
    const fn = String(m.function ?? "COUNT").toUpperCase();
    const field = m.field ? `(payload->>'${String(m.field)}')::numeric` : "*";
    const alias = String(m.alias ?? m.field ?? "value");
    if (fn === "COUNT") return `COUNT(${field}) AS "${alias}"`;
    if (fn === "SUM") return `SUM(${field}) AS "${alias}"`;
    if (fn === "AVG") return `AVG(${field}) AS "${alias}"`;
    if (fn === "MIN") return `MIN(${field}) AS "${alias}"`;
    if (fn === "MAX") return `MAX(${field}) AS "${alias}"`;
    return `COUNT(*) AS "${alias}"`;
  });

  const select = [...dims, ...meas].join(", ");
  const groupBy = dims.length ? `GROUP BY ${dims.map((_, i) => String(i + 1)).join(", ")}` : "";

  return `SELECT ${select} FROM entity_records WHERE tenant_id = $1 AND schema_name = $2 AND entity_name = $3 AND deleted_at IS NULL ${groupBy}`;
}

// ---- View Query Execution ----

export type ViewQueryResult = {
  columns: string[];
  rows: Record<string, any>[];
  rowCount: number;
  truncated: boolean;
};

export async function executeViewQuery(params: {
  pool: Pool;
  view: AnalyticsViewRow;
  tenantId: string;
  limit?: number;
  offset?: number;
  filters?: Record<string, any>;
}): Promise<ViewQueryResult> {
  const maxRows = Math.max(1, Math.min(1000, params.limit ?? 200));
  const offset = Math.max(0, params.offset ?? 0);

  const baseSql = buildAggregationQuery(params.view);
  const sql = `${baseSql} LIMIT ${maxRows + 1} OFFSET ${offset}`;

  const res = await params.pool.query(sql, [params.tenantId, params.view.sourceSchema, params.view.sourceEntity]);
  const truncated = res.rows.length > maxRows;
  const rows = truncated ? res.rows.slice(0, maxRows) : res.rows;
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows, rowCount: rows.length, truncated };
}
