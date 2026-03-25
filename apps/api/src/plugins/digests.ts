export function digestBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const keys = Object.keys(body as any);
  return { keys: keys.slice(0, 50), keyCount: keys.length };
}

export function digestPayload(payload: unknown) {
  if (typeof payload === "string") return { length: payload.length };
  if (payload && Buffer.isBuffer(payload)) return { length: payload.length };
  return undefined;
}

export function mergeOutputDigest(existing: unknown, patch: unknown) {
  if (!patch) return existing;
  if (!existing) return patch;
  if (typeof existing !== "object" || Array.isArray(existing)) return existing;
  if (typeof patch !== "object" || Array.isArray(patch)) return existing;
  if (Object.prototype.hasOwnProperty.call(existing, "length")) return existing;
  return { ...(existing as any), ...(patch as any) };
}
