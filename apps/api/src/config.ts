export type ApiConfig = {
  port: number;
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
  platformLocale: string;
  cors: {
    allowedOrigins: string[];
  };
  secrets: {
    masterKey: string;
  };
  media: {
    fsRootDir: string;
    upload: {
      maxPartBytes: number;
      maxTotalBytes: number;
      expiresSec: number;
    };
  };
};

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const isProd = env.NODE_ENV === "production";
  const allowedOrigins =
    (env.API_CORS_ORIGINS ?? "http://localhost:3000")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const fsRootDir = env.MEDIA_FS_ROOT_DIR ?? "var/media";
  const masterKeyRaw = (env.API_MASTER_KEY ?? "").trim();
  const masterKey = masterKeyRaw || (!isProd ? "dev-master-key-change-me" : "");
  if (isProd && (!masterKey || masterKey === "dev-master-key-change-me")) {
    throw new Error("API_MASTER_KEY is required in production");
  }
  return {
    port: Number(env.API_PORT ?? 3001),
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
    platformLocale: env.PLATFORM_LOCALE ?? "zh-CN",
    cors: {
      allowedOrigins,
    },
    secrets: {
      masterKey,
    },
    media: {
      fsRootDir,
      upload: {
        maxPartBytes: Number(env.MEDIA_UPLOAD_MAX_PART_BYTES ?? 5 * 1024 * 1024),
        maxTotalBytes: Number(env.MEDIA_UPLOAD_MAX_TOTAL_BYTES ?? 50 * 1024 * 1024),
        expiresSec: Number(env.MEDIA_UPLOAD_EXPIRES_SEC ?? 3600),
      },
    },
  };
}
