"use client";

import { useMemo, useState } from "react";
import { API_BASE, apiHeaders, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };

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

export default function ModelGatewayClient(props: { locale: string }) {
  const [purpose, setPurpose] = useState<string>("test");
  const [modelRef, setModelRef] = useState<string>("");
  const [message, setMessage] = useState<string>("hello");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [result, setResult] = useState<unknown>(null);
  const [status, setStatus] = useState<number>(0);

  async function invoke() {
    setError("");
    setBusy(true);
    setResult(null);
    try {
      const body = {
        purpose: purpose.trim() || "test",
        modelRef: modelRef.trim() ? modelRef.trim() : undefined,
        messages: [{ role: "user", content: message }],
      };
      const res = await fetch(`${API_BASE}/models/chat`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setResult(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const routingDecision = useMemo(() => {
    const o = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    return o.routingDecision;
  }, [result]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.modelGateway.title")}
        actions={
          <>
            <Badge>{status || "-"}</Badge>
            <button onClick={invoke} disabled={busy}>
              {t(props.locale, "gov.modelGateway.invoke")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.modelGateway.formTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.modelGateway.purpose")}</div>
              <input value={purpose} onChange={(e) => setPurpose(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.modelGateway.modelRef")}</div>
              <input value={modelRef} onChange={(e) => setModelRef(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.modelGateway.modelRefPlaceholder")} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.modelGateway.message")}</div>
              <textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} disabled={busy} />
            </label>
            <div>
              <button onClick={invoke} disabled={busy}>
                {busy ? t(props.locale, "action.loading") : t(props.locale, "gov.modelGateway.invoke")}
              </button>
            </div>
          </div>
        </Card>
      </div>

      {routingDecision ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "gov.modelGateway.routingDecision")}>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(routingDecision, null, 2)}</pre>
          </Card>
        </div>
      ) : null}

      {result ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "gov.modelGateway.resultTitle")}>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(result, null, 2)}</pre>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

