import crypto from "node:crypto";

function stableStringify(value: any): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${parts.join(",")}}`;
}

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
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

function evalPassed(params: { thresholds: any; summary: any }) {
  const thresholds = params.thresholds ?? {};
  const minPassRate = typeof thresholds.passRateMin === "number" ? thresholds.passRateMin : 1;
  const maxDenyRate = typeof thresholds.denyRateMax === "number" ? thresholds.denyRateMax : 1;
  const passRate = typeof params.summary?.passRate === "number" ? params.summary.passRate : 0;
  const denyRate = typeof params.summary?.denyRate === "number" ? params.summary.denyRate : 0;
  return passRate >= minPassRate && denyRate <= maxDenyRate;
}

function computeEvalSummary(params: { casesJson: any[]; thresholds: any; reportDigest8: string }) {
  const totalCases = params.casesJson.length;
  let passedCases = 0;
  let deniedCases = 0;
  let failedCases = 0;

  const sealRequired = Boolean(params.thresholds?.sealRequired);

  for (const c of params.casesJson) {
    const expectedConstraints = c && typeof c === "object" ? (c as any).expectedConstraints : null;
    const isDeny =
      Boolean((c as any)?.deny) ||
      Boolean((c as any)?.denied) ||
      Boolean((c as any)?.expectedDeny) ||
      Boolean(expectedConstraints?.deny) ||
      Boolean(expectedConstraints?.denied) ||
      Boolean(expectedConstraints?.expectedDeny) ||
      String(expectedConstraints?.outcome ?? "").toLowerCase() === "deny" ||
      (sealRequired && String((c as any)?.sealStatus ?? "") !== "sealed");

    const isFail =
      Boolean((c as any)?.fail) ||
      Boolean((c as any)?.failed) ||
      (typeof (c as any)?.passed === "boolean" && !(c as any).passed) ||
      (typeof (c as any)?.denied === "boolean" && !(c as any).denied && typeof (c as any)?.passed === "boolean" && !(c as any).passed) ||
      Boolean(expectedConstraints?.fail) ||
      Boolean(expectedConstraints?.failed) ||
      Boolean(expectedConstraints?.forceFail) ||
      expectedConstraints?.pass === false ||
      String(expectedConstraints?.outcome ?? "").toLowerCase() === "fail";

    if (isDeny) {
      deniedCases += 1;
      continue;
    }
    if (isFail) {
      failedCases += 1;
      continue;
    }
    passedCases += 1;
  }

  const passRate = totalCases > 0 ? passedCases / totalCases : 0;
  const denyRate = totalCases > 0 ? deniedCases / totalCases : 0;
  const minPassRate = typeof params.thresholds?.passRateMin === "number" ? params.thresholds.passRateMin : 1;
  const maxDenyRate = typeof params.thresholds?.denyRateMax === "number" ? params.thresholds.denyRateMax : 1;
  const result = evalPassed({ thresholds: params.thresholds, summary: { passRate, denyRate } }) ? "pass" : "fail";

  return {
    totalCases,
    passedCases,
    deniedCases,
    failedCases,
    passRate,
    denyRate,
    reportDigest8: params.reportDigest8,
    result,
    thresholds: { passRateMin: minPassRate, denyRateMax: maxDenyRate },
  };
}

async function failRun(params: { pool: any; tenantId: string; evalRunId: string; reportDigest8: string; totalCases: number; reason: string; onMetric?: (action: string) => void }) {
  const digest8 = sha256Hex(params.reason).slice(0, 8);
  await params.pool.query(
    `
      UPDATE eval_runs
      SET status = 'failed',
          summary = $3::jsonb,
          evidence_digest = $4::jsonb,
          finished_at = now()
      WHERE tenant_id = $1 AND id = $2
    `,
    [
      params.tenantId,
      params.evalRunId,
      JSON.stringify({ totalCases: params.totalCases, reportDigest8: params.reportDigest8, result: "fail", errorDigest8: digest8 }),
      JSON.stringify({ caseCount: params.totalCases, reportDigest8: params.reportDigest8, errorDigest8: digest8 }),
    ],
  );
  params.onMetric?.("failed");
}

export async function processGovernanceEvalRun(params: { pool: any; tenantId: string; evalRunId: string; onMetric?: (action: string) => void }) {
  const runRes = await params.pool.query("SELECT id, suite_id, changeset_id, status, summary FROM eval_runs WHERE tenant_id = $1 AND id = $2 LIMIT 1", [
    params.tenantId,
    params.evalRunId,
  ]);
  if (!runRes.rowCount) return;
  const run = runRes.rows[0] as any;
  const suiteId = String(run.suite_id ?? "");
  const changesetId = run.changeset_id ? String(run.changeset_id) : null;
  if (!suiteId) return;

  await params.pool.query("UPDATE eval_runs SET status = 'running' WHERE tenant_id = $1 AND id = $2 AND status IN ('queued','running')", [
    params.tenantId,
    params.evalRunId,
  ]);

  if (changesetId) {
    const bind = await params.pool.query(
      "SELECT 1 FROM changeset_eval_bindings WHERE tenant_id = $1 AND changeset_id = $2 AND suite_id = $3 LIMIT 1",
      [params.tenantId, changesetId, suiteId],
    );
    if (!bind.rowCount) {
      const reportDigest8 = typeof run.summary?.reportDigest8 === "string" ? String(run.summary.reportDigest8) : "";
      await failRun({ pool: params.pool, tenantId: params.tenantId, evalRunId: params.evalRunId, reportDigest8, totalCases: 0, reason: "suite_unbound", onMetric: params.onMetric });
      return;
    }
  }

  const suiteRes = await params.pool.query("SELECT cases_json, thresholds FROM eval_suites WHERE tenant_id = $1 AND id = $2 LIMIT 1", [params.tenantId, suiteId]);
  if (!suiteRes.rowCount) {
    const reportDigest8 = typeof run.summary?.reportDigest8 === "string" ? String(run.summary.reportDigest8) : "";
    await failRun({ pool: params.pool, tenantId: params.tenantId, evalRunId: params.evalRunId, reportDigest8, totalCases: 0, reason: "suite_not_found", onMetric: params.onMetric });
    return;
  }
  const suiteRow = suiteRes.rows[0] as any;
  const casesJson = Array.isArray(suiteRow.cases_json) ? (suiteRow.cases_json as any[]) : [];
  const thresholds = suiteRow.thresholds ?? {};
  const reportDigest8 = evalReportDigest8FromCases(casesJson);
  const expectedDigest8 = typeof run.summary?.reportDigest8 === "string" ? String(run.summary.reportDigest8) : "";
  if (expectedDigest8 && expectedDigest8 !== reportDigest8) {
    await failRun({ pool: params.pool, tenantId: params.tenantId, evalRunId: params.evalRunId, reportDigest8, totalCases: casesJson.length, reason: "suite_changed", onMetric: params.onMetric });
    return;
  }

  const sealRequired = Boolean(thresholds?.sealRequired);

  const nextCases: any[] = [];
  for (const c of casesJson) {
    const src = c && typeof c === "object" ? (c as any).source : null;
    if (!src || String(src.type ?? "") !== "replay") {
      nextCases.push({ ...(c as any), denied: true, denyReason: "unsupported_source" });
      continue;
    }
    const runId = String(src.runId ?? "");
    const stepId = String(src.stepId ?? "");
    if (!runId || !stepId) {
      nextCases.push({ ...(c as any), denied: true, denyReason: "missing_source_ref" });
      continue;
    }
    const r = await params.pool.query(
      `
        SELECT r.policy_snapshot_ref, s.tool_ref, s.sealed_at, s.sealed_input_digest, s.sealed_output_digest, s.input_digest, s.output_digest
        FROM runs r
        JOIN steps s ON s.run_id = r.run_id
        WHERE r.tenant_id = $1 AND r.run_id = $2 AND s.step_id = $3
        LIMIT 1
      `,
      [params.tenantId, runId, stepId],
    );
    if (!r.rowCount) {
      nextCases.push({ ...(c as any), denied: true, denyReason: "replay_source_not_found" });
      continue;
    }
    const row = r.rows[0] as any;
    const sealedAt = row.sealed_at ? String(row.sealed_at) : "";
    const sealStatus = sealedAt ? "sealed" : "legacy";
    const base: any = {
      ...(c as any),
      toolRef: row.tool_ref ? String(row.tool_ref) : (c as any).toolRef,
      policySnapshotRef: row.policy_snapshot_ref ? String(row.policy_snapshot_ref) : (c as any).policySnapshotRef,
      inputDigest: row.input_digest ?? (c as any).inputDigest ?? null,
      outputDigest: row.output_digest ?? (c as any).outputDigest ?? null,
      sealStatus,
      sealedInputDigest: row.sealed_input_digest ?? null,
      sealedOutputDigest: row.sealed_output_digest ?? null,
    };
    if (sealRequired && sealStatus !== "sealed") {
      base.denied = true;
      base.denyReason = "seal_required";
      nextCases.push(base);
      continue;
    }
    base.passed = true;
    nextCases.push(base);
  }

  const summary = computeEvalSummary({ casesJson: nextCases, thresholds, reportDigest8 });
  const sealed = nextCases.filter((c: any) => String(c?.sealStatus ?? "") === "sealed").length;
  const legacy = nextCases.filter((c: any) => String(c?.sealStatus ?? "") !== "sealed").length;
  const evidenceDigest = { caseCount: nextCases.length, sealed, legacy, reportDigest8 };

  await params.pool.query(
    `
      UPDATE eval_runs
      SET status = 'succeeded', summary = $3::jsonb, evidence_digest = $4::jsonb, finished_at = now()
      WHERE tenant_id = $1 AND id = $2
    `,
    [params.tenantId, params.evalRunId, JSON.stringify(summary), JSON.stringify(evidenceDigest)],
  );

  /* ─── Emit eval run metrics ─── */
  params.onMetric?.("succeeded");
  params.onMetric?.(summary.result === "pass" ? "passed" : "not_passed");
}

