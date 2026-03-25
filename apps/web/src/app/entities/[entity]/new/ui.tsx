"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, text } from "../../../../lib/api";
import { t } from "../../../../lib/i18n";
import type { FieldDef, EffectiveSchema, UiFormUi } from "../../../../lib/types";
import { ReferencePicker } from "../../../../components/nl2ui/ReferencePicker";

type Props = {
  locale: string;
  entity: string;
  schema: EffectiveSchema | null;
  toolRef?: string;
  mode?: "create" | "update";
  recordId?: string;
  initialValues?: Record<string, unknown>;
  fieldOrder?: string[];
  groups?: UiFormUi["groups"];
  layoutVariant?: "single" | "twoColumn";
  showReadOnly?: boolean;
};

function validateAndBuildPayload(fields: Record<string, FieldDef>, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [name, def] of Object.entries(fields)) {
    const writable = def?.writable !== false;
    if (!writable) continue;
    const raw = values[name];
    const empty = raw === undefined || raw === "";
    if (def.required && writable && empty) {
      errors[name] = "required";
      continue;
    }
    if (empty) continue;
    if (def.type === "number") {
      const n = Number(raw);
      if (Number.isNaN(n)) errors[name] = "invalid number";
      else out[name] = n;
    } else if (def.type === "boolean") {
      out[name] = Boolean(raw);
    } else if (def.type === "json") {
      try {
        out[name] = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        errors[name] = "invalid json";
      }
    } else {
      out[name] = raw;
    }
  }
  return { ok: Object.keys(errors).length === 0, payload: out, errors };
}

export function EntityForm(props: Props) {
  const router = useRouter();
  const fields = useMemo(() => (props.schema?.fields ?? {}) as Record<string, FieldDef>, [props.schema]);
  const showReadOnly = props.showReadOnly ?? (props.mode === "update");
  const orderedKeys = useMemo(() => {
    const entries = Object.entries(fields);
    const order = Array.isArray(props.fieldOrder) ? props.fieldOrder : [];
    const base = order.length
      ? (() => {
          const map = new Map(entries);
          const out: Array<[string, FieldDef]> = [];
          for (const k of order) {
            const v = map.get(k);
            if (v) out.push([k, v]);
          }
          for (const [k, v] of entries) if (!order.includes(k)) out.push([k, v]);
          return out;
        })()
      : entries;
    return base
      .filter(([, def]) => {
        const writable = def?.writable !== false;
        return writable || showReadOnly;
      })
      .map(([k]) => k);
  }, [fields, props.fieldOrder, showReadOnly]);

  const sections = useMemo(() => {
    const groups = Array.isArray(props.groups) ? props.groups : [];
    if (!groups.length) return [{ title: null as any, keys: orderedKeys }];
    const all = new Set(orderedKeys);
    const used = new Set<string>();
    const out: Array<{ title: any; keys: string[] }> = [];
    for (const g of groups) {
      const keys = (Array.isArray(g?.fields) ? g.fields : [])
        .map((x) => String(x))
        .filter((k) => all.has(k));
      if (!keys.length) continue;
      for (const k of keys) used.add(k);
      out.push({ title: (g as any).title ?? null, keys });
    }
    const rest = orderedKeys.filter((k) => !used.has(k));
    if (rest.length) out.push({ title: null as any, keys: rest });
    return out.length ? out : [{ title: null as any, keys: orderedKeys }];
  }, [orderedKeys, props.groups]);

  const [values, setValues] = useState<Record<string, unknown>>(() => (props.initialValues && typeof props.initialValues === "object" ? { ...props.initialValues } : {}));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);

  function jsonTextValue(v: unknown) {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const built = validateAndBuildPayload(fields, values);
      if (!built.ok) {
        setFieldErrors(built.errors);
        return;
      }
      const payload = built.payload;
      const idempotencyKey = crypto.randomUUID();
      if (props.toolRef) {
        const res = await apiFetch(`/tools/${encodeURIComponent(props.toolRef)}/execute`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          locale: props.locale,
          body: JSON.stringify(
            props.mode === "update"
              ? { schemaName: "core", entityName: props.entity, id: props.recordId, patch: payload }
              : { schemaName: "core", entityName: props.entity, payload },
          ),
        });
        const data = await res.json();
        if (!res.ok) {
          const msg = typeof data?.message === "object" ? text(data.message, props.locale) : String(data?.message ?? res.statusText);
          throw new Error(`${data?.errorCode ?? "ERROR"}: ${msg}`);
        }
        setRunId(String(data.runId));
        router.push(`/runs/${encodeURIComponent(String(data.runId))}?lang=${encodeURIComponent(props.locale)}`);
      } else {
        const isUpdate = props.mode === "update";
        if (isUpdate && !props.recordId) throw new Error("Missing recordId");
        const url = isUpdate
          ? `/entities/${encodeURIComponent(props.entity)}/${encodeURIComponent(String(props.recordId))}`
          : `/entities/${encodeURIComponent(props.entity)}`;
        const res = await apiFetch(url, {
          method: isUpdate ? "PATCH" : "POST",
          headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
          locale: props.locale,
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          const msg = typeof data?.message === "object" ? text(data.message, props.locale) : String(data?.message ?? res.statusText);
          throw new Error(`${data?.errorCode ?? "ERROR"}: ${msg}`);
        }
        if (isUpdate) router.push(`/entities/${encodeURIComponent(props.entity)}/${encodeURIComponent(String(props.recordId))}?lang=${encodeURIComponent(props.locale)}`);
        else router.push(`/entities/${encodeURIComponent(props.entity)}?lang=${encodeURIComponent(props.locale)}`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        maxWidth: props.layoutVariant === "twoColumn" ? 980 : 720,
        gridTemplateColumns: props.layoutVariant === "twoColumn" ? "1fr 1fr" : "1fr",
      }}
    >
      {sections.map((sec, secIdx) => {
        const titleText = sec.title ? text(sec.title as any, props.locale) : "";
        return (
          <div key={`sec-${secIdx}`} style={{ display: "contents" as any }}>
            {titleText ? (
              <h3 style={{ gridColumn: "1 / -1", margin: "8px 0 0 0" }}>{titleText}</h3>
            ) : null}
            {sec.keys.map((name) => {
              const def = fields[name];
              if (!def) return null;
              const label = text(def?.displayName ?? name, props.locale) || name;
              const writable = def?.writable !== false;
              const type = def?.type ?? "string";
              const ferr = fieldErrors[name];
              if (!writable && !showReadOnly) return null;

              if (type === "boolean") {
                return (
                  <div key={name} style={{ display: "grid", gap: 6 }}>
                    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        type="checkbox"
                        checked={Boolean(values[name])}
                        disabled={!writable || submitting}
                        onChange={(e) => {
                          setValues((v) => ({ ...v, [name]: e.target.checked }));
                          setFieldErrors((s) => {
                            const rest = { ...s };
                            delete rest[name];
                            return rest;
                          });
                        }}
                      />
                      {label}
                      {def.required && writable ? " *" : ""}
                    </label>
                    {ferr ? <div style={{ color: "crimson" }}>{ferr}</div> : null}
                  </div>
                );
              }

              if (type === "json") {
                return (
                  <label key={name} style={{ display: "grid", gap: 6 }}>
                    <div>
                      {label}
                      {def.required && writable ? " *" : ""}
                    </div>
                    <textarea
                      rows={4}
                      value={jsonTextValue(values[name])}
                      disabled={!writable || submitting}
                      onChange={(e) => {
                        setValues((v) => ({ ...v, [name]: e.target.value }));
                        setFieldErrors((s) => {
                          const rest = { ...s };
                          delete rest[name];
                          return rest;
                        });
                      }}
                    />
                    {ferr ? <div style={{ color: "crimson" }}>{ferr}</div> : null}
                  </label>
                );
              }

              if (type === "reference") {
                // Build cascadeFilter from dependsOn declaration
                const dep = def.dependsOn;
                const cascadeFilter = dep && values[dep.field]
                  ? { field: dep.filterField, value: String(values[dep.field]) }
                  : null;
                return (
                  <label key={name} style={{ display: "grid", gap: 6 }}>
                    <div>
                      {label}
                      {def.required && writable ? " *" : ""}
                    </div>
                    <ReferencePicker
                      fieldDef={{
                        referenceEntity: def.referenceEntity ?? "",
                        displayField: def.displayField ?? "name",
                        searchFields: def.searchFields,
                        required: def.required,
                      }}
                      value={values[name] as string | undefined}
                      onChange={(val) => {
                        setValues((v) => ({ ...v, [name]: val }));
                        setFieldErrors((s) => {
                          const rest = { ...s };
                          delete rest[name];
                          return rest;
                        });
                      }}
                      disabled={!writable || submitting}
                      placeholder={`${t(props.locale, "common.search")} ${def.referenceEntity ?? "..."}`}
                      cascadeFilter={cascadeFilter}
                    />
                    {ferr ? <div style={{ color: "crimson" }}>{ferr}</div> : null}
                  </label>
                );
              }

              return (
                <label key={name} style={{ display: "grid", gap: 6 }}>
                  <div>
                    {label}
                    {def.required && writable ? " *" : ""}
                  </div>
                  <input
                    type={type === "number" ? "number" : "text"}
                    value={String(values[name] ?? "")}
                    disabled={!writable || submitting}
                    onChange={(e) => {
                      setValues((v) => ({ ...v, [name]: e.target.value }));
                      setFieldErrors((s) => {
                        const rest = { ...s };
                        delete rest[name];
                        return rest;
                      });
                    }}
                  />
                  {ferr ? <div style={{ color: "crimson" }}>{ferr}</div> : null}
                </label>
              );
            })}
          </div>
        );
      })}

      {runId ? (
        <p>
          RunId：{runId}
        </p>
      ) : null}
      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      <button type="button" onClick={submit} disabled={submitting}>
        {t(props.locale, "submit")}
      </button>
    </div>
  );
}
