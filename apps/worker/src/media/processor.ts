import type { Pool } from "pg";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function sha256Hex(bytes: Buffer) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function safeJoin(rootDir: string, storageKey: string) {
  const root = path.resolve(rootDir);
  const full = path.resolve(root, storageKey);
  if (!full.startsWith(root + path.sep)) throw new Error("blobstore_invalid_key");
  return full;
}

async function fsGet(params: { rootDir: string; storageKey: string }) {
  const full = safeJoin(params.rootDir, params.storageKey);
  const bytes = await fs.readFile(full);
  return { bytes };
}

function parsePngDims(bytes: Buffer) {
  if (bytes.length < 24) return null;
  if (bytes.readUInt32BE(0) !== 0x89504e47) return null;
  const w = bytes.readUInt32BE(16);
  const h = bytes.readUInt32BE(20);
  if (!w || !h) return null;
  return { width: w, height: h };
}

function parseJpegDims(bytes: Buffer) {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = bytes.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSof =
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf;
    if (isSof && i + 2 + len <= bytes.length) {
      const h = bytes.readUInt16BE(i + 5);
      const w = bytes.readUInt16BE(i + 7);
      if (!w || !h) return null;
      return { width: w, height: h };
    }
    i += 2 + len;
  }
  return null;
}

function parseWebpDims(bytes: Buffer) {
  if (bytes.length < 30) return null;
  if (bytes.toString("ascii", 0, 4) !== "RIFF") return null;
  if (bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const type = bytes.toString("ascii", 12, 16);
  if (type === "VP8X" && bytes.length >= 30) {
    const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    if (!w || !h) return null;
    return { width: w, height: h };
  }
  if (type === "VP8 " && bytes.length >= 30) {
    const start = 20;
    if (bytes[start] !== 0x9d || bytes[start + 1] !== 0x01 || bytes[start + 2] !== 0x2a) return null;
    const w = bytes.readUInt16LE(start + 3) & 0x3fff;
    const h = bytes.readUInt16LE(start + 5) & 0x3fff;
    if (!w || !h) return null;
    return { width: w, height: h };
  }
  return null;
}

function dimsForContentType(contentType: string, bytes: Buffer) {
  const ct = contentType.toLowerCase();
  if (ct === "image/png") return parsePngDims(bytes);
  if (ct === "image/jpeg") return parseJpegDims(bytes);
  if (ct === "image/webp") return parseWebpDims(bytes);
  return null;
}

async function createArtifact(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  type: string;
  format: string;
  contentType: string;
  contentText: string;
  source: any;
  createdBySubjectId: string | null;
}) {
  const byteSize = Buffer.byteLength(params.contentText, "utf8");
  const res = await params.pool.query(
    `
      INSERT INTO artifacts (tenant_id, space_id, type, format, content_type, byte_size, content_text, source, created_by_subject_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING artifact_id
    `,
    [params.tenantId, params.spaceId, params.type, params.format, params.contentType, byteSize, params.contentText, params.source ?? null, params.createdBySubjectId],
  );
  return { artifactId: String(res.rows[0].artifact_id) };
}

export async function processMediaJob(params: { pool: Pool; tenantId: string; jobId: string; fsRootDir: string }) {
  const client = await params.pool.connect();
  let ops: string[] = [];
  let mediaId = "";
  let spaceId = "";
  let createdBySubjectId: string | null = null;
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT job_id, media_id, space_id, status, ops, created_by_subject_id FROM media_jobs WHERE tenant_id = $1 AND job_id = $2 FOR UPDATE`,
      [params.tenantId, params.jobId],
    );
    if (!locked.rowCount) throw new Error("media_job_not_found");
    const status = String(locked.rows[0].status ?? "");
    if (status !== "pending" && status !== "running") throw new Error("media_job_not_runnable");
    mediaId = String(locked.rows[0].media_id ?? "");
    spaceId = String(locked.rows[0].space_id ?? "");
    ops = Array.isArray(locked.rows[0].ops) ? locked.rows[0].ops.map((x: any) => String(x)) : [];
    createdBySubjectId = locked.rows[0].created_by_subject_id ? String(locked.rows[0].created_by_subject_id) : null;

    await client.query(`UPDATE media_jobs SET status = 'running', updated_at = now(), error_digest = NULL WHERE tenant_id = $1 AND job_id = $2`, [
      params.tenantId,
      params.jobId,
    ]);
    await client.query(`UPDATE media_objects SET status = 'processing', updated_at = now() WHERE tenant_id = $1 AND media_id = $2`, [params.tenantId, mediaId]);
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw err;
  } finally {
    client.release();
  }

  try {
    const objRes = await params.pool.query(
      `SELECT content_type, storage_provider, storage_key, content_bytes FROM media_objects WHERE tenant_id = $1 AND media_id = $2 LIMIT 1`,
      [params.tenantId, mediaId],
    );
    if (!objRes.rowCount) throw new Error("media_object_not_found");
    const obj = objRes.rows[0] as any;
    const contentTypeIn = String(obj.content_type ?? "");
    const storageProvider = (obj.storage_provider as string | null) ?? null;
    const storageKey = (obj.storage_key as string | null) ?? null;
    const contentBytes = (obj.content_bytes as Buffer | null) ?? null;
    const bytes =
      storageProvider === "fs" && storageKey
        ? (await fsGet({ rootDir: params.fsRootDir, storageKey })).bytes
        : contentBytes;
    if (!bytes || !Buffer.isBuffer(bytes) || bytes.byteLength <= 0) throw new Error("media_bytes_not_available");

    const failures: any[] = [];
    for (const op of ops) {
      try {
        if (op === "extractText") {
          const ct = contentTypeIn.toLowerCase();
          const textOk = ct.startsWith("text/") || ct === "application/json" || ct === "application/xml";
          if (!textOk) {
            const meta = { errorDigest: { code: "MEDIA_OP_NOT_SUPPORTED", op, contentType: contentTypeIn } };
            await params.pool.query(
              `INSERT INTO media_derivatives (tenant_id, space_id, media_id, job_id, kind, status, meta) VALUES ($1,$2,$3,$4,$5,'failed',$6)`,
              [params.tenantId, spaceId, mediaId, params.jobId, op, meta],
            );
            failures.push(meta.errorDigest);
            continue;
          }
          const fullText = bytes.toString("utf8");
          const maxChars = 1_000_000;
          const text = fullText.length > maxChars ? fullText.slice(0, maxChars) : fullText;
          const textSha8 = sha256Hex(Buffer.from(text, "utf8")).slice(0, 8);
          const art = await createArtifact({
            pool: params.pool,
            tenantId: params.tenantId,
            spaceId,
            type: "media_derivative",
            format: "text",
            contentType: "text/plain",
            contentText: text,
            source: { kind: "media_derivative", mediaId, jobId: params.jobId, op, contentType: contentTypeIn },
            createdBySubjectId,
          });
          await params.pool.query(
            `INSERT INTO media_derivatives (tenant_id, space_id, media_id, job_id, kind, status, artifact_id, meta) VALUES ($1,$2,$3,$4,$5,'succeeded',$6,$7)`,
            [params.tenantId, spaceId, mediaId, params.jobId, op, art.artifactId, { textDigest: { len: text.length, sha256_8: textSha8 }, contentType: contentTypeIn }],
          );
          continue;
        }

        if (op === "thumbnail") {
          const dims = dimsForContentType(contentTypeIn, bytes);
          if (!dims) {
            const meta = { errorDigest: { code: "MEDIA_OP_NOT_SUPPORTED", op, contentType: contentTypeIn } };
            await params.pool.query(
              `INSERT INTO media_derivatives (tenant_id, space_id, media_id, job_id, kind, status, meta) VALUES ($1,$2,$3,$4,$5,'failed',$6)`,
              [params.tenantId, spaceId, mediaId, params.jobId, op, meta],
            );
            failures.push(meta.errorDigest);
            continue;
          }
          const base64 = bytes.toString("base64");
          const digest8 = sha256Hex(bytes).slice(0, 8);
          const art = await createArtifact({
            pool: params.pool,
            tenantId: params.tenantId,
            spaceId,
            type: "media_derivative",
            format: "base64",
            contentType: "text/plain",
            contentText: base64,
            source: { kind: "media_derivative", mediaId, jobId: params.jobId, op, contentType: contentTypeIn, strategy: "passthrough" },
            createdBySubjectId,
          });
          await params.pool.query(
            `INSERT INTO media_derivatives (tenant_id, space_id, media_id, job_id, kind, status, artifact_id, meta) VALUES ($1,$2,$3,$4,$5,'succeeded',$6,$7)`,
            [
              params.tenantId,
              spaceId,
              mediaId,
              params.jobId,
              op,
              art.artifactId,
              { contentType: contentTypeIn, bytesDigest: { byteSize: bytes.byteLength, sha256_8: digest8 }, dimensionsDigest: dims, strategy: "passthrough_base64" },
            ],
          );
          continue;
        }

        if (op === "transcode" || op === "transcript") {
          const meta = { errorDigest: { code: "MEDIA_PROCESSOR_NOT_CONFIGURED", op } };
          await params.pool.query(
            `INSERT INTO media_derivatives (tenant_id, space_id, media_id, job_id, kind, status, meta) VALUES ($1,$2,$3,$4,$5,'failed',$6)`,
            [params.tenantId, spaceId, mediaId, params.jobId, op, meta],
          );
          failures.push(meta.errorDigest);
          continue;
        }

        const meta = { errorDigest: { code: "MEDIA_OP_UNKNOWN", op } };
        await params.pool.query(
          `INSERT INTO media_derivatives (tenant_id, space_id, media_id, job_id, kind, status, meta) VALUES ($1,$2,$3,$4,$5,'failed',$6)`,
          [params.tenantId, spaceId, mediaId, params.jobId, op, meta],
        );
        failures.push(meta.errorDigest);
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        const meta = { errorDigest: { code: "MEDIA_OP_FAILED", op, message: msg } };
        await params.pool.query(
          `INSERT INTO media_derivatives (tenant_id, space_id, media_id, job_id, kind, status, meta) VALUES ($1,$2,$3,$4,$5,'failed',$6)`,
          [params.tenantId, spaceId, mediaId, params.jobId, op, meta],
        );
        failures.push(meta.errorDigest);
      }
    }
    if (failures.length) {
      await params.pool.query(`UPDATE media_jobs SET status = 'failed', error_digest = $3, updated_at = now() WHERE tenant_id = $1 AND job_id = $2`, [
        params.tenantId,
        params.jobId,
        { errors: failures.slice(0, 10), errorCount: failures.length },
      ]);
      await params.pool.query(`UPDATE media_objects SET status = 'failed', updated_at = now() WHERE tenant_id = $1 AND media_id = $2`, [params.tenantId, mediaId]);
      return;
    }

    await params.pool.query(`UPDATE media_jobs SET status = 'succeeded', updated_at = now() WHERE tenant_id = $1 AND job_id = $2`, [params.tenantId, params.jobId]);
    await params.pool.query(`UPDATE media_objects SET status = 'ready', updated_at = now() WHERE tenant_id = $1 AND media_id = $2`, [params.tenantId, mediaId]);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    await params.pool.query(
      `UPDATE media_jobs SET status = 'failed', error_digest = $3, updated_at = now() WHERE tenant_id = $1 AND job_id = $2`,
      [params.tenantId, params.jobId, { message: msg }],
    );
    await params.pool.query(`UPDATE media_objects SET status = 'failed', updated_at = now() WHERE tenant_id = $1 AND media_id = $2`, [params.tenantId, mediaId]);
    throw err;
  }
}
