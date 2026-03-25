"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { API_BASE, apiHeaders } from "@/lib/api";
import { t } from "@/lib/i18n";
import { PageHeader } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type WorkbenchRow = { plugin?: any; latestReleased?: any; draft?: any };

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export default function AdminWorkbenchesClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<any>(props.initial && typeof props.initial === "object" ? props.initial : null);
  const [createKey, setCreateKey] = useState("ops.dashboard");
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [artifactRef, setArtifactRef] = useState<string>("");
  const [manifestText, setManifestText] = useState<string>(
    JSON.stringify(
      {
        apiVersion: "workbench.openslin/v1",
        workbenchKey: "ops.dashboard",
        entrypoint: { type: "iframe", assetPath: "index.html" },
        capabilities: { dataBindings: [{ kind: "entities.query" }, { kind: "schema.effective" }], actionBindings: [] },
      },
      null,
      2,
    ),
  );
  const [errorText, setErrorText] = useState<string>("");

  const items = useMemo(() => (Array.isArray(data?.items) ? (data.items as WorkbenchRow[]) : []), [data]);

  async function refresh() {
    const res = await fetch(`${API_BASE}/workbenches`, { headers: apiHeaders(props.locale), cache: "no-store" });
    const json: unknown = await res.json().catch(() => null);
    setData(res.ok ? json : null);
  }

  async function createPlugin() {
    setErrorText("");
    try {
      const res = await fetch(`${API_BASE}/workbenches`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ workbenchKey: createKey }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const o = json && typeof json === "object" ? (json as ApiError) : {};
        throw new Error(`${o.errorCode ?? "ERROR"}: ${res.statusText}`);
      }
      await refresh();
    } catch (e: any) {
      setErrorText(errMsg(e));
    }
  }

  async function saveDraft() {
    setErrorText("");
    if (!selectedKey) return;
    try {
      const manifest = manifestText.trim() ? JSON.parse(manifestText) : null;
      const res = await fetch(`${API_BASE}/workbenches/${encodeURIComponent(selectedKey)}/draft`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ artifactRef, manifest }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const o = json && typeof json === "object" ? (json as ApiError) : {};
        const msgVal = o.message;
        const msg = msgVal && typeof msgVal === "string" ? msgVal : msgVal && typeof msgVal === "object" ? JSON.stringify(msgVal) : res.statusText;
        throw new Error(`${o.errorCode ?? "ERROR"}: ${msg}`);
      }
      await refresh();
    } catch (e: any) {
      setErrorText(errMsg(e));
    }
  }

  return (
    <div>
      <PageHeader title={t(props.locale, "admin.workbenches.title")} description={t(props.locale, "admin.workbenches.description")} />
      <div style={{ marginBottom: 12 }}>
        <input value={createKey} onChange={(e) => setCreateKey(e.target.value)} style={{ width: 260, marginRight: 8 }} />
        <button onClick={createPlugin}>{t(props.locale, "admin.workbenches.create")}</button>
        <button onClick={refresh} style={{ marginLeft: 8 }}>
          {t(props.locale, "admin.workbenches.refresh")}
        </button>
      </div>
      {errorText ? <div style={{ color: "crimson", marginBottom: 12 }}>{errorText}</div> : null}

      <table cellPadding={6} style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th align="left">workbenchKey</th>
            <th align="left">draft</th>
            <th align="left">released</th>
            <th align="left">actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row: WorkbenchRow) => {
            const key = String(row?.plugin?.workbenchKey ?? "");
            const draft = row?.draft ?? null;
            const released = row?.latestReleased ?? null;
            return (
              <tr key={key} style={{ borderTop: "1px solid #ddd" }}>
                <td>{key}</td>
                <td>{draft ? `draft` : ""}</td>
                <td>{released ? `v${released.version}` : ""}</td>
                <td>
                  <button
                    onClick={() => {
                      setSelectedKey(key);
                      setArtifactRef(String(draft?.artifactRef ?? ""));
                      setManifestText(JSON.stringify(draft?.manifestJson ?? null, null, 2));
                      setErrorText("");
                    }}
                    style={{ marginRight: 8 }}
                  >
                    {t(props.locale, "admin.workbenches.editDraft")}
                  </button>
                  <Link href={`/w/${encodeURIComponent(key)}?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "admin.workbenches.open")}</Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {selectedKey ? (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            {t(props.locale, "admin.workbenches.draftEditorPrefix")} {selectedKey}
          </div>
          <div style={{ marginBottom: 8 }}>
            <span style={{ marginRight: 8 }}>artifactRef:</span>
            <input value={artifactRef} onChange={(e) => setArtifactRef(e.target.value)} style={{ width: 520 }} />
            <button onClick={saveDraft} style={{ marginLeft: 8 }}>
              {t(props.locale, "admin.workbenches.saveDraft")}
            </button>
          </div>
          <textarea value={manifestText} onChange={(e) => setManifestText(e.target.value)} style={{ width: "100%", minHeight: 320, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }} />
        </div>
      ) : null}
    </div>
  );
}

