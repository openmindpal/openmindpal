import { Pool } from "pg";
import type { ApiConfig } from "../config";

export function createPool(cfg: ApiConfig) {
  return new Pool({
    host: cfg.db.host,
    port: cfg.db.port,
    database: cfg.db.database,
    user: cfg.db.user,
    password: cfg.db.password,
  });
}

