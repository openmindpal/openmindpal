"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type ApiError, errText, safeJsonString, toApiError } from "@/lib/apiError";
import { Card, PageHeader, StatusBadge } from "@/components/ui";

type Plugin = { workbenchKey?: string; displayName?: any; description?: any; status?: string; updatedAt?: string };
type Version = { version?: number; status?: string; artifactRef?: string; manifestJson?: any; manifestDigest?: string; updatedAt?: string };

function pickI18n(locale: string, v: any) {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  if (typeof v[locale] === "string") return v[locale];
  if (typeof v["zh-CN"] === "string") return v["zh-CN"];
  const first = Object.values(v).find((x) => typeof x === "string");
  return typeof first === "string" ? first : "";
}

export default function GovWorkbenchDetailClient(props: { locale: string; workbenchKey: string; initial: any }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [detailRes, setDetailRes] = useState<{ status: number; json: any }>(props.initial?.detail ?? { status: 0, json: null });
  const [effectiveRes, setEffectiveRes] = useState<{ status: number; json: any }>(props.initial?.effective ?? { status: 0, json: null });

  const plugin = useMemo(() => (detailRes?.json?.plugin ?? null) as Plugin | null, [detailRes]);
  const draft = useMemo(() => (detailRes?.json?.draft ?? null) as Version | null, [detailRes]);
  const latestReleased = useMemo(() => (detailRes?.json?.latestReleased ?? null) as Version | null, [detailRes]);

  const [displayName, setDisplayName] = useState<string>(() => pickI18n(props.locale, plugin?.displayName));
  const [description, setDescription] = useState<string>(() => pickI18n(props.locale, plugin?.description));
  const [status, setStatus] = useState<string>(() => String(plugin?.status ?? "enabled"));

  const [artifactRef, setArtifactRef] = useState<string>(() => String(draft?.artifactRef ?? ""));
  const [manifestText, setManifestText] = useState<string>(() => safeJsonString(draft?.manifestJson ?? { workbenchKey: props.workbenchKey, version: 1, title: displayName || props.workbenchKey, panels: [] }));

  const refresh = useCallback(async () => {
    setError("");
    const [dRes, eRes] = await Promise.all([
      apiFetch(`/workbenches/${encodeURIComponent(props.workbenchKey)}`, { locale: props.locale, cache: "no-store" }),
      apiFetch(`/workbenches/${encodeURIComponent(props.workbenchKey)}/effective`, { locale: props.locale, cache: "no-store" }),
    ]);
    const dJson = await dRes.json().catch(() => null);
    const eJson = await eRes.json().catch(() => null);
    setDetailRes({ status: dRes.status, json: dJson });
    setEffectiveRes({ status: eRes.status, json: eJson });
    if (!dRes.ok) setError(errText(props.locale, (dJson as ApiError) ?? { errorCode: String(dRes.status) }));
  }, [props.locale, props.workbenchKey]);

  async function runAction(fn: () => Promise<void>) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function saveMeta() {
    await runAction(async () => {
      const idem = typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function" ? `wb-meta-${(crypto as any).randomUUID()}` : `wb-meta-${Date.now()}`;
      const body: any = {};
      body.displayName = displayName.trim() ? { [props.locale]: displayName.trim() } : null;
      body.description = description.trim() ? { [props.locale]: description.trim() } : null;
      body.status = status === "disabled" ? "disabled" : "enabled";
      const res = await apiFetch(`/workbenches/${encodeURIComponent(props.workbenchKey)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": idem },
        locale: props.locale,
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setNotice(t(props.locale, "gov.workbenches.saved"));
      await refresh();
    });
  }

  async function saveDraft() {
    await runAction(async () => {
      const parsed = JSON.parse(manifestText);
      const idem = typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function" ? `wb-draft-${(crypto as any).randomUUID()}` : `wb-draft-${Date.now()}`;
      const res = await apiFetch(`/workbenches/${encodeURIComponent(props.workbenchKey)}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idem },
        locale: props.locale,
        body: JSON.stringify({ artifactRef: artifactRef.trim(), manifest: parsed }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setNotice(t(props.locale, "gov.workbenches.draftSaved"));
      await refresh();
    });
  }

  async function createChangesetWithItem(kind: "workbench.plugin.publish" | "workbench.plugin.rollback") {
    await runAction(async () => {
      const idem = typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function" ? `cs-${(crypto as any).randomUUID()}` : `cs-${Date.now()}`;
      const csRes = await apiFetch(`/governance/changesets`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idem },
        locale: props.locale,
        body: JSON.stringify({ title: `${kind} ${props.workbenchKey}`, scope: "space" }),
      });
      const csJson = await csRes.json().catch(() => null);
      if (!csRes.ok) throw toApiError(csJson);
      const csId = String((csJson as any)?.changeset?.id ?? "");
      if (!csId) throw toApiError({ errorCode: "INTERNAL_ERROR", message: t(props.locale, "error.missingChangesetId") });
      const itemRes = await apiFetch(`/governance/changesets/${encodeURIComponent(csId)}/items`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idem },
        locale: props.locale,
        body: JSON.stringify({ kind, workbenchKey: props.workbenchKey }),
      });
      const itemJson = await itemRes.json().catch(() => null);
      if (!itemRes.ok) throw toApiError(itemJson);
      router.push(`/gov/changesets/${encodeURIComponent(csId)}?lang=${encodeURIComponent(props.locale)}`);
    });
  }

  return (
    <div>
      <PageHeader
        title={`${t(props.locale, "gov.workbenches.detailTitle")}: ${props.workbenchKey}`}
        actions={
          <>
            <StatusBadge locale={props.locale} status={detailRes.status} />
            <StatusBadge locale={props.locale} status={effectiveRes.status} />
            <button onClick={refresh} disabled={busy}>{t(props.locale, "action.refresh")}</button>
            <Link href={`/gov/workbenches?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "action.back")}</Link>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {notice ? <pre style={{ color: "seagreen", whiteSpace: "pre-wrap" }}>{notice}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.workbenches.metaTitle")}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>
              <div className="muted">{t(props.locale, "gov.workbenches.field.displayName")}</div>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
            <label>
              <div className="muted">{t(props.locale, "gov.workbenches.field.status")}</div>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="enabled">enabled</option>
                <option value="disabled">disabled</option>
              </select>
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              <div className="muted">{t(props.locale, "gov.workbenches.field.description")}</div>
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={saveMeta} disabled={busy}>{t(props.locale, "action.save")}</button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.workbenches.effectiveTitle")}>
          <pre style={{ whiteSpace: "pre-wrap" }}>{safeJsonString(effectiveRes?.json ?? null)}</pre>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.workbenches.versionsTitle")}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{t(props.locale, "gov.workbenches.draftTitle")}</div>
              <pre style={{ whiteSpace: "pre-wrap" }}>{safeJsonString(draft)}</pre>
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{t(props.locale, "gov.workbenches.releasedTitle")}</div>
              <pre style={{ whiteSpace: "pre-wrap" }}>{safeJsonString(latestReleased)}</pre>
            </div>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => void createChangesetWithItem("workbench.plugin.publish")} disabled={busy}>
              {t(props.locale, "gov.workbenches.action.publishViaChangeset")}
            </button>
            <button onClick={() => void createChangesetWithItem("workbench.plugin.rollback")} disabled={busy}>
              {t(props.locale, "gov.workbenches.action.rollbackViaChangeset")}
            </button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.workbenches.draftEditTitle")}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
            <label>
              <div className="muted">{t(props.locale, "gov.workbenches.field.artifactRef")}</div>
              <input value={artifactRef} onChange={(e) => setArtifactRef(e.target.value)} placeholder="artifact://..." />
            </label>
            <label>
              <div className="muted">{t(props.locale, "gov.workbenches.field.manifestJson")}</div>
              <textarea value={manifestText} onChange={(e) => setManifestText(e.target.value)} rows={18} style={{ width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }} />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={saveDraft} disabled={busy || !artifactRef.trim()}>{t(props.locale, "action.save")}</button>
          </div>
        </Card>
      </div>
    </div>
  );
}
