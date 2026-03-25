import type { Pool } from "pg";

/* ================================================================== */
/*  Tool Historical Success Rate (P1-7.3)                               */
/* ================================================================== */

/** Success rate record for a single tool. */
export interface ToolSuccessRate {
  toolRef: string;
  toolName: string;
  total: number;
  success: number;
  rate: number; // [0,1]
}

/**
 * Query historical success rates for tools within a tenant.
 *
 * Returns a Map<toolName, rate> where rate is in [0, 1].
 * Tools with zero executions are omitted (cold start — callers should treat
 * missing entries as "no data" and apply default behaviour).
 *
 * @param params.window  Time window: "1h" | "24h" | "7d"
 */
export async function getToolSuccessRates(params: {
  pool: Pool;
  tenantId: string;
  window?: "1h" | "24h" | "7d";
}): Promise<Map<string, number>> {
  const interval = params.window === "7d" ? "7 days" : params.window === "24h" ? "24 hours" : "1 hour";
  const res = await params.pool.query(
    `
      SELECT
        tool_ref,
        COUNT(*)::int AS total,
        SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END)::int AS success
      FROM audit_events
      WHERE tenant_id = $1
        AND timestamp >= now() - $2::interval
        AND tool_ref IS NOT NULL
        AND resource_type = 'tool'
        AND action = 'execute'
      GROUP BY tool_ref
      HAVING COUNT(*) >= 1
      ORDER BY total DESC
      LIMIT 500
    `,
    [params.tenantId, interval],
  );

  const rates = new Map<string, number>();
  for (const r of res.rows) {
    const toolRef = String(r.tool_ref ?? "");
    const total = Number(r.total ?? 0);
    const success = Number(r.success ?? 0);
    if (!toolRef || total <= 0) continue;
    // Extract tool name from toolRef (name@version)
    const at = toolRef.lastIndexOf("@");
    const toolName = at > 0 ? toolRef.slice(0, at) : toolRef;
    // Use highest rate if multiple versions exist
    const rate = success / total;
    const existing = rates.get(toolName);
    if (existing === undefined || rate > existing) {
      rates.set(toolName, rate);
    }
  }
  return rates;
}

export type ObservabilitySummary = {
  window: "1h" | "24h";
  routes: Array<{ key: string; total: number; success: number; denied: number; error: number; p50Ms: number | null; p95Ms: number | null }>;
  sync: Array<{ spaceId: string | null; pushes: number; ops: number; conflicts: number; conflictRate: number | null }>;
  knowledge: { searches: number; ok: number; denied: number; error: number; emptyResults: number };
  agentSlo: {
    agentRuntime: { totalCreates: number; okCreates: number; planFailed: number; approvalRequested: number };
    collab: { totalCreates: number; okCreates: number; arbiterCommits: number; roleCompleted: number; roleFailed: number };
    approvals: { decisionsApproved: number; decisionsDenied: number };
    modelUsage: { calls: number; totalTokens: number };
  };
  topErrors: Array<{ errorCategory: string | null; key: string; count: number; sampleTraceId: string }>;
};

function windowToInterval(window: "1h" | "24h") {
  return window === "24h" ? "24 hours" : "1 hour";
}

export async function getObservabilitySummary(params: { pool: Pool; tenantId: string; window: "1h" | "24h" }): Promise<ObservabilitySummary> {
  const interval = windowToInterval(params.window);

  const routesRes = await params.pool.query(
    `
      SELECT
        resource_type,
        action,
        COUNT(*)::int AS total,
        SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END)::int AS success,
        SUM(CASE WHEN result = 'denied' THEN 1 ELSE 0 END)::int AS denied,
        SUM(CASE WHEN result = 'error' THEN 1 ELSE 0 END)::int AS error,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms
      FROM audit_events
      WHERE tenant_id = $1
        AND timestamp >= now() - $2::interval
        AND latency_ms IS NOT NULL
      GROUP BY resource_type, action
      ORDER BY total DESC
      LIMIT 80
    `,
    [params.tenantId, interval],
  );

  const syncRes = await params.pool.query(
    `
      SELECT
        space_id,
        COUNT(*)::int AS pushes,
        COALESCE(SUM(NULLIF((output_digest->>'opCount')::int, NULL)), 0)::int AS ops,
        COALESCE(SUM(NULLIF((output_digest->>'conflicts')::int, NULL)), 0)::int AS conflicts
      FROM audit_events
      WHERE tenant_id = $1
        AND timestamp >= now() - $2::interval
        AND resource_type = 'sync'
        AND action = 'push'
        AND result = 'success'
      GROUP BY space_id
      ORDER BY pushes DESC
      LIMIT 50
    `,
    [params.tenantId, interval],
  );

  const knowledgeRes = await params.pool.query(
    `
      SELECT
        COUNT(*)::int AS searches,
        SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END)::int AS ok,
        SUM(CASE WHEN result = 'denied' THEN 1 ELSE 0 END)::int AS denied,
        SUM(CASE WHEN result = 'error' THEN 1 ELSE 0 END)::int AS error,
        SUM(CASE WHEN result = 'success' AND COALESCE((output_digest->>'returnedCount')::int, 0) = 0 THEN 1 ELSE 0 END)::int AS empty_results
      FROM audit_events
      WHERE tenant_id = $1
        AND timestamp >= now() - $2::interval
        AND resource_type = 'knowledge'
        AND action = 'search'
    `,
    [params.tenantId, interval],
  );

  const topErrRes = await params.pool.query(
    `
      SELECT
        error_category,
        resource_type,
        action,
        COUNT(*)::int AS c,
        MIN(trace_id) AS sample_trace_id
      FROM audit_events
      WHERE tenant_id = $1
        AND timestamp >= now() - $2::interval
        AND result <> 'success'
      GROUP BY error_category, resource_type, action
      ORDER BY c DESC
      LIMIT 30
    `,
    [params.tenantId, interval],
  );

  const agentRuntimeRes = await params.pool.query(
    `
      SELECT
        COUNT(*)::int AS total,
        SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END)::int AS ok,
        SUM(CASE WHEN (output_digest->>'errorCode') LIKE 'AGENT_PLAN_%' THEN 1 ELSE 0 END)::int AS plan_failed,
        SUM(CASE WHEN (output_digest->>'status') = 'needs_approval' THEN 1 ELSE 0 END)::int AS approval_requested
      FROM audit_events
      WHERE tenant_id = $1
        AND timestamp >= now() - $2::interval
        AND resource_type = 'agent_runtime'
        AND action = 'run.create'
    `,
    [params.tenantId, interval],
  );

  const collabRes = await params.pool.query(
    `
      SELECT
        COUNT(*)::int AS total,
        SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END)::int AS ok,
        SUM(CASE WHEN action = 'collab.arbiter.commit' AND result = 'success' THEN 1 ELSE 0 END)::int AS arbiter_commits
      FROM audit_events
      WHERE tenant_id = $1
        AND timestamp >= now() - $2::interval
        AND resource_type = 'agent_runtime'
        AND action IN ('collab.create', 'collab.arbiter.commit')
    `,
    [params.tenantId, interval],
  );

  const collabRolesRes = await params.pool.query(
    `
      SELECT
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int AS completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failed
      FROM collab_agent_roles
      WHERE tenant_id = $1
        AND updated_at >= now() - $2::interval
    `,
    [params.tenantId, interval],
  );

  const approvalDecRes = await params.pool.query(
    `
      SELECT
        SUM(CASE WHEN decision = 'approve' THEN 1 ELSE 0 END)::int AS approved,
        SUM(CASE WHEN decision = 'deny' THEN 1 ELSE 0 END)::int AS denied
      FROM approval_decisions
      WHERE tenant_id = $1
        AND created_at >= now() - $2::interval
    `,
    [params.tenantId, interval],
  );

  const usageRes = await params.pool.query(
    `
      SELECT
        COUNT(*)::int AS calls,
        COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::bigint AS total_tokens
      FROM model_usage_events
      WHERE tenant_id = $1
        AND created_at >= now() - $2::interval
    `,
    [params.tenantId, interval],
  );

  return {
    window: params.window,
    routes: routesRes.rows.map((r) => ({
      key: `${r.resource_type}.${r.action}`,
      total: Number(r.total ?? 0),
      success: Number(r.success ?? 0),
      denied: Number(r.denied ?? 0),
      error: Number(r.error ?? 0),
      p50Ms: r.p50_ms == null ? null : Math.round(Number(r.p50_ms)),
      p95Ms: r.p95_ms == null ? null : Math.round(Number(r.p95_ms)),
    })),
    sync: syncRes.rows.map((r) => {
      const ops = Number(r.ops ?? 0);
      const conflicts = Number(r.conflicts ?? 0);
      return {
        spaceId: r.space_id ? String(r.space_id) : null,
        pushes: Number(r.pushes ?? 0),
        ops,
        conflicts,
        conflictRate: ops > 0 ? Math.round((conflicts / ops) * 10000) / 10000 : null,
      };
    }),
    knowledge: {
      searches: Number(knowledgeRes.rows[0]?.searches ?? 0),
      ok: Number(knowledgeRes.rows[0]?.ok ?? 0),
      denied: Number(knowledgeRes.rows[0]?.denied ?? 0),
      error: Number(knowledgeRes.rows[0]?.error ?? 0),
      emptyResults: Number(knowledgeRes.rows[0]?.empty_results ?? 0),
    },
    agentSlo: {
      agentRuntime: {
        totalCreates: Number(agentRuntimeRes.rows[0]?.total ?? 0),
        okCreates: Number(agentRuntimeRes.rows[0]?.ok ?? 0),
        planFailed: Number(agentRuntimeRes.rows[0]?.plan_failed ?? 0),
        approvalRequested: Number(agentRuntimeRes.rows[0]?.approval_requested ?? 0),
      },
      collab: {
        totalCreates: Number(collabRes.rows[0]?.total ?? 0),
        okCreates: Number(collabRes.rows[0]?.ok ?? 0),
        arbiterCommits: Number(collabRes.rows[0]?.arbiter_commits ?? 0),
        roleCompleted: Number(collabRolesRes.rows[0]?.completed ?? 0),
        roleFailed: Number(collabRolesRes.rows[0]?.failed ?? 0),
      },
      approvals: {
        decisionsApproved: Number(approvalDecRes.rows[0]?.approved ?? 0),
        decisionsDenied: Number(approvalDecRes.rows[0]?.denied ?? 0),
      },
      modelUsage: {
        calls: Number(usageRes.rows[0]?.calls ?? 0),
        totalTokens: Number(usageRes.rows[0]?.total_tokens ?? 0),
      },
    },
    topErrors: topErrRes.rows.map((r) => ({
      errorCategory: r.error_category ? String(r.error_category) : null,
      key: `${r.resource_type}.${r.action}`,
      count: Number(r.c ?? 0),
      sampleTraceId: String(r.sample_trace_id ?? ""),
    })),
  };
}

/* ================================================================== */
/*  Skill Runtime Degradation Metrics (P1-11.4)                        */
/* ================================================================== */

export interface RuntimeDegradationEvent {
  tenantId: string;
  toolRef: string;
  fromLevel: string;
  toLevel: string;
  reason: string;
  traceId?: string;
}

/**
 * 记录运行时降级事件（写入 audit_events）。
 * 用于可观测性指标 skill.runtime.degraded 产出。
 */
export async function recordRuntimeDegradation(params: {
  pool: Pool;
  event: RuntimeDegradationEvent;
}): Promise<void> {
  await params.pool.query(
    `INSERT INTO audit_events (tenant_id, resource_type, action, actor_type, actor_id, metadata, trace_id)
     VALUES ($1, 'skill.runtime', 'degraded', 'system', 'supply_chain_policy',
             $2::jsonb, $3)`,
    [
      params.event.tenantId,
      JSON.stringify({
        toolRef: params.event.toolRef,
        fromLevel: params.event.fromLevel,
        toLevel: params.event.toLevel,
        reason: params.event.reason,
      }),
      params.event.traceId ?? null,
    ],
  );
}

/**
 * 查询运行时降级统计（指标 skill.runtime.degraded）。
 */
export async function getRuntimeDegradationStats(params: {
  pool: Pool;
  tenantId: string;
  window?: "1h" | "24h" | "7d";
}): Promise<{ total: number; byTool: Array<{ toolRef: string; count: number }> }> {
  const interval = params.window === "7d" ? "7 days" : params.window === "24h" ? "24 hours" : "1 hour";
  const res = await params.pool.query(
    `SELECT
       metadata->>'toolRef' AS tool_ref,
       COUNT(*)::int AS cnt
     FROM audit_events
     WHERE tenant_id = $1
       AND resource_type = 'skill.runtime'
       AND action = 'degraded'
       AND created_at >= NOW() - $2::interval
     GROUP BY metadata->>'toolRef'
     ORDER BY cnt DESC
     LIMIT 50`,
    [params.tenantId, interval],
  );
  const byTool = res.rows.map((r: any) => ({
    toolRef: String(r.tool_ref ?? ""),
    count: Number(r.cnt ?? 0),
  }));
  const total = byTool.reduce((sum, t) => sum + t.count, 0);
  return { total, byTool };
}

/* ================================================================== */
/*  Agent OS Operations View (P2-15)                                   */
/* ================================================================== */

/** 核心运营指标定义 */
export interface AgentOSOperationsMetrics {
  /** 规划成功率 */
  planSuccessRate: number;
  /** 建议命中率 (tool 成功执行 / 总规划建议) */
  suggestionHitRate: number;
  /** 审批介入率 */
  approvalInterventionRate: number;
  /** 重试率 */
  retryRate: number;
  /** replan 率 */
  replanRate: number;
  /** 默认拒绝率 (tool 未启用导致的拒绝) */
  defaultDenyRate: number;
  /** 按入口维度拆分 */
  byEntryPoint: Record<string, EntryPointMetrics>;
}

export interface EntryPointMetrics {
  totalRuns: number;
  succeeded: number;
  failed: number;
  approvalRequested: number;
}

/**
 * 查询 Agent OS 运营指标。
 * 按入口维度拆分：manual / orchestrator / agent-runtime / collab-runtime
 */
export async function getAgentOSOperationsMetrics(params: {
  pool: Pool;
  tenantId: string;
  window?: "1h" | "24h" | "7d";
}): Promise<AgentOSOperationsMetrics> {
  const interval = params.window === "7d" ? "7 days" : params.window === "24h" ? "24 hours" : "1 hour";

  // 规划成功率 + 重试 + replan
  const planRes = await params.pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
       COALESCE(SUM((metadata->>'attempt')::int), 0)::int AS total_attempts,
       COALESCE(SUM((metadata->>'replanCount')::int), 0)::int AS replan_count
     FROM runs
     WHERE tenant_id = $1 AND created_at >= NOW() - $2::interval`,
    [params.tenantId, interval],
  );
  const planRow = planRes.rows[0] ?? {};
  const totalRuns = Number(planRow.total ?? 0);
  const succeededRuns = Number(planRow.succeeded ?? 0);
  const totalAttempts = Number(planRow.total_attempts ?? 0);
  const replanCount = Number(planRow.replan_count ?? 0);

  const planSuccessRate = totalRuns > 0 ? succeededRuns / totalRuns : 0;
  const retryRate = totalRuns > 0 ? Math.max(0, (totalAttempts - totalRuns)) / totalRuns : 0;
  const replanRate = totalRuns > 0 ? replanCount / totalRuns : 0;

  // 审批介入率
  const approvalRes = await params.pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status IN ('needs_approval','needs_arbiter'))::int AS approval_runs
     FROM runs
     WHERE tenant_id = $1 AND created_at >= NOW() - $2::interval`,
    [params.tenantId, interval],
  );
  const approvalRow = approvalRes.rows[0] ?? {};
  const approvalRuns = Number(approvalRow.approval_runs ?? 0);
  const approvalInterventionRate = totalRuns > 0 ? approvalRuns / totalRuns : 0;

  // 建议命中率 (成功执行的 step / 总 step)
  const stepRes = await params.pool.query(
    `SELECT
       COUNT(*)::int AS total_steps,
       COUNT(*) FILTER (WHERE s.status = 'succeeded')::int AS ok_steps
     FROM steps s
       JOIN runs r ON s.run_id = r.run_id
     WHERE r.tenant_id = $1 AND s.created_at >= NOW() - $2::interval`,
    [params.tenantId, interval],
  );
  const stepRow = stepRes.rows[0] ?? {};
  const totalSteps = Number(stepRow.total_steps ?? 0);
  const okSteps = Number(stepRow.ok_steps ?? 0);
  const suggestionHitRate = totalSteps > 0 ? okSteps / totalSteps : 0;

  // 默认拒绝率 (工具未启用导致的拒绝)
  const denyRes = await params.pool.query(
    `SELECT COUNT(*)::int AS deny_count
     FROM audit_events
     WHERE tenant_id = $1
       AND action = 'tool_execution_denied'
       AND created_at >= NOW() - $2::interval`,
    [params.tenantId, interval],
  );
  const denyCount = Number(denyRes.rows[0]?.deny_count ?? 0);
  const defaultDenyRate = totalSteps > 0 ? denyCount / totalSteps : 0;

  // 按入口维度拆分
  const entryRes = await params.pool.query(
    `SELECT
       COALESCE(trigger, 'manual') AS entry_point,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE status IN ('needs_approval','needs_arbiter'))::int AS approval_requested
     FROM runs
     WHERE tenant_id = $1 AND created_at >= NOW() - $2::interval
     GROUP BY COALESCE(trigger, 'manual')`,
    [params.tenantId, interval],
  );

  const byEntryPoint: Record<string, EntryPointMetrics> = {};
  for (const row of entryRes.rows) {
    const ep = String(row.entry_point ?? "manual");
    byEntryPoint[ep] = {
      totalRuns: Number(row.total ?? 0),
      succeeded: Number(row.succeeded ?? 0),
      failed: Number(row.failed ?? 0),
      approvalRequested: Number(row.approval_requested ?? 0),
    };
  }

  return {
    planSuccessRate,
    suggestionHitRate,
    approvalInterventionRate,
    retryRate,
    replanRate,
    defaultDenyRate,
    byEntryPoint,
  };
}

/* ================================================================== */
/*  Architecture Quality Alerts (P2-15.4)                               */
/* ================================================================== */

export interface ArchitectureQualityAlert {
  name: string;
  severity: "critical" | "warning" | "info";
  value: number;
  threshold: number;
  triggered: boolean;
  message: string;
}

/**
 * 架构质量告警检查。
 * 当指标超过阈值时生成告警。
 */
export async function checkArchitectureQualityAlerts(params: {
  pool: Pool;
  tenantId: string;
  window?: "1h" | "24h" | "7d";
}): Promise<ArchitectureQualityAlert[]> {
  const interval = params.window === "7d" ? "7 days" : params.window === "24h" ? "24 hours" : "1 hour";
  const alerts: ArchitectureQualityAlert[] = [];

  // 1. 旁路执行率 (traceId 缺失的 step 比例)
  const bypassRes = await params.pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE (s.input->>'traceId') IS NULL OR s.input->>'traceId' = 'unknown')::int AS bypass_count
     FROM steps s
       JOIN runs r ON s.run_id = r.run_id
     WHERE r.tenant_id = $1 AND s.created_at >= NOW() - $2::interval`,
    [params.tenantId, interval],
  );
  const bypassTotal = Number(bypassRes.rows[0]?.total ?? 0);
  const bypassCount = Number(bypassRes.rows[0]?.bypass_count ?? 0);
  const bypassRate = bypassTotal > 0 ? bypassCount / bypassTotal : 0;
  alerts.push({
    name: "bypass_execution_rate",
    severity: bypassRate > 0.01 ? "critical" : "info",
    value: bypassRate,
    threshold: 0,
    triggered: bypassRate > 0,
    message: bypassRate > 0
      ? `${bypassCount}/${bypassTotal} steps lack traceId (bypass rate: ${(bypassRate * 100).toFixed(1)}%)`
      : "No bypass executions detected",
  });

  // 2. 未注册工具调用率
  const unregRes = await params.pool.query(
    `SELECT COUNT(*)::int AS unreg_count
     FROM audit_events
     WHERE tenant_id = $1
       AND action = 'tool_not_registered'
       AND created_at >= NOW() - $2::interval`,
    [params.tenantId, interval],
  );
  const unregCount = Number(unregRes.rows[0]?.unreg_count ?? 0);
  alerts.push({
    name: "unregistered_tool_calls",
    severity: unregCount > 0 ? "warning" : "info",
    value: unregCount,
    threshold: 0,
    triggered: unregCount > 0,
    message: unregCount > 0
      ? `${unregCount} calls to unregistered tools detected`
      : "No unregistered tool calls",
  });

  // 3. 运行时降级率
  const degradeStats = await getRuntimeDegradationStats(params);
  alerts.push({
    name: "runtime_degradation_rate",
    severity: degradeStats.total > 10 ? "warning" : "info",
    value: degradeStats.total,
    threshold: 0,
    triggered: degradeStats.total > 0,
    message: degradeStats.total > 0
      ? `${degradeStats.total} runtime degradation events`
      : "No runtime degradation events",
  });

  return alerts;
}
