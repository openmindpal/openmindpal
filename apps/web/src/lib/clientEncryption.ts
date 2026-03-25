/**
 * Client-side Encryption Helper — Architecture §15.17
 * Space-level key isolation using Web Crypto API (AES-GCM).
 */

const ALGO = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const STORAGE_PREFIX = "openslin_space_key_";

/* ─── Key derivation (space-level isolation) ─── */

export async function deriveSpaceKey(params: {
  spaceId: string;
  passphrase: string;
  salt?: Uint8Array;
}): Promise<{ key: CryptoKey; salt: Uint8Array }> {
  const enc = new TextEncoder();
  const salt = params.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(params.passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: 100_000, hash: "SHA-256" },
    baseKey,
    { name: ALGO, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
  return { key, salt };
}

/* ─── Encrypt ─── */

export async function encryptPayload(params: {
  key: CryptoKey;
  plaintext: string;
}): Promise<{ iv: string; ciphertext: string }> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    params.key,
    enc.encode(params.plaintext),
  );
  return {
    iv: arrayToBase64(iv),
    ciphertext: arrayToBase64(new Uint8Array(ct)),
  };
}

/* ─── Decrypt ─── */

export async function decryptPayload(params: {
  key: CryptoKey;
  iv: string;
  ciphertext: string;
}): Promise<string> {
  const dec = new TextDecoder();
  const ivBuf = base64ToArray(params.iv);
  const ctBuf = base64ToArray(params.ciphertext);
  const pt = await crypto.subtle.decrypt(
    { name: ALGO, iv: ivBuf.buffer as ArrayBuffer },
    params.key,
    ctBuf.buffer as ArrayBuffer,
  );
  return dec.decode(pt);
}

/* ─── Space key storage (IndexedDB-backed via localStorage fallback) ─── */

export function storeSpaceKeySalt(spaceId: string, salt: Uint8Array) {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${spaceId}_salt`, arrayToBase64(salt));
  } catch { /* ignore */ }
}

export function loadSpaceKeySalt(spaceId: string): Uint8Array | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${spaceId}_salt`);
    if (!raw) return null;
    return base64ToArray(raw);
  } catch {
    return null;
  }
}

export function clearSpaceKey(spaceId: string) {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${spaceId}_salt`);
  } catch { /* ignore */ }
}

/* ─── Helpers ─── */

function arrayToBase64(buf: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary);
}

function base64ToArray(base64: string): Uint8Array {
  const binary = atob(base64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf;
}

/* ─── High-level API ─── */

export async function encryptForSpace(params: {
  spaceId: string;
  passphrase: string;
  plaintext: string;
}): Promise<{ salt: string; iv: string; ciphertext: string }> {
  const existingSalt = loadSpaceKeySalt(params.spaceId);
  const { key, salt } = await deriveSpaceKey({
    spaceId: params.spaceId,
    passphrase: params.passphrase,
    salt: existingSalt ?? undefined,
  });
  if (!existingSalt) storeSpaceKeySalt(params.spaceId, salt);
  const { iv, ciphertext } = await encryptPayload({ key, plaintext: params.plaintext });
  return { salt: arrayToBase64(salt), iv, ciphertext };
}

export async function decryptForSpace(params: {
  spaceId: string;
  passphrase: string;
  salt: string;
  iv: string;
  ciphertext: string;
}): Promise<string> {
  const saltBuf = base64ToArray(params.salt);
  const { key } = await deriveSpaceKey({
    spaceId: params.spaceId,
    passphrase: params.passphrase,
    salt: saltBuf,
  });
  return decryptPayload({ key, iv: params.iv, ciphertext: params.ciphertext });
}
