import type { Pool } from "pg";

export type AgentMessageRow = {
  messageId: string;
  tenantId: string;
  spaceId: string | null;
  taskId: string;
  from: { agentId: string | null; role: string };
  intent: string;
  correlation: any;
  inputs: any;
  outputs: any;
  createdAt: string;
};

function toMessage(r: any): AgentMessageRow {
  return {
    messageId: r.message_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id ?? null,
    taskId: r.task_id,
    from: { agentId: r.from_agent_id ?? null, role: r.from_role },
    intent: r.intent,
    correlation: r.correlation ?? null,
    inputs: r.inputs ?? null,
    outputs: r.outputs ?? null,
    createdAt: r.created_at,
  };
}

export async function appendAgentMessage(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string | null;
  taskId: string;
  fromAgentId?: string | null;
  fromRole: string;
  intent: string;
  correlation?: any;
  inputs?: any;
  outputs?: any;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO agent_messages (
        tenant_id, space_id, task_id, from_agent_id, from_role, intent,
        correlation, inputs, outputs
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId ?? null,
      params.taskId,
      params.fromAgentId ?? null,
      params.fromRole,
      params.intent,
      params.correlation ?? null,
      params.inputs ?? null,
      params.outputs ?? null,
    ],
  );
  return toMessage(res.rows[0]);
}

export async function listAgentMessagesByTask(params: { pool: Pool; tenantId: string; taskId: string; limit: number; before?: string | null }) {
  const where: string[] = ["tenant_id = $1", "task_id = $2"];
  const args: any[] = [params.tenantId, params.taskId];
  let idx = 3;
  if (params.before) {
    where.push(`created_at < $${idx++}::timestamptz`);
    args.push(params.before);
  }
  args.push(params.limit);
  const res = await params.pool.query(
    `
      SELECT *
      FROM agent_messages
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx++}
    `,
    args,
  );
  return res.rows.map(toMessage);
}

