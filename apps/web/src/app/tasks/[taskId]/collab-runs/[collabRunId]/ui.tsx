"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type RunLite = { runId: string; status: string; toolRef?: string | null; policySnapshotRef?: string | null; idempotencyKey?: string | null; createdAt?: string; updatedAt?: string };
type CollabDetailResp = { collabRun?: unknown; runs?: RunLite[]; latestEvents?: unknown[]; taskState?: unknown } & ApiError;
type EnvelopesResp = { items?: unknown[]; nextBefore?: string | null } & ApiError;
type EventsResp = { items?: unknown[]; nextBefore?: string | null } & ApiError;

function toApiError(e: unknown): ApiError {
  if (e && typeof e === "object") return e as ApiError;
  return { errorCode: "ERROR", message: String(e) };
}

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg = msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

export default function CollabRunClient(props: {
  locale: string;
  taskId: string;
  collabRunId: string;
  initial: unknown;
  initialStatus: number;
  initialEnvelopes: unknown;
  initialEnvelopesStatus: number;
}) {
  const [data, setData] = useState<CollabDetailResp | null>((props.initial as CollabDetailResp) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [envData, setEnvData] = useState<EnvelopesResp | null>((props.initialEnvelopes as EnvelopesResp) ?? null);
  const [envStatus, setEnvStatus] = useState<number>(props.initialEnvelopesStatus);
  const [eventsData, setEventsData] = useState<EventsResp | null>({ items: asArray((props.initial as any)?.latestEvents) });
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const [envFromRole, setEnvFromRole] = useState<string>("planner");
  const [envToRole, setEnvToRole] = useState<string>("arbiter");
  const [envKind, setEnvKind] = useState<string>("message");
  const [envCorrelationId, setEnvCorrelationId] = useState<string>("");
  const [envPayload, setEnvPayload] = useState<string>("");

  const [commitCorrelationId, setCommitCorrelationId] = useState<string>("");
  const [commitStatus, setCommitStatus] = useState<string>("executing");
  const [commitDecision, setCommitDecision] = useState<string>("");

  const collabRun = data?.collabRun ?? null;
  const taskState = (data as any)?.taskState ?? null;
  const runs = useMemo(() => (Array.isArray(data?.runs) ? (data!.runs as RunLite[]) : []), [data]);
  const envelopes = useMemo(() => (Array.isArray(envData?.items) ? envData!.items! : []), [envData]);
  const events = useMemo(() => (Array.isArray(eventsData?.items) ? eventsData!.items! : []), [eventsData]);

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    if (envStatus >= 400) return errText(props.locale, envData);
    return "";
  }, [data, envData, envStatus, props.locale, status]);

  const inferredPlanCorrelationId = useMemo(() => {
    for (const e of events) {
      const type = typeof (e as any)?.type === "string" ? String((e as any).type) : "";
      const corr = typeof (e as any)?.correlationId === "string" ? String((e as any).correlationId) : "";
      if (type === "collab.plan.generated" && corr) return corr;
    }
    return "";
  }, [events]);

  async function refresh() {
    setError("");
    const dRes = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/collab-runs/${encodeURIComponent(props.collabRunId)}`, {
      locale: props.locale,
      cache: "no-store",
    });
    setStatus(dRes.status);
    const dJson: unknown = await dRes.json().catch(() => null);
    setData((dJson as CollabDetailResp) ?? null);

    const eRes = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/collab-runs/${encodeURIComponent(props.collabRunId)}/events?limit=50`, {
      locale: props.locale,
      cache: "no-store",
    });
    const eJson: unknown = await eRes.json().catch(() => null);
    if (eRes.ok) setEventsData((eJson as EventsResp) ?? null);

    const envRes = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/collab-runs/${encodeURIComponent(props.collabRunId)}/envelopes?limit=50`, {
      locale: props.locale,
      cache: "no-store",
    });
    setEnvStatus(envRes.status);
    const envJson: unknown = await envRes.json().catch(() => null);
    setEnvData((envJson as EnvelopesResp) ?? null);

    if (!dRes.ok) setError(errText(props.locale, (dJson as ApiError) ?? { errorCode: String(dRes.status) }));
    else if (!envRes.ok) setError(errText(props.locale, (envJson as ApiError) ?? { errorCode: String(envRes.status) }));
  }

  async function runAction(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function sendEnvelope() {
    if (!envPayload.trim()) return;
    await runAction(async () => {
      const payloadParsed = (() => {
        try {
          return JSON.parse(envPayload);
        } catch {
          return { text: envPayload.trim().slice(0, 20_000) };
        }
      })();
      const res = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/collab-runs/${encodeURIComponent(props.collabRunId)}/envelopes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          fromRole: envFromRole.trim().slice(0, 50),
          toRole: envToRole.trim().slice(0, 50),
          kind: envKind.trim().slice(0, 50),
          correlationId: envCorrelationId.trim().slice(0, 200) || undefined,
          payloadRedacted: payloadParsed,
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setEnvPayload("");
    });
  }

  async function arbiterCommit() {
    const corr = (commitCorrelationId || inferredPlanCorrelationId).trim();
    if (!corr) return;
    await runAction(async () => {
      const res = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/collab-runs/${encodeURIComponent(props.collabRunId)}/arbiter/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          actorRole: "arbiter",
          correlationId: corr.slice(0, 200),
          status: commitStatus ? commitStatus : undefined,
          decisionRedacted: commitDecision.trim() ? { text: commitDecision.trim().slice(0, 20_000) } : undefined,
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
    });
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "collab.detailTitle")}
        description={
          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
            taskId={props.taskId} collabRunId={props.collabRunId}
          </span>
        }
        actions={
          <>
            <Badge>{status}</Badge>
            <Badge>{envStatus}</Badge>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "collab.summaryTitle")}>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(collabRun, null, 2)}</pre>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "collab.taskStateTitle")}>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(taskState, null, 2)}</pre>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table header={<span>{t(props.locale, "collab.runsTitle")}</span>}>
          <thead>
            <tr>
              <th align="left">runId</th>
              <th align="left">status</th>
              <th align="left">toolRef</th>
              <th align="left">createdAt</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.runId}>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                  <Link href={`/runs/${encodeURIComponent(r.runId)}?lang=${encodeURIComponent(props.locale)}`}>{r.runId}</Link>
                </td>
                <td>
                  <Badge>{r.status}</Badge>
                </td>
                <td>{r.toolRef ?? "-"}</td>
                <td>{r.createdAt ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "collab.arbiterTitle")}>
          <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
            <div>
              correlationId{" "}
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                {inferredPlanCorrelationId ? `(plan=${inferredPlanCorrelationId})` : ""}
              </span>
            </div>
            <input value={commitCorrelationId} onChange={(e) => setCommitCorrelationId(e.target.value)} />
            <div>status</div>
            <select value={commitStatus} onChange={(e) => setCommitStatus(e.target.value)}>
              <option value="executing">executing</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
              <option value="canceled">canceled</option>
              <option value="stopped">stopped</option>
            </select>
            <div>{t(props.locale, "collab.decisionTitle")}</div>
            <textarea value={commitDecision} onChange={(e) => setCommitDecision(e.target.value)} rows={3} />
            <button onClick={arbiterCommit} disabled={busy || !(commitCorrelationId.trim() || inferredPlanCorrelationId)}>
              {t(props.locale, "collab.commitButton")}
            </button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "collab.envelopeSendTitle")}>
          <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <div>
                <div>fromRole</div>
                <input value={envFromRole} onChange={(e) => setEnvFromRole(e.target.value)} />
              </div>
              <div>
                <div>toRole</div>
                <input value={envToRole} onChange={(e) => setEnvToRole(e.target.value)} />
              </div>
              <div>
                <div>kind</div>
                <input value={envKind} onChange={(e) => setEnvKind(e.target.value)} />
              </div>
            </div>
            <div>correlationId</div>
            <input value={envCorrelationId} onChange={(e) => setEnvCorrelationId(e.target.value)} />
            <div>{t(props.locale, "collab.envelopePayloadLabel")}</div>
            <textarea value={envPayload} onChange={(e) => setEnvPayload(e.target.value)} rows={4} />
            <button onClick={sendEnvelope} disabled={busy || !envPayload.trim()}>
              {t(props.locale, "collab.sendButton")}
            </button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table header={<span>{t(props.locale, "collab.eventsTitle")}</span>}>
          <thead>
            <tr>
              <th align="left">createdAt</th>
              <th align="left">type</th>
              <th align="left">actorRole</th>
              <th align="left">correlationId</th>
              <th align="left">payloadDigest</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e: any, i: number) => (
              <tr key={String(e?.eventId ?? i)}>
                <td>{String(e?.createdAt ?? e?.created_at ?? "-")}</td>
                <td>
                  <Badge>{String(e?.type ?? "-")}</Badge>
                </td>
                <td>{String(e?.actorRole ?? e?.actor_role ?? "-")}</td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{String(e?.correlationId ?? e?.correlation_id ?? "-")}</td>
                <td>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(e?.payloadDigest ?? e?.payload_digest ?? null, null, 2)}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table header={<span>{t(props.locale, "collab.envelopesTitle")}</span>}>
          <thead>
            <tr>
              <th align="left">createdAt</th>
              <th align="left">fromRole</th>
              <th align="left">toRole</th>
              <th align="left">kind</th>
              <th align="left">correlationId</th>
              <th align="left">payloadDigest</th>
            </tr>
          </thead>
          <tbody>
            {envelopes.map((env: any, i: number) => (
              <tr key={String(env?.envelopeId ?? i)}>
                <td>{String(env?.createdAt ?? env?.created_at ?? "-")}</td>
                <td>{String(env?.fromRole ?? env?.from_role ?? "-")}</td>
                <td>{String(env?.toRole ?? env?.to_role ?? "-")}</td>
                <td>
                  <Badge>{String(env?.kind ?? "-")}</Badge>
                </td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{String(env?.correlationId ?? env?.correlation_id ?? "-")}</td>
                <td>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(env?.payloadDigest ?? env?.payload_digest ?? null, null, 2)}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}
