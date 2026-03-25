import type { Pool, PoolClient } from "pg";

export type IdempotencyRecord = {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  operation: string;
  entityName: string;
  recordId: string | null;
  createdAt: string;
};

function rowToRecord(r: any): IdempotencyRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    idempotencyKey: r.idempotency_key,
    operation: r.operation,
    entityName: r.entity_name,
    recordId: r.record_id,
    createdAt: r.created_at,
  };
}

export async function getIdempotencyRecord(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  idempotencyKey: string;
  operation: string;
  entityName: string;
}) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM idempotency_records
      WHERE tenant_id = $1
        AND idempotency_key = $2
        AND operation = $3
        AND entity_name = $4
      LIMIT 1
    `,
    [params.tenantId, params.idempotencyKey, params.operation, params.entityName],
  );
  if (res.rowCount === 0) return null;
  return rowToRecord(res.rows[0]);
}

export async function insertIdempotencyRecord(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  idempotencyKey: string;
  operation: string;
  entityName: string;
  recordId?: string;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO idempotency_records (tenant_id, idempotency_key, operation, entity_name, record_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (tenant_id, idempotency_key, operation, entity_name)
      DO UPDATE SET record_id = COALESCE(idempotency_records.record_id, EXCLUDED.record_id)
      RETURNING *
    `,
    [params.tenantId, params.idempotencyKey, params.operation, params.entityName, params.recordId ?? null],
  );
  return rowToRecord(res.rows[0]);
}
