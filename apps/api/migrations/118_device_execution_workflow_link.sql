-- 端侧执行集成：关联 device_execution 与 workflow run/step
-- 用于 Worker 自动路由 device.* 工具调用到设备代理，并在设备回传结果后恢复工作流

ALTER TABLE device_executions ADD COLUMN IF NOT EXISTS run_id TEXT NULL;
ALTER TABLE device_executions ADD COLUMN IF NOT EXISTS step_id TEXT NULL;

CREATE INDEX IF NOT EXISTS device_executions_run_step_idx
  ON device_executions (tenant_id, run_id, step_id)
  WHERE run_id IS NOT NULL;

-- 用于 ticker 查询已完成但尚未恢复工作流的设备执行
CREATE INDEX IF NOT EXISTS device_executions_completed_pending_resume_idx
  ON device_executions (tenant_id, status, completed_at)
  WHERE run_id IS NOT NULL AND status IN ('succeeded', 'failed');
