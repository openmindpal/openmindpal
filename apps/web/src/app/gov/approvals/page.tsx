import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import ApprovalsClient from "./ui";
import { cookies } from "next/headers";

async function loadApprovals(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/approvals?limit=50`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovApprovalsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const approvalsRes = await loadApprovals(locale);
  return (
    <ApprovalsClient locale={locale} initial={approvalsRes.json} initialStatus={approvalsRes.status} />
  );
}
