import Link from "next/link";
import { cookies } from "next/headers";
import { apiFetch, pickLocale, text } from "../../../../../lib/api";
import { t } from "../../../../../lib/i18n";
import type { EffectiveSchema, SearchParams } from "../../../../../lib/types";
import { EntityForm } from "../../new/ui";

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

export default async function EntityEditPage(props: {
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
  const recObj = recRaw && typeof recRaw === "object" ? (recRaw as Record<string, unknown>) : null;
  const payload = recObj?.payload && typeof recObj.payload === "object" ? (recObj.payload as Record<string, unknown>) : {};
  const fieldOrder = Object.keys((schema?.fields ?? {}) as Record<string, unknown>);

  return (
    <main style={{ padding: 24 }}>
      <p>
        <Link href={`/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}?lang=${encodeURIComponent(locale)}`}>{t(locale, "back")}</Link>
      </p>
      {entity === "notes" ? (
        <p>
          <Link href={`/notes/${encodeURIComponent(id)}?lang=${encodeURIComponent(locale)}`}>{t(locale, "notes.collab.open")}</Link>
        </p>
      ) : null}
      <h1>
        {t(locale, "entity.edit")} {title} / {id}
      </h1>
      <EntityForm
        locale={locale}
        entity={entity}
        schema={schema}
        mode="update"
        recordId={id}
        initialValues={payload}
        fieldOrder={fieldOrder}
        layoutVariant="twoColumn"
        showReadOnly={true}
      />
    </main>
  );
}
