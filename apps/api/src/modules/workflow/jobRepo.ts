import type { Pool } from "pg";
import { digestInputV1 } from "../../lib/digest";
import { encryptSecretEnvelope } from "../secrets/envelope";

function isPlainObject(v: any): v is Record<string, any> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function buildStepInputMeta(input: any) {
  if (!isPlainObject(input)) return input ?? null;
  const out: any = {};
  if (typeof input.toolRef === "string") out.toolRef = input.toolRef;
  if (isPlainObject(input.toolContract)) out.toolContract = input.toolContract;
  if (isPlainObject(input.limits)) out.limits = input.limits;
  if (isPlainObject(input.networkPolicy)) out.networkPolicy = input.networkPolicy;
  if (isPlainObject(input.capabilityEnvelope)) out.capabilityEnvelope = input.capabilityEnvelope;
  if (typeof input.planStepId === "string") out.planStepId = input.planStepId;
  if (typeof input.actorRole === "string") out.actorRole = input.actorRole;
  if (typeof input.stepKind === "string") out.stepKind = input.stepKind;
  if (Array.isArray(input.dependsOn)) out.dependsOn = input.dependsOn;
  if (typeof input.collabRunId === "string") out.collabRunId = input.collabRunId;
  if (typeof input.taskId === "string") out.taskId = input.taskId;
  if (typeof input.correlationId === "string") out.correlationId = input.correlationId;
  if (typeof input.autoArbiter === "boolean") out.autoArbiter = input.autoArbiter;
  if (typeof input.tenantId === "string") out.tenantId = input.tenantId;
  if (typeof input.spaceId === "string") out.spaceId = input.spaceId;
  if (typeof input.subjectId === "string") out.subjectId = input.subjectId;
  if (typeof input.traceId === "string") out.traceId = input.traceId;
  if (typeof input.idempotencyKey === "string") out.idempotencyKey = input.idempotencyKey;
  if (typeof input.kind === "string") out.kind = input.kind;
  return out;
}

export type JobRow = {
  jobId: string;
  tenantId: string;
  jobType: string;
  status: string;
  progress: number;
  runId: string | null;
  deadletteredAt?: string | null;
  resultSummary: any;
  createdAt: string;
  updatedAt: string;
};

export type RunRow = {
  runId: string;
  tenantId: string;
  spaceId?: string | null;
  traceId?: string | null;
  status: string;
  policySnapshotRef: string | null;
  toolRef: string | null;
  inputDigest: any;
  sealedAt?: string | null;
  sealedSchemaVersion?: number | null;
  sealedInputDigest?: any;
  sealedOutputDigest?: any;
  nondeterminismPolicy?: any;
  supplyChain?: any;
  isolation?: any;
  idempotencyKey: string | null;
  reexecOfRunId?: string | null;
  createdBySubjectId?: string | null;
  trigger?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StepRow = {
  stepId: string;
  runId: string;
  seq: number;
  status: string;
  attempt: number;
  toolRef: string | null;
  policySnapshotRef?: string | null;
  compensable?: boolean;
  inputDigest?: any;
  outputDigest?: any;
  sealedAt?: string | null;
  sealedSchemaVersion?: number | null;
  sealedInputDigest?: any;
  sealedOutputDigest?: any;
  nondeterminismPolicy?: any;
  supplyChain?: any;
  isolation?: any;
  errorCategory: string | null;
  lastError: string | null;
  lastErrorDigest?: any;
  deadletteredAt?: string | null;
  queueJobId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

function toJob(r: any): JobRow {
  return {
    jobId: r.job_id,
    tenantId: r.tenant_id,
    jobType: r.job_type,
    status: r.status,
    progress: r.progress,
    runId: r.run_id,
    deadletteredAt: r.deadlettered_at ?? null,
    resultSummary: r.result_summary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRun(r: any): RunRow {
  return {
    runId: r.run_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id ?? null,
    traceId: r.trace_id ?? null,
    status: r.status,
    policySnapshotRef: r.policy_snapshot_ref,
    toolRef: r.tool_ref,
    inputDigest: r.input_digest,
    sealedAt: r.sealed_at ?? null,
    sealedSchemaVersion: r.sealed_schema_version ?? null,
    sealedInputDigest: r.sealed_input_digest ?? null,
    sealedOutputDigest: r.sealed_output_digest ?? null,
    nondeterminismPolicy: r.nondeterminism_policy ?? null,
    supplyChain: r.supply_chain ?? null,
    isolation: r.isolation ?? null,
    idempotencyKey: r.idempotency_key,
    reexecOfRunId: r.reexec_of_run_id ?? null,
    createdBySubjectId: r.created_by_subject_id ?? null,
    trigger: r.trigger ?? null,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toStep(r: any): StepRow {
  const compensable = r.compensation_enc_format === "envelope.v1" && Boolean(r.compensation_encrypted_payload) && Number(r.compensation_key_version ?? 0) > 0;
  return {
    stepId: r.step_id,
    runId: r.run_id,
    seq: r.seq,
    status: r.status,
    attempt: r.attempt,
    toolRef: r.tool_ref,
    policySnapshotRef: r.policy_snapshot_ref ?? null,
    compensable,
    inputDigest: r.input_digest,
    outputDigest: r.output_digest,
    sealedAt: r.sealed_at ?? null,
    sealedSchemaVersion: r.sealed_schema_version ?? null,
    sealedInputDigest: r.sealed_input_digest ?? null,
    sealedOutputDigest: r.sealed_output_digest ?? null,
    nondeterminismPolicy: r.nondeterminism_policy ?? null,
    supplyChain: r.supply_chain ?? null,
    isolation: r.isolation ?? null,
    errorCategory: r.error_category,
    lastError: r.last_error,
    lastErrorDigest: r.last_error_digest ?? null,
    deadletteredAt: r.deadlettered_at ?? null,
    queueJobId: r.queue_job_id ?? null,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type DeadletterStepRow = {
  jobId: string | null;
  runId: string;
  stepId: string;
  status: string;
  attempt: number;
  toolRef: string | null;
  errorCategory: string | null;
  lastErrorDigest: any;
  deadletteredAt: string;
  updatedAt: string;
};

export async function createJobRunStep(params: {
  pool: Pool;
  tenantId: string;
  jobType: string;
  toolRef: string;
  policySnapshotRef?: string;
  idempotencyKey?: string;
  input?: any;
  createdBySubjectId?: string;
  trigger?: string;
  masterKey?: string;
}) {
  const inputDigest = params.input ? digestInputV1(params.input) : null;
  let stepInput = params.input ?? null;
  let inputEncFormat: string | null = null;
  let inputKeyVersion: number | null = null;
  let inputEncryptedPayload: any | null = null;
  if (params.jobType === "tool.execute" && params.masterKey && isPlainObject(params.input)) {
    const spaceId = typeof params.input.spaceId === "string" ? params.input.spaceId : null;
    if (spaceId) {
      const enc = await encryptSecretEnvelope({
        pool: params.pool,
        tenantId: params.tenantId,
        scopeType: "space",
        scopeId: spaceId,
        masterKey: params.masterKey,
        payload: params.input,
      });
      inputEncFormat = enc.encFormat;
      inputKeyVersion = enc.keyVersion;
      inputEncryptedPayload = enc.encryptedPayload;
      stepInput = buildStepInputMeta(params.input);
    }
  }
  await params.pool.query("BEGIN");
  try {
    if (params.idempotencyKey) {
      const runUpsert = await params.pool.query(
        `
          INSERT INTO runs (tenant_id, status, policy_snapshot_ref, tool_ref, input_digest, idempotency_key, created_by_subject_id, trigger)
          VALUES ($1, 'created', $2, $3, $4, $5, $6, $7)
          ON CONFLICT (tenant_id, idempotency_key, tool_ref) WHERE idempotency_key IS NOT NULL AND tool_ref IS NOT NULL
          DO UPDATE SET updated_at = now()
          RETURNING *
        `,
        [
          params.tenantId,
          params.policySnapshotRef ?? null,
          params.toolRef,
          inputDigest,
          params.idempotencyKey,
          params.createdBySubjectId ?? null,
          params.trigger ?? null,
        ],
      );
      const run = toRun(runUpsert.rows[0]);
      const existing = await params.pool.query(
        `
          SELECT j.*, s.step_id AS first_step_id
          FROM jobs j
          JOIN steps s ON s.run_id = j.run_id AND s.seq = 1
          WHERE j.tenant_id = $1 AND j.run_id = $2
          ORDER BY j.created_at DESC
          LIMIT 1
        `,
        [params.tenantId, run.runId],
      );
      if (existing.rowCount) {
        const row = existing.rows[0] as any;
        const job = toJob(row);
        const steps = await params.pool.query("SELECT * FROM steps WHERE step_id = $1 LIMIT 1", [row.first_step_id]);
        await params.pool.query("COMMIT");
        return { job, run, step: toStep(steps.rows[0]) };
      }

      const jobRes = await params.pool.query(
        "INSERT INTO jobs (tenant_id, job_type, status, run_id) VALUES ($1, $2, 'queued', $3) RETURNING *",
        [params.tenantId, params.jobType, run.runId],
      );
      const stepRes = await params.pool.query(
        `
          INSERT INTO steps (run_id, seq, status, tool_ref, input, input_digest, input_enc_format, input_key_version, input_encrypted_payload, policy_snapshot_ref)
          VALUES ($1, 1, 'pending', $2, $3, $4, $5, $6, $7, $8)
          RETURNING *
        `,
        [run.runId, params.toolRef, stepInput, inputDigest, inputEncFormat, inputKeyVersion, inputEncryptedPayload, params.policySnapshotRef ?? null],
      );
      if (params.policySnapshotRef) stepRes.rows[0].policy_snapshot_ref = params.policySnapshotRef;
      await params.pool.query("COMMIT");
      return { job: toJob(jobRes.rows[0]), run, step: toStep(stepRes.rows[0]) };
    }

    const jobRes = await params.pool.query(
      "INSERT INTO jobs (tenant_id, job_type, status) VALUES ($1, $2, 'queued') RETURNING *",
      [params.tenantId, params.jobType],
    );
    const runRes = await params.pool.query(
      `
        INSERT INTO runs (tenant_id, status, policy_snapshot_ref, tool_ref, input_digest, idempotency_key, created_by_subject_id, trigger)
        VALUES ($1, 'created', $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
      [
        params.tenantId,
        params.policySnapshotRef ?? null,
        params.toolRef,
        inputDigest,
        params.idempotencyKey ?? null,
        params.createdBySubjectId ?? null,
        params.trigger ?? null,
      ],
    );
    const stepRes = await params.pool.query(
      `
        INSERT INTO steps (run_id, seq, status, tool_ref, input, input_digest, input_enc_format, input_key_version, input_encrypted_payload, policy_snapshot_ref)
        VALUES ($1, 1, 'pending', $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `,
      [runRes.rows[0].run_id, params.toolRef, stepInput, inputDigest, inputEncFormat, inputKeyVersion, inputEncryptedPayload, params.policySnapshotRef ?? null],
    );

    await params.pool.query("UPDATE jobs SET run_id = $1, updated_at = now() WHERE job_id = $2", [
      runRes.rows[0].run_id,
      jobRes.rows[0].job_id,
    ]);

    await params.pool.query("COMMIT");
    return { job: toJob(jobRes.rows[0]), run: toRun(runRes.rows[0]), step: toStep(stepRes.rows[0]) };
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

export async function createJobRun(params: {
  pool: Pool;
  tenantId: string;
  jobType: string;
  runToolRef: string;
  inputDigest?: any;
  idempotencyKey?: string;
  policySnapshotRef?: string;
  createdBySubjectId?: string;
  trigger?: string;
}) {
  await params.pool.query("BEGIN");
  try {
    const jobRes = await params.pool.query(
      "INSERT INTO jobs (tenant_id, job_type, status) VALUES ($1, $2, 'queued') RETURNING *",
      [params.tenantId, params.jobType],
    );
    const runRes = await params.pool.query(
      `
        INSERT INTO runs (tenant_id, status, policy_snapshot_ref, tool_ref, input_digest, idempotency_key, created_by_subject_id, trigger)
        VALUES ($1, 'created', $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
      [
        params.tenantId,
        params.policySnapshotRef ?? null,
        params.runToolRef,
        params.inputDigest ?? null,
        params.idempotencyKey ?? null,
        params.createdBySubjectId ?? null,
        params.trigger ?? null,
      ],
    );
    await params.pool.query("UPDATE jobs SET run_id = $1, updated_at = now() WHERE job_id = $2", [
      runRes.rows[0].run_id,
      jobRes.rows[0].job_id,
    ]);
    await params.pool.query("COMMIT");
    return { job: toJob(jobRes.rows[0]), run: toRun(runRes.rows[0]) };
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

export async function appendStepToRun(params: {
  pool: Pool;
  tenantId: string;
  jobType: string;
  runId: string;
  toolRef: string;
  policySnapshotRef?: string;
  input?: any;
  masterKey?: string;
}) {
  const seqRes = await params.pool.query("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM steps WHERE run_id = $1", [
    params.runId,
  ]);
  const seq = Number(seqRes.rowCount ? (seqRes.rows[0].max_seq as any) : 0) + 1;

  const inputDigest = params.input ? digestInputV1(params.input) : null;
  let stepInput = params.input ?? null;
  let inputEncFormat: string | null = null;
  let inputKeyVersion: number | null = null;
  let inputEncryptedPayload: any | null = null;
  if ((params.jobType === "tool.execute" || params.jobType === "agent.run") && params.masterKey && isPlainObject(params.input)) {
    const spaceId = typeof params.input.spaceId === "string" ? params.input.spaceId : null;
    if (spaceId) {
      const enc = await encryptSecretEnvelope({
        pool: params.pool,
        tenantId: params.tenantId,
        scopeType: "space",
        scopeId: spaceId,
        masterKey: params.masterKey,
        payload: params.input,
      });
      inputEncFormat = enc.encFormat;
      inputKeyVersion = enc.keyVersion;
      inputEncryptedPayload = enc.encryptedPayload;
      stepInput = buildStepInputMeta(params.input);
    }
  }

  const res = await params.pool.query(
    `
      INSERT INTO steps (run_id, seq, status, tool_ref, input, input_digest, input_enc_format, input_key_version, input_encrypted_payload, policy_snapshot_ref)
      VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `,
    [
      params.runId,
      seq,
      params.toolRef,
      stepInput,
      inputDigest,
      inputEncFormat,
      inputKeyVersion,
      inputEncryptedPayload,
      params.policySnapshotRef ?? null,
    ],
  );
  return toStep(res.rows[0]);
}

export async function createJobRunStepWithoutToolRef(params: {
  pool: Pool;
  tenantId: string;
  jobType: string;
  runToolRef: string;
  policySnapshotRef?: string;
  idempotencyKey?: string;
  input?: any;
  createdBySubjectId?: string;
  trigger?: string;
}) {
  await params.pool.query("BEGIN");
  try {
    if (params.idempotencyKey) {
      const runUpsert = await params.pool.query(
        `
          INSERT INTO runs (tenant_id, status, policy_snapshot_ref, tool_ref, input_digest, idempotency_key, created_by_subject_id, trigger)
          VALUES ($1, 'created', $2, $3, $4, $5, $6, $7)
          ON CONFLICT (tenant_id, idempotency_key, tool_ref) WHERE idempotency_key IS NOT NULL AND tool_ref IS NOT NULL
          DO UPDATE SET updated_at = now()
          RETURNING *
        `,
        [
          params.tenantId,
          params.policySnapshotRef ?? null,
          params.runToolRef,
          params.input ?? null,
          params.idempotencyKey,
          params.createdBySubjectId ?? null,
          params.trigger ?? null,
        ],
      );
      const run = toRun(runUpsert.rows[0]);
      const existing = await params.pool.query(
        `
          SELECT j.*, s.step_id AS first_step_id
          FROM jobs j
          JOIN steps s ON s.run_id = j.run_id AND s.seq = 1
          WHERE j.tenant_id = $1 AND j.run_id = $2
          ORDER BY j.created_at DESC
          LIMIT 1
        `,
        [params.tenantId, run.runId],
      );
      if (existing.rowCount) {
        const row = existing.rows[0] as any;
        const job = toJob(row);
        const steps = await params.pool.query("SELECT * FROM steps WHERE step_id = $1 LIMIT 1", [row.first_step_id]);
        await params.pool.query("COMMIT");
        return { job, run, step: toStep(steps.rows[0]) };
      }

      const jobRes = await params.pool.query(
        "INSERT INTO jobs (tenant_id, job_type, status, run_id) VALUES ($1, $2, 'queued', $3) RETURNING *",
        [params.tenantId, params.jobType, run.runId],
      );
      const stepRes = await params.pool.query(
        `
          INSERT INTO steps (run_id, seq, status, tool_ref, input, input_digest)
          VALUES ($1, 1, 'pending', NULL, $2, $3)
          RETURNING *
        `,
        [run.runId, params.input ?? null, params.input ?? null],
      );
      await params.pool.query("COMMIT");
      return { job: toJob(jobRes.rows[0]), run, step: toStep(stepRes.rows[0]) };
    }

    const jobRes = await params.pool.query(
      "INSERT INTO jobs (tenant_id, job_type, status) VALUES ($1, $2, 'queued') RETURNING *",
      [params.tenantId, params.jobType],
    );
    const runRes = await params.pool.query(
      `
        INSERT INTO runs (tenant_id, status, policy_snapshot_ref, tool_ref, input_digest, idempotency_key, created_by_subject_id, trigger)
        VALUES ($1, 'created', $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
      [
        params.tenantId,
        params.policySnapshotRef ?? null,
        params.runToolRef,
        params.input ?? null,
        params.idempotencyKey ?? null,
        params.createdBySubjectId ?? null,
        params.trigger ?? null,
      ],
    );
    const stepRes = await params.pool.query(
      `
        INSERT INTO steps (run_id, seq, status, tool_ref, input, input_digest)
        VALUES ($1, 1, 'pending', NULL, $2, $3)
        RETURNING *
      `,
      [runRes.rows[0].run_id, params.input ?? null, params.input ?? null],
    );

    await params.pool.query("UPDATE jobs SET run_id = $1, updated_at = now() WHERE job_id = $2", [
      runRes.rows[0].run_id,
      jobRes.rows[0].job_id,
    ]);

    await params.pool.query("COMMIT");
    return { job: toJob(jobRes.rows[0]), run: toRun(runRes.rows[0]), step: toStep(stepRes.rows[0]) };
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

export async function getJob(pool: Pool, tenantId: string, jobId: string) {
  const res = await pool.query("SELECT * FROM jobs WHERE tenant_id = $1 AND job_id = $2 LIMIT 1", [
    tenantId,
    jobId,
  ]);
  if (res.rowCount === 0) return null;
  return toJob(res.rows[0]);
}

export async function getRun(pool: Pool, tenantId: string, runId: string) {
  const res = await pool.query("SELECT * FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [tenantId, runId]);
  if (res.rowCount === 0) return null;
  return toRun(res.rows[0]);
}

export async function getRunForSpace(pool: Pool, tenantId: string, spaceId: string, runId: string) {
  const res = await pool.query(
    `
      SELECT
        r.*,
        (s.input->>'spaceId') AS space_id,
        COALESCE(s.input->>'traceId', s.input->>'trace_id') AS trace_id
      FROM runs r
      JOIN steps s ON s.run_id = r.run_id AND s.seq = 1
      WHERE r.tenant_id = $1 AND r.run_id = $2 AND (s.input->>'spaceId') = $3
      LIMIT 1
    `,
    [tenantId, runId, spaceId],
  );
  if (res.rowCount === 0) return null;
  return toRun(res.rows[0]);
}

export async function listRuns(pool: Pool, tenantId: string, params: { limit: number; offset?: number; status?: string; spaceId: string; updatedFrom?: string; updatedTo?: string }) {
  const where: string[] = ["r.tenant_id = $1", "(s.input->>'spaceId') = $2"];
  const args: any[] = [tenantId, params.spaceId];
  let idx = 3;
  if (params.status) {
    where.push(`r.status = $${idx++}`);
    args.push(params.status);
  }
  if (params.updatedFrom) {
    where.push(`r.updated_at >= $${idx++}`);
    args.push(params.updatedFrom);
  }
  if (params.updatedTo) {
    where.push(`r.updated_at <= $${idx++}`);
    args.push(params.updatedTo);
  }
  const res = await pool.query(
    `
      SELECT
        r.*,
        (s.input->>'spaceId') AS space_id,
        COALESCE(s.input->>'traceId', s.input->>'trace_id') AS trace_id
      FROM runs r
      JOIN steps s ON s.run_id = r.run_id AND s.seq = 1
      WHERE ${where.join(" AND ")}
      ORDER BY r.updated_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `,
    [...args, params.limit, params.offset ?? 0],
  );
  return res.rows.map(toRun);
}

export async function listSteps(pool: Pool, runId: string) {
  const res = await pool.query("SELECT * FROM steps WHERE run_id = $1 ORDER BY seq ASC", [runId]);
  return res.rows.map(toStep);
}

export async function listDeadletterStepsByTenant(params: {
  pool: Pool;
  tenantId: string;
  limit: number;
  toolRef?: string;
}) {
  const where: string[] = ["r.tenant_id = $1", "s.status = 'deadletter'", "s.deadlettered_at IS NOT NULL"];
  const args: any[] = [params.tenantId];
  let idx = 2;
  if (params.toolRef) {
    where.push(`s.tool_ref = $${idx++}`);
    args.push(params.toolRef);
  }
  const res = await params.pool.query(
    `
      SELECT
        j.job_id,
        r.run_id,
        s.step_id,
        s.status,
        s.attempt,
        s.tool_ref,
        s.error_category,
        s.last_error_digest,
        s.deadlettered_at,
        s.updated_at
      FROM steps s
      JOIN runs r ON r.run_id = s.run_id
      LEFT JOIN jobs j ON j.run_id = r.run_id AND j.tenant_id = r.tenant_id
      WHERE ${where.join(" AND ")}
      ORDER BY s.deadlettered_at DESC
      LIMIT $${idx}
    `,
    [...args, params.limit],
  );
  return res.rows.map((r: any) => ({
    jobId: r.job_id ?? null,
    runId: r.run_id,
    stepId: r.step_id,
    status: r.status,
    attempt: r.attempt,
    toolRef: r.tool_ref,
    errorCategory: r.error_category,
    lastErrorDigest: r.last_error_digest ?? null,
    deadletteredAt: r.deadlettered_at,
    updatedAt: r.updated_at,
  })) as DeadletterStepRow[];
}

export async function markStepDeadlettered(params: {
  pool: Pool;
  tenantId: string;
  stepId: string;
  queueJobId?: string | null;
  errorCategory?: string | null;
  lastErrorDigest?: any;
}) {
  await params.pool.query("BEGIN");
  try {
    const stepRes = await params.pool.query(
      `
        UPDATE steps s
        SET status = 'deadletter',
            deadlettered_at = COALESCE(s.deadlettered_at, now()),
            queue_job_id = COALESCE($3, s.queue_job_id),
            error_category = COALESCE($4, s.error_category),
            last_error_digest = COALESCE($5, s.last_error_digest),
            finished_at = COALESCE(s.finished_at, now()),
            updated_at = now()
        FROM runs r
        WHERE s.step_id = $2 AND r.run_id = s.run_id AND r.tenant_id = $1
        RETURNING s.*
      `,
      [params.tenantId, params.stepId, params.queueJobId ?? null, params.errorCategory ?? null, params.lastErrorDigest ?? null],
    );
    if (!stepRes.rowCount) {
      await params.pool.query("ROLLBACK");
      return null;
    }
    const step = toStep(stepRes.rows[0]);

    await params.pool.query(
      `
        UPDATE runs
        SET status = CASE WHEN status IN ('succeeded','canceled','compensated') THEN status ELSE 'failed' END,
            finished_at = COALESCE(finished_at, now()),
            updated_at = now()
        WHERE tenant_id = $1 AND run_id = $2
      `,
      [params.tenantId, step.runId],
    );
    await params.pool.query(
      `
        UPDATE jobs
        SET status = CASE WHEN status IN ('succeeded','canceled','compensated') THEN status ELSE 'failed' END,
            deadlettered_at = COALESCE(deadlettered_at, now()),
            updated_at = now()
        WHERE tenant_id = $1 AND run_id = $2
      `,
      [params.tenantId, step.runId],
    );

    await params.pool.query("COMMIT");
    return step;
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

export async function retryDeadletterStep(params: { pool: Pool; tenantId: string; stepId: string }) {
  await params.pool.query("BEGIN");
  try {
    const stepRes = await params.pool.query(
      `
        UPDATE steps s
        SET status = 'pending',
            deadlettered_at = NULL,
            queue_job_id = NULL,
            error_category = NULL,
            last_error_digest = NULL,
            updated_at = now(),
            finished_at = NULL
        FROM runs r
        WHERE s.step_id = $2 AND s.status = 'deadletter' AND r.run_id = s.run_id AND r.tenant_id = $1
        RETURNING s.*
      `,
      [params.tenantId, params.stepId],
    );
    if (!stepRes.rowCount) {
      await params.pool.query("ROLLBACK");
      return null;
    }
    const step = toStep(stepRes.rows[0]);

    await params.pool.query("UPDATE runs SET status = 'queued', updated_at = now(), finished_at = NULL WHERE tenant_id = $1 AND run_id = $2", [
      params.tenantId,
      step.runId,
    ]);
    await params.pool.query("UPDATE jobs SET status = 'queued', updated_at = now(), deadlettered_at = NULL WHERE tenant_id = $1 AND run_id = $2", [
      params.tenantId,
      step.runId,
    ]);

    await params.pool.query("COMMIT");
    return step;
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

export async function retryFailedStep(params: { pool: Pool; tenantId: string; stepId: string }) {
  await params.pool.query("BEGIN");
  try {
    const stepRes = await params.pool.query(
      `
        UPDATE steps s
        SET status = 'pending',
            queue_job_id = NULL,
            error_category = NULL,
            last_error = NULL,
            last_error_digest = NULL,
            updated_at = now(),
            finished_at = NULL
        FROM runs r
        WHERE s.step_id = $2
          AND s.status = 'failed'
          AND r.run_id = s.run_id
          AND r.tenant_id = $1
        RETURNING s.*
      `,
      [params.tenantId, params.stepId],
    );
    if (!stepRes.rowCount) {
      await params.pool.query("ROLLBACK");
      return null;
    }
    const step = toStep(stepRes.rows[0]);

    await params.pool.query(
      "UPDATE runs SET status = CASE WHEN status IN ('succeeded','canceled','compensated') THEN status ELSE 'queued' END, updated_at = now(), finished_at = NULL WHERE tenant_id = $1 AND run_id = $2",
      [params.tenantId, step.runId],
    );
    await params.pool.query(
      "UPDATE jobs SET status = CASE WHEN status IN ('succeeded','canceled','compensated') THEN status ELSE 'queued' END, updated_at = now() WHERE tenant_id = $1 AND run_id = $2",
      [params.tenantId, step.runId],
    );

    await params.pool.query("COMMIT");
    return step;
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

export async function cancelDeadletterStep(params: { pool: Pool; tenantId: string; stepId: string }) {
  await params.pool.query("BEGIN");
  try {
    const stepRes = await params.pool.query(
      `
        UPDATE steps s
        SET status = 'canceled',
            deadlettered_at = NULL,
            queue_job_id = NULL,
            error_category = NULL,
            last_error_digest = NULL,
            updated_at = now(),
            finished_at = COALESCE(s.finished_at, now())
        FROM runs r
        WHERE s.step_id = $2 AND s.status = 'deadletter' AND r.run_id = s.run_id AND r.tenant_id = $1
        RETURNING s.*
      `,
      [params.tenantId, params.stepId],
    );
    if (!stepRes.rowCount) {
      await params.pool.query("ROLLBACK");
      return null;
    }
    const step = toStep(stepRes.rows[0]);

    await params.pool.query("UPDATE runs SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE tenant_id = $1 AND run_id = $2", [
      params.tenantId,
      step.runId,
    ]);
    await params.pool.query("UPDATE jobs SET status = 'canceled', deadlettered_at = NULL, updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [
      params.tenantId,
      step.runId,
    ]);

    await params.pool.query("COMMIT");
    return step;
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

export async function cancelRun(params: { pool: Pool; tenantId: string; runId: string }) {
  await params.pool.query("BEGIN");
  try {
    const before = await params.pool.query(
      "SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
      [params.tenantId, params.runId],
    );
    if (!before.rowCount) {
      await params.pool.query("ROLLBACK");
      return null;
    }
    const prevStatus = before.rows[0].status as string;

    const runRes = await params.pool.query(
      `
        UPDATE runs
        SET status = CASE WHEN status IN ('succeeded','failed','canceled','compensated') THEN status ELSE 'canceled' END,
            finished_at = CASE WHEN status IN ('succeeded','failed','canceled','compensated') THEN finished_at ELSE now() END,
            updated_at = now()
        WHERE tenant_id = $1 AND run_id = $2
        RETURNING *
      `,
      [params.tenantId, params.runId],
    );
    const run = toRun(runRes.rows[0]);

    if (!["succeeded", "failed", "canceled", "compensated"].includes(prevStatus)) {
      await params.pool.query("UPDATE steps SET status = 'canceled', updated_at = now(), finished_at = now() WHERE run_id = $1 AND status IN ('pending','running','compensating')", [params.runId]);
      await params.pool.query("UPDATE jobs SET status = 'canceled', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [params.tenantId, params.runId]);
    }

    await params.pool.query("COMMIT");
    return run;
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}
