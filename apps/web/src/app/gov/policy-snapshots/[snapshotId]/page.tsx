import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import GovPolicySnapshotDetailClient from "./ui";
import { cookies } from "next/headers";

async function loadExplain(locale: string, snapshotId: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/governance/policy/snapshots/${encodeURIComponent(snapshotId)}/explain`, {
    token, locale,
    cache: "no-store",
  });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovPolicySnapshotDetailPage(props: {
  params: Promise<{ snapshotId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadExplain(locale, params.snapshotId);
  return (
    <GovPolicySnapshotDetailClient locale={locale} snapshotId={params.snapshotId} initial={initial.json} initialStatus={initial.status} />
  );
}
