import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import KnowledgeQualityClient from "./ui";

export default async function GovKnowledgeQualityPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return <KnowledgeQualityClient locale={locale} />;
}

