import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { cookies } from "next/headers";
import SchemaDetailClient from "./ui";

async function loadVersions(locale: string, name: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/schemas/${encodeURIComponent(name)}/versions?limit=50`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function loadLatest(locale: string, name: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/schemas/${encodeURIComponent(name)}/latest`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function loadMigrations(locale: string, name: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/governance/schema-migrations?schemaName=${encodeURIComponent(name)}&limit=50`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovSchemaDetailPage(props: {
  params: Promise<{ name: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const name = decodeURIComponent(params.name);
  const [vers, latest, migrations] = await Promise.all([
    loadVersions(locale, name),
    loadLatest(locale, name),
    loadMigrations(locale, name),
  ]);
  return (
    <SchemaDetailClient
      locale={locale}
      name={name}
      initialVersions={vers.json}
      initialVersionsStatus={vers.status}
      initialLatest={latest.json}
      initialLatestStatus={latest.status}
      initialMigrations={migrations.json}
      initialMigrationsStatus={migrations.status}
    />
  );
}
