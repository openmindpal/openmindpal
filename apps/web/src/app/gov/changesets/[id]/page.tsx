import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import ChangeSetDetailClient from "./ui";
import { cookies } from "next/headers";

async function loadChangeSet(locale: string, id: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/governance/changesets/${encodeURIComponent(id)}`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovChangeSetDetailPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const id = decodeURIComponent(params.id);
  const detailRes = await loadChangeSet(locale, id);
  return (
    <ChangeSetDetailClient locale={locale} changesetId={id} initial={detailRes.json} initialStatus={detailRes.status} />
  );
}
