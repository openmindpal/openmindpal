/**
 * 设备执行恢复 ticker
 *
 * 定期扫描已完成（succeeded/failed）但关联 run_id/step_id 的 device_executions，
 * 将对应的 run 从 needs_device 恢复为 queued 并将 step 重新入队执行。
 *
 * 这是端侧执行集成的"拉取式恢复"兜底机制，确保即使 API 侧的实时恢复
 * （在 result 回传时触发）因并发或异常未能完成，Worker 也能自行恢复。
 */
import type { Pool } from "pg";
import type { Queue } from "bullmq";

export async function tickDeviceExecutionResume(params: { pool: Pool; queue: Queue }) {
  const { pool, queue } = params;

  // 查找已完成的设备执行，其关联的 run 仍处于 needs_device 状态
  const res = await pool.query(
    `
      SELECT de.device_execution_id, de.tenant_id, de.run_id, de.step_id, de.status AS de_status,
             r.status AS run_status, j.job_id
      FROM device_executions de
      JOIN runs r ON r.run_id::text = de.run_id AND r.tenant_id = de.tenant_id
      JOIN jobs j ON j.tenant_id = r.tenant_id AND j.run_id::text = r.run_id::text
      WHERE de.run_id IS NOT NULL
        AND de.step_id IS NOT NULL
        AND de.status IN ('succeeded', 'failed')
        AND de.completed_at IS NOT NULL
        AND de.completed_at > now() - interval '1 hour'
        AND r.status = 'needs_device'
      ORDER BY de.completed_at ASC
      LIMIT 20
    `,
  );

  if (!res.rowCount) return;

  for (const row of res.rows) {
    const runId = String(row.run_id);
    const stepId = String(row.step_id);
    const jobId = String(row.job_id);
    const tenantId = String(row.tenant_id);
    const deviceExecutionId = String(row.device_execution_id);

    try {
      // 恢复 run 状态为 queued
      const updated = await pool.query(
        "UPDATE runs SET status = 'queued', updated_at = now() WHERE run_id = $1::uuid AND tenant_id = $2 AND status = 'needs_device'",
        [runId, tenantId],
      );
      if (!updated.rowCount) continue; // 其他进程已恢复

      await pool.query(
        "UPDATE jobs SET status = 'queued', updated_at = now() WHERE job_id = $1::uuid AND tenant_id = $2",
        [jobId, tenantId],
      );

      // 确保 step 状态为 pending 且清除旧的 queue_job_id
      await pool.query(
        "UPDATE steps SET status = 'pending', queue_job_id = NULL, updated_at = now() WHERE step_id = $1::uuid AND status = 'pending'",
        [stepId],
      );

      // 恢复协作运行状态（如有）
      const metaRes = await pool.query(
        "SELECT (input->>'collabRunId') AS collab_run_id, (input->>'spaceId') AS space_id FROM steps WHERE step_id = $1::uuid LIMIT 1",
        [stepId],
      );
      const collabRunId = metaRes.rowCount ? String(metaRes.rows[0].collab_run_id ?? "") : "";
      const spaceId = metaRes.rowCount ? String(metaRes.rows[0].space_id ?? "") : "";

      if (collabRunId) {
        await pool.query(
          "UPDATE collab_runs SET status = 'executing', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2::uuid AND status = 'needs_device'",
          [tenantId, collabRunId],
        );
      }

      if (spaceId) {
        await pool.query(
          "UPDATE memory_task_states SET phase = 'executing', updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3::uuid AND deleted_at IS NULL",
          [tenantId, spaceId, runId],
        );
      }

      // 将 step 重新入队
      const bj = await queue.add(
        "step",
        { jobId, runId, stepId },
        { attempts: 3, backoff: { type: "exponential", delay: 500 } },
      );
      await pool.query(
        "UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2::uuid AND (queue_job_id IS NULL OR queue_job_id = '')",
        [String((bj as any).id), stepId],
      );

      console.log(`[device-resume-ticker] resumed: runId=${runId} stepId=${stepId} deviceExecutionId=${deviceExecutionId} jobId=${jobId}`);
    } catch (err) {
      console.error(`[device-resume-ticker] failed to resume: runId=${runId} stepId=${stepId} deviceExecutionId=${deviceExecutionId}`, err);
    }
  }
}
