import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import { cookies } from "next/headers";
import AdminRbacClient from "./ui";
import type { SearchParams } from "@/lib/types";

export default async function AdminRbacPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const token = (await cookies()).get("openslin_token")?.value ?? "";

  const [rolesRes, permsRes] = await Promise.all([
    apiFetch(`/rbac/roles?limit=200`, { locale, token, cache: "no-store", signal: AbortSignal.timeout(SSR_TIMEOUT_MS) }),
    apiFetch(`/rbac/permissions?limit=500`, { locale, token, cache: "no-store", signal: AbortSignal.timeout(SSR_TIMEOUT_MS) }),
  ]);

  const rolesJson = rolesRes.ok ? await rolesRes.json() : await rolesRes.json().catch(() => null);
  const permsJson = permsRes.ok ? await permsRes.json() : await permsRes.json().catch(() => null);

  return (
    <AdminRbacClient
      locale={locale}
      initial={{ roles: rolesJson, permissions: permsJson, rolesStatus: rolesRes.status, permissionsStatus: permsRes.status }}
    />
  );
}
