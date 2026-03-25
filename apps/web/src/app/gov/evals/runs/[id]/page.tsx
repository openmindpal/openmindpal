import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import EvalRunClient from "./ui";
import { cookies } from "next/headers";

async function loadEvalRun(locale: string, id: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/governance/evals/runs/${encodeURIComponent(id)}`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function EvalRunPage(props: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const id = decodeURIComponent(params.id);
  const out = await loadEvalRun(locale, id);
  return (
    <EvalRunClient locale={locale} runId={id} initial={out.json} initialStatus={out.status} />
  );
}
