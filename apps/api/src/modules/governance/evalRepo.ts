import type { Pool } from "pg";

export type EvalSuiteRow = {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  casesJson: any[];
  thresholds: any;
  createdAt: string;
  updatedAt: string;
};

export type EvalRunRow = {
  id: string;
  tenantId: string;
  suiteId: string;
  changesetId: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  summary: any;
  evidenceDigest: any;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
};

function toSuite(r: any): EvalSuiteRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    description: r.description,
    casesJson: r.cases_json ?? [],
    thresholds: r.thresholds ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRun(r: any): EvalRunRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    suiteId: r.suite_id,
    changesetId: r.changeset_id,
    status: r.status,
    summary: r.summary ?? {},
    evidenceDigest: r.evidence_digest ?? null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
  };
}

export async function createEvalSuite(params: { pool: Pool; tenantId: string; name: string; description?: string | null; casesJson: any[]; thresholds: any }) {
  const casesJson = JSON.stringify(params.casesJson ?? []);
  const thresholds = JSON.stringify(params.thresholds ?? {});
  const res = await params.pool.query(
    `
      INSERT INTO eval_suites (tenant_id, name, description, cases_json, thresholds)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)
      RETURNING *
    `,
    [params.tenantId, params.name, params.description ?? null, casesJson, thresholds],
  );
  return toSuite(res.rows[0]);
}

export async function updateEvalSuite(params: { pool: Pool; tenantId: string; id: string; description?: string | null; casesJson?: any[]; thresholds?: any }) {
  const patch: string[] = [];
  const args: any[] = [params.tenantId, params.id];
  let idx = 3;

  if (params.description !== undefined) {
    patch.push(`description = $${idx++}`);
    args.push(params.description);
  }
  if (params.casesJson !== undefined) {
    patch.push(`cases_json = $${idx++}::jsonb`);
    args.push(JSON.stringify(params.casesJson));
  }
  if (params.thresholds !== undefined) {
    patch.push(`thresholds = $${idx++}::jsonb`);
    args.push(JSON.stringify(params.thresholds));
  }
  if (!patch.length) {
    const cur = await getEvalSuite({ pool: params.pool, tenantId: params.tenantId, id: params.id });
    if (!cur) throw new Error("suite_not_found");
    return cur;
  }

  const res = await params.pool.query(
    `
      UPDATE eval_suites
      SET ${patch.join(", ")}, updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *
    `,
    args,
  );
  if (!res.rowCount) throw new Error("suite_not_found");
  return toSuite(res.rows[0]);
}

export async function getEvalSuite(params: { pool: Pool; tenantId: string; id: string }) {
  const res = await params.pool.query(
    `SELECT * FROM eval_suites WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [params.tenantId, params.id],
  );
  if (!res.rowCount) return null;
  return toSuite(res.rows[0]);
}

export async function listEvalSuites(params: { pool: Pool; tenantId: string; limit: number }) {
  const res = await params.pool.query(
    `SELECT * FROM eval_suites WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [params.tenantId, params.limit],
  );
  return res.rows.map(toSuite);
}

export async function createEvalRun(params: { pool: Pool; tenantId: string; suiteId: string; changesetId?: string | null; status: EvalRunRow["status"]; summary: any; evidenceDigest?: any }) {
  const summary = JSON.stringify(params.summary ?? {});
  const evidenceDigest = params.evidenceDigest === undefined ? null : JSON.stringify(params.evidenceDigest);
  const res = await params.pool.query(
    `
      INSERT INTO eval_runs (tenant_id, suite_id, changeset_id, status, summary, evidence_digest, finished_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb, CASE WHEN $4 IN ('succeeded','failed') THEN now() ELSE NULL END)
      RETURNING *
    `,
    [params.tenantId, params.suiteId, params.changesetId ?? null, params.status, summary, evidenceDigest],
  );
  return toRun(res.rows[0]);
}

export async function setEvalRunFinished(params: { pool: Pool; tenantId: string; id: string; status: "succeeded" | "failed"; summary: any; evidenceDigest?: any }) {
  const summary = JSON.stringify(params.summary ?? {});
  const evidenceDigest = params.evidenceDigest === undefined ? null : JSON.stringify(params.evidenceDigest);
  const res = await params.pool.query(
    `
      UPDATE eval_runs
      SET status = $3, summary = $4::jsonb, evidence_digest = $5::jsonb, finished_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *
    `,
    [params.tenantId, params.id, params.status, summary, evidenceDigest],
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

export async function setEvalRunStatus(params: { pool: Pool; tenantId: string; id: string; status: "queued" | "running" | "succeeded" | "failed" }) {
  const res = await params.pool.query(
    `
      UPDATE eval_runs
      SET status = $3
      WHERE tenant_id = $1 AND id = $2
      RETURNING *
    `,
    [params.tenantId, params.id, params.status],
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

export async function getEvalRun(params: { pool: Pool; tenantId: string; id: string }) {
  const res = await params.pool.query(
    `SELECT * FROM eval_runs WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [params.tenantId, params.id],
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

export async function listEvalRuns(params: { pool: Pool; tenantId: string; suiteId?: string; changesetId?: string; limit: number }) {
  const where: string[] = ["tenant_id = $1"];
  const args: any[] = [params.tenantId];
  let idx = 2;
  if (params.suiteId) {
    where.push(`suite_id = $${idx++}`);
    args.push(params.suiteId);
  }
  if (params.changesetId) {
    where.push(`changeset_id = $${idx++}`);
    args.push(params.changesetId);
  }
  const res = await params.pool.query(
    `
      SELECT *
      FROM eval_runs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx}
    `,
    [...args, params.limit],
  );
  return res.rows.map(toRun);
}

export async function replaceChangeSetEvalBindings(params: { pool: Pool; tenantId: string; changesetId: string; suiteIds: string[] }) {
  await params.pool.query("BEGIN");
  try {
    await params.pool.query(
      `DELETE FROM changeset_eval_bindings WHERE tenant_id = $1 AND changeset_id = $2`,
      [params.tenantId, params.changesetId],
    );
    for (const suiteId of params.suiteIds) {
      await params.pool.query(
        `
          INSERT INTO changeset_eval_bindings (tenant_id, changeset_id, suite_id)
          VALUES ($1,$2,$3)
          ON CONFLICT DO NOTHING
        `,
        [params.tenantId, params.changesetId, suiteId],
      );
    }
    await params.pool.query("COMMIT");
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

export async function listChangeSetEvalBindings(params: { pool: Pool; tenantId: string; changesetId: string }) {
  const res = await params.pool.query(
    `
      SELECT suite_id
      FROM changeset_eval_bindings
      WHERE tenant_id = $1 AND changeset_id = $2
      ORDER BY created_at ASC
    `,
    [params.tenantId, params.changesetId],
  );
  return res.rows.map((r) => r.suite_id as string);
}

export async function getLatestSucceededEvalRun(params: { pool: Pool; tenantId: string; suiteId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM eval_runs
      WHERE tenant_id = $1 AND suite_id = $2 AND status = 'succeeded'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [params.tenantId, params.suiteId],
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

export async function getLatestEvalRunForChangeSet(params: { pool: Pool; tenantId: string; suiteId: string; changesetId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM eval_runs
      WHERE tenant_id = $1 AND suite_id = $2 AND changeset_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [params.tenantId, params.suiteId, params.changesetId],
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

export async function getActiveEvalRunForChangeSet(params: {
  pool: Pool;
  tenantId: string;
  suiteId: string;
  changesetId: string;
  reportDigest8?: string | null;
}) {
  const where: string[] = ["tenant_id = $1", "suite_id = $2", "changeset_id = $3", "status IN ('queued','running')"];
  const args: any[] = [params.tenantId, params.suiteId, params.changesetId];
  let idx = 4;
  if (params.reportDigest8) {
    where.push(`(summary->>'reportDigest8') = $${idx++}`);
    args.push(params.reportDigest8);
  }
  const res = await params.pool.query(
    `
      SELECT *
      FROM eval_runs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    args,
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}
