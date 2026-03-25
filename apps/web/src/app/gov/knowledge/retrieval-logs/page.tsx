import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import RetrievalLogsClient from "./ui";

export default async function GovKnowledgeRetrievalLogsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return <RetrievalLogsClient locale={locale} />;
}
