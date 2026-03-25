export async function execute(req: any) {
  const url = String(req?.input?.url ?? "");
  const method = String(req?.input?.method ?? "GET");
  const res = await fetch(url, { method });
  return { status: (res as any)?.status ?? null };
}

