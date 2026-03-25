import crypto from "node:crypto";
import type { Pool } from "pg";
import { attachDlpSummary, redactValue } from "@openslin/shared";

function effectiveRetentionDays(v: any) {
  if (v === null || v === undefined) return 7;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 7;
  return Math.max(0, Math.min(365, Math.trunc(n)));
}

export async function tickWorkflowStepPayloadPurge(params: { pool: Pool; limit?: number }) {
  const limit = params.limit ?? 200;
  const tenants = await params.pool.query("SELECT id, workflow_step_payload_retention_days FROM tenants");
  let totalPurged = 0;
  for (const t of tenants.rows as any[]) {
    const tenantId = String(t.id);
    const days = effectiveRetentionDays(t.workflow_step_payload_retention_days);
    const targets = await params.pool.query(
      `
        WITH targets AS (
          SELECT s.step_id
          FROM steps s
          JOIN runs r ON r.run_id = s.run_id
          WHERE r.tenant_id = $1
            AND s.status IN ('succeeded','failed','canceled','deadletter')
            AND (s.input_encrypted_payload IS NOT NULL OR s.output_encrypted_payload IS NOT NULL)
            AND COALESCE(s.finished_at, s.updated_at, s.created_at) <= now() - ($2 || ' days')::interval
          ORDER BY COALESCE(s.finished_at, s.updated_at, s.created_at) ASC
          LIMIT $3
        )
        UPDATE steps
        SET input_encrypted_payload = NULL,
            output_encrypted_payload = NULL,
            updated_at = now()
        WHERE step_id IN (SELECT step_id FROM targets)
        RETURNING step_id
      `,
      [tenantId, String(days), limit],
    );
    const purged = Number(targets.rowCount ?? 0);
    if (purged <= 0) continue;
    totalPurged += purged;

    const traceId = `t-step-purge-${crypto.randomUUID()}`;
    const redactedIn = redactValue({ tenantId, retentionDays: days });
    const redactedOut = redactValue({ purgedCount: purged });
    await params.pool.query(
      `
        INSERT INTO audit_events (timestamp, subject_id, tenant_id, space_id, resource_type, action, input_digest, output_digest, result, trace_id, request_id)
        VALUES (now(), NULL, $1, NULL, 'governance', 'workflow.step.payload.purge', $2::jsonb, $3::jsonb, 'success', $4, NULL)
      `,
      [tenantId, redactedIn.value ?? null, attachDlpSummary(redactedOut.value, redactedOut.summary) ?? null, traceId],
    );
  }
  return { ok: true, purgedCount: totalPurged };
}

