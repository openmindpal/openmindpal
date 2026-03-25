"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type ChangeSetDetail = {
  changeset?: { id: string; title?: string; status?: string; scope_type?: "tenant" | "space"; scope_id?: string };
  items?: Array<{ id: string; kind: string; payload?: unknown; created_at?: string }>;
} & ApiError;

type PipelineGate = { gateType: string; required: boolean; status: "pass" | "warn" | "fail" | "unknown"; detailsDigest?: unknown };
type Pipeline = {
  changeset: { id: string; title?: string | null; status: string; riskLevel: string; requiredApprovals: number; scopeType: string; scopeId: string; createdAt: string; createdBy: string };
  gates: PipelineGate[];
  rollout: { mode: "full" | "canary"; canaryTargets: string[] | null; canaryReleasedAt: string | null; releasedAt: string | null; promotedAt: string | null; rolledBackAt: string | null };
  warnings: string[];
  rollbackPreviewDigest: { actionCount: number; sha256_8: string };
};

type PipelinePreflightEval = { suiteId?: string; name?: string; passed?: boolean; latestRunId?: string | null };
type PipelinePreflight = { evalGate?: { suites?: PipelinePreflightEval[] } } | null;

type ItemKind =
  | "tool.enable"
  | "tool.disable"
  | "tool.set_active"
  | "model_routing.upsert"
  | "model_routing.disable"
  | "model_limits.set"
  | "tool_limits.set"
  | "artifact_policy.upsert";

function parseItemKind(v: string): ItemKind {
  switch (v) {
    case "tool.enable":
    case "tool.disable":
    case "tool.set_active":
    case "model_routing.upsert":
    case "model_routing.disable":
    case "model_limits.set":
    case "tool_limits.set":
    case "artifact_policy.upsert":
      return v;
    default:
      return "tool.enable";
  }
}

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

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  if (Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

export default function ChangeSetDetailClient(props: { locale: string; changesetId: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<ChangeSetDetail | null>((props.initial as ChangeSetDetail) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState<number>(0);
  const [pipelinePreflight, setPipelinePreflight] = useState<PipelinePreflight>(null);

  const [itemKind, setItemKind] = useState<ItemKind>("tool.enable");
  const [toolRef, setToolRef] = useState<string>("");
  const [toolName, setToolName] = useState<string>("");
  const [purpose, setPurpose] = useState<string>("");
  const [primaryModelRef, setPrimaryModelRef] = useState<string>("");
  const [fallbackModelRefs, setFallbackModelRefs] = useState<string>("");
  const [routingEnabled, setRoutingEnabled] = useState<boolean>(true);
  const [limitsScopeType, setLimitsScopeType] = useState<"tenant" | "space">("space");
  const [limitsScopeId, setLimitsScopeId] = useState<string>("");
  const [modelChatRpm, setModelChatRpm] = useState<string>("");
  const [defaultMaxConcurrency, setDefaultMaxConcurrency] = useState<string>("");
  const [artifactPolicyScopeType, setArtifactPolicyScopeType] = useState<"tenant" | "space">("space");
  const [artifactPolicyScopeId, setArtifactPolicyScopeId] = useState<string>("");
  const [downloadTokenExpiresInSec, setDownloadTokenExpiresInSec] = useState<string>("");
  const [downloadTokenMaxUses, setDownloadTokenMaxUses] = useState<string>("");
  const [watermarkHeadersEnabled, setWatermarkHeadersEnabled] = useState<boolean>(true);
  const [mode, setMode] = useState<"full" | "canary">("full");
  const [preflight, setPreflight] = useState<unknown>(null);
  const [lastActionResult, setLastActionResult] = useState<unknown>(null);

  const cs = data?.changeset ?? null;
  const items = useMemo(() => (Array.isArray(data?.items) ? data!.items! : []), [data]);
  const effectiveScopeType = cs?.scope_type;
  const effectiveScopeId = cs?.scope_id ?? "";

  async function refreshPipeline(nextMode?: "full" | "canary") {
    const useMode = nextMode ?? mode;
    const res = await apiFetch(`/governance/changesets/${encodeURIComponent(props.changesetId)}/pipeline?mode=${encodeURIComponent(useMode)}`, {
      locale: props.locale,
      cache: "no-store",
    });
    setPipelineStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    if (res.ok) {
      const obj = asRecord(json);
      const p = obj ? (obj.pipeline as unknown) : null;
      const pre = obj ? (obj.preflight as unknown) : null;
      setPipeline((p && typeof p === "object" ? (p as Pipeline) : null) ?? null);
      setPipelinePreflight((pre && typeof pre === "object" ? (pre as PipelinePreflight) : null) ?? null);
    }
    return json;
  }

  async function refresh() {
    setError("");
    const res = await apiFetch(`/governance/changesets/${encodeURIComponent(props.changesetId)}`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as ChangeSetDetail) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
    if (res.ok) await refreshPipeline();
  }

  async function runAction(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      const out = await fn();
      setLastActionResult(out);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function addItem() {
    const body =
      itemKind === "tool.set_active"
        ? { kind: itemKind, name: toolName.trim(), toolRef: toolRef.trim() }
        : itemKind === "tool.enable" || itemKind === "tool.disable"
          ? { kind: itemKind, toolRef: toolRef.trim() }
          : itemKind === "model_routing.upsert"
            ? {
                kind: itemKind,
                purpose: purpose.trim(),
                primaryModelRef: primaryModelRef.trim(),
                fallbackModelRefs: fallbackModelRefs
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .slice(0, 10),
                enabled: routingEnabled,
              }
            : itemKind === "model_routing.disable"
              ? { kind: itemKind, purpose: purpose.trim() }
              : itemKind === "model_limits.set"
                ? {
                    kind: itemKind,
                    scopeType: limitsScopeType ?? effectiveScopeType ?? "space",
                    scopeId: (limitsScopeId || effectiveScopeId).trim(),
                    modelChatRpm: Number(modelChatRpm),
                  }
                : itemKind === "tool_limits.set"
                  ? { kind: itemKind, toolRef: toolRef.trim(), defaultMaxConcurrency: Number(defaultMaxConcurrency) }
                  : {
                      kind: itemKind,
                      scopeType: artifactPolicyScopeType,
                      scopeId: artifactPolicyScopeId.trim(),
                      downloadTokenExpiresInSec: Number(downloadTokenExpiresInSec),
                      downloadTokenMaxUses: Number(downloadTokenMaxUses),
                      watermarkHeadersEnabled,
                    };
    await runAction(async () => {
      const res = await apiFetch(`/governance/changesets/${encodeURIComponent(props.changesetId)}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      return json;
    });
  }

  async function submit() {
    await runAction(async () => {
      const res = await apiFetch(`/governance/changesets/${encodeURIComponent(props.changesetId)}/submit`, {
        method: "POST",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      return json;
    });
  }

  async function approve() {
    await runAction(async () => {
      const res = await apiFetch(`/governance/changesets/${encodeURIComponent(props.changesetId)}/approve`, {
        method: "POST",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      return json;
    });
  }

  async function doPreflight() {
    setPreflight(null);
    await runAction(async () => {
      await refreshPipeline(mode);
      const res = await apiFetch(`/governance/changesets/${encodeURIComponent(props.changesetId)}/preflight?mode=${encodeURIComponent(mode)}`, {
        method: "POST",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setPreflight(json);
      return json;
    });
  }

  async function release() {
    await runAction(async () => {
      const res = await apiFetch(`/governance/changesets/${encodeURIComponent(props.changesetId)}/release?mode=${encodeURIComponent(mode)}`, {
        method: "POST",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      return json;
    });
  }

  async function triggerEvalRun(suiteId: string) {
    await runAction(async () => {
      const res = await apiFetch(`/governance/evals/suites/${encodeURIComponent(suiteId)}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ changesetId: props.changesetId, status: "succeeded" }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      return json;
    });
  }

  async function promote() {
    await runAction(async () => {
      const res = await apiFetch(`/governance/changesets/${encodeURIComponent(props.changesetId)}/promote`, {
        method: "POST",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      return json;
    });
  }

  async function rollback() {
    await runAction(async () => {
      const res = await apiFetch(`/governance/changesets/${encodeURIComponent(props.changesetId)}/rollback`, {
        method: "POST",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      return json;
    });
  }

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.changesetDetail.title")}
        description={
          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
            id={props.changesetId} status={cs?.status ?? "-"} scope={cs?.scope_type ?? "-"}:{cs?.scope_id ?? "-"}
          </span>
        }
        actions={
          <>
            <Badge>{status}</Badge>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.changesetDetail.pipelineTitle")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Badge>{pipelineStatus || "-"}</Badge>
            <button onClick={() => refreshPipeline()} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </div>
          {pipeline ? (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <Badge>{pipeline.rollout.mode}</Badge>
                <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                  risk={pipeline.changeset.riskLevel} approvals={pipeline.changeset.requiredApprovals}
                </span>
              </div>
              <div style={{ marginTop: 12 }}>
                <Table header={<span>{t(props.locale, "gov.changesetDetail.gatesTitle")}</span>}>
                  <thead>
                    <tr>
                      <th align="left">gate</th>
                      <th align="left">required</th>
                      <th align="left">status</th>
                      <th align="left">details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(pipeline.gates ?? []).map((g) => (
                      <tr key={g.gateType}>
                        <td>{g.gateType}</td>
                        <td>{g.required ? "yes" : "no"}</td>
                        <td>
                          <Badge>{g.status}</Badge>
                        </td>
                        <td>
                          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(g.detailsDigest ?? null, null, 2)}</pre>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
              {Array.isArray(pipelinePreflight?.evalGate?.suites) && pipelinePreflight.evalGate.suites.length ? (
                <div style={{ marginTop: 12 }}>
                  <Table header={<span>evals</span>}>
                    <thead>
                      <tr>
                        <th align="left">suite</th>
                        <th align="left">passed</th>
                        <th align="left">latestRunId</th>
                        <th align="left">action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pipelinePreflight.evalGate.suites.map((e) => (
                        <tr key={String(e?.suiteId ?? "")}>
                          <td>{e?.name ?? e?.suiteId ?? "-"}</td>
                          <td>{e?.passed ? <Badge>pass</Badge> : <Badge>fail</Badge>}</td>
                          <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                            {e?.latestRunId ? (
                              <Link href={`/gov/evals/runs/${encodeURIComponent(String(e.latestRunId))}?lang=${encodeURIComponent(props.locale)}`}>{String(e.latestRunId)}</Link>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td>
                            <button disabled={busy || !e?.suiteId} onClick={() => triggerEvalRun(String(e.suiteId))}>
                              trigger
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              ) : null}
              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <span>
                    rollbackPreview: actions={pipeline.rollbackPreviewDigest.actionCount} sha256_8={pipeline.rollbackPreviewDigest.sha256_8}
                  </span>
                  {pipeline.warnings?.length ? <Badge>warnings:{pipeline.warnings.length}</Badge> : <Badge>warnings:0</Badge>}
                </div>
                {pipeline.warnings?.length ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(pipeline.warnings, null, 2)}</pre> : null}
              </div>
            </div>
          ) : (
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{t(props.locale, "gov.changesetDetail.pipelineEmpty")}</pre>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.changesetDetail.summaryTitle")}>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(cs, null, 2)}</pre>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.changesetDetail.actionsTitle")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={submit} disabled={busy}>
              {t(props.locale, "gov.action.submit")}
            </button>
            <button onClick={approve} disabled={busy}>
              {t(props.locale, "gov.action.approve")}
            </button>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.action.mode")}</span>
              <select value={mode} onChange={(e) => setMode(e.target.value === "canary" ? "canary" : "full")} disabled={busy}>
                <option value="full">full</option>
                <option value="canary">canary</option>
              </select>
            </label>
            <button onClick={doPreflight} disabled={busy}>
              {t(props.locale, "gov.action.preflight")}
            </button>
            <button onClick={release} disabled={busy}>
              {t(props.locale, "gov.action.release")}
            </button>
            <button onClick={promote} disabled={busy}>
              {t(props.locale, "gov.action.promote")}
            </button>
            <button onClick={rollback} disabled={busy}>
              {t(props.locale, "gov.action.rollback")}
            </button>
          </div>
        </Card>
      </div>

      {preflight ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "gov.changesetDetail.preflightTitle")}>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(preflight, null, 2)}</pre>
          </Card>
        </div>
      ) : null}

      {lastActionResult ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "gov.changesetDetail.lastResultTitle")}>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(lastActionResult, null, 2)}</pre>
          </Card>
        </div>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.changesetDetail.addItemTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 900 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.changesetDetail.itemKind")}</div>
              <select
                value={itemKind}
                onChange={(e) => setItemKind(parseItemKind(e.target.value))}
                disabled={busy}
              >
                <option value="tool.enable">tool.enable</option>
                <option value="tool.disable">tool.disable</option>
                <option value="tool.set_active">tool.set_active</option>
                <option value="model_routing.upsert">model_routing.upsert</option>
                <option value="model_routing.disable">model_routing.disable</option>
                <option value="model_limits.set">model_limits.set</option>
                <option value="tool_limits.set">tool_limits.set</option>
                <option value="artifact_policy.upsert">artifact_policy.upsert</option>
              </select>
            </label>
            {itemKind === "tool.set_active" ? (
              <label style={{ display: "grid", gap: 6 }}>
                <div>{t(props.locale, "gov.changesetDetail.toolName")}</div>
                <input value={toolName} onChange={(e) => setToolName(e.target.value)} disabled={busy} />
              </label>
            ) : null}
            {itemKind === "tool.enable" || itemKind === "tool.disable" || itemKind === "tool.set_active" || itemKind === "tool_limits.set" ? (
              <label style={{ display: "grid", gap: 6 }}>
                <div>{t(props.locale, "gov.changesetDetail.toolRef")}</div>
                <input value={toolRef} onChange={(e) => setToolRef(e.target.value)} disabled={busy} />
              </label>
            ) : null}

            {itemKind === "tool_limits.set" ? (
              <label style={{ display: "grid", gap: 6 }}>
                <div>{t(props.locale, "gov.changesetDetail.defaultMaxConcurrency")}</div>
                <input value={defaultMaxConcurrency} onChange={(e) => setDefaultMaxConcurrency(e.target.value)} disabled={busy} />
              </label>
            ) : null}

            {itemKind === "model_routing.upsert" || itemKind === "model_routing.disable" ? (
              <label style={{ display: "grid", gap: 6 }}>
                <div>{t(props.locale, "gov.changesetDetail.purpose")}</div>
                <input value={purpose} onChange={(e) => setPurpose(e.target.value)} disabled={busy} />
              </label>
            ) : null}

            {itemKind === "model_routing.upsert" ? (
              <>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>{t(props.locale, "gov.changesetDetail.primaryModelRef")}</div>
                  <input value={primaryModelRef} onChange={(e) => setPrimaryModelRef(e.target.value)} disabled={busy} />
                </label>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>{t(props.locale, "gov.changesetDetail.fallbackModelRefs")}</div>
                  <input value={fallbackModelRefs} onChange={(e) => setFallbackModelRefs(e.target.value)} disabled={busy} />
                </label>
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="checkbox" checked={routingEnabled} onChange={(e) => setRoutingEnabled(e.target.checked)} disabled={busy} />
                  <span>{t(props.locale, "gov.changesetDetail.enabled")}</span>
                </label>
              </>
            ) : null}

            {itemKind === "model_limits.set" ? (
              <>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>{t(props.locale, "gov.changesetDetail.scopeType")}</div>
                  <select value={limitsScopeType} onChange={(e) => setLimitsScopeType(e.target.value === "tenant" ? "tenant" : "space")} disabled={busy}>
                    <option value="space">space</option>
                    <option value="tenant">tenant</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>{t(props.locale, "gov.changesetDetail.scopeId")}</div>
                  <input value={limitsScopeId} onChange={(e) => setLimitsScopeId(e.target.value)} disabled={busy} placeholder={effectiveScopeId || ""} />
                </label>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>{t(props.locale, "gov.changesetDetail.modelChatRpm")}</div>
                  <input value={modelChatRpm} onChange={(e) => setModelChatRpm(e.target.value)} disabled={busy} />
                </label>
              </>
            ) : null}

            {itemKind === "artifact_policy.upsert" ? (
              <>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>{t(props.locale, "gov.changesetDetail.scopeType")}</div>
                  <select
                    value={artifactPolicyScopeType}
                    onChange={(e) => setArtifactPolicyScopeType(e.target.value === "tenant" ? "tenant" : "space")}
                    disabled={busy}
                  >
                    <option value="space">space</option>
                    <option value="tenant">tenant</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>{t(props.locale, "gov.changesetDetail.scopeId")}</div>
                  <input value={artifactPolicyScopeId} onChange={(e) => setArtifactPolicyScopeId(e.target.value)} disabled={busy} />
                </label>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>downloadTokenExpiresInSec</div>
                  <input value={downloadTokenExpiresInSec} onChange={(e) => setDownloadTokenExpiresInSec(e.target.value)} disabled={busy} placeholder="300" />
                </label>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>downloadTokenMaxUses</div>
                  <input value={downloadTokenMaxUses} onChange={(e) => setDownloadTokenMaxUses(e.target.value)} disabled={busy} placeholder="1" />
                </label>
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="checkbox" checked={watermarkHeadersEnabled} onChange={(e) => setWatermarkHeadersEnabled(e.target.checked)} disabled={busy} />
                  <span>watermarkHeadersEnabled</span>
                </label>
              </>
            ) : null}
            <div>
              <button
                onClick={addItem}
                disabled={
                  busy ||
                  (itemKind === "tool.set_active" && (!toolRef.trim() || !toolName.trim())) ||
                  ((itemKind === "tool.enable" || itemKind === "tool.disable" || itemKind === "tool_limits.set") && !toolRef.trim()) ||
                  (itemKind === "tool_limits.set" && !defaultMaxConcurrency.trim()) ||
                  ((itemKind === "model_routing.upsert" || itemKind === "model_routing.disable") && !purpose.trim()) ||
                  (itemKind === "model_routing.upsert" && !primaryModelRef.trim()) ||
                  (itemKind === "model_limits.set" && !(limitsScopeId || effectiveScopeId).trim()) ||
                  (itemKind === "model_limits.set" && !modelChatRpm.trim()) ||
                  (itemKind === "artifact_policy.upsert" && !artifactPolicyScopeId.trim()) ||
                  (itemKind === "artifact_policy.upsert" && !downloadTokenExpiresInSec.trim()) ||
                  (itemKind === "artifact_policy.upsert" && !downloadTokenMaxUses.trim())
                }
              >
                {t(props.locale, "action.add")}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table header={<span>{t(props.locale, "gov.changesetDetail.itemsTitle")}</span>}>
          <thead>
            <tr>
              <th align="left">id</th>
              <th align="left">kind</th>
              <th align="left">{t(props.locale, "gov.changesetDetail.payload")}</th>
              <th align="left">{t(props.locale, "gov.changesetDetail.createdAt")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{it.id}</td>
                <td>{it.kind}</td>
                <td>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(it.payload ?? null, null, 2)}</pre>
                </td>
                <td>{it.created_at ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}
