import Link from "next/link";
import { cookies } from "next/headers";
import { apiFetch, pickLocale, text } from "../../../../lib/api";
import { t } from "../../../../lib/i18n";
import type { EffectiveSchema, FieldDef, SearchParams } from "../../../../lib/types";
import { Table } from "../../../../components/ui";
import { resolveReferenceLabels, type RefLabelMap } from "../../../../lib/referenceResolver";

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

async function loadEntity(locale: string, entity: string, id: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`, {
    method: "GET",
    token,
    locale,
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as unknown;
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

export default async function EntityDetailPage(props: {
  params: Promise<{ entity: string; id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const entity = decodeURIComponent(params.entity);
  const id = decodeURIComponent(params.id);

  const [schema, recRaw] = await Promise.all([loadEffectiveSchema(locale, entity), loadEntity(locale, entity, id)]);
  const title = text(schema?.displayName ?? entity, locale) || entity;
  const fields = (schema?.fields ?? {}) as Record<string, FieldDef>;
  const recObj = recRaw && typeof recRaw === "object" ? (recRaw as Record<string, unknown>) : null;
  const payload = recObj?.payload && typeof recObj.payload === "object" ? (recObj.payload as Record<string, unknown>) : {};

  // Resolve reference field display labels for detail view
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const refLabels: RefLabelMap = await resolveReferenceLabels({
    fields,
    items: recObj ? [recObj] : [],
    fetchOne: async (refEntity, refId) => {
      try {
        const r = await apiFetch(`/entities/${encodeURIComponent(refEntity)}/${encodeURIComponent(refId)}`, { method: "GET", token, locale, cache: "no-store" });
        if (!r.ok) return null;
        return (await r.json()) as Record<string, unknown>;
      } catch { return null; }
    },
  });

  return (
    <main style={{ padding: 24 }}>
      <p>
        <Link href={`/entities/${encodeURIComponent(entity)}?lang=${encodeURIComponent(locale)}`}>{t(locale, "back")}</Link>
      </p>
      <h1>
        {title} / {id}
      </h1>
      <p style={{ display: "flex", gap: 10 }}>
        <Link href={`/entities/${encodeURIComponent(entity)}?lang=${encodeURIComponent(locale)}`}>{t(locale, "entity.detail")}</Link>
        <Link href={`/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}/edit?lang=${encodeURIComponent(locale)}`}>{t(locale, "entity.edit")}</Link>
      </p>

      <h2 style={{ marginTop: 18 }}>{t(locale, "entity.detail.fieldsTab")}</h2>
      <Table>
        <thead>
          <tr>
            <th align="left">field</th>
            <th align="left">value</th>
          </tr>
        </thead>
        <tbody>
          {Object.keys(fields).map((k) => (
            <tr key={k} style={{ borderTop: "1px solid #ddd" }}>
              <td style={{ padding: 6 }}>{text(fields[k]?.displayName ?? k, locale) || k}</td>
              <td style={{ padding: 6 }}>{formatValue(fields[k], payload[k], locale, refLabels[k]?.[String(payload[k])])}</td>
            </tr>
          ))}
        </tbody>
      </Table>

      <h2 style={{ marginTop: 18 }}>{t(locale, "entity.detail.rawTab")}</h2>
      <pre style={{ background: "rgba(15, 23, 42, 0.03)", padding: 12, overflowX: "auto" }}>
        {JSON.stringify(recObj, null, 2)}
      </pre>
    </main>
  );
}
