import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { tickCronTriggers } from "./tickCron";
import { tickEventTriggers } from "./tickEvent";

export async function tickTriggers(params: { pool: Pool; queue: Queue }) {
  await tickCronTriggers(params);
  await tickEventTriggers(params);
}
