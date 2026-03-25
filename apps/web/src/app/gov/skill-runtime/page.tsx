import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import SkillRuntimeClient from "./ui";

export default async function GovSkillRuntimePage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return <SkillRuntimeClient locale={locale} />;
}

