import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import RetrievalLogDetailClient from "./ui";

export default async function GovKnowledgeRetrievalLogDetailPage(props: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return <RetrievalLogDetailClient locale={locale} id={params.id} />;
}

