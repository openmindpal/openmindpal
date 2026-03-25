import type { Pool } from "pg";
import { attachDlpSummary, normalizeAuditErrorCategory, redactValue } from "@openslin/shared";

export async function markWorkflowStepDeadletter(params: {
  pool: Pool;
  jobId: string;
  runId: string;
  stepId: string;
  queueJobId: string;
  err: unknown;
}) {
  const infoRes = await params.pool.query(
    `
      SELECT
        r.tenant_id,
        s.tool_ref,
        (s.input->>'spaceId') AS space_id,
        (s.input->>'subjectId') AS subject_id,
        COALESCE(s.input->>'traceId', s.input->>'trace_id') AS trace_id,
        s.error_category
      FROM steps s
      JOIN runs r ON r.run_id = s.run_id
      WHERE s.step_id = $1 AND s.run_id = $2
      LIMIT 1
    `,
    [params.stepId, params.runId],
  );
  if (!infoRes.rowCount) return null;

  const row = infoRes.rows[0] as any;
  const tenantId = String(row.tenant_id);
  const toolRef = row.tool_ref ? String(row.tool_ref) : null;
  const spaceId = row.space_id ? String(row.space_id) : null;
  const subjectId = row.subject_id ? String(row.subject_id) : null;
  const traceId = row.trace_id ? String(row.trace_id) : params.queueJobId;
  const errorCategory = row.error_category ? String(row.error_category) : null;
  const auditErrorCategory = normalizeAuditErrorCategory(errorCategory);

  const msg = String((params.err as any)?.message ?? params.err);
  const redactedError = redactValue({ name: (params.err as any)?.name ?? null, message: msg, code: (params.err as any)?.code ?? null });
  const lastErrorDigest = attachDlpSummary(redactedError.value, redactedError.summary);

  await params.pool.query(
    `
      UPDATE steps
      SET status = 'deadletter',
          deadlettered_at = COALESCE(deadlettered_at, now()),
          queue_job_id = COALESCE(queue_job_id, $2),
          last_error_digest = $3::jsonb,
          updated_at = now(),
          finished_at = COALESCE(finished_at, now())
      WHERE step_id = $1
    `,
    [params.stepId, params.queueJobId, lastErrorDigest],
  );
  await params.pool.query("UPDATE jobs SET deadlettered_at = COALESCE(deadlettered_at, now()), updated_at = now() WHERE job_id = $1 AND tenant_id = $2", [
    params.jobId,
    tenantId,
  ]);
  await params.pool.query("UPDATE runs SET finished_at = COALESCE(finished_at, now()), updated_at = now() WHERE run_id = $1 AND tenant_id = $2", [
    params.runId,
    tenantId,
  ]);

  const redactedIn = redactValue({ runId: params.runId, stepId: params.stepId, toolRef });
  const redactedOut = redactValue({ status: "deadletter", errorCategory, lastErrorDigest });

  await params.pool.query(
    `
      INSERT INTO audit_events (timestamp, subject_id, tenant_id, space_id, resource_type, action, tool_ref, workflow_ref, input_digest, output_digest, result, trace_id, request_id, run_id, step_id, error_category)
      VALUES (now(), $1, $2, $3, 'workflow', 'workflow:deadletter', $4, $5, $6::jsonb, $7::jsonb, 'error', $8, NULL, $5, $9, $10)
    `,
    [
      subjectId,
      tenantId,
      spaceId,
      toolRef,
      params.runId,
      redactedIn.value ?? null,
      attachDlpSummary(redactedOut.value, redactedOut.summary) ?? null,
      traceId,
      params.stepId,
      auditErrorCategory,
    ],
  );

  return { tenantId, runId: params.runId, stepId: params.stepId, traceId };
}
