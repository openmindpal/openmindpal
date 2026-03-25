import { cookies } from "next/headers";
import GovTriggersClient from "./ui";
import { apiFetch } from "@/lib/api";

export default async function GovTriggersPage(props: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = (await props.searchParams) ?? {};
  const locale = typeof sp.lang === "string" ? sp.lang : "zh-CN";
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/governance/triggers?limit=50`, { token, locale, cache: "no-store" });
  const json = await res.json().catch(() => null);
  return <GovTriggersClient locale={locale} initial={{ status: res.status, json }} />;
}
