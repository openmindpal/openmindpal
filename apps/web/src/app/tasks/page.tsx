import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import TasksClient from "./ui";
import { cookies } from "next/headers";

function pickFirst(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

async function loadLongTasks(locale: string, searchParams: SearchParams) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const q = new URLSearchParams();
  const scope = pickFirst(searchParams.scope);
  const limit = pickFirst(searchParams.limit);
  const offset = pickFirst(searchParams.offset);
  if (scope) q.set("scope", scope);
  if (limit) q.set("limit", limit);
  if (offset) q.set("offset", offset);
  const res = await apiFetch(`/tasks/long-tasks?${q.toString()}`, { token, locale, cache: "no-store", signal: AbortSignal.timeout(SSR_TIMEOUT_MS) });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json, initialQuery: { scope, limit, offset } };
}

export default async function TasksPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const out = await loadLongTasks(locale, searchParams);
  return (
    <TasksClient locale={locale} initial={out.json} initialStatus={out.status} initialQuery={out.initialQuery} />
  );
}

