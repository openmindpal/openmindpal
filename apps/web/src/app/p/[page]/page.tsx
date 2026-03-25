import Link from "next/link";
import { cookies } from "next/headers";
import { apiFetch, pickLocale, text } from "../../../lib/api";
import { EntityForm } from "../../entities/[entity]/new/ui";
import { t } from "../../../lib/i18n";
import type { EffectiveSchema, FieldDef, SearchParams, UiActionBinding, UiDataBinding, UiPageVersion } from "../../../lib/types";
import EntityEditForm from "./editUi";
import { ViewPrefsPanel } from "./ViewPrefsPanel";
import { Card, Table } from "../../../components/ui";
import { resolveReferenceLabels, type RefLabelMap } from "../../../lib/referenceResolver";
import Nl2UiPageRenderer from "./Nl2UiPageRenderer";

async function loadPage(locale: string, name: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/ui/pages/${encodeURIComponent(name)}`, {
    token,
    locale,
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as unknown as { released?: UiPageVersion | null };
}

async function loadViewPrefs(locale: string, name: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/ui/pages/${encodeURIComponent(name)}/view-prefs`, {
    token,
    locale,
    cache: "no-store",
  });
  if (!res.ok) return null;
  const json = (await res.json()) as any;
  return json?.prefs ?? null;
}

async function loadEffectiveSchemaBy(locale: string, entity: string, schemaName: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/schemas/${encodeURIComponent(entity)}/effective?schemaName=${encodeURIComponent(schemaName)}`, {
    token,
    locale,
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as unknown as EffectiveSchema;
}

async function loadEntity(locale: string, entity: string, id: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`, {
    token,
    locale,
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as unknown;
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

function getSchemaNameFromBindings(binds: UiDataBinding[]) {
  const b = binds.find((x): x is Extract<UiDataBinding, { target: "schema.effective" }> => x.target === "schema.effective");
  return String(b?.schemaName ?? "core");
}

function getIdParamFromBindings(binds: UiDataBinding[]) {
  const b = binds.find((x): x is Extract<UiDataBinding, { target: "entities.get" }> => x.target === "entities.get");
  return String(b?.idParam ?? "id");
}

function getUi(released: UiPageVersion): Record<string, unknown> {
  return released.ui ?? {};
}

function getContentComponentId(ui: Record<string, unknown>) {
  const blocks = (ui as any).blocks;
  if (!Array.isArray(blocks)) return "";
  const hit = blocks.find((b: any) => b && typeof b === "object" && String(b.slot ?? "") === "content");
  return typeof hit?.componentId === "string" ? String(hit.componentId) : "";
}

function mergeUi(base: Record<string, unknown>, prefs: any, searchParams: SearchParams) {
  const out: any = { ...(base ?? {}) };
  if (prefs && typeof prefs === "object") {
    if (prefs.layout && typeof prefs.layout === "object") out.layout = { ...(out.layout ?? {}), ...prefs.layout };
    if (prefs.list && typeof prefs.list === "object") out.list = { ...(out.list ?? {}), ...prefs.list };
  }
  const vRaw = searchParams.v;
  const v = Array.isArray(vRaw) ? vRaw[0] : vRaw;
  if (typeof v === "string" && v.trim()) out.layout = { ...(out.layout ?? {}), variant: v.trim() };
  const dRaw = searchParams.density;
  const d = Array.isArray(dRaw) ? dRaw[0] : dRaw;
  if (d === "comfortable" || d === "compact") out.layout = { ...(out.layout ?? {}), density: d };
  const colsRaw = searchParams.cols;
  const colsStr = Array.isArray(colsRaw) ? colsRaw[0] : colsRaw;
  if (typeof colsStr === "string" && colsStr.trim()) {
    const cols = colsStr
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    out.list = { ...(out.list ?? {}), columns: cols };
  }
  return out as Record<string, unknown>;
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

function resolveBackHref(locale: string) {
  return `/?lang=${encodeURIComponent(locale)}`;
}

export default async function PageEntry(props: {
  params: Promise<{ page: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const routeParams = await Promise.resolve(props.params);
  const name = decodeURIComponent(routeParams.page);
  const cfg = await loadPage(locale, name);
  const backHref = resolveBackHref(locale);
  const released = cfg?.released;
  if (!released) {
    return (
      <main style={{ padding: 24 }}>
        <p>
          <Link href={backHref}>{t(locale, "back")}</Link>
        </p>
        <h1>
          {t(locale, "page.notFound")}
          {name}
        </h1>
      </main>
    );
  }

  const pageType = released.pageType as string;
  const params = released.params ?? {};
  const binds = (released.dataBindings ?? []) as UiDataBinding[];
  const schemaName = getSchemaNameFromBindings(binds);
  const prefs = await loadViewPrefs(locale, name);
  const mergedUi = mergeUi(getUi(released), prefs, searchParams);

  const nl2uiConfig = (params as any).nl2uiConfig;
  if (nl2uiConfig && typeof nl2uiConfig === "object" && nl2uiConfig.ui?.layout) {
    const pageTitle = text(released.title ?? name, locale) || name;
    const nl2uiBackHref = `/gov/ui-pages/${encodeURIComponent(name)}?lang=${encodeURIComponent(locale)}`;
    return (
      <Nl2UiPageRenderer
        config={nl2uiConfig}
        locale={locale}
        pageName={name}
        title={pageTitle}
        backHref={nl2uiBackHref}
        released={released}
      />
    );
  }

  if (pageType === "entity.list") {
    const entityName = String(params.entityName ?? "");
    const schema = await loadEffectiveSchemaBy(locale, entityName, schemaName);
    const qBind = binds.find((b): b is Extract<UiDataBinding, { target: "entities.query" }> => b.target === "entities.query");
    const baseQuery = (qBind?.query ?? {}) as Record<string, unknown>;
    const uiList = (mergedUi as Record<string, unknown>).list;
    const uiListObj = uiList && typeof uiList === "object" ? (uiList as Record<string, unknown>) : {};
    const cursor = buildCursor(searchParams);
    const fields = (schema?.fields ?? {}) as Record<string, FieldDef>;
    const selectKeys = Array.isArray(baseQuery.select) ? (baseQuery.select as unknown[]).map((x) => String(x)) : [];
    const fallbackKeys = Object.keys(fields);
    const uiColumns = Array.isArray(uiListObj.columns) ? (uiListObj.columns as unknown[]).map((x) => String(x)) : [];
    const fieldKeys = (uiColumns.length ? uiColumns : selectKeys.length ? selectKeys : fallbackKeys)
      .filter((k) => Object.prototype.hasOwnProperty.call(fields, k))
      .slice(0, 8);

    const uiFilters = Array.isArray(uiListObj.filters) ? (uiListObj.filters as unknown[]).map((x) => String(x)) : [];
    const filterKeys = (uiFilters.length ? uiFilters : fieldKeys).filter((k) => Object.prototype.hasOwnProperty.call(fields, k)).slice(0, 8);
    const filters = buildFilters(schema, searchParams, filterKeys);
    const mergedFilters = baseQuery.filters && filters ? { and: [baseQuery.filters, filters] } : baseQuery.filters ?? filters;
    const sortParamRaw = searchParams.sort;
    const sortParam = Array.isArray(sortParamRaw) ? sortParamRaw[0] : sortParamRaw;
    const uiSortOptions = Array.isArray(uiListObj.sortOptions) ? (uiListObj.sortOptions as unknown[]) : [];
    const sortSelected = typeof sortParam === "string" ? sortParam : "";
    type SortOpt = { field: string; direction: "asc" | "desc" };
    const allowedSorts: SortOpt[] = uiSortOptions
      .map((o) => {
        const oo = o && typeof o === "object" ? (o as Record<string, unknown>) : {};
        return { field: String(oo.field ?? ""), direction: String(oo.direction ?? "") };
      })
      .filter((o): o is SortOpt => Boolean(o.field) && (o.direction === "asc" || o.direction === "desc"));
    const defaultSort = allowedSorts[0] ? [allowedSorts[0]] : baseQuery?.orderBy;
    const parsedSort: SortOpt | null = sortSelected.includes(":")
      ? (() => {
          const [field, direction] = sortSelected.split(":");
          if (direction !== "asc" && direction !== "desc") return null;
          return { field, direction };
        })()
      : null;
    const pickedSort = parsedSort && allowedSorts.some((o) => o.field === parsedSort.field && o.direction === parsedSort.direction) ? [parsedSort] : defaultSort;
    const orderBy = cursor ? [{ field: "updatedAt", direction: "desc" }] : pickedSort;
    const limit = uiListObj.pageSize ? Number(uiListObj.pageSize) : baseQuery?.limit;
    const queryBody = { schemaName: qBind?.schemaName ?? schemaName, ...baseQuery, limit, orderBy, cursor, filters: mergedFilters };
    const data = await loadEntityQuery(locale, entityName, queryBody);

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
    const title = text(released.title ?? entityName, locale) || entityName;
    const layoutObj = (mergedUi as any).layout && typeof (mergedUi as any).layout === "object" ? ((mergedUi as any).layout as any) : {};
    const contentComponentId = getContentComponentId(mergedUi);
    const variantRaw = typeof layoutObj.variant === "string" ? layoutObj.variant : "";
    const variant =
      variantRaw ||
      (contentComponentId === "EntityList.Cards" ? "cards" : contentComponentId === "EntityList.Table" ? "table" : "table");
    const density = layoutObj.density === "compact" ? "compact" : "comfortable";
    const nextCursorRaw = dataObj.nextCursor;
    const nextCursor = nextCursorRaw && typeof nextCursorRaw === "object" ? (nextCursorRaw as Record<string, unknown>) : null;
    const loadMoreHref =
      nextCursor?.updatedAt && nextCursor?.id
        ? `/p/${encodeURIComponent(name)}${buildSearchString(searchParams, {
            cursorUpdatedAt: String(nextCursor.updatedAt),
            cursorId: String(nextCursor.id),
          })}`
        : "";

    return (
      <main style={{ padding: 24 }}>
        <p>
          <Link href={backHref}>{t(locale, "back")}</Link>
        </p>
        <h1>{title}</h1>
        <p>
          <Link href={`/p/${encodeURIComponent(`${entityName}.new`)}?lang=${encodeURIComponent(locale)}`}>{t(locale, "create")}</Link>
        </p>

        <ViewPrefsPanel
          locale={locale}
          pageName={name}
          currentVariant={variant}
          currentDensity={density}
          availableColumns={Object.keys(fields).slice(0, 24)}
          currentColumns={fieldKeys}
        />

        <form method="GET" style={{ display: "grid", gap: 8, margin: "12px 0", maxWidth: 720 }}>
          <input type="hidden" name="lang" value={locale} />
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
          {allowedSorts.length ? (
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(locale, "entity.sort")}</div>
              <select name="sort" defaultValue={cursor ? "" : sortSelected} disabled={Boolean(cursor)}>
                <option value=""></option>
                {allowedSorts.map((o) => (
                  <option key={`${o.field}:${o.direction}`} value={`${o.field}:${o.direction}`}>
                    {o.field}:{o.direction}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit">{t(locale, "entity.filter")}</button>
            <Link href={`/p/${encodeURIComponent(name)}?lang=${encodeURIComponent(locale)}`}>{t(locale, "entity.reset")}</Link>
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
                      <Link href={`/p/${encodeURIComponent(`${entityName}.detail`)}?id=${encodeURIComponent(id)}&lang=${encodeURIComponent(locale)}`}>{t(locale, "entity.detail")}</Link>
                      <Link href={`/p/${encodeURIComponent(`${entityName}.edit`)}?id=${encodeURIComponent(id)}&lang=${encodeURIComponent(locale)}`}>{t(locale, "entity.edit")}</Link>
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
                      <Link href={`/p/${encodeURIComponent(`${entityName}.detail`)}?id=${encodeURIComponent(id)}&lang=${encodeURIComponent(locale)}`}>{t(locale, "entity.detail")}</Link>
                      <Link href={`/p/${encodeURIComponent(`${entityName}.edit`)}?id=${encodeURIComponent(id)}&lang=${encodeURIComponent(locale)}`} style={{ marginLeft: 8 }}>
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

  if (pageType === "entity.new") {
    const entityName = String(params.entityName ?? "");
    const toolRef = (released.actionBindings ?? ([] as UiActionBinding[])).find((a) => a.action === "create")?.toolRef;
    const schema = await loadEffectiveSchemaBy(locale, entityName, schemaName);
    const form = (mergedUi as any).form;
    const formObj = form && typeof form === "object" ? (form as Record<string, unknown>) : {};
    const fieldOrderRaw = formObj.fieldOrder;
    const fieldOrder = Array.isArray(fieldOrderRaw) ? (fieldOrderRaw as unknown[]).map((x) => String(x)) : undefined;
    const layoutObj = (mergedUi as any).layout && typeof (mergedUi as any).layout === "object" ? ((mergedUi as any).layout as any) : {};
    const layoutVariant = layoutObj.variant === "twoColumn" ? "twoColumn" : "single";
    const title = text(released.title ?? entityName, locale) || entityName;
    return (
      <main style={{ padding: 24 }}>
        <p>
          <Link href={backHref}>{t(locale, "back")}</Link>
        </p>
        <h1>{title}</h1>
        <EntityForm locale={locale} entity={entityName} schema={schema} toolRef={toolRef} fieldOrder={fieldOrder} layoutVariant={layoutVariant} />
      </main>
    );
  }

  if (pageType === "entity.detail") {
    const entityName = String(params.entityName ?? "");
    const idParam = getIdParamFromBindings(binds);
    const id = String(searchParams[idParam] ?? "");
    if (!id) {
      return (
        <main style={{ padding: 24 }}>
          <p>
            <Link href={backHref}>{t(locale, "back")}</Link>
          </p>
          <h1>{text(released.title ?? entityName, locale) || entityName}</h1>
          <p>{t(locale, "entity.missingId")}</p>
        </main>
      );
    }
    const schema = await loadEffectiveSchemaBy(locale, entityName, schemaName);
    type EntityRecord = { id?: unknown; payload?: Record<string, unknown> };
    const entityRaw = await loadEntity(locale, entityName, id);
    const entity = entityRaw && typeof entityRaw === "object" ? (entityRaw as EntityRecord) : null;
    const fields = (schema?.fields ?? {}) as Record<string, FieldDef>;

    // Resolve reference field display labels for detail view
    const detailToken = (await cookies()).get("openslin_token")?.value ?? "";
    const detailRefLabels: RefLabelMap = await resolveReferenceLabels({
      fields,
      items: entity ? [{ payload: entity.payload ?? {} } as Record<string, unknown>] : [],
      fetchOne: async (refEntity, refId) => {
        try {
          const r = await apiFetch(`/entities/${encodeURIComponent(refEntity)}/${encodeURIComponent(refId)}`, { method: "GET", token: detailToken, locale, cache: "no-store" });
          if (!r.ok) return null;
          return (await r.json()) as Record<string, unknown>;
        } catch { return null; }
      },
    });

    const detail = (mergedUi as Record<string, unknown>).detail;
    const detailObj = detail && typeof detail === "object" ? (detail as Record<string, unknown>) : {};
    const orderRaw = detailObj.fieldOrder;
    const order = Array.isArray(orderRaw) ? (orderRaw as unknown[]).map((x) => String(x)) : [];
    const schemaKeys = Object.keys(fields);
    const fieldKeys = order.length ? [...order.filter((k: string) => schemaKeys.includes(k)), ...schemaKeys.filter((k) => !order.includes(k))] : schemaKeys;
    const layoutObj = (mergedUi as any).layout && typeof (mergedUi as any).layout === "object" ? ((mergedUi as any).layout as any) : {};
    const variant = layoutObj.variant === "tabs" ? "tabs" : "panel";
    return (
      <main style={{ padding: 24 }}>
        <p>
          <Link href={backHref}>{t(locale, "back")}</Link>
        </p>
        <h1>{text(released.title ?? entityName, locale) || entityName}</h1>
        {variant === "tabs" ? (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 12 }}>
              <a href="#fields">{t(locale, "entity.detail.fieldsTab")}</a>
              <a href="#raw">{t(locale, "entity.detail.rawTab")}</a>
            </div>
            <section id="fields">
              <Table>
                <tbody>
                  <tr style={{ borderTop: "1px solid #ddd" }}>
                    <td style={{ width: 200, fontWeight: 600 }}>id</td>
                    <td>{String(entity?.id ?? "")}</td>
                  </tr>
                  {fieldKeys.map((k) => (
                    <tr key={k} style={{ borderTop: "1px solid #ddd" }}>
                      <td style={{ width: 200, fontWeight: 600 }}>{text(fields[k]?.displayName ?? k, locale) || k}</td>
                      <td>
                        {fields[k]?.type === "json" ? (
                          <details>
                            <summary>{formatValue(fields[k], entity?.payload?.[k], locale, detailRefLabels[k]?.[String(entity?.payload?.[k])])}</summary>
                            <pre style={{ whiteSpace: "pre-wrap" }}>
                              {(() => {
                                const v = entity?.payload?.[k];
                                if (v === undefined || v === null) return "";
                                return typeof v === "string" ? v : JSON.stringify(v, null, 2);
                              })()}
                            </pre>
                          </details>
                        ) : (
                          formatValue(fields[k], entity?.payload?.[k], locale, detailRefLabels[k]?.[String(entity?.payload?.[k])])
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </section>
            <section id="raw">
              <pre style={{ whiteSpace: "pre-wrap", background: "rgba(15, 23, 42, 0.03)", padding: 12 }}>
                {JSON.stringify(entity?.payload ?? null, null, 2)}
              </pre>
            </section>
          </div>
        ) : (
          <Table>
            <tbody>
              <tr style={{ borderTop: "1px solid #ddd" }}>
                <td style={{ width: 200, fontWeight: 600 }}>id</td>
                <td>{String(entity?.id ?? "")}</td>
              </tr>
              {fieldKeys.map((k) => (
                <tr key={k} style={{ borderTop: "1px solid #ddd" }}>
                  <td style={{ width: 200, fontWeight: 600 }}>{text(fields[k]?.displayName ?? k, locale) || k}</td>
                  <td>
                    {fields[k]?.type === "json" ? (
                      <details>
                        <summary>{formatValue(fields[k], entity?.payload?.[k], locale, detailRefLabels[k]?.[String(entity?.payload?.[k])])}</summary>
                        <pre style={{ whiteSpace: "pre-wrap" }}>
                          {(() => {
                            const v = entity?.payload?.[k];
                            if (v === undefined || v === null) return "";
                            return typeof v === "string" ? v : JSON.stringify(v, null, 2);
                          })()}
                        </pre>
                      </details>
                    ) : (
                      formatValue(fields[k], entity?.payload?.[k], locale, detailRefLabels[k]?.[String(entity?.payload?.[k])])
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p>
          <Link href={`/p/${encodeURIComponent(`${entityName}.edit`)}?${encodeURIComponent(idParam)}=${encodeURIComponent(id)}&lang=${encodeURIComponent(locale)}`}>
            {t(locale, "entity.edit")}
          </Link>
        </p>
      </main>
    );
  }

  if (pageType === "entity.edit") {
    const entityName = String(params.entityName ?? "");
    const idParam = getIdParamFromBindings(binds);
    const id = String(searchParams[idParam] ?? "");
    const toolRef = (released.actionBindings ?? ([] as UiActionBinding[])).find((a) => a.action === "update")?.toolRef;
    const schema = await loadEffectiveSchemaBy(locale, entityName, schemaName);
    type EntityRecord = { id?: unknown; payload?: Record<string, unknown> };
    const entityRaw = id ? await loadEntity(locale, entityName, id) : null;
    const entity = entityRaw && typeof entityRaw === "object" ? (entityRaw as EntityRecord) : null;
    const form = (mergedUi as any).form;
    const formObj = form && typeof form === "object" ? (form as Record<string, unknown>) : {};
    const fieldOrderRaw = formObj.fieldOrder;
    const fieldOrder = Array.isArray(fieldOrderRaw) ? (fieldOrderRaw as unknown[]).map((x) => String(x)) : undefined;
    const layoutObj = (mergedUi as any).layout && typeof (mergedUi as any).layout === "object" ? ((mergedUi as any).layout as any) : {};
    const layoutVariant = layoutObj.variant === "twoColumn" ? "twoColumn" : "single";
    const title = text(released.title ?? entityName, locale) || entityName;
    return (
      <main style={{ padding: 24 }}>
        <p>
          <Link href={backHref}>{t(locale, "back")}</Link>
        </p>
        <h1>{title}</h1>
        {!id ? (
          <p>{t(locale, "entity.missingId")}</p>
        ) : (
          <EntityEditForm
            locale={locale}
            entity={entityName}
            recordId={id}
            schema={schema}
            initial={entity?.payload ?? null}
            toolRef={toolRef}
            fieldOrder={fieldOrder}
            layoutVariant={layoutVariant}
          />
        )}
      </main>
    );
  }

  return (
    <main style={{ padding: 24 }}>
      <p>
        <Link href={backHref}>{t(locale, "back")}</Link>
      </p>
      <h1>
        {t(locale, "page.unsupportedType")}
        {pageType}
      </h1>
    </main>
  );
}
