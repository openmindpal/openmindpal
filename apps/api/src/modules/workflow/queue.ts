import { Queue } from "bullmq";
import type { ApiConfig } from "../../config";
import { attachJobTraceCarrier } from "../../lib/tracing";

export type WorkflowQueue = Queue;

export function createWorkflowQueue(cfg: ApiConfig) {
  const connection = { host: cfg.redis.host, port: cfg.redis.port };
  const q = new Queue("workflow", { connection });
  const origAdd = q.add.bind(q);
  (q as any).add = (name: string, data: any, opts: any) => origAdd(name, attachJobTraceCarrier(data ?? {}), opts);
  return q;
}

export async function setRunAndJobStatus(params: {
  pool: any;
  tenantId: string;
  runId: string;
  jobId: string;
  runStatus: string;
  jobStatus: string;
}) {
  await params.pool.query("UPDATE runs SET status = $3, updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [
    params.tenantId,
    params.runId,
    params.runStatus,
  ]);
  await params.pool.query("UPDATE jobs SET status = $3, updated_at = now() WHERE tenant_id = $1 AND job_id = $2", [
    params.tenantId,
    params.jobId,
    params.jobStatus,
  ]);
}

export async function enqueueWorkflowStep(params: {
  queue: WorkflowQueue;
  pool: any;
  jobId: string;
  runId: string;
  stepId: string;
  attempts?: number;
  backoffDelayMs?: number;
}) {
  const attempts = typeof params.attempts === "number" && Number.isFinite(params.attempts) ? params.attempts : 3;
  const delay = typeof params.backoffDelayMs === "number" && Number.isFinite(params.backoffDelayMs) ? params.backoffDelayMs : 500;
  const bj = await params.queue.add(
    "step",
    { jobId: params.jobId, runId: params.runId, stepId: params.stepId },
    { attempts, backoff: { type: "exponential", delay } },
  );
  await params.pool.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2", [
    String((bj as any).id ?? ""),
    params.stepId,
  ]);
  return bj;
}
