import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { apiFetch, SSR_TIMEOUT_MS } from "@/lib/api";

function resolveArtifactDir(artifactRef: string) {
  const trimmed = artifactRef.trim();
  if (trimmed.startsWith("file://")) return fileURLToPath(trimmed);
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(process.cwd(), trimmed);
}

function extContentType(p: string) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml; charset=utf-8";
  if (ext === ".woff") return "font/woff";
  if (ext === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function cspHeaderValue() {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

export async function GET(req: Request, ctx: { params: Promise<{ workbenchKey: string; path: string[] }> }) {
  const { workbenchKey, path: relParts } = await ctx.params;
  const rel = Array.isArray(relParts) ? relParts.join("/") : "";
  if (!workbenchKey || !rel) return new NextResponse("Not found", { status: 404 });
  if (rel.includes("..")) return new NextResponse("Not found", { status: 404 });

  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const locale = String(req.headers.get("x-user-locale") ?? "zh-CN");
  const effRes = await apiFetch(`/workbenches/${encodeURIComponent(workbenchKey)}/effective`, {
    method: "GET",
    token,
    locale,
    cache: "no-store",
    signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
  });
  const effJson: any = await effRes.json().catch(() => null);
  if (!effRes.ok) return NextResponse.json(effJson ?? { errorCode: "UPSTREAM_ERROR" }, { status: effRes.status });

  const artifactRef = String(effJson?.artifactRef ?? "");
  if (!artifactRef) return new NextResponse("Not found", { status: 404 });
  const dir = resolveArtifactDir(artifactRef);
  const dirAbs = path.resolve(dir);
  const fileAbs = path.resolve(dirAbs, rel);
  if (!(fileAbs === dirAbs || fileAbs.startsWith(dirAbs + path.sep))) return new NextResponse("Not found", { status: 404 });

  let buf: Buffer;
  try {
    buf = await fs.readFile(fileAbs);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const bytes = Uint8Array.from(buf);
  const res = new NextResponse(new Blob([bytes]), { status: 200 });
  res.headers.set("content-type", extContentType(fileAbs));
  res.headers.set("cache-control", "no-store");
  res.headers.set("content-security-policy", cspHeaderValue());
  return res;
}
