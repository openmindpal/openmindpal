import { pickLocale } from "../../lib/api";
import type { SearchParams } from "../../lib/types";
import SettingsClient from "./ui";

export default async function SettingsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return <SettingsClient locale={locale} />;
}
