"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, text } from "../../../lib/api";
import { t } from "../../../lib/i18n";
import type { FieldDef, EffectiveSchema } from "../../../lib/types";
import { ReferencePicker } from "../../../components/nl2ui/ReferencePicker";

function isWritable(schema: EffectiveSchema | null, k: string) {
  const f = schema?.fields?.[k];
  return Boolean(f?.writable);
}

function toPatch(fields: Record<string, FieldDef>, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [name, def] of Object.entries(fields)) {
    const raw = values[name];
    if (raw === undefined || raw === "") continue;
    if (def.type === "number") {
      const n = Number(raw);
      if (Number.isNaN(n)) errors[name] = "invalid number";
      else out[name] = n;
    }
    else if (def.type === "boolean") out[name] = Boolean(raw);
    else if (def.type === "json") {
      try {
        out[name] = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        errors[name] = "invalid json";
      }
    }
    else out[name] = raw;
  }
  return { ok: Object.keys(errors).length === 0, patch: out, errors };
}

export default function EntityEditForm(props: {
  locale: string;
  entity: string;
  recordId: string;
  schema: EffectiveSchema | null;
  initial: Record<string, unknown> | null;
  toolRef?: string;
  fieldOrder?: string[];
  layoutVariant?: "single" | "twoColumn";
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const fields = useMemo(() => (props.schema?.fields ?? {}) as Record<string, FieldDef>, [props.schema]);
  const keys = useMemo(() => {
    const all = Object.keys(fields).filter((k) => isWritable(props.schema, k));
    const order = Array.isArray(props.fieldOrder) ? props.fieldOrder : [];
    if (!order.length) return all;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of order) {
      if (all.includes(k)) {
        out.push(k);
        seen.add(k);
      }
    }
    for (const k of all) if (!seen.has(k)) out.push(k);
    return out;
  }, [fields, props.fieldOrder, props.schema]);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const k of keys) {
      const t = fields[k]?.type ?? "string";
      const init = props.initial?.[k];
      if (t === "json") v[k] = init === undefined ? "" : JSON.stringify(init, null, 2);
      else if (t === "boolean") v[k] = Boolean(init);
      else v[k] = init ?? "";
    }
    return v;
  });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!props.toolRef) {
      setError("missing toolRef");
      return;
    }
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const writableFields: Record<string, FieldDef> = {};
      for (const k of keys) writableFields[k] = fields[k];
      const built = toPatch(writableFields, values);
      if (!built.ok) {
        setFieldErrors(built.errors);
        return;
      }
      const patch = built.patch;
      const idempotencyKey = crypto.randomUUID();
      const res = await apiFetch(`/tools/${encodeURIComponent(props.toolRef)}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        idempotencyKey: idempotencyKey,
        body: JSON.stringify({ schemaName: "core", entityName: props.entity, recordId: props.recordId, patch }),
      });
      if (!res.ok) throw new Error("update_failed");
      const json = await res.json();
      const runId = json?.run?.runId;
      if (runId) router.push(`/runs/${encodeURIComponent(runId)}?lang=${encodeURIComponent(props.locale)}`);
      else router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <div
        style={{
          display: "grid",
          gap: 12,
          maxWidth: props.layoutVariant === "twoColumn" ? 980 : 720,
          gridTemplateColumns: props.layoutVariant === "twoColumn" ? "1fr 1fr" : "1fr",
        }}
      >
      {keys.length === 0 ? <p>no writable fields</p> : null}
      {keys.map((k) => {
        const def = fields[k];
        const type = def?.type ?? "string";
        const ferr = fieldErrors[k];
        if (type === "boolean") {
          return (
            <div key={k} style={{ display: "grid", gap: 6, marginBottom: 12 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={Boolean(values[k])}
                  disabled={saving}
                  onChange={(e) => {
                    setValues((s) => ({ ...s, [k]: e.target.checked }));
                    setFieldErrors((v) => {
                      const rest = { ...v };
                      delete rest[k];
                      return rest;
                    });
                  }}
                />
                {k}
              </label>
              {ferr ? <div style={{ color: "crimson" }}>{ferr}</div> : null}
            </div>
          );
        }

        if (type === "json") {
          return (
            <label key={k} style={{ display: "grid", gap: 6, marginBottom: 12 }}>
              <div style={{ fontWeight: 600 }}>{k}</div>
              <textarea
                rows={4}
                value={String(values[k] ?? "")}
                disabled={saving}
                onChange={(e) => {
                  setValues((s) => ({ ...s, [k]: e.target.value }));
                  setFieldErrors((v) => {
                    const rest = { ...v };
                    delete rest[k];
                    return rest;
                  });
                }}
              />
              {ferr ? <div style={{ color: "crimson" }}>{ferr}</div> : null}
            </label>
          );
        }

        if (type === "reference") {
          const dep = def?.dependsOn;
          const cascadeFilter = dep && values[dep.field]
            ? { field: dep.filterField, value: String(values[dep.field]) }
            : null;
          return (
            <label key={k} style={{ display: "grid", gap: 6, marginBottom: 12 }}>
              <div style={{ fontWeight: 600 }}>{text(fields[k]?.displayName ?? k, props.locale) || k}</div>
              <ReferencePicker
                fieldDef={{
                  referenceEntity: fields[k]?.referenceEntity ?? "",
                  displayField: fields[k]?.displayField ?? "name",
                  searchFields: fields[k]?.searchFields,
                  required: fields[k]?.required,
                }}
                value={values[k] as string | undefined}
                onChange={(val) => {
                  setValues((s) => ({ ...s, [k]: val }));
                  setFieldErrors((v) => {
                    const rest = { ...v };
                    delete rest[k];
                    return rest;
                  });
                }}
                disabled={saving}
                placeholder={`${t(props.locale, "common.search")} ${fields[k]?.referenceEntity ?? "..."}`}
                cascadeFilter={cascadeFilter}
              />
              {ferr ? <div style={{ color: "crimson" }}>{ferr}</div> : null}
            </label>
          );
        }

        return (
          <label key={k} style={{ display: "grid", gap: 6, marginBottom: 12 }}>
            <div style={{ fontWeight: 600 }}>{k}</div>
            <input
              type={type === "number" ? "number" : "text"}
              value={String(values[k] ?? "")}
              disabled={saving}
              onChange={(e) => {
                setValues((s) => ({ ...s, [k]: e.target.value }));
                setFieldErrors((v) => {
                  const rest = { ...v };
                  delete rest[k];
                  return rest;
                });
              }}
              style={{ width: "100%", padding: 8 }}
            />
            {ferr ? <div style={{ color: "crimson" }}>{ferr}</div> : null}
          </label>
        );
      })}
      {error ? <p style={{ color: "red" }}>{error}</p> : null}
      <button type="submit" disabled={saving}>
        {saving ? "saving..." : "save"}
      </button>
      </div>
    </form>
  );
}
