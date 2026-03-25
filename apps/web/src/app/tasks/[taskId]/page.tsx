import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import TaskDetailClient from "./ui";
import { cookies } from "next/headers";

async function loadTask(locale: string, taskId: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/tasks/${encodeURIComponent(taskId)}`, { token, locale, cache: "no-store", signal: AbortSignal.timeout(SSR_TIMEOUT_MS) });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function loadMessages(locale: string, taskId: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/tasks/${encodeURIComponent(taskId)}/messages?limit=50`, { token, locale, cache: "no-store", signal: AbortSignal.timeout(SSR_TIMEOUT_MS) });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function loadCollabRuns(locale: string, taskId: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/tasks/${encodeURIComponent(taskId)}/collab-runs?limit=50`, { token, locale, cache: "no-store", signal: AbortSignal.timeout(SSR_TIMEOUT_MS) });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function TaskDetailPage(props: { params: Promise<{ taskId: string }>; searchParams: Promise<SearchParams> }) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const taskId = decodeURIComponent(params.taskId);
  const [taskRes, msgRes, collabRes] = await Promise.all([
    loadTask(locale, taskId),
    loadMessages(locale, taskId),
    loadCollabRuns(locale, taskId),
  ]);
  return (
    <TaskDetailClient
      locale={locale}
      taskId={taskId}
      initialTask={taskRes.json}
      initialTaskStatus={taskRes.status}
      initialMessages={msgRes.json}
      initialMessagesStatus={msgRes.status}
      initialCollabRuns={collabRes.json}
      initialCollabRunsStatus={collabRes.status}
    />
  );
}
