import type { Pool } from "pg";

function canonicalize(value: any): any {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") return value;
  const out: any = {};
  const keys = Object.keys(value).sort();
  for (const k of keys) out[k] = canonicalize(value[k]);
  return out;
}

function stableStringify(value: any) {
  return JSON.stringify(canonicalize(value));
}

async function chooseArtifactSpaceId(pool: Pool, tenantId: string, preferredSpaceId: string | null) {
  if (preferredSpaceId) return preferredSpaceId;
  const res = await pool.query("SELECT id FROM spaces WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT 1", [tenantId]);
  return res.rowCount ? (res.rows[0].id as string) : "space_dev";
}

export async function processAuditExport(params: { pool: Pool; tenantId: string; exportId: string; subjectId: string; spaceId: string | null }) {
  const tx = await params.pool.connect();
  try {
    await tx.query("BEGIN");
    const locked = await tx.query(
      `SELECT export_id, status, filters FROM audit_exports WHERE tenant_id = $1 AND export_id = $2 FOR UPDATE`,
      [params.tenantId, params.exportId],
    );
    if (!locked.rowCount) throw new Error("audit_export_not_found");
    const status = String(locked.rows[0].status ?? "");
    if (status !== "pending" && status !== "running") throw new Error("audit_export_not_runnable");
    const filters = (locked.rows[0].filters ?? {}) as any;
    await tx.query(`UPDATE audit_exports SET status = 'running', updated_at = now() WHERE tenant_id = $1 AND export_id = $2`, [
      params.tenantId,
      params.exportId,
    ]);
    await tx.query("COMMIT");

    const where: string[] = ["tenant_id = $1"];
    const args: any[] = [params.tenantId];
    let idx = 2;

    if (filters.spaceId) {
      where.push(`space_id = $${idx++}`);
      args.push(String(filters.spaceId));
    }
    if (filters.subjectId) {
      where.push(`subject_id = $${idx++}`);
      args.push(String(filters.subjectId));
    }
    if (filters.action) {
      where.push(`action = $${idx++}`);
      args.push(String(filters.action));
    }
    if (filters.toolRef) {
      where.push(`tool_ref = $${idx++}`);
      args.push(String(filters.toolRef));
    }
    if (filters.workflowRef) {
      where.push(`workflow_ref = $${idx++}`);
      args.push(String(filters.workflowRef));
    }
    if (filters.traceId) {
      where.push(`trace_id = $${idx++}`);
      args.push(String(filters.traceId));
    }
    if (filters.from) {
      where.push(`timestamp >= $${idx++}::timestamptz`);
      args.push(String(filters.from));
    }
    if (filters.to) {
      where.push(`timestamp <= $${idx++}::timestamptz`);
      args.push(String(filters.to));
    }

    const limit = Math.min(Math.max(Number(filters.limit ?? 2000), 1), 50000);
    args.push(limit);

    const res = await params.pool.query(
      `
        SELECT *
        FROM audit_events
        WHERE ${where.join(" AND ")}
        ORDER BY timestamp ASC, event_id ASC
        LIMIT $${idx}
      `,
      args,
    );

    const lines = res.rows.map((r) => stableStringify(r)).join("\n") + (res.rowCount ? "\n" : "");
    const spaceId = await chooseArtifactSpaceId(params.pool, params.tenantId, filters.spaceId ? String(filters.spaceId) : params.spaceId);
    const byteSize = Buffer.byteLength(lines, "utf8");

    const artRes = await params.pool.query(
      `
        INSERT INTO artifacts (tenant_id, space_id, type, format, content_type, byte_size, content_text, source, created_by_subject_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING artifact_id
      `,
      [
        params.tenantId,
        spaceId,
        "audit.export",
        "jsonl",
        "application/x-ndjson",
        byteSize,
        lines,
        { kind: "audit.export", exportId: params.exportId, filters: filters ?? null },
        params.subjectId,
      ],
    );
    const artifactId = artRes.rows[0].artifact_id as string;
    const artifactRef = `artifact:${artifactId}`;

    await params.pool.query(
      `
        UPDATE audit_exports
        SET status = 'succeeded',
            artifact_id = $3,
            artifact_ref = $4,
            error_digest = NULL,
            updated_at = now()
        WHERE tenant_id = $1 AND export_id = $2
      `,
      [params.tenantId, params.exportId, artifactId, artifactRef],
    );
  } catch (err: any) {
    try {
      await tx.query("ROLLBACK");
    } catch {
    }
    const msg = String(err?.message ?? err);
    await params.pool.query(
      `
        UPDATE audit_exports
        SET status = 'failed',
            error_digest = $3,
            updated_at = now()
        WHERE tenant_id = $1 AND export_id = $2
      `,
      [params.tenantId, params.exportId, { message: msg }],
    );
    throw err;
  } finally {
    tx.release();
  }
}

