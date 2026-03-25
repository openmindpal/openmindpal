import type { Pool } from "pg";

type MetricsRegistry = {
  setCollabRunBacklog: (p: { status: string; count: number }) => void;
  setCollabEventCount1h: (p: { type: string; count: number }) => void;
  setCollabRunDurationAvgMs1h: (p: { value: number }) => void;
  setCollabStepsTotal: (p: { actorRole: string; status: string; count: number }) => void;
  setCollabBlockedTotal: (p: { actorRole: string; reason: string; count: number }) => void;
  setCollabNeedsApprovalTotal: (p: { actorRole: string; count: number }) => void;
  setCollabStepDurationCount1h: (p: { actorRole: string; count: number }) => void;
  setCollabStepDurationSumMs1h: (p: { actorRole: string; sumMs: number }) => void;
  setCollabStepDurationBucket1h: (p: { actorRole: string; le: string; count: number }) => void;
};

export async function collectCollabBacklogMetrics(db: Pool, metrics: MetricsRegistry) {
  const [backlogRes, evRes, roleAggRes, durRes, stepDurRes] = await Promise.all([
    db.query("SELECT status, COUNT(*)::int AS c FROM collab_runs GROUP BY status"),
    db.query("SELECT type, COUNT(*)::int AS c FROM collab_run_events WHERE created_at > now() - interval '1 hour' GROUP BY type"),
    db.query(
      `
        SELECT COALESCE(actor_role,'') AS actor_role, type, COUNT(*)::int AS c
        FROM collab_run_events
        WHERE created_at > now() - interval '1 hour'
          AND type IN ('collab.step.started','collab.step.completed','collab.step.failed','collab.policy.denied','collab.budget.exceeded','collab.run.needs_approval','collab.single_writer.violation')
        GROUP BY COALESCE(actor_role,''), type
      `,
    ),
    db.query(
      `
        SELECT AVG(EXTRACT(EPOCH FROM (r.finished_at - r.created_at)) * 1000)::float AS avg_ms
        FROM collab_runs cr
        JOIN runs r ON r.run_id = cr.primary_run_id
        WHERE r.finished_at IS NOT NULL AND r.finished_at > now() - interval '1 hour'
      `,
    ),
    db.query(
      `
        WITH d AS (
          SELECT COALESCE(e.actor_role,'') AS actor_role,
                 (EXTRACT(EPOCH FROM (s.finished_at - s.created_at)) * 1000)::float AS dur_ms
          FROM collab_run_events e
          JOIN steps s ON s.step_id = e.step_id
          WHERE e.type = 'collab.step.completed'
            AND s.finished_at IS NOT NULL
            AND s.finished_at > now() - interval '1 hour'
        )
        SELECT actor_role,
               COUNT(*)::int AS c,
               COALESCE(SUM(dur_ms), 0)::float AS sum_ms,
               SUM(CASE WHEN dur_ms <= 5 THEN 1 ELSE 0 END)::int AS le_5,
               SUM(CASE WHEN dur_ms <= 10 THEN 1 ELSE 0 END)::int AS le_10,
               SUM(CASE WHEN dur_ms <= 25 THEN 1 ELSE 0 END)::int AS le_25,
               SUM(CASE WHEN dur_ms <= 50 THEN 1 ELSE 0 END)::int AS le_50,
               SUM(CASE WHEN dur_ms <= 100 THEN 1 ELSE 0 END)::int AS le_100,
               SUM(CASE WHEN dur_ms <= 250 THEN 1 ELSE 0 END)::int AS le_250,
               SUM(CASE WHEN dur_ms <= 500 THEN 1 ELSE 0 END)::int AS le_500,
               SUM(CASE WHEN dur_ms <= 1000 THEN 1 ELSE 0 END)::int AS le_1000,
               SUM(CASE WHEN dur_ms <= 2500 THEN 1 ELSE 0 END)::int AS le_2500,
               SUM(CASE WHEN dur_ms <= 5000 THEN 1 ELSE 0 END)::int AS le_5000,
               SUM(CASE WHEN dur_ms <= 10000 THEN 1 ELSE 0 END)::int AS le_10000
        FROM d
        GROUP BY actor_role
      `,
    ),
  ]);

  // collab_runs backlog
  const statusMap = new Map<string, number>();
  for (const row of backlogRes.rows) statusMap.set(String((row as any).status), Number((row as any).c ?? 0));
  const statuses = ["created", "planning", "executing", "needs_approval", "succeeded", "failed", "canceled", "stopped"];
  for (const s of statuses) metrics.setCollabRunBacklog({ status: s, count: statusMap.get(s) ?? 0 });

  // event counts
  const evMap = new Map<string, number>();
  for (const row of evRes.rows) evMap.set(String((row as any).type), Number((row as any).c ?? 0));
  const types = [
    "collab.run.created", "collab.plan.generated",
    "collab.step.started", "collab.step.completed", "collab.step.failed",
    "collab.run.needs_approval", "collab.policy.denied", "collab.budget.exceeded",
    "collab.run.succeeded", "collab.run.failed", "collab.run.canceled", "collab.run.stopped",
  ];
  for (const t of types) metrics.setCollabEventCount1h({ type: t, count: evMap.get(t) ?? 0 });

  // average duration
  const avgMs = durRes.rowCount ? Number((durRes.rows[0] as any).avg_ms ?? 0) : 0;
  metrics.setCollabRunDurationAvgMs1h({ value: Number.isFinite(avgMs) ? avgMs : 0 });

  // per-role step aggregation
  const roleStepMap = new Map<string, { started: number; completed: number; failed: number; blocked: Record<string, number>; approval: number; violation: number }>();
  function slot(role: string) {
    const k = role || "";
    const cur = roleStepMap.get(k);
    if (cur) return cur;
    const v = { started: 0, completed: 0, failed: 0, blocked: { policy_denied: 0, budget_exceeded: 0 }, approval: 0, violation: 0 };
    roleStepMap.set(k, v);
    return v;
  }
  for (const row of roleAggRes.rows as any[]) {
    const role = String(row.actor_role ?? "");
    const type = String(row.type ?? "");
    const c = Number(row.c ?? 0);
    const s = slot(role);
    if (type === "collab.step.started") s.started += c;
    else if (type === "collab.step.completed") s.completed += c;
    else if (type === "collab.step.failed") s.failed += c;
    else if (type === "collab.policy.denied") s.blocked.policy_denied += c;
    else if (type === "collab.budget.exceeded") s.blocked.budget_exceeded += c;
    else if (type === "collab.run.needs_approval") s.approval += c;
    else if (type === "collab.single_writer.violation") s.violation += c;
  }
  for (const [role, s] of roleStepMap.entries()) {
    metrics.setCollabStepsTotal({ actorRole: role, status: "started", count: s.started });
    metrics.setCollabStepsTotal({ actorRole: role, status: "completed", count: s.completed });
    metrics.setCollabStepsTotal({ actorRole: role, status: "failed", count: s.failed });
    metrics.setCollabBlockedTotal({ actorRole: role, reason: "policy_denied", count: s.blocked.policy_denied });
    metrics.setCollabBlockedTotal({ actorRole: role, reason: "budget_exceeded", count: s.blocked.budget_exceeded });
    metrics.setCollabBlockedTotal({ actorRole: role, reason: "single_writer_violation", count: s.violation });
    metrics.setCollabNeedsApprovalTotal({ actorRole: role, count: s.approval });
  }

  // per-role step duration histogram
  for (const row of stepDurRes.rows as any[]) {
    const role = String(row.actor_role ?? "");
    const count = Number(row.c ?? 0);
    const sumMs = Number(row.sum_ms ?? 0);
    metrics.setCollabStepDurationCount1h({ actorRole: role, count });
    metrics.setCollabStepDurationSumMs1h({ actorRole: role, sumMs: Number.isFinite(sumMs) ? sumMs : 0 });
    metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "5", count: Number(row.le_5 ?? 0) });
    metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "10", count: Number(row.le_10 ?? 0) });
    metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "25", count: Number(row.le_25 ?? 0) });
    metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "50", count: Number(row.le_50 ?? 0) });
    metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "100", count: Number(row.le_100 ?? 0) });
    metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "250", count: Number(row.le_250 ?? 0) });
    metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "500", count: Number(row.le_500 ?? 0) });
    metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "1000", count: Number(row.le_1000 ?? 0) });
    metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "2500", count: Number(row.le_2500 ?? 0) });
    metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "5000", count: Number(row.le_5000 ?? 0) });
    metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "10000", count: Number(row.le_10000 ?? 0) });
    metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "+Inf", count });
  }
}
