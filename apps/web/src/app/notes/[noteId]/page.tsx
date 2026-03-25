import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import NoteEditorClient from "./ui";
import { cookies } from "next/headers";

async function loadNote(locale: string, noteId: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/entities/notes/${encodeURIComponent(noteId)}`, { token, locale, cache: "no-store", signal: AbortSignal.timeout(SSR_TIMEOUT_MS) });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function NoteEditorPage(props: { params: Promise<{ noteId: string }>; searchParams: Promise<SearchParams> }) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const out = await loadNote(locale, params.noteId);
  return (
    <NoteEditorClient locale={locale} noteId={params.noteId} initial={out.json} initialStatus={out.status} />
  );
}

