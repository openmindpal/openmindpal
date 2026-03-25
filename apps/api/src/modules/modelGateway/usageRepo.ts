import type { Pool } from "pg";

export async function insertModelUsageEvent(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  purpose: string;
  provider: string;
  modelRef: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  result: "success" | "denied" | "error";
}) {
  await params.pool.query(
    `
      INSERT INTO model_usage_events (
        tenant_id, space_id, subject_id, purpose, provider, model_ref,
        prompt_tokens, completion_tokens, total_tokens, latency_ms, result
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `,
    [
      params.tenantId,
      params.spaceId,
      params.subjectId,
      params.purpose,
      params.provider,
      params.modelRef,
      params.promptTokens,
      params.completionTokens,
      params.totalTokens,
      params.latencyMs,
      params.result,
    ],
  );
}

export async function queryModelUsageAgg(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  since: string;
  until: string;
  purpose?: string;
  modelRef?: string;
}) {
  const where: string[] = ["tenant_id = $1", "created_at >= $2", "created_at < $3"];
  const args: any[] = [params.tenantId, params.since, params.until];
  let idx = 3;
  if (params.spaceId) {
    args.push(params.spaceId);
    where.push(`space_id = $${++idx}`);
  }
  if (params.purpose) {
    args.push(params.purpose);
    where.push(`purpose = $${++idx}`);
  }
  if (params.modelRef) {
    args.push(params.modelRef);
    where.push(`model_ref = $${++idx}`);
  }

  const res = await params.pool.query(
    `
      SELECT
        purpose,
        provider,
        model_ref,
        COUNT(*)::int AS calls,
        SUM(COALESCE(prompt_tokens, 0))::bigint AS prompt_tokens,
        SUM(COALESCE(completion_tokens, 0))::bigint AS completion_tokens,
        SUM(COALESCE(total_tokens, 0))::bigint AS total_tokens,
        SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END)::int AS success,
        SUM(CASE WHEN result = 'denied' THEN 1 ELSE 0 END)::int AS denied,
        SUM(CASE WHEN result = 'error' THEN 1 ELSE 0 END)::int AS error
      FROM model_usage_events
      WHERE ${where.join(" AND ")}
      GROUP BY purpose, provider, model_ref
      ORDER BY calls DESC, model_ref ASC
      LIMIT 200
    `,
    args,
  );
  return res.rows.map((r) => ({
    purpose: r.purpose as string,
    provider: r.provider as string,
    modelRef: r.model_ref as string,
    calls: Number(r.calls ?? 0),
    tokens: {
      prompt: Number(r.prompt_tokens ?? 0),
      completion: Number(r.completion_tokens ?? 0),
      total: Number(r.total_tokens ?? 0),
    },
    results: { success: Number(r.success ?? 0), denied: Number(r.denied ?? 0), error: Number(r.error ?? 0) },
  }));
}

