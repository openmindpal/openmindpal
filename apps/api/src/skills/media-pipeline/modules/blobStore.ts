import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function sha256HexBytes(bytes: Buffer) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function safeJoin(rootDir: string, storageKey: string) {
  const root = path.resolve(rootDir);
  const full = path.resolve(root, storageKey);
  if (!full.startsWith(root + path.sep)) throw new Error("blobstore_invalid_key");
  return full;
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

export async function fsPut(params: { rootDir: string; storageKey: string; bytes: Buffer }) {
  const full = safeJoin(params.rootDir, params.storageKey);
  await ensureDir(path.dirname(full));
  const tmp = `${full}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, params.bytes);
  await fs.rename(tmp, full);
  return { byteSize: params.bytes.length, sha256: sha256HexBytes(params.bytes) };
}

export async function fsGet(params: { rootDir: string; storageKey: string }) {
  const full = safeJoin(params.rootDir, params.storageKey);
  const bytes = await fs.readFile(full);
  return { bytes };
}

export async function fsDelete(params: { rootDir: string; storageKey: string }) {
  const full = safeJoin(params.rootDir, params.storageKey);
  await fs.rm(full, { force: true });
}

export async function fsCompose(params: { rootDir: string; sourceKeys: string[]; targetKey: string }) {
  const targetFull = safeJoin(params.rootDir, params.targetKey);
  await ensureDir(path.dirname(targetFull));
  const tmp = `${targetFull}.${crypto.randomUUID()}.tmp`;
  const hash = crypto.createHash("sha256");
  let byteSize = 0;
  const out = await fs.open(tmp, "w");
  try {
    for (const key of params.sourceKeys) {
      const full = safeJoin(params.rootDir, key);
      const buf = await fs.readFile(full);
      await out.write(buf);
      hash.update(buf);
      byteSize += buf.length;
    }
  } finally {
    await out.close();
  }
  await fs.rename(tmp, targetFull);
  return { byteSize, sha256: hash.digest("hex") };
}

