import { pickLocale } from "../lib/api";
import type { SearchParams } from "../lib/types";
import HomeChat from "./HomeChat";

export default async function Home(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return <HomeChat locale={locale} />;
}
