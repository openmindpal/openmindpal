"use client";

import { useCallback, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { Card, PageHeader, Table, StatusBadge } from "@/components/ui";
import { useUndoToast, UndoToastContainer } from "@/components/ui/UndoToast";
import { nextId } from "@/lib/apiError";

type Binding = { id?: string; modelRef?: string; provider?: string; model?: string; baseUrl?: string | null; chatCompletionsPath?: string | null; connectorInstanceId?: string; secretId?: string; secretIds?: string[]; status?: string; updatedAt?: string };

type ProviderKey = "openai_compatible" | "deepseek" | "hunyuan" | "qianwen" | "doubao" | "zhipu" | "kimi";
type OnboardResult = { modelRef: string; provider: string; model: string; baseUrl: string | null; binding?: Binding };

export default function GovModelsClient(props: { locale: string; initial: any }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [bindings, setBindings] = useState<{ status: number; json: any }>(props.initial?.bindings ?? { status: 0, json: null });
  const [, setCatalog] = useState<{ status: number; json: any }>(props.initial?.catalog ?? { status: 0, json: null });

  const bindingItems = useMemo(() => (Array.isArray(bindings?.json?.bindings) ? (bindings.json.bindings as Binding[]) : []), [bindings]);

  const [providerKey, setProviderKey] = useState<ProviderKey>("deepseek");
  const [baseUrl, setBaseUrl] = useState("");
  const [chatCompletionsPath, setChatCompletionsPath] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [lastSaved, setLastSaved] = useState<OnboardResult | null>(null);
  const [testOutput, setTestOutput] = useState<{ outputText: string; traceId: string } | null>(null);
  const [testError, setTestError] = useState<string>("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  /* Undo toast for delete operations (§07§6 Delay Window) */
  const { toasts: undoToasts, enqueue: enqueueUndo, undo: undoAction } = useUndoToast();

  const refreshCatalog = useCallback(async () => {
    const res = await apiFetch(`/models/catalog`, { locale: props.locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    setCatalog({ status: res.status, json });
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.locale]);

  const refreshBindings = useCallback(async () => {
    const res = await apiFetch(`/models/bindings`, { locale: props.locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    setBindings({ status: res.status, json });
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.locale]);

  async function runAction(fn: () => Promise<void>) {
    setError("");
    setNotice("");
    setTestError("");
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function saveOnboard() {
    await runAction(async () => {
      setTestOutput(null);
      setTestError("");
      setNotice("");
      const idem =
        typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function" ? `model-onboard-${(crypto as any).randomUUID()}` : `model-onboard-${Date.now()}`;
      const res = await apiFetch(`/models/onboard`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idem },
        locale: props.locale,
        body: JSON.stringify({ provider: providerKey, baseUrl, chatCompletionsPath: chatCompletionsPath.trim() || undefined, apiKey, modelName }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const modelRef = String((json as any)?.modelRef ?? "");
      const provider = String((json as any)?.provider ?? "");
      const model = String((json as any)?.model ?? "");
      const savedBaseUrl = (json as any)?.baseUrl != null ? String((json as any).baseUrl) : null;
      const testPassed = Boolean((json as any)?.connectionTestPassed);
      setLastSaved({ modelRef, provider, model, baseUrl: savedBaseUrl, binding: (json as any)?.binding ?? null });
      setApiKey("");
      await refreshBindings();
      await refreshCatalog();
      setNotice(testPassed ? t(props.locale, "gov.models.testAndSaveSuccess") : t(props.locale, "gov.models.saved"));
    });
  }

  async function testModel(modelRef: string) {
    await runAction(async () => {
      const idem = typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function"
        ? `model-test-${(crypto as any).randomUUID()}` : `model-test-${Date.now()}`;
      const res = await apiFetch(`/models/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idem },
        locale: props.locale,
        body: JSON.stringify({
          purpose: "gov.models.test",
          modelRef,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setTestOutput(null);
        setTestError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
        return;
      }
      setTestError("");
      setTestOutput({ outputText: String((json as any)?.outputText ?? ""), traceId: String((json as any)?.traceId ?? "") });
    });
  }

  async function deleteModel(bindingId: string) {
    /* Use UndoToast delay-confirm instead of browser confirm() (§07§6) */
    const undoId = nextId("undo");
    setDeletingId(bindingId);
    setError("");
    setNotice("");
    enqueueUndo({
      id: undoId,
      label: `${t(props.locale, "gov.models.action.delete")} ${bindingId}`,
      durationMs: 5000,
      onConfirm: async () => {
        try {
          const idem = typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function"
            ? `model-delete-${(crypto as any).randomUUID()}` : `model-delete-${Date.now()}`;
          const res = await apiFetch(`/models/bindings/${encodeURIComponent(bindingId)}`, {
            method: "DELETE",
            headers: { "idempotency-key": idem },
            locale: props.locale,
          });
          const json = await res.json().catch(() => null);
          if (!res.ok) {
            setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
            return;
          }
          setNotice(t(props.locale, "gov.models.deleted"));
          await refreshBindings();
        } catch (e: any) {
          setError(errText(props.locale, toApiError(e)));
        } finally {
          setDeletingId(null);
        }
      },
      onUndo: () => {
        setDeletingId(null);
      },
    });
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.models.title")}
        actions={
          <>
            <StatusBadge locale={props.locale} status={bindings.status} />
            <button onClick={refreshBindings} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {notice ? <pre style={{ color: "seagreen", whiteSpace: "pre-wrap" }}>{notice}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.models.bindingsTitle")}>
          <Table>
            <thead>
              <tr>
                <th>{t(props.locale, "gov.models.table.modelRef")}</th>
                <th>{t(props.locale, "gov.models.table.provider")}</th>
                <th>{t(props.locale, "gov.models.table.model")}</th>
                <th>{t(props.locale, "gov.models.table.baseUrl")}</th>
                <th>{t(props.locale, "gov.models.table.connectorInstanceId")}</th>
                <th>{t(props.locale, "gov.models.table.secrets")}</th>
                <th>{t(props.locale, "gov.models.table.status")}</th>
                <th>{t(props.locale, "gov.models.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {bindingItems.map((b, idx) => (
                <tr key={String(b.id ?? b.modelRef ?? idx)}>
                  <td>{String(b.modelRef ?? "")}</td>
                  <td>{String(b.provider ?? "")}</td>
                  <td>{String(b.model ?? "")}</td>
                  <td>{String(b.baseUrl ?? "")}</td>
                  <td>{String(b.connectorInstanceId ?? "")}</td>
                  <td>{Array.isArray(b.secretIds) && b.secretIds.length ? String(b.secretIds.length) : b.secretId ? "1" : "0"}</td>
                  <td>{String(b.status ?? "")}</td>
                  <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button onClick={() => testModel(String(b.modelRef ?? ""))} disabled={busy || !String(b.modelRef ?? "")}>
                      {t(props.locale, "action.test")}
                    </button>
                    <button
                      onClick={() => deleteModel(String(b.id ?? ""))}
                      disabled={busy || deletingId === String(b.id ?? "") || !String(b.id ?? "")}
                      style={{ color: "crimson" }}
                    >
                      {deletingId === String(b.id ?? "")
                        ? t(props.locale, "gov.models.action.deleting")
                        : t(props.locale, "gov.models.action.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.models.onboardTitle")}>
          <div style={{ display: "grid", gap: 10, marginTop: 12, maxWidth: 820 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.models.provider")}</div>
              <select value={providerKey} onChange={(e) => setProviderKey(e.target.value as ProviderKey)} disabled={busy}>
                <option value="deepseek">{t(props.locale, "gov.models.provider.deepseek")}</option>
                <option value="hunyuan">{t(props.locale, "gov.models.provider.hunyuan")}</option>
                <option value="qianwen">{t(props.locale, "gov.models.provider.qianwen")}</option>
                <option value="doubao">{t(props.locale, "gov.models.provider.doubao")}</option>
                <option value="zhipu">{t(props.locale, "gov.models.provider.zhipu")}</option>
                <option value="kimi">{t(props.locale, "gov.models.provider.kimi")}</option>
                <option value="openai_compatible">{t(props.locale, "gov.models.provider.openai_compatible")}</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.models.baseUrl")}</div>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={busy} placeholder="https://api.openai.com" />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.models.chatPath")}</div>
              <input value={chatCompletionsPath} onChange={(e) => setChatCompletionsPath(e.target.value)} disabled={busy} placeholder="/chat/completions" />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.models.apiKey")}</div>
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={busy} type="password" />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.models.modelName")}</div>
              <input value={modelName} onChange={(e) => setModelName(e.target.value)} disabled={busy} placeholder="deepseek-v3" />
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={saveOnboard} disabled={busy || !baseUrl.trim() || !apiKey || !modelName.trim()}>
                {busy ? t(props.locale, "gov.models.testingAndSaving") : t(props.locale, "gov.models.testAndSave")}
              </button>
              <button onClick={() => (lastSaved?.modelRef ? testModel(lastSaved.modelRef) : null)} disabled={busy || !lastSaved?.modelRef}>
                {t(props.locale, "action.test")}
              </button>
              {lastSaved?.modelRef ? <span>{`${t(props.locale, "gov.models.modelRef")}: ${lastSaved.modelRef}`}</span> : null}
            </div>
          </div>
        </Card>
      </div>

      {testError ? <pre style={{ marginTop: 12, color: "crimson", whiteSpace: "pre-wrap" }}>{testError}</pre> : null}
      {testOutput ? (
        <div style={{ marginTop: 12 }}>
          <Card title={t(props.locale, "gov.models.testResult")}>
            <pre style={{ whiteSpace: "pre-wrap" }}>{testOutput.outputText}</pre>
            <div>{testOutput.traceId ? `traceId=${testOutput.traceId}` : ""}</div>
          </Card>
        </div>
      ) : null}

      {/* Undo Toast */}
      <UndoToastContainer toasts={undoToasts} onUndo={undoAction} undoLabel={t(props.locale, "action.undo")} />
    </div>
  );
}
