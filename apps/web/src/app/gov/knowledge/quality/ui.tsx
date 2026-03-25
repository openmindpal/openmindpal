"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type EvalSet = Record<string, unknown>;
type EvalRun = Record<string, unknown>;
type EvalSetsResp = ApiError & { sets?: EvalSet[] };
type EvalRunsResp = ApiError & { runs?: EvalRun[] };
type CreateSetResp = ApiError & { set?: EvalSet };
type RunResp = ApiError & { run?: EvalRun };

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

export default function KnowledgeQualityClient(props: { locale: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<number>(0);

  const [sets, setSets] = useState<EvalSetsResp | null>(null);
  const [runs, setRuns] = useState<EvalRunsResp | null>(null);

  const [createName, setCreateName] = useState("baseline");
  const [createDescription, setCreateDescription] = useState("");
  const [createQueriesText, setCreateQueriesText] = useState(
    JSON.stringify(
      [
        { query: "hello knowledge", expectedDocumentIds: ["00000000-0000-0000-0000-000000000000"], k: 5 },
      ],
      null,
      2,
    ),
  );

  const setRows = useMemo(() => (Array.isArray(sets?.sets) ? sets!.sets! : []), [sets]);
  const runRows = useMemo(() => (Array.isArray(runs?.runs) ? runs!.runs! : []), [runs]);

  async function refresh(selectedEvalSetId?: string) {
    setError("");
    setBusy(true);
    try {
      const sRes = await apiFetch(`/governance/knowledge/quality/eval-sets?limit=50`, { locale: props.locale, cache: "no-store" });
      setStatus(sRes.status);
      const sJson: unknown = await sRes.json().catch(() => null);
      if (!sRes.ok) throw toApiError(sJson);
      setSets((sJson as EvalSetsResp) ?? null);

      const id = selectedEvalSetId ?? (() => {
        const arr = (sJson as any)?.sets;
        const first = Array.isArray(arr) && arr.length ? arr[0] : null;
        return first && typeof first === "object" ? String((first as any).id ?? "") : "";
      })();
      const q = new URLSearchParams();
      q.set("limit", "50");
      if (id) q.set("evalSetId", id);
      const rRes = await apiFetch(`/governance/knowledge/quality/runs?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      const rJson: unknown = await rRes.json().catch(() => null);
      if (!rRes.ok) throw toApiError(rJson);
      setRuns((rJson as EvalRunsResp) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function createSet() {
    setError("");
    setBusy(true);
    try {
      const parsed = JSON.parse(createQueriesText);
      const res = await apiFetch(`/governance/knowledge/quality/eval-sets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ name: createName, description: createDescription || undefined, queries: parsed }),
      });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as CreateSetResp) ?? {};
      const id = out.set && typeof out.set === "object" ? String((out.set as any).id ?? "") : "";
      await refresh(id || undefined);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function runEval(evalSetId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/knowledge/quality/eval-sets/${encodeURIComponent(evalSetId)}/runs`, {
        method: "POST",
        locale: props.locale,
      });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as RunResp) ?? {};
      const run = out.run && typeof out.run === "object" ? (out.run as EvalRun) : null;
      const setId = run ? String((run as any).evalSetId ?? evalSetId) : evalSetId;
      await refresh(setId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "gov.nav.knowledgeQuality")}
        actions={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Badge>{status || "-"}</Badge>
            <button disabled={busy} onClick={() => refresh()}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      <Card title={t(props.locale, "gov.knowledgeQuality.createEvalSetTitle")}>
        <div style={{ display: "grid", gap: 10, maxWidth: 920 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "gov.knowledgeQuality.form.name")}</div>
            <input value={createName} onChange={(e) => setCreateName(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "gov.knowledgeQuality.form.description")}</div>
            <input value={createDescription} onChange={(e) => setCreateDescription(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "gov.knowledgeQuality.form.queriesJson")}</div>
            <textarea value={createQueriesText} onChange={(e) => setCreateQueriesText(e.target.value)} rows={10} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }} />
          </label>
          <div>
            <button disabled={busy || !createName.trim()} onClick={createSet}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.create")}
            </button>
          </div>
        </div>
      </Card>

      <Card title={t(props.locale, "gov.knowledgeQuality.evalSetsTitle")}>
        <Table header={<span>{setRows.length ? `${setRows.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.table.id")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.table.name")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.table.createdAt")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.table.queries")}</th>
              <th align="left">{t(props.locale, "gov.changesets.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {setRows.map((s) => {
              const rec = asRecord(s);
              const id = rec ? String(rec.id ?? "") : "";
              const name = rec ? String(rec.name ?? "") : "";
              const queries = rec ? (rec.queries as unknown) : null;
              const qCount = Array.isArray(queries) ? queries.length : 0;
              return (
                <tr key={id}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{id}</td>
                  <td>{name || "-"}</td>
                  <td>{rec ? String(rec.createdAt ?? "-") : "-"}</td>
                  <td>{qCount}</td>
                  <td>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button disabled={!id || busy} onClick={() => refresh(id)}>
                        {t(props.locale, "gov.knowledgeQuality.action.runs")}
                      </button>
                      <button disabled={!id || busy} onClick={() => runEval(id)}>
                        {t(props.locale, "gov.knowledgeQuality.action.run")}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card title={t(props.locale, "gov.knowledgeQuality.runsTitle")}>
        <Table header={<span>{runRows.length ? `${runRows.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.runsTable.id")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.runsTable.status")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.runsTable.createdAt")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.runsTable.metrics")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.runsTable.detail")}</th>
            </tr>
          </thead>
          <tbody>
            {runRows.map((r, idx) => {
              const rec = asRecord(r);
              const id = rec ? String(rec.id ?? idx) : String(idx);
              return (
                <tr key={id}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{id}</td>
                  <td>{rec ? String(rec.status ?? "-") : "-"}</td>
                  <td>{rec ? String(rec.createdAt ?? "-") : "-"}</td>
                  <td>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(rec?.metrics ?? null, null, 2)}</pre>
                  </td>
                  <td>
                    <details>
                      <summary>{t(props.locale, "gov.knowledgeQuality.json")}</summary>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(r, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
