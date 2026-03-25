import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import GovSkillPackagesClient from "./ui";
import { cookies } from "next/headers";

async function loadSkillPackages(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/artifacts/skill-packages?limit=50`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovSkillPackagesPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadSkillPackages(locale);
  return (
    <GovSkillPackagesClient locale={locale} initial={initial.json} initialStatus={initial.status} />
  );
}

