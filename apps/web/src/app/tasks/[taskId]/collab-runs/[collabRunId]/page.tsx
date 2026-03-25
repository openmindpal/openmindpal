import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import CollabRunClient from "./ui";
import { cookies } from "next/headers";

async function loadCollab(locale: string, taskId: string, collabRunId: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/tasks/${encodeURIComponent(taskId)}/collab-runs/${encodeURIComponent(collabRunId)}`, {
    method: "GET",
    token,
    locale,
    cache: "no-store",
    signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
  });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function loadEnvelopes(locale: string, taskId: string, collabRunId: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/tasks/${encodeURIComponent(taskId)}/collab-runs/${encodeURIComponent(collabRunId)}/envelopes?limit=50`, {
    method: "GET",
    token,
    locale,
    cache: "no-store",
    signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
  });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function CollabRunPage(props: {
  params: Promise<{ taskId: string; collabRunId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const taskId = decodeURIComponent(params.taskId);
  const collabRunId = decodeURIComponent(params.collabRunId);
  const [collabRes, envRes] = await Promise.all([
    loadCollab(locale, taskId, collabRunId),
    loadEnvelopes(locale, taskId, collabRunId),
  ]);
  return (
    <CollabRunClient
      locale={locale}
      taskId={taskId}
      collabRunId={collabRunId}
      initial={collabRes.json}
      initialStatus={collabRes.status}
      initialEnvelopes={envRes.json}
      initialEnvelopesStatus={envRes.status}
    />
  );
}
