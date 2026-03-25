"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type RetrievalLog = Record<string, unknown>;
type RetrievalLogResp = ApiError & { log?: RetrievalLog };
type EvidenceResolveResp = ApiError & { evidence?: Record<string, unknown> };

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

function pickArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export default function RetrievalLogDetailClient(props: { locale: string; id: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<number>(0);
  const [data, setData] = useState<RetrievalLogResp | null>(null);

  const [evidenceBusy, setEvidenceBusy] = useState<string>("");
  const [evidenceError, setEvidenceError] = useState<string>("");
  const [evidenceByKey, setEvidenceByKey] = useState<Record<string, Record<string, unknown>>>({});

  async function load() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/knowledge/retrieval-logs/${encodeURIComponent(props.id)}`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setData((json as RetrievalLogResp) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const log = data?.log ?? null;
  const ranked = useMemo(() => {
    const rec = asRecord(log);
    const v = rec ? rec.rankedEvidenceRefs : null;
    return pickArr(v);
  }, [log]);

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
      const out = (json as EvidenceResolveResp) ?? {};
      if (!out.evidence || typeof out.evidence !== "object") throw ({ errorCode: "ERROR", message: "missing evidence" } satisfies ApiError);
      setEvidenceByKey((prev) => ({ ...prev, [key]: out.evidence as Record<string, unknown> }));
    } catch (e: unknown) {
      setEvidenceError(errText(props.locale, toApiError(e)));
    } finally {
      setEvidenceBusy("");
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={`${t(props.locale, "gov.nav.knowledgeLogs")}: ${props.id}`}
        actions={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Badge>{status || "-"}</Badge>
            <button disabled={busy} onClick={load}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      <Card title={t(props.locale, "gov.knowledgeLogs.detail.logTitle")}>
        <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(log, null, 2)}</pre>
      </Card>

      <Card title={t(props.locale, "gov.knowledgeLogs.detail.rankedEvidenceRefsTitle")}>
        {evidenceError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{evidenceError}</pre> : null}
        <Table>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.knowledgeLogs.detail.table.sourceRef")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeLogs.detail.table.rankReason")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeLogs.detail.table.snippetDigest")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeLogs.detail.table.location")}</th>
              <th align="left">{t(props.locale, "gov.changesets.actions")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeLogs.detail.table.resolved")}</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((e, idx) => {
              const rec = asRecord(e);
              const sr = rec && asRecord(rec.sourceRef);
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
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(rec?.snippetDigest ?? null, null, 2)}</pre>
                  </td>
                  <td>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(rec?.location ?? null, null, 2)}</pre>
                  </td>
                  <td>
                    <button disabled={!sr || evidenceBusy === key} onClick={() => sr && resolveEvidence(sr)}>
                      {evidenceBusy === key ? t(props.locale, "action.loading") : t(props.locale, "gov.knowledgeLogs.detail.resolve")}
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
      </Card>
    </div>
  );
}
