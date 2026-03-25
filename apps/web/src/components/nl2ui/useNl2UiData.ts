"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch, text as i18nText } from "@/lib/api";
import type { EffectiveSchema, FieldDef } from "@/lib/types";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DataBinding {
  id: string;
  target: string;
  params?: Record<string, any>;
  filters?: Record<string, any>;
  sort?: { field: string; direction: "asc" | "desc" };
}

export interface EntityRecord {
  id: string;
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BindingResult {
  loading: boolean;
  error: string | null;
  /** Raw records from entities.query / entities.list */
  items: EntityRecord[];
  /** Effective schema (if fetched) */
  schema: EffectiveSchema | null;
  /** Next cursor for pagination */
  nextCursor: { updatedAt: string; id: string } | null;
  /** Total count hint (if available) */
  totalHint: number | null;
  /** Resolved display labels for reference fields: fieldName → { recordId → label } */
  refLabels?: Record<string, Record<string, string>>;
}

export type DataMap = Record<string, BindingResult>;

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * useNl2UiData - fetches real data from platform APIs based on dataBindings.
 *
 * Supported binding.target values:
 * - entities.list    → GET /entities/:entityName
 * - entities.query   → POST /entities/:entityName/query
 * - schema.effective → GET /schemas/:entityName/effective
 */
export function useNl2UiData(
  dataBindings: DataBinding[],
  locale: string,
): { data: DataMap; refresh: () => void } {
  const [data, setData] = useState<DataMap>(() => {
    const init: DataMap = {};
    for (const b of dataBindings) {
      init[b.id] = { loading: true, error: null, items: [], schema: null, nextCursor: null, totalHint: null };
    }
    return init;
  });

  // Track last bindings JSON to avoid re-fetch on same config
  const bindingsRef = useRef<string>("");
  const fetchCountRef = useRef(0);

  const fetchAll = useCallback(async () => {
    const fetchId = ++fetchCountRef.current;

    // Mark all as loading
    setData((prev) => {
      const next = { ...prev };
      for (const b of dataBindings) {
        next[b.id] = { ...(next[b.id] ?? { loading: true, error: null, items: [], schema: null, nextCursor: null, totalHint: null }), loading: true, error: null };
      }
      return next;
    });

    // Fetch all bindings in parallel (with per-binding timeout to avoid infinite loading)
    const results = await Promise.allSettled(
      dataBindings.map((binding) => fetchBindingWithTimeout(binding, locale)),
    );

    // Stale check
    if (fetchId !== fetchCountRef.current) return;

    setData(() => {
      const next: DataMap = {};
      for (let i = 0; i < dataBindings.length; i++) {
        const b = dataBindings[i];
        const result = results[i];
        if (result.status === "fulfilled") {
          next[b.id] = { ...result.value, loading: false };
        } else {
          const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          next[b.id] = { loading: false, error: errMsg, items: [], schema: null, nextCursor: null, totalHint: null };
        }
      }
      return next;
    });

    // Resolve reference labels asynchronously (non-blocking)
    for (let i = 0; i < dataBindings.length; i++) {
      const b = dataBindings[i];
      const result = results[i];
      if (result.status !== "fulfilled" || !result.value.items.length || !result.value.schema) continue;
      resolveClientRefLabels(result.value.items, result.value.schema, locale).then((refLabels) => {
        if (fetchId !== fetchCountRef.current) return;
        if (!refLabels || Object.keys(refLabels).length === 0) return;
        setData((prev) => ({
          ...prev,
          [b.id]: { ...prev[b.id], refLabels },
        }));
      });
    }
  }, [dataBindings, locale]);

  // Use a ref to hold the latest fetchAll so the effect only depends on dataBindings
  const fetchAllRef = useRef(fetchAll);
  useEffect(() => {
    fetchAllRef.current = fetchAll;
  }, [fetchAll]);

  useEffect(() => {
    const key = JSON.stringify(dataBindings);
    if (key === bindingsRef.current) return;
    bindingsRef.current = key;
    // Call directly instead of setTimeout to avoid React 18 StrictMode
    // cleanup cancelling the pending timer before it fires.
    void fetchAllRef.current();
  }, [dataBindings]);

  return { data, refresh: fetchAll };
}

// ─── Fetchers ───────────────────────────────────────────────────────────────

const DEFAULT_BINDING_TIMEOUT_MS = 15_000;

async function apiFetchWithTimeout(
  path: string,
  init: RequestInit & { locale?: string },
  timeoutMs = DEFAULT_BINDING_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  try {
    const fetchPromise = apiFetch(path, { ...init, signal: ctrl.signal });
    const timeoutPromise = new Promise<Response>((_, reject) => {
      setTimeout(() => {
        try { ctrl.abort(); } catch {}
        reject(new DOMException("TimeoutError", "AbortError"));
      }, timeoutMs);
    });
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
  }
}

async function fetchBindingWithTimeout(binding: DataBinding, locale: string) {
  const timeoutMsRaw = binding.params?.timeoutMs;
  const timeoutMs =
    typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.max(1_000, Math.round(timeoutMsRaw))
      : DEFAULT_BINDING_TIMEOUT_MS;
  return await fetchBinding(binding, locale, timeoutMs);
}

async function fetchBinding(
  binding: DataBinding,
  locale: string,
  timeoutMs: number,
): Promise<Omit<BindingResult, "loading">> {
  const entityName = binding.params?.entityName ?? "";
  if (!entityName) {
    return { error: "missing entityName in binding params", items: [], schema: null, nextCursor: null, totalHint: null };
  }

  switch (binding.target) {
    case "entities.query":
      return fetchEntityQuery(entityName, binding, locale, timeoutMs);
    case "entities.list":
      return fetchEntityList(entityName, locale, timeoutMs);
    case "schema.effective":
      return fetchEffectiveSchema(entityName, locale, timeoutMs);
    default:
      return { error: `unsupported binding target: ${binding.target}`, items: [], schema: null, nextCursor: null, totalHint: null };
  }
}

async function fetchEntityQuery(
  entityName: string,
  binding: DataBinding,
  locale: string,
  timeoutMs: number,
): Promise<Omit<BindingResult, "loading">> {
  try {
    // First fetch schema for field metadata
    const schemaResult = await fetchEffectiveSchema(entityName, locale, timeoutMs);
    const schema = schemaResult.schema;
    const fieldKeys = schema ? Object.keys(schema.fields ?? {}) : [];

    // Build query body
    const queryBody: Record<string, unknown> = {
      schemaName: "core",
      limit: 50,
    };

    // Select fields (max 8)
    if (fieldKeys.length > 0) {
      queryBody.select = fieldKeys.slice(0, 8);
    }

    // Apply sort from binding
    if (binding.sort) {
      queryBody.orderBy = [{ field: binding.sort.field, direction: binding.sort.direction }];
    } else {
      // Default sort by updatedAt desc (if field exists)
      if (fieldKeys.includes("updatedAt")) {
        queryBody.orderBy = [{ field: "updatedAt", direction: "desc" }];
      }
    }

    // Apply filters from binding (simplified: only apply safe filters)
    if (binding.filters && Object.keys(binding.filters).length > 0) {
      const filterConds: Array<{ field: string; op: string; value: unknown }> = [];
      for (const [field, condition] of Object.entries(binding.filters)) {
        if (!fieldKeys.includes(field) && fieldKeys.length > 0) continue; // Skip unknown fields
        if (condition && typeof condition === "object") {
          if ("equals" in condition) filterConds.push({ field, op: "eq", value: condition.equals });
          if ("contains" in condition) filterConds.push({ field, op: "contains", value: condition.contains });
          if ("gte" in condition) filterConds.push({ field, op: "gte", value: condition.gte });
          if ("lte" in condition) filterConds.push({ field, op: "lte", value: condition.lte });
        }
      }
      if (filterConds.length === 1) {
        queryBody.filters = filterConds[0];
      } else if (filterConds.length > 1) {
        queryBody.filters = { and: filterConds };
      }
    }

    const res = await apiFetchWithTimeout(`/entities/${encodeURIComponent(entityName)}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      locale,
      body: JSON.stringify(queryBody),
    }, timeoutMs);

    if (!res.ok) {
      const errJson: any = await res.json().catch(() => null);
      const errMsg = errJson?.message
        ? (typeof errJson.message === "object" ? i18nText(errJson.message, locale) : String(errJson.message))
        : `HTTP ${res.status}`;
      return { error: errMsg, items: [], schema, nextCursor: null, totalHint: null };
    }

    const json = (await res.json()) as Record<string, unknown>;
    const items = Array.isArray(json.items) ? (json.items as EntityRecord[]) : [];
    const nextCursorRaw = json.nextCursor;
    const nextCursor =
      nextCursorRaw && typeof nextCursorRaw === "object"
        ? (nextCursorRaw as { updatedAt: string; id: string })
        : null;

    // T12: Defense-in-depth — strip payload fields not in effective schema
    const safeItems = sanitizeItemsToSchema(items, schema);

    return {
      error: null,
      items: safeItems,
      schema,
      nextCursor,
      totalHint: safeItems.length,
    };
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    const msg = isAbort ? `Request timed out (${timeoutMs}ms)` : err instanceof Error ? err.message : String(err);
    console.error(`[NL2UI] fetchEntityQuery(${entityName}) failed:`, msg);
    return { error: msg, items: [], schema: null, nextCursor: null, totalHint: null };
  }
}

async function fetchEntityList(
  entityName: string,
  locale: string,
  timeoutMs: number,
): Promise<Omit<BindingResult, "loading">> {
  // entities.list is essentially a simpler query with defaults
  return fetchEntityQuery(entityName, { id: "_list", target: "entities.query", params: { entityName } }, locale, timeoutMs);
}

async function fetchEffectiveSchema(
  entityName: string,
  locale: string,
  timeoutMs: number,
): Promise<Omit<BindingResult, "loading">> {
  try {
    const res = await apiFetchWithTimeout(`/schemas/${encodeURIComponent(entityName)}/effective?schemaName=core`, {
      method: "GET",
      locale,
      cache: "no-store",
    }, timeoutMs);

    if (!res.ok) {
      return { error: `Schema fetch failed: HTTP ${res.status}`, items: [], schema: null, nextCursor: null, totalHint: null };
    }

    const schema = (await res.json()) as EffectiveSchema;
    return { error: null, items: [], schema, nextCursor: null, totalHint: null };
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    const msg = isAbort ? `Request timed out (${timeoutMs}ms)` : err instanceof Error ? err.message : String(err);
    console.error(`[NL2UI] fetchEffectiveSchema(${entityName}) failed:`, msg);
    return { error: msg, items: [], schema: null, nextCursor: null, totalHint: null };
  }
}

// ─── Data Transformers ──────────────────────────────────────────────────────

/**
 * Convert entity records into DataGrid columns and rows.
 */
export function toGridData(
  items: EntityRecord[],
  schema: EffectiveSchema | null,
  locale: string,
  refLabels?: Record<string, Record<string, string>>,
): { columns: Array<{ id: string; label: string; type: "text" | "number" | "date" | "boolean" | "select" }>; rows: Array<{ id: string; cells: Record<string, any> }> } {
  const fields = (schema?.fields ?? {}) as Record<string, FieldDef>;
  const fieldKeys = Object.keys(fields).slice(0, 8);

  // If no schema, infer columns from first item's payload
  if (fieldKeys.length === 0 && items.length > 0) {
    const firstPayload = items[0].payload ?? {};
    const keys = Object.keys(firstPayload).slice(0, 8);
    return {
      columns: keys.map((k) => ({ id: k, label: k, type: "text" as const })),
      rows: items.map((r) => ({
        id: String(r.id),
        cells: Object.fromEntries(keys.map((k) => [k, r.payload?.[k] ?? ""])),
      })),
    };
  }

  const typeMap: Record<string, "text" | "number" | "date" | "boolean"> = {
    string: "text",
    number: "number",
    datetime: "date",
    boolean: "boolean",
    json: "text",
    reference: "text",
  };

  const columns = fieldKeys.map((k) => ({
    id: k,
    label: i18nText(fields[k]?.displayName ?? k, locale) || k,
    type: typeMap[fields[k]?.type ?? "string"] ?? ("text" as const),
  }));

  const rows = items.map((r) => ({
    id: String(r.id),
    cells: Object.fromEntries(
      fieldKeys.map((k) => {
        const val = r.payload?.[k];
        const label = refLabels?.[k]?.[String(val)];
        return [k, formatCellValue(val, fields[k]?.type, label)];
      }),
    ),
  }));

  return { columns, rows };
}

/**
 * Convert entity records into Kanban columns.
 * Group by a status-like field.
 */
export function toKanbanData(
  items: EntityRecord[],
  schema: EffectiveSchema | null,
  _locale: string,
): Array<{ id: string; title: string; color: string; cards: Array<{ id: string; title: string; description?: string; priority: "none"; labels?: string[] }> }> {
  void _locale;
  const fields = (schema?.fields ?? {}) as Record<string, FieldDef>;
  const schemaKeys = Object.keys(fields);
  const inferredKeys = schemaKeys.length === 0 && items.length > 0 ? Object.keys(items[0].payload ?? {}) : [];
  const fieldKeys = schemaKeys.length ? schemaKeys : inferredKeys;

  // Find a status-like field for grouping
  const statusField = fieldKeys.find((k) => k === "status") ?? fieldKeys.find((k) => k.includes("status")) ?? null;
  const titleField = fieldKeys.find((k) => ["title", "name", "subject"].includes(k)) ?? fieldKeys[0] ?? "id";
  const descField = fieldKeys.find((k) => ["description", "content", "body", "note"].includes(k));

  const colors = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

  if (!statusField) {
    // No status field — put all items in one column
    return [{
      id: "all",
      title: "All Items",
      color: colors[0],
      cards: items.map((r) => ({
        id: String(r.id),
        title: String(r.payload?.[titleField] ?? r.id),
        description: descField ? String(r.payload?.[descField] ?? "") : undefined,
        priority: "none" as const,
      })),
    }];
  }

  // Group by status field
  const groups: Record<string, EntityRecord[]> = {};
  for (const r of items) {
    const status = String(r.payload?.[statusField] ?? "other");
    (groups[status] ??= []).push(r);
  }

  return Object.entries(groups).map(([status, records], idx) => ({
    id: status,
    title: status,
    color: colors[idx % colors.length],
    cards: records.map((r) => ({
      id: String(r.id),
      title: String(r.payload?.[titleField] ?? r.id),
      description: descField ? String(r.payload?.[descField] ?? "") : undefined,
      priority: "none" as const,
    })),
  }));
}

/**
 * Convert entity records into CardList data.
 */
export function toCardListData(
  items: EntityRecord[],
  schema: EffectiveSchema | null,
  locale: string,
): Array<{ title: string; description: string; image?: string; fields: Array<{ label: string; value: string }> }> {
  const fields = (schema?.fields ?? {}) as Record<string, FieldDef>;
  const schemaKeys = Object.keys(fields);
  const inferredKeys = schemaKeys.length === 0 && items.length > 0 ? Object.keys(items[0].payload ?? {}).slice(0, 12) : [];
  const fieldKeys = schemaKeys.length ? schemaKeys : inferredKeys;

  const titleField = fieldKeys.find((k) => ["title", "name", "subject"].includes(k)) ?? fieldKeys[0] ?? "id";
  const descField = fieldKeys.find((k) => ["description", "content", "body", "note"].includes(k));
  const imageField = fieldKeys.find((k) => ["image", "imageUrl", "avatar", "cover", "logo", "photo", "thumbnail", "icon", "picture", "img"].includes(k));
  const metaFields = fieldKeys.filter((k) => k !== titleField && k !== descField && k !== imageField).slice(0, 3);

  return items.map((r) => {
    const imgVal = imageField ? String(r.payload?.[imageField] ?? "") : "";
    return {
      title: String(r.payload?.[titleField] ?? r.id),
      description: descField ? String(r.payload?.[descField] ?? "") : "",
      image: imgVal && (imgVal.startsWith("http") || imgVal.startsWith("/") || imgVal.startsWith("data:")) ? imgVal : undefined,
      fields: metaFields.map((k) => ({
        label: schemaKeys.length ? (i18nText(fields[k]?.displayName ?? k, locale) || k) : k,
        value: String(r.payload?.[k] ?? ""),
      })),
    };
  });
}

/**
 * Convert entity records into dashboard summary data.
 */
export function toBiData(
  items: EntityRecord[],
  schema: EffectiveSchema | null,
  _locale: string,
): { totalCount: number; statusGroups: Array<{ label: string; value: number }>; recentTrend: Array<{ label: string; value: number }> } {
  void _locale;
  const fields = (schema?.fields ?? {}) as Record<string, FieldDef>;
  const schemaKeys = Object.keys(fields);
  const inferredKeys = schemaKeys.length === 0 && items.length > 0 ? Object.keys(items[0].payload ?? {}) : [];
  const fieldKeys = schemaKeys.length ? schemaKeys : inferredKeys;
  const statusField = fieldKeys.find((k) => k === "status") ?? fieldKeys.find((k) => k.includes("status"));

  const statusGroups: Array<{ label: string; value: number }> = [];
  if (statusField) {
    const counts: Record<string, number> = {};
    for (const r of items) {
      const s = String(r.payload?.[statusField] ?? "unknown");
      counts[s] = (counts[s] ?? 0) + 1;
    }
    for (const [label, value] of Object.entries(counts)) {
      statusGroups.push({ label, value });
    }
  }

  return {
    totalCount: items.length,
    statusGroups,
    recentTrend: items.slice(0, 7).map((r, i) => ({
      label: `#${i + 1}`,
      value: i + 1,
    })),
  };
}

/**
 * Extract dashboard stats from entity records (auto-detect numeric fields).
 */
export function toStatsData(
  items: EntityRecord[],
  schema: EffectiveSchema | null,
  locale: string,
): Array<{ label: string; value: number | string; suffix?: string }> {
  const fields = (schema?.fields ?? {}) as Record<string, FieldDef>;
  const schemaKeys = Object.keys(fields);
  const inferredKeys = schemaKeys.length === 0 && items.length > 0 ? Object.keys(items[0].payload ?? {}) : [];
  const fieldKeys = schemaKeys.length ? schemaKeys : inferredKeys;
  const stats: Array<{ label: string; value: number | string; suffix?: string }> = [];

  // 1) Total count
  stats.push({ label: "Total", value: items.length });

  // 2) Find numeric fields and compute sum/avg
  const numericFields = fieldKeys.filter((k) => {
    if (["id", "revision"].includes(k)) return false;
    const sample = items.find((r) => r.payload?.[k] != null);
    return sample && !Number.isNaN(Number(sample.payload?.[k]));
  }).slice(0, 2);

  for (const nk of numericFields) {
    const vals = items.map((r) => Number(r.payload?.[nk] ?? 0)).filter((v) => !Number.isNaN(v));
    if (vals.length === 0) continue;
    const sum = vals.reduce((a, b) => a + b, 0);
    const label = schemaKeys.length ? (i18nText(fields[nk]?.displayName ?? nk, locale) || nk) : nk;
    stats.push({ label: `${label} Sum`, value: Math.round(sum * 100) / 100 });
  }

  // 3) Status breakdown (count of most common)
  const statusField = fieldKeys.find((k) => k === "status") ?? fieldKeys.find((k) => k.includes("status"));
  if (statusField) {
    const counts: Record<string, number> = {};
    for (const r of items) {
      const s = String(r.payload?.[statusField] ?? "unknown");
      counts[s] = (counts[s] ?? 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (sorted[0]) stats.push({ label: sorted[0][0], value: sorted[0][1] });
  }

  return stats.slice(0, 4);
}

// ─── T12: Field-level security helpers ──────────────────────────────────────

/**
 * T12: defensive field filtering - clip item payload to fields allowed by the effective schema.
 * Even if the API already filters fields, keep defense-in-depth here.
 */
function sanitizeItemsToSchema(
  items: EntityRecord[],
  schema: EffectiveSchema | null,
): EntityRecord[] {
  if (!schema?.fields) return items;
  const allowedFields = new Set(Object.keys(schema.fields));
  // Always keep system fields
  allowedFields.add("id");
  allowedFields.add("createdAt");
  allowedFields.add("updatedAt");

  return items.map((item) => {
    if (!item.payload) return item;
    const safePayload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item.payload)) {
      if (allowedFields.has(k)) safePayload[k] = v;
    }
    return { ...item, payload: safePayload };
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatCellValue(value: unknown, type?: string, resolvedLabel?: string): any {
  if (value === null || value === undefined) return "";
  if (type === "reference") {
    return resolvedLabel || String(value);
  }
  if (type === "datetime") {
    const d = new Date(String(value));
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
    return String(value);
  }
  if (type === "json") {
    try {
      const s = typeof value === "string" ? value : JSON.stringify(value);
      return s.length > 80 ? `${s.slice(0, 80)}…` : s;
    } catch {
      return String(value);
    }
  }
  if (type === "boolean") return Boolean(value);
  return value;
}

/**
 * Client-side async resolver for reference field labels.
 * Fetches referenced entity records and returns a fieldName→{id→label} map.
 */
async function resolveClientRefLabels(
  items: EntityRecord[],
  schema: EffectiveSchema,
  _locale: string,
): Promise<Record<string, Record<string, string>>> {
  void _locale;
  const fields = (schema.fields ?? {}) as Record<string, FieldDef>;
  const result: Record<string, Record<string, string>> = {};

  // Collect unique IDs per reference field
  const groups: Record<string, { entity: string; displayField: string; ids: Set<string> }> = {};
  for (const [fieldName, def] of Object.entries(fields)) {
    if (def.type !== "reference" || !def.referenceEntity) continue;
    const ids = new Set<string>();
    for (const item of items) {
      const val = item.payload?.[fieldName];
      if (typeof val === "string" && val) ids.add(val);
    }
    if (ids.size > 0) {
      groups[fieldName] = { entity: def.referenceEntity, displayField: def.displayField ?? "name", ids };
    }
  }

  if (Object.keys(groups).length === 0) return result;

  // Deduplicate fetches: entity+id → promise
  const cache = new Map<string, Promise<Record<string, unknown> | null>>();
  const fetchOne = async (entity: string, id: string): Promise<Record<string, unknown> | null> => {
    try {
      const res = await apiFetch(`/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  for (const group of Object.values(groups)) {
    for (const id of group.ids) {
      const key = `${group.entity}::${id}`;
      if (!cache.has(key)) cache.set(key, fetchOne(group.entity, id));
    }
  }

  await Promise.all(cache.values());

  for (const [fieldName, group] of Object.entries(groups)) {
    result[fieldName] = {};
    for (const id of group.ids) {
      const rec = await cache.get(`${group.entity}::${id}`);
      if (rec) {
        const payload = rec.payload && typeof rec.payload === "object" ? (rec.payload as Record<string, unknown>) : rec;
        result[fieldName][id] = String(payload[group.displayField] ?? payload.name ?? id);
      } else {
        result[fieldName][id] = id;
      }
    }
  }

  return result;
}

// ─── Chart Data Transformer ─────────────────────────────────────────────────

/**
 * Convert entity records into chart series.
 * Auto-detect a numeric field as value and a string field as label.
 */
export function toChartData(
  items: EntityRecord[],
  schema: EffectiveSchema | null,
  locale: string,
  valueField?: string,
  labelField?: string,
): Array<{ label: string; value: number; color?: string }> {
  const fields = (schema?.fields ?? {}) as Record<string, FieldDef>;
  const fieldKeys = Object.keys(fields);

  // Auto-detect value field (first number field)
  const vField = valueField
    || fieldKeys.find((k) => fields[k]?.type === "number")
    || fieldKeys.find((k) => k.includes("amount") || k.includes("count") || k.includes("total") || k.includes("price"));

  // Auto-detect label field
  const lField = labelField
    || fieldKeys.find((k) => ["title", "name", "label", "subject", "status"].includes(k))
    || fieldKeys[0]
    || "id";

  // If we have a dedicated value field, use direct mapping
  if (vField) {
    return items.slice(0, 20).map((r) => ({
      label: String(r.payload?.[lField] ?? r.id),
      value: Number(r.payload?.[vField] ?? 0) || 0,
    }));
  }

  // Fallback: group by label field and count
  const counts: Record<string, number> = {};
  for (const r of items) {
    const key = String(r.payload?.[lField] ?? "other");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts).map(([label, value]) => ({ label, value }));
}

// ─── Timeline Data Transformer ──────────────────────────────────────────────

/**
 * Convert entity records into timeline events.
 */
export function toTimelineData(
  items: EntityRecord[],
  schema: EffectiveSchema | null,
  _locale: string,
): Array<{ id: string; title: string; description?: string; timestamp: string }> {
  void _locale;
  const fields = (schema?.fields ?? {}) as Record<string, FieldDef>;
  const schemaKeys = Object.keys(fields);
  const inferredKeys = schemaKeys.length === 0 && items.length > 0 ? Object.keys(items[0].payload ?? {}) : [];
  const fieldKeys = schemaKeys.length ? schemaKeys : inferredKeys;

  const titleField = fieldKeys.find((k) => ["title", "name", "subject"].includes(k)) ?? fieldKeys[0] ?? "id";
  const descField = fieldKeys.find((k) => ["description", "content", "body", "note"].includes(k));
  const dateField =
    (schemaKeys.length ? fieldKeys.find((k) => fields[k]?.type === "datetime") : null)
    ?? fieldKeys.find((k) => ["createdAt", "updatedAt", "date", "startDate", "dueDate"].includes(k))
    ?? "createdAt";

  return items.slice(0, 30).map((r) => ({
    id: String(r.id),
    title: String(r.payload?.[titleField] ?? r.id),
    description: descField ? String(r.payload?.[descField] ?? "") : undefined,
    timestamp: String(r.payload?.[dateField] ?? r.payload?.["createdAt"] ?? new Date().toISOString()),
  }));
}

// ─── Calendar Data Transformer ──────────────────────────────────────────────

/**
 * Convert entity records into calendar events.
 */
export function toCalendarData(
  items: EntityRecord[],
  schema: EffectiveSchema | null,
  _locale: string,
): Array<{ id: string; title: string; date: string; description?: string }> {
  void _locale;
  const fields = (schema?.fields ?? {}) as Record<string, FieldDef>;
  const schemaKeys = Object.keys(fields);
  const inferredKeys = schemaKeys.length === 0 && items.length > 0 ? Object.keys(items[0].payload ?? {}) : [];
  const fieldKeys = schemaKeys.length ? schemaKeys : inferredKeys;

  const titleField = fieldKeys.find((k) => ["title", "name", "subject"].includes(k)) ?? fieldKeys[0] ?? "id";
  const descField = fieldKeys.find((k) => ["description", "content", "body", "note"].includes(k));
  const dateField =
    (schemaKeys.length ? fieldKeys.find((k) => fields[k]?.type === "datetime") : null)
    ?? fieldKeys.find((k) => ["createdAt", "date", "startDate", "dueDate", "deadline"].includes(k))
    ?? "createdAt";

  return items.slice(0, 50).map((r) => ({
    id: String(r.id),
    title: String(r.payload?.[titleField] ?? r.id),
    date: String(r.payload?.[dateField] ?? r.payload?.["createdAt"] ?? new Date().toISOString()),
    description: descField ? String(r.payload?.[descField] ?? "") : undefined,
  }));
}
