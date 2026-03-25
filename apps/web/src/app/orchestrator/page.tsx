import type { SearchParams } from "@/lib/types";
import { pickLocale } from "@/lib/api";
import OrchestratorPlaygroundClient from "./ui";

export default async function OrchestratorPlaygroundPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return <OrchestratorPlaygroundClient locale={locale} />;
}

