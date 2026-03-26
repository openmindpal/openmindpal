/**
 * E2E 测试全局清理
 * 在所有测试完成后关闭数据库连接池
 */
import { afterAll } from "vitest";
import { closePool } from "./setup";

afterAll(async () => {
  await closePool();
}, 120_000);
