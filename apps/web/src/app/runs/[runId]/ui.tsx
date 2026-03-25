"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type RunRow = Record<string, unknown>;
type StepRow = Record<string, unknown>;
type RunDetailResponse = ApiError & { run?: RunRow; steps?: StepRow[] };
type TimelineEvent = {
  timestamp?: string | null;
  eventType?: string | null;
  runId?: string | null;
  stepId?: string | null;
  result?: string | null;
  errorCategory?: string | null;
  traceId?: string | null;
  requestId?: string | null;
};
type RunReplayResponse = ApiError & { timeline?: TimelineEvent[] };
type EvalSuiteLite = { id?: string; name?: string };
type EvalSuitesResponse = ApiError & { suites?: EvalSuiteLite[] };

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg = msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

function toApiError(e: unknown): ApiError {
  if (e && typeof e === "object") return e as ApiError;
  return { errorCode: "ERROR", message: String(e) };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function pickStr(v: unknown) {
  return v != null ? String(v) : "";
}

function isFinishedStatus(status: string) {
  return status === "succeeded" || status === "failed" || status === "canceled" || status === "compensated";
}

export default function RunClient(props: { locale: string; runId: string; initial: unknown; initialStatus: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayError, setReplayError] = useState("");
  const [evalSuitesBusy, setEvalSuitesBusy] = useState(false);
  const [evalSuitesError, setEvalSuitesError] = useState("");
  const [evalSuites, setEvalSuites] = useState<EvalSuiteLite[]>([]);
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>("");
  const [addCaseBusy, setAddCaseBusy] = useState<string>("");
  const [addCaseError, setAddCaseError] = useState<string>("");
  const [evidenceBusy, setEvidenceBusy] = useState<string>("");
  const [evidenceError, setEvidenceError] = useState<string>("");
  const [evidenceByKey, setEvidenceByKey] = useState<Record<string, Record<string, unknown>>>({});
  const [compBusy, setCompBusy] = useState<string>("");
  const [compError, setCompError] = useState<string>("");
  const [compByStepId, setCompByStepId] = useState<Record<string, unknown>>({});

  const initialOut = (props.initial as RunDetailResponse | null) ?? null;
  const [httpStatus, setHttpStatus] = useState<number>(props.initialStatus);
  const [run, setRun] = useState<RunRow | null>(initialOut && initialOut.run && typeof initialOut.run === "object" ? (initialOut.run as RunRow) : null);
  const [steps, setSteps] = useState<StepRow[]>(Array.isArray(initialOut?.steps) ? (initialOut?.steps as StepRow[]) : []);
  const [timeline, setTimeline] = useState<TimelineEvent[] | null>(null);

  const stepRows = useMemo(() => steps, [steps]);
  const status = run ? pickStr(run.status) : "";
  const traceId = run ? pickStr(run.traceId) : "";
  const sealStatus = run && (run as any).sealedAt ? "sealed" : "legacy";

  const reload = useCallback(async () => {
    setError("");
    try {
      const res = await apiFetch(`/runs/${encodeURIComponent(props.runId)}`, { locale: props.locale, cache: "no-store" });
      setHttpStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as RunDetailResponse) ?? {};
      const nextRun = out.run && typeof out.run === "object" ? (out.run as RunRow) : null;
      setRun(nextRun);
      setSteps(Array.isArray(out.steps) ? (out.steps as StepRow[]) : []);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }, [props.locale, props.runId]);

  const loadReplay = useCallback(async () => {
    setReplayError("");
    setReplayBusy(true);
    try {
      const res = await apiFetch(`/runs/${encodeURIComponent(props.runId)}/replay`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as RunReplayResponse) ?? {};
      setTimeline(Array.isArray(out.timeline) ? out.timeline : []);
    } catch (e: unknown) {
      setReplayError(errText(props.locale, toApiError(e)));
      setTimeline(null);
    } finally {
      setReplayBusy(false);
    }
  }, [props.locale, props.runId]);

  const loadEvalSuites = useCallback(async () => {
    setEvalSuitesError("");
    setEvalSuitesBusy(true);
    try {
      const res = await apiFetch(`/governance/evals/suites?limit=20`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as EvalSuitesResponse) ?? {};
      setEvalSuites(Array.isArray(out.suites) ? out.suites : []);
      if (!selectedSuiteId && Array.isArray(out.suites) && out.suites[0]?.id) setSelectedSuiteId(String(out.suites[0].id));
    } catch (e: unknown) {
      setEvalSuitesError(errText(props.locale, toApiError(e)));
      setEvalSuites([]);
    } finally {
      setEvalSuitesBusy(false);
    }
  }, [props.locale, selectedSuiteId]);

  useEffect(() => {
    if (!run) return;
    const s = pickStr(run.status);
    if (isFinishedStatus(s)) return;
    const id = setInterval(() => {
      void reload();
    }, 2000);
    return () => clearInterval(id);
  }, [reload, run]);

  async function cancel() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/runs/${encodeURIComponent(props.runId)}/cancel`, { method: "POST", locale: props.locale });
      setHttpStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await reload();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/runs/${encodeURIComponent(props.runId)}/retry`, { method: "POST", locale: props.locale });
      setHttpStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await reload();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function reexec() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/runs/${encodeURIComponent(props.runId)}/reexec`, { method: "POST", locale: props.locale });
      setHttpStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const rec = asRecord(json);
      const nextRunId = rec && typeof rec.runId === "string" ? rec.runId : "";
      if (!nextRunId) throw ({ errorCode: "ERROR", message: "missing runId" } satisfies ApiError);
      router.push(`/runs/${encodeURIComponent(nextRunId)}?lang=${encodeURIComponent(props.locale)}`);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const canCancel = status === "queued" || status === "running" || status === "compensating" || status === "created" || status === "pending";
  const canRetry = status === "failed";
  const canReexec = Boolean(run);

  const evidenceRefs = useMemo(() => {
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const s of stepRows) {
      const od = s && typeof s === "object" ? ((s as any).outputDigest as any) : null;
      const arr = od && Array.isArray(od.evidenceRefs) ? (od.evidenceRefs as any[]) : [];
      for (const e of arr) {
        const sr = e && typeof e === "object" ? ((e as any).sourceRef as any) : null;
        const key = sr ? `${String(sr.documentId ?? "")}:${String(sr.version ?? "")}:${String(sr.chunkId ?? "")}` : JSON.stringify(e);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e as any);
      }
    }
    return out;
  }, [stepRows]);

  async function resolveEvidence(sourceRef: Record<string, unknown>) {
    setEvidenceError("");
    const key = `${String(sourceRef.documentId ?? "")}:${String(sourceRef.version ?? "")}:${String(sourceRef.chunkId ?? "")}`;
    setEvidenceBusy(key);
    try {
      const res = await apiFetch(`/knowledge/evidence/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ sourceRef }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const rec = asRecord(json);
      const ev = rec && rec.evidence && typeof rec.evidence === "object" ? (rec.evidence as Record<string, unknown>) : null;
      if (!ev) throw ({ errorCode: "ERROR", message: "missing evidence" } satisfies ApiError);
      setEvidenceByKey((prev) => ({ ...prev, [key]: ev }));
    } catch (e: unknown) {
      setEvidenceError(errText(props.locale, toApiError(e)));
    } finally {
      setEvidenceBusy("");
    }
  }

  async function addEvalCaseFromReplay(stepId: string) {
    setAddCaseError("");
    if (!selectedSuiteId) {
      setAddCaseError("missing suiteId");
      return;
    }
    setAddCaseBusy(stepId);
    try {
      const res = await apiFetch(`/governance/evals/suites/${encodeURIComponent(selectedSuiteId)}/cases/from-replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ runId: props.runId, stepId }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
    } catch (e: unknown) {
      setAddCaseError(errText(props.locale, toApiError(e)));
    } finally {
      setAddCaseBusy("");
    }
  }

  async function loadCompensations(stepId: string) {
    setCompError("");
    setCompBusy(stepId);
    try {
      const res = await apiFetch(`/governance/workflow/steps/${encodeURIComponent(stepId)}/compensations`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setCompByStepId((prev) => ({ ...prev, [stepId]: json }));
    } catch (e: unknown) {
      setCompError(errText(props.locale, toApiError(e)));
    } finally {
      setCompBusy("");
    }
  }

  async function compensate(stepId: string) {
    setCompError("");
    setCompBusy(stepId);
    try {
      const res = await apiFetch(`/governance/workflow/steps/${encodeURIComponent(stepId)}/compensate`, { method: "POST", locale: props.locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setCompByStepId((prev) => ({ ...prev, [stepId]: json }));
      await reload();
    } catch (e: unknown) {
      setCompError(errText(props.locale, toApiError(e)));
    } finally {
      setCompBusy("");
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <div>
        <Link
          href={`/runs?lang=${encodeURIComponent(props.locale)}`}
          style={{ fontSize: 13, color: "var(--sl-accent, #6366f1)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          {t(props.locale, "runs.backToList")}
        </Link>
      </div>
      <PageHeader
        title={t(props.locale, "runs.detail.title")}
        description={
          error
            ? error
            : `HTTP ${httpStatus || "-"}`
        }
        actions={
          <div style={{ display: "flex", gap: 12 }}>
            <button disabled={busy || !canRetry} onClick={retry}>
              {t(props.locale, "runs.action.retry")}
            </button>
            <button disabled={busy || !canCancel} onClick={cancel}>
              {t(props.locale, "runs.action.cancel")}
            </button>
            <button disabled={busy || !canReexec} onClick={reexec}>
              {t(props.locale, "runs.action.reexec")}
            </button>
            <button disabled={busy} onClick={reload}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
            </button>
          </div>
        }
      />

      <Card title={t(props.locale, "runs.detail.runCardTitle")} footer={run ? <Badge>{pickStr(run.status) || "-"}</Badge> : null}>
        <Table>
          <tbody>
            <tr>
              <th>{t(props.locale, "runs.detail.field.runId")}</th>
              <td>{props.runId}</td>
            </tr>
            <tr>
              <th>{t(props.locale, "runs.detail.field.traceId")}</th>
              <td>{run ? pickStr(run.traceId) || "-" : "-"}</td>
            </tr>
            <tr>
              <th>{t(props.locale, "runs.detail.field.toolRef")}</th>
              <td>{run ? pickStr(run.toolRef) || "-" : "-"}</td>
            </tr>
            <tr>
              <th>{t(props.locale, "runs.detail.field.trigger")}</th>
              <td>{run ? pickStr(run.trigger) || "-" : "-"}</td>
            </tr>
            <tr>
              <th>{t(props.locale, "runs.detail.field.createdAt")}</th>
              <td>{run ? pickStr(run.createdAt) || "-" : "-"}</td>
            </tr>
            <tr>
              <th>{t(props.locale, "runs.detail.field.startedAt")}</th>
              <td>{run ? pickStr(run.startedAt) || "-" : "-"}</td>
            </tr>
            <tr>
              <th>{t(props.locale, "runs.detail.field.finishedAt")}</th>
              <td>{run ? pickStr(run.finishedAt) || "-" : "-"}</td>
            </tr>
            <tr>
              <th>{t(props.locale, "runs.detail.sealStatus")}</th>
              <td>
                <Badge>{sealStatus === "sealed" ? t(props.locale, "runs.sealStatus.sealed") : t(props.locale, "runs.sealStatus.legacy")}</Badge>
              </td>
            </tr>
            <tr>
              <th>{t(props.locale, "runs.detail.sealedOutputDigest")}</th>
              <td>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify((run as any)?.sealedOutputDigest ?? null, null, 2)}</pre>
              </td>
            </tr>
          </tbody>
        </Table>
      </Card>

      <Card
        title={t(props.locale, "runs.detail.stepsTitle")}
        footer={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            {evalSuitesError ? <span style={{ color: "crimson" }}>{evalSuitesError}</span> : null}
            <button disabled={evalSuitesBusy} onClick={loadEvalSuites}>
              {evalSuitesBusy ? t(props.locale, "action.loading") : t(props.locale, "runs.evalSuites.load")}
            </button>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "runs.evalSuites.suite")}</span>
              <select value={selectedSuiteId} onChange={(e) => setSelectedSuiteId(e.target.value)} disabled={evalSuitesBusy || !evalSuites.length}>
                {evalSuites.map((s) => (
                  <option key={String(s?.id ?? "")} value={String(s?.id ?? "")}>
                    {String(s?.name ?? s?.id ?? "-")}
                  </option>
                ))}
              </select>
            </label>
            {addCaseError ? <span style={{ color: "crimson" }}>{addCaseError}</span> : null}
            {compError ? <span style={{ color: "crimson" }}>{compError}</span> : null}
          </div>
        }
      >
        <Table>
          <thead>
            <tr>
              <th>{t(props.locale, "runs.steps.seq")}</th>
              <th>{t(props.locale, "runs.steps.status")}</th>
              <th>{t(props.locale, "runs.steps.attempt")}</th>
              <th>{t(props.locale, "runs.steps.toolRef")}</th>
              <th>{t(props.locale, "runs.steps.seal")}</th>
              <th>{t(props.locale, "runs.steps.compensable")}</th>
              <th>{t(props.locale, "runs.steps.compensation")}</th>
              <th>{t(props.locale, "runs.steps.errorCategory")}</th>
              <th>{t(props.locale, "runs.steps.eval")}</th>
              <th>{t(props.locale, "runs.steps.outputDigest")}</th>
            </tr>
          </thead>
          <tbody>
            {stepRows.map((s, idx) => (
              <tr key={`${pickStr(s.stepId)}:${idx}`}>
                <td>{pickStr(s.seq) || "-"}</td>
                <td>
                  <Badge>{pickStr(s.status) || "-"}</Badge>
                </td>
                <td>{pickStr(s.attempt) || "-"}</td>
                <td>{pickStr(s.toolRef) || "-"}</td>
                <td>
                  <Badge>{(s as any).sealedAt ? t(props.locale, "runs.sealStatus.sealed") : t(props.locale, "runs.sealStatus.legacy")}</Badge>
                </td>
                <td>{String((s as any).compensable ?? false)}</td>
                <td>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button disabled={!pickStr(s.stepId) || compBusy === pickStr(s.stepId) || !(s as any).compensable} onClick={() => compensate(pickStr(s.stepId))}>
                      {compBusy === pickStr(s.stepId) ? t(props.locale, "action.loading") : t(props.locale, "runs.steps.compensate")}
                    </button>
                    <button disabled={!pickStr(s.stepId) || compBusy === pickStr(s.stepId)} onClick={() => loadCompensations(pickStr(s.stepId))}>
                      {compBusy === pickStr(s.stepId) ? t(props.locale, "action.loading") : t(props.locale, "runs.steps.history")}
                    </button>
                  </div>
                  {pickStr(s.stepId) && compByStepId[pickStr(s.stepId)] ? (
                    <pre style={{ margin: "8px 0 0 0", whiteSpace: "pre-wrap" }}>{JSON.stringify(compByStepId[pickStr(s.stepId)], null, 2)}</pre>
                  ) : null}
                </td>
                <td>{pickStr(s.errorCategory) || "-"}</td>
                <td>
                  <button disabled={!pickStr(s.stepId) || addCaseBusy === pickStr(s.stepId)} onClick={() => addEvalCaseFromReplay(pickStr(s.stepId))}>
                    {addCaseBusy === pickStr(s.stepId) ? t(props.locale, "action.loading") : t(props.locale, "runs.steps.addEvalCase")}
                  </button>
                </td>
                <td>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(s.outputDigest ?? null, null, 2)}</pre>
                  <pre style={{ margin: "8px 0 0 0", whiteSpace: "pre-wrap" }}>{JSON.stringify((s as any).sealedOutputDigest ?? null, null, 2)}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card title={t(props.locale, "runs.evidenceRefs.title")}>
        {evidenceError ? <div style={{ color: "crimson" }}>{evidenceError}</div> : null}
        {evidenceRefs.length ? (
          <Table>
            <thead>
              <tr>
                <th>{t(props.locale, "runs.evidenceRefs.sourceRef")}</th>
                <th>{t(props.locale, "runs.evidenceRefs.rankReason")}</th>
                <th>{t(props.locale, "runs.evidenceRefs.location")}</th>
                <th>{t(props.locale, "gov.changesets.actions")}</th>
                <th>{t(props.locale, "runs.evidenceRefs.resolved")}</th>
              </tr>
            </thead>
            <tbody>
              {evidenceRefs.map((e, idx) => {
                const rec = e && typeof e === "object" ? (e as any) : null;
                const sr = rec && rec.sourceRef && typeof rec.sourceRef === "object" ? (rec.sourceRef as Record<string, unknown>) : null;
                const key = sr ? `${String(sr.documentId ?? "")}:${String(sr.version ?? "")}:${String(sr.chunkId ?? "")}` : `${idx}`;
                const resolved = evidenceByKey[key] ?? null;
                return (
                  <tr key={key}>
                    <td>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(sr ?? null, null, 2)}</pre>
                    </td>
                    <td>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(rec?.rankReason ?? null, null, 2)}</pre>
                    </td>
                    <td>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(rec?.location ?? null, null, 2)}</pre>
                    </td>
                    <td>
                      <button disabled={!sr || evidenceBusy === key} onClick={() => sr && resolveEvidence(sr)}>
                        {evidenceBusy === key ? t(props.locale, "action.loading") : t(props.locale, "runs.evidenceRefs.resolve")}
                      </button>
                    </td>
                    <td>
                      {resolved ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(resolved, null, 2)}</pre> : "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <div style={{ opacity: 0.8 }}>-</div>
        )}
      </Card>

      <Card
        title={t(props.locale, "runs.replay.title")}
        footer={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            {traceId ? (
              <span style={{ opacity: 0.8 }}>
                {t(props.locale, "runs.replay.traceId")} {traceId}
              </span>
            ) : null}
            <a href={`/gov/audit?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "runs.replay.openAudit")}</a>
            <button disabled={replayBusy} onClick={loadReplay}>
              {replayBusy ? t(props.locale, "action.loading") : t(props.locale, "runs.replay.load")}
            </button>
          </div>
        }
      >
        {replayError ? <div style={{ color: "crimson" }}>{replayError}</div> : null}
        {!replayError && timeline === null ? <div style={{ opacity: 0.8 }}>{t(props.locale, "runs.replay.hint")}</div> : null}
        {timeline ? (
          <Table>
            <thead>
              <tr>
                <th>{t(props.locale, "runs.replay.table.timestamp")}</th>
                <th>{t(props.locale, "runs.replay.table.eventType")}</th>
                <th>{t(props.locale, "runs.replay.table.stepId")}</th>
                <th>{t(props.locale, "runs.replay.table.result")}</th>
                <th>{t(props.locale, "runs.replay.table.detail")}</th>
              </tr>
            </thead>
            <tbody>
              {timeline.map((e, idx) => (
                <tr key={`${pickStr(e.timestamp)}:${pickStr(e.eventType)}:${idx}`}>
                  <td>{pickStr(e.timestamp) || "-"}</td>
                  <td>{pickStr(e.eventType) || "-"}</td>
                  <td>{pickStr(e.stepId) || "-"}</td>
                  <td>{pickStr(e.result) || pickStr(e.errorCategory) || "-"}</td>
                  <td>
                    <details>
                      <summary>{t(props.locale, "runs.replay.viewJson")}</summary>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(e, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </Card>
    </div>
  );
}
