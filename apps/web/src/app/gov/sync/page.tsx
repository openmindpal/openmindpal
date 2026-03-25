import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import SyncDebugClient from "./ui";

export default async function GovSyncDebugPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return <SyncDebugClient locale={locale} />;
}

