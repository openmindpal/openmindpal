export type EvalThresholds = {
  passRateMin?: number;
  denyRateMax?: number;
  sealRequired?: boolean;
};

export type EvalRunSummary = {
  totalCases?: number;
  passedCases?: number;
  deniedCases?: number;
  failedCases?: number;
  passRate?: number;
  denyRate?: number;
  reportDigest8?: string;
  result?: "pass" | "fail";
  thresholds?: { passRateMin: number; denyRateMax: number };
};

export function evalPassed(params: { thresholds: EvalThresholds | null | undefined; summary: EvalRunSummary | null | undefined }) {
  const thresholds = params.thresholds ?? {};
  const minPassRate = typeof thresholds.passRateMin === "number" ? thresholds.passRateMin : 1;
  const maxDenyRate = typeof thresholds.denyRateMax === "number" ? thresholds.denyRateMax : 1;
  const passRate = typeof params.summary?.passRate === "number" ? params.summary.passRate : 0;
  const denyRate = typeof params.summary?.denyRate === "number" ? params.summary.denyRate : 0;
  return passRate >= minPassRate && denyRate <= maxDenyRate;
}

export function computeEvalSummary(params: { casesJson: any[]; thresholds: EvalThresholds | null | undefined; reportDigest8: string }) {
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
  const minPassRate = typeof params.thresholds?.passRateMin === "number" ? params.thresholds!.passRateMin! : 1;
  const maxDenyRate = typeof params.thresholds?.denyRateMax === "number" ? params.thresholds!.denyRateMax! : 1;
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
  } satisfies EvalRunSummary;
}

