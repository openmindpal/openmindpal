/**
 * Regression Evaluation Scheduler (§15.13)
 *
 * Scans for changeset-suite bindings where the latest eval run is
 * missing, expired, or stale, and enqueues new eval runs.
 * Designed to run periodically (cron/interval) within the worker process.
 */
import crypto from "node:crypto";

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function stableStringify(value: any): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${parts.join(",")}}`;
}

function evalReportDigest8FromCases(casesJson: any[]) {
  const cases = Array.isArray(casesJson) ? casesJson : [];
  const digestInput = cases.map((c: any) => ({
    caseId: c?.caseId ?? null,
    sourceType: c?.source?.type ?? null,
    toolRef: c?.toolRef ?? null,
    sealStatus: c?.sealStatus ?? null,
    sealedInputDigest: c?.sealedInputDigest ?? null,
    sealedOutputDigest: c?.sealedOutputDigest ?? null,
  }));
  return sha256Hex(stableStringify(digestInput)).slice(0, 8);
}

export type RegressionScanResult = {
  scannedBindings: number;
  enqueued: number;
  skipped: number;
  alreadyRunning: number;
  details: Array<{
    tenantId: string;
    changesetId: string;
    suiteId: string;
    action: "enqueued" | "skipped_up_to_date" | "already_running" | "skipped_no_cases" | "error";
    evalRunId?: string;
    reportDigest8?: string;
    error?: string;
  }>;
};

/**
 * Scan all active changeset-suite bindings and enqueue regression eval runs
 * for any where the latest eval result is missing, expired (reportDigest8 mismatch), or failed.
 *
 * @param maxBindings – limit number of bindings processed per scan (prevents runaway)
 */
export async function scanAndEnqueueRegressionEvals(params: {
  pool: any;
  queue: { add: (name: string, data: any, opts?: any) => Promise<any> };
  maxBindings?: number;
  onMetric?: (action: string) => void;
}): Promise<RegressionScanResult> {
  const maxBindings = params.maxBindings ?? 200;

  // Find all active bindings (changesets that are not yet released/rolled_back)
  const bindingsRes = await params.pool.query(
    `
      SELECT b.tenant_id, b.changeset_id, b.suite_id
      FROM changeset_eval_bindings b
      JOIN changesets c ON c.tenant_id = b.tenant_id AND c.id = b.changeset_id
      WHERE c.status IN ('draft', 'submitted', 'approved')
      ORDER BY b.created_at DESC
      LIMIT $1
    `,
    [maxBindings],
  );

  const result: RegressionScanResult = {
    scannedBindings: bindingsRes.rows.length,
    enqueued: 0,
    skipped: 0,
    alreadyRunning: 0,
    details: [],
  };

  for (const row of bindingsRes.rows) {
    const tenantId = String(row.tenant_id);
    const changesetId = String(row.changeset_id);
    const suiteId = String(row.suite_id);

    try {
      // Load suite cases to compute current reportDigest8
      const suiteRes = await params.pool.query(
        "SELECT cases_json, thresholds FROM eval_suites WHERE tenant_id = $1 AND id = $2 LIMIT 1",
        [tenantId, suiteId],
      );
      if (!suiteRes.rowCount) {
        result.skipped += 1;
        result.details.push({ tenantId, changesetId, suiteId, action: "skipped_no_cases" });
        continue;
      }
      const casesJson = Array.isArray(suiteRes.rows[0].cases_json) ? suiteRes.rows[0].cases_json : [];
      if (!casesJson.length) {
        result.skipped += 1;
        result.details.push({ tenantId, changesetId, suiteId, action: "skipped_no_cases" });
        continue;
      }
      const reportDigest8 = evalReportDigest8FromCases(casesJson);

      // Check if there's already a running eval for this exact version
      const activeRes = await params.pool.query(
        `SELECT id FROM eval_runs
         WHERE tenant_id = $1 AND suite_id = $2 AND changeset_id = $3
           AND status IN ('queued','running')
           AND (summary->>'reportDigest8') = $4
         LIMIT 1`,
        [tenantId, suiteId, changesetId, reportDigest8],
      );
      if (activeRes.rowCount) {
        result.alreadyRunning += 1;
        result.details.push({ tenantId, changesetId, suiteId, action: "already_running", evalRunId: String(activeRes.rows[0].id), reportDigest8 });
        continue;
      }

      // Check latest succeeded run — if digest matches, it's up-to-date
      const latestRes = await params.pool.query(
        `SELECT id, summary FROM eval_runs
         WHERE tenant_id = $1 AND suite_id = $2 AND changeset_id = $3 AND status = 'succeeded'
         ORDER BY created_at DESC LIMIT 1`,
        [tenantId, suiteId, changesetId],
      );
      if (latestRes.rowCount) {
        const latestDigest = String(latestRes.rows[0].summary?.reportDigest8 ?? "");
        const latestResult = String(latestRes.rows[0].summary?.result ?? "");
        if (latestDigest === reportDigest8 && latestResult === "pass") {
          result.skipped += 1;
          result.details.push({ tenantId, changesetId, suiteId, action: "skipped_up_to_date", reportDigest8 });
          continue;
        }
      }

      // Enqueue new eval run
      const totalCases = casesJson.length;
      const createRes = await params.pool.query(
        `INSERT INTO eval_runs (tenant_id, suite_id, changeset_id, status, summary, evidence_digest)
         VALUES ($1, $2, $3, 'queued', $4::jsonb, $5::jsonb)
         RETURNING id`,
        [
          tenantId,
          suiteId,
          changesetId,
          JSON.stringify({ totalCases, reportDigest8 }),
          JSON.stringify({ caseCount: totalCases, reportDigest8 }),
        ],
      );
      const evalRunId = String(createRes.rows[0].id);
      await params.queue.add(
        "governance.eval",
        { kind: "governance.evalrun.execute", tenantId, changesetId, suiteId, evalRunId, requestedBySubjectId: null },
        { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
      );
      params.onMetric?.("enqueue");
      result.enqueued += 1;
      result.details.push({ tenantId, changesetId, suiteId, action: "enqueued", evalRunId, reportDigest8 });
    } catch (err: any) {
      result.details.push({ tenantId, changesetId, suiteId, action: "error", error: String(err?.message ?? err).slice(0, 200) });
    }
  }

  return result;
}
