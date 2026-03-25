import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import ApprovalDetailClient from "./ui";
import { cookies } from "next/headers";

async function loadApproval(locale: string, approvalId: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/approvals/${encodeURIComponent(approvalId)}`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovApprovalDetailPage(props: {
  params: Promise<{ approvalId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const approvalId = decodeURIComponent(params.approvalId);
  const detailRes = await loadApproval(locale, approvalId);
  return (
    <ApprovalDetailClient locale={locale} approvalId={approvalId} initial={detailRes.json} initialStatus={detailRes.status} />
  );
}
