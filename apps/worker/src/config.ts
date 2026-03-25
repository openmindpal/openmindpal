export type WorkerConfig = {
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  redis: {
    host: string;
    port: number;
  };
  secrets: {
    masterKey: string;
  };
  media: {
    fsRootDir: string;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const isProd = env.NODE_ENV === "production";
  const masterKeyRaw = (env.API_MASTER_KEY ?? "").trim();
  const masterKey = masterKeyRaw || (!isProd ? "dev-master-key-change-me" : "");
  if (isProd && (!masterKey || masterKey === "dev-master-key-change-me")) {
    throw new Error("API_MASTER_KEY is required in production");
  }
  return {
    db: {
      host: env.POSTGRES_HOST ?? "127.0.0.1",
      port: Number(env.POSTGRES_PORT ?? 5432),
      database: env.POSTGRES_DB ?? "openslin",
      user: env.POSTGRES_USER ?? "openslin",
      password: env.POSTGRES_PASSWORD ?? "openslin",
    },
    redis: {
      host: env.REDIS_HOST ?? "127.0.0.1",
      port: Number(env.REDIS_PORT ?? 6379),
    },
    secrets: {
      masterKey,
    },
    media: {
      fsRootDir: env.MEDIA_FS_ROOT_DIR ?? "var/media",
    },
  };
}
