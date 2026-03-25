import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

export async function migrate(pool: Pool, migrationsDir: string) {
  await pool.query("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");

  // Advisory lock prevents concurrent migration runs across multiple instances.
  // Lock key 0x4F53_4D49 = "OSMI" (OpenSLIn MIgrate).
  const ADVISORY_LOCK_KEY = 0x4F534D49;
  await pool.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
  try {
    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".sql"))
      .map((e) => e.name)
      .sort();

    for (const file of files) {
      const id = file;
      const already = await pool.query("SELECT 1 FROM migrations WHERE id = $1", [id]);
      if (already.rowCount && already.rowCount > 0) continue;

      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await pool.query("BEGIN");
      try {
        console.log(`[migrate] applying: ${file}`);
        await pool.query(sql);
        await pool.query("INSERT INTO migrations (id) VALUES ($1)", [id]);
        await pool.query("COMMIT");
        console.log(`[migrate] done: ${file}`);
      } catch (err) {
        await pool.query("ROLLBACK");
        console.error(`[migrate] FAILED on: ${file}`, err);
        throw err;
      }
    }
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
  }
}

