import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { apiFetch, SSR_TIMEOUT_MS } from "@/lib/api";

function findAllowedCap(manifest: any, listKey: "dataBindings" | "actionBindings", kind: string) {
  const caps = manifest?.capabilities ?? null;
  const arr = Array.isArray(caps?.[listKey]) ? caps[listKey] : [];
  return arr.find((x: any) => x && typeof x === "object" && String(x.kind ?? "") === kind) ?? null;
}

function allowEntityName(allow: any, entityName: string) {
  if (!allow || typeof allow !== "object") return true;
  const names = Array.isArray((allow as any).entityNames) ? (allow as any).entityNames : null;
  if (!names) return true;
  return names.includes(entityName);
}

function allowToolRef(allow: any, toolRef: string) {
  if (!allow || typeof allow !== "object") return false;
  const toolRefs = Array.isArray((allow as any).toolRefs) ? (allow as any).toolRefs : null;
  const toolNames = Array.isArray((allow as any).toolNames) ? (allow as any).toolNames : null;
  if (!toolRefs && !toolNames) return false;
  const at = toolRef.lastIndexOf("@");
  const toolName = at > 0 ? toolRef.slice(0, at) : toolRef;
  if (toolNames && toolNames.includes(toolName)) return true;
  if (toolRefs) {
    for (const v of toolRefs) {
      const s = String(v ?? "");
      if (!s) continue;
      if (s === toolRef) return true;
      if (!s.includes("@") && s === toolName) return true;
    }
  }
  return false;
}

export async function POST(req: Request, ctx: { params: Promise<{ workbenchKey: string }> }) {
  const { workbenchKey } = await ctx.params;
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const locale = String(req.headers.get("x-user-locale") ?? "zh-CN");
  const body: any = await req.json().catch(() => null);
  const id = String(body?.id ?? "");
  const kind = String(body?.kind ?? "");
  const payload = body?.payload;
  if (!id || !kind) return NextResponse.json({ errorCode: "BAD_REQUEST" }, { status: 400 });

  const effRes = await apiFetch(`/workbenches/${encodeURIComponent(workbenchKey)}/effective`, {
    method: "GET",
    token,
    locale,
    cache: "no-store",
    signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
  });
  const effJson: any = await effRes.json().catch(() => null);
  if (!effRes.ok) return NextResponse.json(effJson ?? { errorCode: "UPSTREAM_ERROR" }, { status: effRes.status });
  const manifest = effJson?.manifest ?? null;

  if (kind === "entities.query") {
    const cap = findAllowedCap(manifest, "dataBindings", "entities.query");
    if (!cap) return NextResponse.json({ errorCode: "WORKBENCH_MANIFEST_DENIED" }, { status: 403 });
    const entityName = String((payload as any)?.entityName ?? "");
    const queryBody = (payload as any)?.body ?? {};
    if (!entityName) return NextResponse.json({ errorCode: "BAD_REQUEST" }, { status: 400 });
    if (!allowEntityName(cap.allow, entityName)) return NextResponse.json({ errorCode: "WORKBENCH_MANIFEST_DENIED" }, { status: 403 });
    const res = await apiFetch(`/entities/${encodeURIComponent(entityName)}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      token,
      locale,
      cache: "no-store",
      signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
      body: JSON.stringify(queryBody ?? {}),
    });
    const json = await res.json().catch(() => null);
    return NextResponse.json({ id, kind, result: json }, { status: res.status });
  }

  if (kind === "entities.get") {
    const cap = findAllowedCap(manifest, "dataBindings", "entities.get");
    if (!cap) return NextResponse.json({ errorCode: "WORKBENCH_MANIFEST_DENIED" }, { status: 403 });
    const entityName = String((payload as any)?.entityName ?? "");
    const idValue = String((payload as any)?.id ?? "");
    if (!entityName || !idValue) return NextResponse.json({ errorCode: "BAD_REQUEST" }, { status: 400 });
    if (!allowEntityName(cap.allow, entityName)) return NextResponse.json({ errorCode: "WORKBENCH_MANIFEST_DENIED" }, { status: 403 });
    const res = await apiFetch(`/entities/${encodeURIComponent(entityName)}/${encodeURIComponent(idValue)}`, {
      method: "GET",
      token,
      locale,
      cache: "no-store",
      signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    return NextResponse.json({ id, kind, result: json }, { status: res.status });
  }

  if (kind === "schema.effective") {
    const cap = findAllowedCap(manifest, "dataBindings", "schema.effective");
    if (!cap) return NextResponse.json({ errorCode: "WORKBENCH_MANIFEST_DENIED" }, { status: 403 });
    const entityName = String((payload as any)?.entityName ?? "");
    const schemaName = String((payload as any)?.schemaName ?? "core");
    if (!entityName) return NextResponse.json({ errorCode: "BAD_REQUEST" }, { status: 400 });
    if (!allowEntityName(cap.allow, entityName)) return NextResponse.json({ errorCode: "WORKBENCH_MANIFEST_DENIED" }, { status: 403 });
    const res = await apiFetch(`/schemas/${encodeURIComponent(entityName)}/effective?schemaName=${encodeURIComponent(schemaName)}`, {
      method: "GET",
      token,
      locale,
      cache: "no-store",
      signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    return NextResponse.json({ id, kind, result: json }, { status: res.status });
  }

  if (kind === "tools.invoke") {
    const cap = findAllowedCap(manifest, "actionBindings", "tools.invoke");
    if (!cap) return NextResponse.json({ errorCode: "WORKBENCH_MANIFEST_DENIED" }, { status: 403 });
    const toolRef = String((payload as any)?.toolRef ?? "");
    const input = (payload as any)?.input ?? {};
    const idempotencyKey = String((payload as any)?.idempotencyKey ?? "");
    if (!toolRef) return NextResponse.json({ errorCode: "BAD_REQUEST" }, { status: 400 });
    if (!allowToolRef(cap.allow, toolRef)) return NextResponse.json({ errorCode: "WORKBENCH_MANIFEST_DENIED" }, { status: 403 });

    const at = toolRef.lastIndexOf("@");
    const toolName = at > 0 ? toolRef.slice(0, at) : toolRef;
    const defRes = await apiFetch(`/tools/${encodeURIComponent(toolName)}`, {
      method: "GET",
      token,
      locale,
      cache: "no-store",
      signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
    });
    const defJson: any = await defRes.json().catch(() => null);
    if (!defRes.ok) return NextResponse.json(defJson ?? { errorCode: "UPSTREAM_ERROR" }, { status: defRes.status });
    const tool = defJson?.tool ?? null;
    const scope = String(tool?.scope ?? "");
    if (scope === "write" && !idempotencyKey) {
      return NextResponse.json({ errorCode: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
    }
    const headers: any = { "content-type": "application/json" };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const res = await apiFetch(`/tools/${encodeURIComponent(toolRef)}/execute`, {
      method: "POST",
      headers,
      token,
      locale,
      cache: "no-store",
      signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
      body: JSON.stringify(input ?? {}),
    });
    const json = await res.json().catch(() => null);
    return NextResponse.json({ id, kind, result: json }, { status: res.status });
  }

  return NextResponse.json({ errorCode: "WORKBENCH_MANIFEST_DENIED" }, { status: 403 });
}
