import fs from "node:fs/promises";
import path from "node:path";
import "./otel";
import { loadConfig } from "./config";
import { migrate } from "./db/migrate";
import { createPool } from "./db/pool";
import { createWorkflowQueue } from "./modules/workflow/queue";
import { buildServer } from "./server";
import { autoDiscoverAndRegisterTools } from "./modules/tools/toolAutoDiscovery";

async function findMigrationsDir(): Promise<string> {
  const candidates = [
    path.resolve(__dirname, "../migrations"),
    path.resolve(process.cwd(), "apps/api/migrations"),
    path.resolve(process.cwd(), "migrations"),
  ];
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c);
      if (stat.isDirectory()) return c;
    } catch {
      continue;
    }
  }
  return candidates[1];
}

async function main() {
  const cfg = loadConfig(process.env);
  const pool = createPool(cfg);
  await migrate(pool, await findMigrationsDir());

  const queue = createWorkflowQueue(cfg);
  const app = buildServer(cfg, { db: pool, queue });

  // Auto-discover and register tools AFTER buildServer (built-in skills are registered at this point)
  try {
    const discovery = await autoDiscoverAndRegisterTools(pool);
    console.log(`[tool-discovery] registered=${discovery.registered} skipped=${discovery.skipped}`);
  } catch (err) {
    console.error("[tool-discovery] failed (non-fatal):", err);
  }

  await app.listen({ port: cfg.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
