import type { Pool } from "pg";
import { processSubscriptionPoll } from "./processor";

export async function tickSubscriptions(params: { pool: Pool; masterKey: string; limit?: number }) {
  const limit = params.limit ?? 50;
  const res = await params.pool.query(
    `
      SELECT subscription_id
      FROM subscriptions
      WHERE status = 'enabled'
      ORDER BY updated_at ASC
      LIMIT $1
    `,
    [limit],
  );
  for (const r of res.rows) {
    const id = r.subscription_id as string;
    try {
      await processSubscriptionPoll({ pool: params.pool, subscriptionId: id, masterKey: params.masterKey });
    } catch {
      continue;
    }
  }
}
