import type { Pool } from "pg";
import { getRun, listSteps } from "./jobRepo";

function digestObject(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const keys = Object.keys(body as any);
  return { keys: keys.slice(0, 50), keyCount: keys.length };
}

export async function buildRunReplay(params: { pool: Pool; tenantId: string; runId: string; limit?: number }) {
  const run = await getRun(params.pool, params.tenantId, params.runId);
  if (!run) return null;
  const steps = await listSteps(params.pool, run.runId);

  const limit = params.limit ?? 500;
  const evRes = await params.pool.query(
    `
      SELECT timestamp, event_id, resource_type, action, result, error_category, trace_id, request_id, run_id, step_id
      FROM audit_events
      WHERE tenant_id = $1 AND run_id = $2
      ORDER BY timestamp ASC, event_id ASC
      LIMIT $3
    `,
    [params.tenantId, params.runId, limit],
  );

  const timeline = evRes.rows.map((r: any) => {
    const ts = r.timestamp ? new Date(r.timestamp).toISOString() : null;
    return {
      timestamp: ts,
      eventType: `${String(r.resource_type)}.${String(r.action)}`,
      runId: r.run_id,
      stepId: r.step_id ?? null,
      result: r.result ?? null,
      errorCategory: r.error_category ?? null,
      traceId: r.trace_id ?? null,
      requestId: r.request_id ?? null,
    };
  });

  const replay = {
    run: {
      ...run,
      sealStatus: (run as any).sealedAt ? "sealed" : "legacy",
      sealedInputDigest: (run as any).sealedInputDigest ?? null,
      sealedOutputDigest: (run as any).sealedOutputDigest ?? null,
      inputDigest: digestObject((run as any).inputDigest),
    },
    steps: steps.map((s: any) => ({
      ...s,
      sealStatus: s.sealedAt ? "sealed" : "legacy",
      sealedInputDigest: (s as any).sealedInputDigest ?? null,
      sealedOutputDigest: (s as any).sealedOutputDigest ?? null,
      inputDigest: digestObject(s.inputDigest),
      outputDigest: digestObject(s.outputDigest),
    })),
    timeline,
  };
  return replay;
}
