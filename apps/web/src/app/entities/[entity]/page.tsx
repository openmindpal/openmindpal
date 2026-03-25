import Link from "next/link";
import { cookies } from "next/headers";
import { apiFetch, pickLocale, text } from "../../../lib/api";
import { t } from "../../../lib/i18n";
import type { EffectiveSchema, FieldDef, SearchParams } from "../../../lib/types";
import { Card, Table } from "../../../components/ui";
import { resolveReferenceLabels, type RefLabelMap } from "../../../lib/referenceResolver";

async function loadEffectiveSchema(locale: string, entity: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/schemas/${encodeURIComponent(entity)}/effective?schemaName=core`, {
    method: "GET",
    token,
    locale,
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as unknown as EffectiveSchema;
}

async function loadEntityQuery(locale: string, entity: string, body: unknown) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/entities/${encodeURIComponent(entity)}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    token,
    locale,
    cache: "no-store",
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) return null;
  return (await res.json()) as unknown;
}

function buildCursor(searchParams: SearchParams) {
  const updatedAtRaw = searchParams.cursorUpdatedAt;
  const idRaw = searchParams.cursorId;
  const updatedAt = Array.isArray(updatedAtRaw) ? updatedAtRaw[0] : updatedAtRaw;
  const id = Array.isArray(idRaw) ? idRaw[0] : idRaw;
  if (!updatedAt || !id) return undefined;
  return { updatedAt: String(updatedAt), id: String(id) };
}

type FilterCond = { field: string; op: string; value: unknown } | { and: FilterCond[] };

function buildFilters(schema: EffectiveSchema | null, searchParams: SearchParams, fieldKeys: string[]) {
  const fields = (schema?.fields ?? {}) as Record<string, FieldDef>;
  const conds: FilterCond[] = [];
  for (const name of fieldKeys) {
    const def = fields[name];
    const type = def?.type ?? "string";
    if (type === "number") {
      const gRaw = searchParams[`f_${name}_gte`];
      const lRaw = searchParams[`f_${name}_lte`];
      const g = Array.isArray(gRaw) ? gRaw[0] : gRaw;
      const l = Array.isArray(lRaw) ? lRaw[0] : lRaw;
      if (g !== undefined && g !== "") {
        const n = Number(g);
        if (!Number.isNaN(n)) conds.push({ field: name, op: "gte", value: n });
      }
      if (l !== undefined && l !== "") {
        const n = Number(l);
        if (!Number.isNaN(n)) conds.push({ field: name, op: "lte", value: n });
      }
      continue;
    }

    const raw = searchParams[`f_${name}`];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (v === undefined || v === "") continue;
    if (type === "string") conds.push({ field: name, op: "contains", value: String(v) });
    else if (type === "boolean") {
      if (String(v) === "true") conds.push({ field: name, op: "eq", value: true });
      if (String(v) === "false") conds.push({ field: name, op: "eq", value: false });
    } else if (type === "datetime") conds.push({ field: name, op: "eq", value: String(v) });
    else conds.push({ field: name, op: "contains", value: String(v) });
  }
  if (conds.length === 0) return undefined;
  if (conds.length === 1) return conds[0];
  return { and: conds };
}

function buildSearchString(searchParams: SearchParams, overrides: Record<string, string | undefined>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const vv of v) if (vv !== undefined) qs.append(k, String(vv));
    } else {
      qs.set(k, String(v));
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) qs.delete(k);
    else qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

function formatValue(def: FieldDef | undefined, v: unknown, locale: string, resolvedLabel?: string) {
  if (v === null || v === undefined) return "";
  const type = def?.type ?? "string";
  if (type === "reference") {
    return resolvedLabel || String(v);
  }
  if (type === "datetime") {
    const d = new Date(String(v));
    if (!Number.isNaN(d.getTime())) return d.toLocaleString(locale);
    return String(v);
  }
  if (type === "json") {
    try {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      if (s.length > 120) return `${s.slice(0, 120)}…`;
      return s;
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export default async function EntityListPage(props: {
  params: Promise<{ entity: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const entity = decodeURIComponent(params.entity);

  const schema = await loadEffectiveSchema(locale, entity);
  const fields = (schema?.fields ?? {}) as Record<string, FieldDef>;
  const allKeys = Object.keys(fields);
  const colsRaw = searchParams.cols;
  const colsStr = Array.isArray(colsRaw) ? colsRaw[0] : colsRaw;
  const cols = typeof colsStr === "string" && colsStr.trim() ? colsStr.split(",").map((x) => x.trim()).filter(Boolean) : [];
  const fieldKeys = (cols.length ? cols : allKeys).filter((k) => Object.prototype.hasOwnProperty.call(fields, k)).slice(0, 8);
  const filterKeys = fieldKeys.slice(0, 6);
  const cursor = buildCursor(searchParams);
  const filters = buildFilters(schema, searchParams, filterKeys);

  const sortRaw = searchParams.sort;
  const sortStr = Array.isArray(sortRaw) ? sortRaw[0] : sortRaw;
  const sortSelected = typeof sortStr === "string" ? sortStr : "";
  const parsedSort =
    !cursor && sortSelected.includes(":")
      ? (() => {
          const [field, direction] = sortSelected.split(":");
          if (!Object.prototype.hasOwnProperty.call(fields, field)) return null;
          if (direction !== "asc" && direction !== "desc") return null;
          return { field, direction };
        })()
      : null;
  const orderBy = cursor ? [{ field: "updatedAt", direction: "desc" }] : parsedSort ? [parsedSort] : [{ field: "updatedAt", direction: "desc" }];

  const queryBody = { schemaName: "core", limit: 50, select: fieldKeys, filters, orderBy, cursor };
  const data = await loadEntityQuery(locale, entity, queryBody);

  // Resolve reference field display labels
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const refLabels: RefLabelMap = await resolveReferenceLabels({
    fields,
    items: Array.isArray((data as any)?.items) ? (data as any).items : [],
    fetchOne: async (refEntity, id) => {
      try {
        const r = await apiFetch(`/entities/${encodeURIComponent(refEntity)}/${encodeURIComponent(id)}`, { method: "GET", token, locale, cache: "no-store" });
        if (!r.ok) return null;
        return (await r.json()) as Record<string, unknown>;
      } catch { return null; }
    },
  });
  const dataObj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const items = Array.isArray(dataObj.items) ? (dataObj.items as Array<Record<string, unknown>>) : [];
  const nextCursorRaw = dataObj.nextCursor;
  const nextCursor = nextCursorRaw && typeof nextCursorRaw === "object" ? (nextCursorRaw as Record<string, unknown>) : null;

  const vRaw = searchParams.v;
  const v = Array.isArray(vRaw) ? vRaw[0] : vRaw;
  const variant = v === "cards" ? "cards" : "table";
  const dRaw = searchParams.density;
  const d = Array.isArray(dRaw) ? dRaw[0] : dRaw;
  const density = d === "compact" ? "compact" : "comfortable";

  const loadMoreHref =
    nextCursor?.updatedAt && nextCursor?.id
      ? `/entities/${encodeURIComponent(entity)}${buildSearchString(searchParams, {
          cursorUpdatedAt: String(nextCursor.updatedAt),
          cursorId: String(nextCursor.id),
        })}`
      : "";

  const title = text(schema?.displayName ?? entity, locale) || entity;

  return (
    <main style={{ padding: 24 }}>
      <p>
        <Link href={`/?lang=${encodeURIComponent(locale)}`}>{t(locale, "back")}</Link>
      </p>
      <h1>{title}</h1>
      <p>
        <Link href={`/entities/${encodeURIComponent(entity)}/new?lang=${encodeURIComponent(locale)}`}>{t(locale, "create")}</Link>
      </p>

      <form method="GET" style={{ display: "grid", gap: 8, margin: "12px 0", maxWidth: 720 }}>
        <input type="hidden" name="lang" value={locale} />
        <label style={{ display: "grid", gap: 6 }}>
          <div>{t(locale, "entity.viewPrefs.variant")}</div>
          <select name="v" defaultValue={variant}>
            <option value="table">{t(locale, "entity.viewPrefs.variant.table")}</option>
            <option value="cards">{t(locale, "entity.viewPrefs.variant.cards")}</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <div>{t(locale, "entity.viewPrefs.density")}</div>
          <select name="density" defaultValue={density}>
            <option value="comfortable">{t(locale, "entity.viewPrefs.density.comfortable")}</option>
            <option value="compact">{t(locale, "entity.viewPrefs.density.compact")}</option>
          </select>
        </label>
        {!cursor ? (
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(locale, "entity.sort")}</div>
            <select name="sort" defaultValue={sortSelected}>
              <option value=""></option>
              {fieldKeys.map((k) => (
                <option key={`${k}:asc`} value={`${k}:asc`}>
                  {k}:asc
                </option>
              ))}
              {fieldKeys.map((k) => (
                <option key={`${k}:desc`} value={`${k}:desc`}>
                  {k}:desc
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {filterKeys.map((k) => {
          const def = fields[k];
          const label = text(def?.displayName ?? k, locale) || k;
          const type = def?.type ?? "string";
          if (type === "boolean") {
            const raw = searchParams[`f_${k}`];
            const v = Array.isArray(raw) ? raw[0] : raw;
            return (
              <label key={k} style={{ display: "grid", gap: 6 }}>
                <div>{label}</div>
                <select name={`f_${k}`} defaultValue={v ? String(v) : ""}>
                  <option value=""></option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              </label>
            );
          }
          if (type === "number") {
            const gRaw = searchParams[`f_${k}_gte`];
            const lRaw = searchParams[`f_${k}_lte`];
            const g = Array.isArray(gRaw) ? gRaw[0] : gRaw;
            const l = Array.isArray(lRaw) ? lRaw[0] : lRaw;
            return (
              <label key={k} style={{ display: "grid", gap: 6 }}>
                <div>{label}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <input name={`f_${k}_gte`} defaultValue={g ? String(g) : ""} placeholder={t(locale, "entity.filter.gte")} />
                  <input name={`f_${k}_lte`} defaultValue={l ? String(l) : ""} placeholder={t(locale, "entity.filter.lte")} />
                </div>
              </label>
            );
          }
          const raw = searchParams[`f_${k}`];
          const v = Array.isArray(raw) ? raw[0] : raw;
          return (
            <label key={k} style={{ display: "grid", gap: 6 }}>
              <div>{label}</div>
              <input name={`f_${k}`} defaultValue={v ? String(v) : ""} placeholder={type} />
            </label>
          );
        })}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit">{t(locale, "entity.filter")}</button>
          <Link href={`/entities/${encodeURIComponent(entity)}?lang=${encodeURIComponent(locale)}`}>{t(locale, "entity.reset")}</Link>
        </div>
      </form>

      {variant === "cards" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          {items.map((r) => {
            const payload = r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {};
            const id = String(r.id ?? "");
            const titleKey = fieldKeys[0] ?? "";
            const titleText = titleKey ? formatValue(fields[titleKey], payload[titleKey], locale, refLabels[titleKey]?.[String(payload[titleKey])]) : id;
            return (
              <Card
                key={id}
                title={<div style={{ fontWeight: 700 }}>{titleText || id}</div>}
                footer={
                  <div style={{ display: "flex", gap: 10 }}>
                    <Link href={`/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}?lang=${encodeURIComponent(locale)}`}>{t(locale, "entity.detail")}</Link>
                    <Link
                      href={`/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}/edit?lang=${encodeURIComponent(locale)}`}
                      style={{ marginLeft: 8 }}
                    >
                      {t(locale, "entity.edit")}
                    </Link>
                  </div>
                }
              >
                <div style={{ display: "grid", gap: density === "compact" ? 4 : 8 }}>
                  {fieldKeys.slice(0, 3).map((k) => (
                    <div key={k} style={{ display: "grid", gap: 2 }}>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>{text(fields[k]?.displayName ?? k, locale) || k}</div>
                      <div>{formatValue(fields[k], payload[k], locale, refLabels[k]?.[String(payload[k])])}</div>
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <th align="left">id</th>
              {fieldKeys.map((k) => {
                const def = fields[k];
                const label = text(def?.displayName ?? k, locale) || k;
                return (
                  <th key={k} align="left">
                    {label}
                  </th>
                );
              })}
              <th align="left">{t(locale, "gov.changesets.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => {
              const payload = r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {};
              const id = String(r.id ?? "");
              return (
                <tr key={id} style={{ borderTop: "1px solid #ddd" }}>
                  <td style={{ padding: density === "compact" ? 4 : 6 }}>{id}</td>
                  {fieldKeys.map((k) => (
                    <td key={k} style={{ padding: density === "compact" ? 4 : 6 }}>
                      {formatValue(fields[k], payload[k], locale, refLabels[k]?.[String(payload[k])])}
                    </td>
                  ))}
                  <td style={{ padding: density === "compact" ? 4 : 6 }}>
                    <Link href={`/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}?lang=${encodeURIComponent(locale)}`}>{t(locale, "entity.detail")}</Link>
                    <Link
                      href={`/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}/edit?lang=${encodeURIComponent(locale)}`}
                      style={{ marginLeft: 8 }}
                    >
                      {t(locale, "entity.edit")}
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {loadMoreHref ? (
        <p style={{ marginTop: 12 }}>
          <Link href={loadMoreHref}>{t(locale, "entity.loadMore")}</Link>
        </p>
      ) : null}

      <pre style={{ background: "rgba(15, 23, 42, 0.03)", padding: 12, overflowX: "auto", marginTop: 12 }}>
        {JSON.stringify({ count: items.length, nextCursor: dataObj.nextCursor ?? null }, null, 2)}
      </pre>
    </main>
  );
}
