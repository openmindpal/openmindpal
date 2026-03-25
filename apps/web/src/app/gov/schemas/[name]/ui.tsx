"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table, StatusBadge } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };

function normalizeSchema(input: any) {
  const schema = input?.schema ?? input;
  return schema && typeof schema === "object" && !Array.isArray(schema) ? schema : null;
}

function computeSchemaDiffSummary(aRaw: any, bRaw: any) {
  const a = normalizeSchema(aRaw);
  const b = normalizeSchema(bRaw);
  const out: any = {
    entitiesAdded: [] as string[],
    entitiesRemoved: [] as string[],
    fieldsAdded: 0,
    fieldsRemoved: 0,
    typeChanged: 0,
    requiredChanged: 0,
    byEntity: {} as Record<string, any>,
  };
  if (!a || !b) return out;

  const aEnt = (a as any).entities && typeof (a as any).entities === "object" ? (a as any).entities : {};
  const bEnt = (b as any).entities && typeof (b as any).entities === "object" ? (b as any).entities : {};
  const aNames = new Set(Object.keys(aEnt));
  const bNames = new Set(Object.keys(bEnt));
  for (const n of bNames) if (!aNames.has(n)) out.entitiesAdded.push(n);
  for (const n of aNames) if (!bNames.has(n)) out.entitiesRemoved.push(n);

  for (const n of Array.from(new Set([...aNames, ...bNames])).sort()) {
    if (!aNames.has(n) || !bNames.has(n)) continue;
    const aFields = aEnt[n]?.fields && typeof aEnt[n].fields === "object" ? aEnt[n].fields : {};
    const bFields = bEnt[n]?.fields && typeof bEnt[n].fields === "object" ? bEnt[n].fields : {};
    const aFns = new Set(Object.keys(aFields));
    const bFns = new Set(Object.keys(bFields));
    const added = Array.from(bFns).filter((k) => !aFns.has(k)).sort();
    const removed = Array.from(aFns).filter((k) => !bFns.has(k)).sort();
    const typeChanged: Array<{ field: string; from: string; to: string }> = [];
    const requiredChanged: Array<{ field: string; from: boolean; to: boolean }> = [];
    for (const f of Array.from(new Set([...aFns, ...bFns])).sort()) {
      if (!aFns.has(f) || !bFns.has(f)) continue;
      const at = String(aFields[f]?.type ?? "");
      const bt = String(bFields[f]?.type ?? "");
      if (at && bt && at !== bt) typeChanged.push({ field: f, from: at, to: bt });
      const ar = Boolean(aFields[f]?.required ?? false);
      const br = Boolean(bFields[f]?.required ?? false);
      if (ar !== br) requiredChanged.push({ field: f, from: ar, to: br });
    }
    if (added.length || removed.length || typeChanged.length || requiredChanged.length) {
      out.byEntity[n] = { added, removed, typeChanged, requiredChanged };
    }
    out.fieldsAdded += added.length;
    out.fieldsRemoved += removed.length;
    out.typeChanged += typeChanged.length;
    out.requiredChanged += requiredChanged.length;
  }
  return out;
}

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

export default function SchemaDetailClient(props: {
  locale: string;
  name: string;
  initialVersions: unknown;
  initialVersionsStatus: number;
  initialLatest: unknown;
  initialLatestStatus: number;
  initialMigrations: unknown;
  initialMigrationsStatus: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [versionsData, setVersionsData] = useState<any>(props.initialVersions ?? null);
  const [versionsStatus, setVersionsStatus] = useState<number>(props.initialVersionsStatus);
  const [latestData, setLatestData] = useState<any>(props.initialLatest ?? null);
  const [latestStatus, setLatestStatus] = useState<number>(props.initialLatestStatus);
  const [migrationsData, setMigrationsData] = useState<any>(props.initialMigrations ?? null);
  const [migrationsStatus, setMigrationsStatus] = useState<number>(props.initialMigrationsStatus);

  const versions = useMemo(() => (Array.isArray(versionsData?.versions) ? versionsData.versions : []), [versionsData]);
  const migrations = useMemo(() => (Array.isArray(migrationsData?.items) ? migrationsData.items : []), [migrationsData]);

  const [schemaJson, setSchemaJson] = useState<string>(JSON.stringify(latestData?.schema ?? latestData ?? null, null, 2));
  const [diffA, setDiffA] = useState<number>(0);
  const [diffB, setDiffB] = useState<number>(0);
  const [diffOut, setDiffOut] = useState<any>(null);

  async function refresh() {
    setError("");
    setBusy(true);
    try {
      const vRes = await apiFetch(`/schemas/${encodeURIComponent(props.name)}/versions?limit=50`, { locale: props.locale, cache: "no-store" });
      setVersionsStatus(vRes.status);
      const vJson = await vRes.json().catch(() => null);
      setVersionsData(vJson);
      const lRes = await apiFetch(`/schemas/${encodeURIComponent(props.name)}/latest`, { locale: props.locale, cache: "no-store" });
      setLatestStatus(lRes.status);
      const lJson = await lRes.json().catch(() => null);
      setLatestData(lJson);
      const mRes = await apiFetch(`/governance/schema-migrations?schemaName=${encodeURIComponent(props.name)}&limit=50`, { locale: props.locale, cache: "no-store" });
      setMigrationsStatus(mRes.status);
      const mJson = await mRes.json().catch(() => null);
      setMigrationsData(mJson);
      if (!vRes.ok) throw toApiError(vJson);
      if (!lRes.ok) throw toApiError(lJson);
      if (!mRes.ok) throw toApiError(mJson);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function createChangeSetWithItems(title: string, items: any[]) {
    const csRes = await apiFetch(`/governance/changesets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      locale: props.locale,
      body: JSON.stringify({ title, scope: "tenant" }),
    });
    const csJson: any = await csRes.json().catch(() => null);
    if (!csRes.ok) throw toApiError(csJson);
    const id = String(csJson?.changeset?.id ?? "");
    for (const it of items) {
      const res = await apiFetch(`/governance/changesets/${encodeURIComponent(id)}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(it),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(j);
    }
    return id;
  }

  async function publishSchema() {
    setError("");
    setBusy(true);
    try {
      const schemaDef = (() => {
        try {
          return JSON.parse(schemaJson);
        } catch {
          return null;
        }
      })();
      if (!schemaDef) throw toApiError({ errorCode: "INVALID_JSON", message: "invalid schema json" });
      const id = await createChangeSetWithItems(`schema publish ${props.name}`, [{ kind: "schema.publish", schemaDef }]);
      window.location.href = `/gov/changesets/${encodeURIComponent(id)}?lang=${encodeURIComponent(props.locale)}`;
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function rollbackSchema() {
    setError("");
    setBusy(true);
    try {
      const id = await createChangeSetWithItems(`schema rollback ${props.name}`, [{ kind: "schema.rollback", schemaName: props.name }]);
      window.location.href = `/gov/changesets/${encodeURIComponent(id)}?lang=${encodeURIComponent(props.locale)}`;
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function setActive(version: number) {
    setError("");
    setBusy(true);
    try {
      const id = await createChangeSetWithItems(`schema set_active ${props.name}@${version}`, [{ kind: "schema.set_active", schemaName: props.name, version }]);
      window.location.href = `/gov/changesets/${encodeURIComponent(id)}?lang=${encodeURIComponent(props.locale)}`;
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadDiff(a: number, b: number) {
    setError("");
    setBusy(true);
    try {
      const ra = await apiFetch(`/schemas/${encodeURIComponent(props.name)}/${encodeURIComponent(String(a))}`, { locale: props.locale, cache: "no-store" });
      const ja: any = await ra.json().catch(() => null);
      if (!ra.ok) throw toApiError(ja);
      const rb = await apiFetch(`/schemas/${encodeURIComponent(props.name)}/${encodeURIComponent(String(b))}`, { locale: props.locale, cache: "no-store" });
      const jb: any = await rb.json().catch(() => null);
      if (!rb.ok) throw toApiError(jb);
      const aStr = JSON.stringify(ja?.schema ?? ja ?? null);
      const bStr = JSON.stringify(jb?.schema ?? jb ?? null);
      setDiffOut({ changed: aStr !== bStr, aSize: aStr.length, bSize: bStr.length, summary: computeSchemaDiffSummary(ja, jb) });
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const initialError = useMemo(() => {
    if (versionsStatus >= 400) return errText(props.locale, versionsData);
    if (latestStatus >= 400) return errText(props.locale, latestData);
    if (migrationsStatus >= 400) return errText(props.locale, migrationsData);
    return "";
  }, [latestData, latestStatus, migrationsData, migrationsStatus, props.locale, versionsData, versionsStatus]);

  return (
    <div>
      <PageHeader
        title={`${t(props.locale, "gov.schemas.schemaTitle")} ${props.name}`}
        description={
          <>
            <StatusBadge locale={props.locale} status={versionsStatus} />
            <StatusBadge locale={props.locale} status={latestStatus} />
            <StatusBadge locale={props.locale} status={migrationsStatus} />
          </>
        }
        actions={
          <>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
            <Link href={`/gov/schemas?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "gov.schemas.backLink")}</Link>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.schemas.publishTitle")}>
          <div style={{ display: "grid", gap: 8 }}>
            <textarea value={schemaJson} onChange={(e) => setSchemaJson(e.target.value)} rows={12} disabled={busy} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={publishSchema} disabled={busy}>
                {t(props.locale, "gov.schemas.publishButton")}
              </button>
              <button onClick={rollbackSchema} disabled={busy}>
                {t(props.locale, "gov.schemas.rollbackButton")}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.schemas.versionsTitle")}>
          <Table header={<span>{t(props.locale, "gov.schemas.versionsHeader")}</span>}>
            <thead>
              <tr>
                <th align="left">{t(props.locale, "gov.schemas.table.version")}</th>
                <th align="left">{t(props.locale, "gov.schemas.table.status")}</th>
                <th align="left">{t(props.locale, "gov.schemas.table.publishedAt")}</th>
                <th align="left">{t(props.locale, "gov.schemas.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v: any) => (
                <tr key={String(v?.version ?? "")}>
                  <td>{String(v?.version ?? "")}</td>
                  <td>
                    <Badge>{String(v?.status ?? "")}</Badge>
                  </td>
                  <td>{String(v?.publishedAt ?? "-")}</td>
                  <td style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setActive(Number(v.version))} disabled={busy}>
                      {t(props.locale, "gov.schemas.setActive")}
                    </button>
                    <button
                      onClick={() => {
                        if (!diffA) setDiffA(Number(v.version));
                        else setDiffB(Number(v.version));
                      }}
                      disabled={busy}
                    >
                      {t(props.locale, "gov.schemas.pickDiff")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
            <span>{t(props.locale, "gov.schemas.diff")}</span>
            <input style={{ width: 80 }} value={diffA || ""} onChange={(e) => setDiffA(Number(e.target.value) || 0)} />
            <input style={{ width: 80 }} value={diffB || ""} onChange={(e) => setDiffB(Number(e.target.value) || 0)} />
            <button onClick={() => loadDiff(diffA, diffB)} disabled={busy || !diffA || !diffB}>
              {t(props.locale, "gov.schemas.diff")}
            </button>
          </div>
          {diffOut ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(diffOut, null, 2)}</pre> : null}
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.schemas.migrationsTitle")}>
          <Table header={<span>{t(props.locale, "gov.schemas.migrationRuns")}</span>}>
            <thead>
              <tr>
                <th align="left">{t(props.locale, "gov.schemas.table.migrationId")}</th>
                <th align="left">{t(props.locale, "gov.schemas.table.status")}</th>
                <th align="left">{t(props.locale, "gov.schemas.table.latestRunId")}</th>
              </tr>
            </thead>
            <tbody>
              {migrations.map((m: any) => (
                <tr key={String(m?.migrationId ?? "")}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{String(m?.migrationId ?? "")}</td>
                  <td>
                    <Badge>{String(m?.status ?? "")}</Badge>
                  </td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                    {m?.latestRunId ? <Link href={`/runs/${encodeURIComponent(String(m.latestRunId))}?lang=${encodeURIComponent(props.locale)}`}>{String(m.latestRunId)}</Link> : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
