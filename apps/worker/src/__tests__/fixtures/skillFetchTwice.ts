export async function execute(req: any) {
  const urls = Array.isArray(req?.input?.urls) ? req.input.urls : [];
  const u1 = urls.length > 0 ? String(urls[0]) : String(req?.input?.url1 ?? "");
  const u2 = urls.length > 1 ? String(urls[1]) : String(req?.input?.url2 ?? "");
  const res1 = await fetch(u1, { method: "GET" });
  const res2 = await fetch(u2, { method: "GET" });
  return { statuses: [(res1 as any)?.status ?? null, (res2 as any)?.status ?? null] };
}

