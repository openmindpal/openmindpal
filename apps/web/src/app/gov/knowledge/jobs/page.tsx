import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import KnowledgeJobsClient from "./ui";

export default async function GovKnowledgeJobsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return <KnowledgeJobsClient locale={locale} />;
}

