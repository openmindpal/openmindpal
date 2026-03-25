import { apiFetch } from "@/lib/api";
import { decryptJson, encryptJson, exportKeyJwk, generateAesGcmKey, importKeyJwk } from "./crypto";
import { idbGet, idbGetAll, idbPut, openOfflineDb } from "./idb";

type StoredKey = { keyId: string; jwk: JsonWebKey; createdAt: string };
type StoredOp = {
  opId: string;
  createdAt: string;
  status: "pending" | "accepted" | "rejected" | "conflict";
  meta: { schemaName: string; entityName: string; recordId: string; baseVersion: number | null };
  ivB64: string;
  ctB64: string;
  cursor: number | null;
  conflict: any | null;
};

type StoredMeta = { id: string; value: any };

export type SyncOp = {
  opId: string;
  schemaName: string;
  schemaVersion?: number;
  entityName: string;
  recordId: string;
  baseVersion?: number | null;
  patch: Record<string, unknown>;
  clock?: unknown;
};

export async function getOrCreateKey(keyId: string) {
  const db = await openOfflineDb();
  const existing = await idbGet<StoredKey>(db, "keys", keyId);
  if (existing?.jwk) return importKeyJwk(existing.jwk);
  const key = await generateAesGcmKey();
  const jwk = (await exportKeyJwk(key)) as JsonWebKey;
  await idbPut(db, "keys", { keyId, jwk, createdAt: new Date().toISOString() } satisfies StoredKey);
  return key;
}

export async function enqueueOp(params: { locale: string; keyId: string; op: SyncOp }) {
  const db = await openOfflineDb();
  const key = await getOrCreateKey(params.keyId);
  const { ivB64, ctB64 } = await encryptJson({ key, value: params.op });
  const meta = {
    schemaName: params.op.schemaName,
    entityName: params.op.entityName,
    recordId: params.op.recordId,
    baseVersion: params.op.baseVersion ?? null,
  };
  const row: StoredOp = {
    opId: params.op.opId,
    createdAt: new Date().toISOString(),
    status: "pending",
    meta,
    ivB64,
    ctB64,
    cursor: null,
    conflict: null,
  };
  await idbPut(db, "ops", row);
  return row;
}

export async function listStoredOps() {
  const db = await openOfflineDb();
  return idbGetAll<StoredOp>(db, "ops");
}

export async function decryptOp(params: { keyId: string; row: StoredOp }) {
  const key = await getOrCreateKey(params.keyId);
  return decryptJson<SyncOp>({ key, ivB64: params.row.ivB64, ctB64: params.row.ctB64 });
}

export async function updateStoredOp(params: { opId: string; patch: Partial<StoredOp> }) {
  const db = await openOfflineDb();
  const existing = await idbGet<StoredOp>(db, "ops", params.opId);
  if (!existing) return null;
  const next: StoredOp = { ...existing, ...params.patch, opId: existing.opId };
  await idbPut(db, "ops", next);
  return next;
}

export async function getMeta<T>(id: string): Promise<T | null> {
  const db = await openOfflineDb();
  const row = await idbGet<StoredMeta>(db, "meta", id);
  return row ? (row.value as T) : null;
}

export async function setMeta(id: string, value: any) {
  const db = await openOfflineDb();
  await idbPut(db, "meta", { id, value } satisfies StoredMeta);
}

export async function syncPush(params: { locale: string; keyId: string; clientId: string; deviceId?: string; onlyOpIds?: string[] }) {
  const db = await openOfflineDb();
  const rows = await idbGetAll<StoredOp>(db, "ops");
  const pending = rows.filter((r) => r.status === "pending" && (!params.onlyOpIds || params.onlyOpIds.includes(r.opId)));
  const ops: SyncOp[] = [];
  for (const r of pending) ops.push(await decryptOp({ keyId: params.keyId, row: r }));

  const res = await apiFetch(`/sync/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    locale: params.locale,
    body: JSON.stringify({ clientId: params.clientId, deviceId: params.deviceId, ops }),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok) return { ok: false as const, status: res.status, body: json };

  const accepted = Array.isArray(json?.accepted) ? (json.accepted as any[]) : [];
  const conflicts = Array.isArray(json?.conflicts) ? (json.conflicts as any[]) : [];
  const acceptedById = new Map<string, any>();
  for (const a of accepted) acceptedById.set(String(a.opId ?? ""), a);
  const conflictsById = new Map<string, any>();
  for (const c of conflicts) conflictsById.set(String(c.opId ?? ""), c);

  for (const r of rows) {
    if (!pending.some((p) => p.opId === r.opId)) continue;
    const a = acceptedById.get(r.opId);
    const c = conflictsById.get(r.opId);
    if (a) {
      await idbPut(db, "ops", { ...r, status: "accepted", cursor: Number(a.cursor ?? 0), conflict: null } satisfies StoredOp);
    } else if (c) {
      await idbPut(db, "ops", { ...r, status: "conflict", conflict: c } satisfies StoredOp);
    } else {
      await idbPut(db, "ops", { ...r, status: "rejected" } satisfies StoredOp);
    }
  }
  return { ok: true as const, status: res.status, body: json };
}

export async function syncPull(params: { locale: string; clientId: string; cursor?: number; limit?: number }) {
  const res = await apiFetch(`/sync/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    locale: params.locale,
    body: JSON.stringify({ cursor: params.cursor, limit: params.limit }),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok) return { ok: false as const, status: res.status, body: json };
  return { ok: true as const, status: res.status, body: json };
}
