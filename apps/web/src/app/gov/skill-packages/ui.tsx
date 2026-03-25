"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type SkillPackagesResponse = ApiError & { items?: any[] };
type SkillPackageUploadResponse = ApiError & { artifactId?: string; depsDigest?: string; signatureStatus?: string; scanSummary?: unknown; manifestSummary?: unknown };
type ToolPublishResponse = ApiError & { toolRef?: string; version?: any };

function toApiError(e: unknown): ApiError {
  if (e && typeof e === "object") return e as ApiError;
  return { errorCode: "ERROR", message: String(e) };
}

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg =
    msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

function guessFormat(name: string): "zip" | "tgz" {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz") || lower.endsWith(".gz")) return "tgz";
  return "zip";
}

function bytesToBase64(bytes: Uint8Array) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const part = bytes.subarray(i, Math.min(bytes.length, i + chunk));
    bin += String.fromCharCode(...Array.from(part));
  }
  return btoa(bin);
}

export default function GovSkillPackagesClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<SkillPackagesResponse | null>((props.initial as SkillPackagesResponse) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<"zip" | "tgz">("tgz");
  const [uploadStatus, setUploadStatus] = useState<number>(0);
  const [uploadResult, setUploadResult] = useState<SkillPackageUploadResponse | null>(null);

  const [pubToolName, setPubToolName] = useState<string>("echo.tool");
  const [pubArtifactId, setPubArtifactId] = useState<string>("");
  const [pubDepsDigest, setPubDepsDigest] = useState<string>("");
  const [pubStatus, setPubStatus] = useState<number>(0);
  const [pubResult, setPubResult] = useState<ToolPublishResponse | null>(null);

  const items = useMemo(() => (Array.isArray(data?.items) ? data!.items! : []), [data]);
  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  async function refresh() {
    setError("");
    const res = await apiFetch(`/artifacts/skill-packages?limit=50`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as SkillPackagesResponse) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }

  async function copyText(val: string) {
    if (!val) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(val);
    } catch {}
  }

  async function upload() {
    setError("");
    setUploadResult(null);
    setUploadStatus(0);
    if (!file) {
      setError(t(props.locale, "gov.skillPackages.fileRequired"));
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const base64 = bytesToBase64(new Uint8Array(buf));
      const res = await apiFetch(`/artifacts/skill-packages/upload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ archiveFormat: format, archiveBase64: base64 }),
      });
      setUploadStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setUploadResult((json as SkillPackageUploadResponse) ?? null);
      const aid = String((json as any)?.artifactId ?? "");
      if (aid) setPubArtifactId(aid);
      const dd = String((json as any)?.depsDigest ?? "");
      if (dd) setPubDepsDigest(dd);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setError("");
    setPubResult(null);
    setPubStatus(0);
    const name = pubToolName.trim();
    const artifactId = pubArtifactId.trim();
    const depsDigest = pubDepsDigest.trim();
    if (!name) {
      setError(t(props.locale, "gov.skillPackages.toolNameRequired"));
      return;
    }
    if (!artifactId) {
      setError(t(props.locale, "gov.skillPackages.artifactIdRequired"));
      return;
    }
    setBusy(true);
    try {
      const payload: any = { artifactId };
      if (depsDigest) payload.depsDigest = depsDigest;
      const res = await apiFetch(`/tools/${encodeURIComponent(name)}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(payload),
      });
      setPubStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setPubResult((json as ToolPublishResponse) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.skillPackages.title")}
        actions={
          <>
            <Badge>{status}</Badge>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}
      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
        <Card>
          <h3>{t(props.locale, "gov.skillPackages.uploadTitle")}</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="file"
              accept=".zip,.tgz,.tar.gz,application/zip,application/gzip"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0] ?? null;
                setFile(f);
                if (f) setFormat(guessFormat(f.name));
              }}
              disabled={busy}
            />
            <select value={format} onChange={(e) => setFormat(e.currentTarget.value === "zip" ? "zip" : "tgz")} disabled={busy}>
              <option value="tgz">tgz</option>
              <option value="zip">zip</option>
            </select>
            <button onClick={upload} disabled={busy || !file}>
              {t(props.locale, "gov.skillPackages.upload")}
            </button>
            {uploadStatus ? <Badge>{uploadStatus}</Badge> : null}
          </div>
          {uploadResult ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span>{`artifactId=${String(uploadResult.artifactId ?? "")}`}</span>
                <button onClick={() => copyText(String(uploadResult.artifactId ?? ""))} disabled={busy}>
                  {t(props.locale, "action.copy")}
                </button>
              </div>
              <pre style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{JSON.stringify(uploadResult, null, 2)}</pre>
            </div>
          ) : null}
        </Card>

        <Card>
          <h3>{t(props.locale, "gov.skillPackages.publishTitle")}</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input value={pubToolName} onChange={(e) => setPubToolName(e.currentTarget.value)} placeholder={t(props.locale, "gov.skillPackages.placeholder.toolName")} disabled={busy} />
            <input value={pubArtifactId} onChange={(e) => setPubArtifactId(e.currentTarget.value)} placeholder={t(props.locale, "gov.skillPackages.placeholder.artifactId")} disabled={busy} />
            <input value={pubDepsDigest} onChange={(e) => setPubDepsDigest(e.currentTarget.value)} placeholder={t(props.locale, "gov.skillPackages.placeholder.depsDigest")} disabled={busy} />
            <button onClick={publish} disabled={busy}>
              {t(props.locale, "gov.skillPackages.publish")}
            </button>
            {pubStatus ? <Badge>{pubStatus}</Badge> : null}
            {pubResult?.toolRef ? (
              <a href={`/gov/tools?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "gov.skillPackages.openGovTools")}</a>
            ) : null}
          </div>
          {pubResult ? <pre style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{JSON.stringify(pubResult, null, 2)}</pre> : null}
        </Card>

        <Card>
          <h3>{t(props.locale, "gov.skillPackages.recentTitle")}</h3>
          <Table>
            <thead>
              <tr>
                <th align="left">{t(props.locale, "gov.skillPackages.table.artifactId")}</th>
                <th align="left">{t(props.locale, "gov.skillPackages.table.type")}</th>
                <th align="left">{t(props.locale, "gov.skillPackages.table.format")}</th>
                <th align="left">{t(props.locale, "gov.skillPackages.table.createdAt")}</th>
                <th align="left">{t(props.locale, "gov.skillPackages.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r, idx) => {
                const aid = String(r?.artifactId ?? r?.artifact_id ?? "");
                return (
                  <tr key={`${aid || "x"}:${idx}`}>
                    <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{aid || "-"}</td>
                    <td>{String(r?.type ?? "-")}</td>
                    <td>{String(r?.format ?? "-")}</td>
                    <td>{String(r?.createdAt ?? r?.created_at ?? "-")}</td>
                    <td>
                      <button onClick={() => copyText(aid)} disabled={busy || !aid}>
                        {t(props.locale, "action.copy")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
