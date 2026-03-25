import Link from "next/link";
import { cookies } from "next/headers";
import { apiFetch, pickLocale, text } from "../../../../lib/api";
import { EntityForm } from "./ui";
import { t } from "../../../../lib/i18n";
import type { EffectiveSchema, SearchParams } from "../../../../lib/types";

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

export default async function EntityNewPage(props: {
  params: Promise<{ entity: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const entity = decodeURIComponent(params.entity);
  const schema = await loadEffectiveSchema(locale, entity);
  const title = text(schema?.displayName ?? entity, locale) || entity;

  return (
    <main style={{ padding: 24 }}>
      <p>
        <Link href={`/entities/${encodeURIComponent(entity)}?lang=${encodeURIComponent(locale)}`}>{t(locale, "back")}</Link>
      </p>
      <h1>
        {t(locale, "create.prefix")}
        {title}
      </h1>
      <EntityForm locale={locale} entity={entity} schema={schema} />
    </main>
  );
}
