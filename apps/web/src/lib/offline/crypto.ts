function bytesToBase64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function base64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function generateAesGcmKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function exportKeyJwk(key: CryptoKey) {
  return crypto.subtle.exportKey("jwk", key);
}

export async function importKeyJwk(jwk: JsonWebKey) {
  return crypto.subtle.importKey("jwk", jwk, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

export async function encryptJson(params: { key: CryptoKey; value: unknown }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(params.value ?? null));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, params.key, plain);
  return { ivB64: bytesToBase64(iv), ctB64: bytesToBase64(new Uint8Array(ct)) };
}

export async function decryptJson<T = unknown>(params: { key: CryptoKey; ivB64: string; ctB64: string }) {
  const iv = base64ToBytes(params.ivB64);
  const ct = base64ToBytes(params.ctB64);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, params.key, ct);
  const text = new TextDecoder().decode(new Uint8Array(plain));
  return JSON.parse(text) as T;
}

