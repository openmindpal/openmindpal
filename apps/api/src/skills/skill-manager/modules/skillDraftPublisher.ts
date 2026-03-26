/**
 * Skill Draft Publisher
 *
 * 负责将草稿发布为可运行的动态Skill：
 * 1. 从草稿生成完整的Skill包（manifest.json + index.ts + routes.ts）
 * 2. 写入skill-registry目录
 * 3. 创建artifact记录
 * 4. 注册为tool（使动态加载生效）
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { createArtifact } from "../../../modules/artifacts/artifactRepo";
import { publishToolVersion } from "../../../modules/tools/toolRepo";
import { getSkillDraft, updateSkillDraftStatus } from "./skillDraftRepo";

// ─── Constants ───────────────────────────────────────────────────────────
function registryRootDir() {
  const raw = String(process.env.SKILL_REGISTRY_DIR ?? "").trim();
  return path.resolve(raw || path.resolve(process.cwd(), ".data", "skill-registry"));
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

// ─── Types ───────────────────────────────────────────────────────────────
export interface PublishResult {
  success: boolean;
  artifactId: string;
  artifactDir: string;
  toolName: string;
  depsDigest: string;
  publishedAt: string;
}

export interface PublishOptions {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  draftId: string;
  publishedBy: string;
  /** 是否跳过代码扫描（开发环境可设为true） */
  skipScan?: boolean;
}

// ─── Helper Functions ────────────────────────────────────────────────────

/**
 * 计算文件内容的SHA256摘要（前16位）
 */
function computeDigest(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/**
 * 生成package.json
 */
function generatePackageJson(skillName: string, manifest: any): string {
  const safeName = skillName.replace(/\./g, "-").toLowerCase();
  return JSON.stringify(
    {
      name: `@openslin-skill/${safeName}`,
      version: manifest?.identity?.version ?? "1.0.0",
      type: "module",
      main: "dist/index.js",
      scripts: {
        build: "tsc",
        dev: "tsc --watch",
      },
      dependencies: {
        fastify: "^4.0.0",
        zod: "^3.0.0",
      },
      devDependencies: {
        typescript: "^5.0.0",
      },
    },
    null,
    2
  );
}

/**
 * 生成tsconfig.json
 */
function generateTsConfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Node",
        esModuleInterop: true,
        strict: true,
        outDir: "./dist",
        rootDir: "./src",
        declaration: true,
      },
      include: ["src/**/*"],
    },
    null,
    2
  );
}

// ─── Main Publish Function ───────────────────────────────────────────────

/**
 * 发布草稿为可运行的动态Skill
 *
 * 流程：
 * 1. 获取草稿内容
 * 2. 创建artifact目录结构
 * 3. 写入所有文件（manifest.json, src/index.ts, src/routes.ts, package.json, tsconfig.json）
 * 4. 创建artifact数据库记录
 * 5. 注册为tool（使planningKernel可发现）
 * 6. 更新草稿状态为published
 */
export async function publishSkillDraft(options: PublishOptions): Promise<PublishResult> {
  const { pool, tenantId, spaceId, draftId, publishedBy } = options;

  // 1. 获取草稿
  const draft = await getSkillDraft({ pool, tenantId, draftId });
  if (!draft) {
    throw new Error("草稿不存在");
  }
  if (draft.status !== "approved" && draft.status !== "draft") {
    // 允许直接发布draft状态（个人使用）或approved状态（审核通过）
    if (draft.status === "published") {
      throw new Error("草稿已发布，无需重复发布");
    }
    throw new Error(`草稿状态不允许发布: ${draft.status}`);
  }

  const skillName = draft.skillName;
  const manifest = draft.manifest as any;
  const indexCode = draft.indexCode;
  const routesCode = draft.routesCode;

  // 2. 生成artifact ID和目录
  const artifactId = crypto.randomUUID();
  const registryRoot = registryRootDir();
  const artifactDir = path.join(registryRoot, artifactId);

  try {
    // 3. 创建目录结构
    await ensureDir(artifactDir);
    await ensureDir(path.join(artifactDir, "src"));
    await ensureDir(path.join(artifactDir, "dist"));

    // 4. 写入文件
    // manifest.json - 动态skill加载必须
    await fs.writeFile(
      path.join(artifactDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );

    // src/index.ts
    await fs.writeFile(path.join(artifactDir, "src", "index.ts"), indexCode, "utf8");

    // src/routes.ts
    await fs.writeFile(path.join(artifactDir, "src", "routes.ts"), routesCode, "utf8");

    // package.json
    await fs.writeFile(
      path.join(artifactDir, "package.json"),
      generatePackageJson(skillName, manifest),
      "utf8"
    );

    // tsconfig.json
    await fs.writeFile(path.join(artifactDir, "tsconfig.json"), generateTsConfig(), "utf8");

    // dist/index.js - 直接复制ts作为js（简化处理，实际应编译）
    // 对于动态skill，运行时会处理
    await fs.writeFile(path.join(artifactDir, "dist", "index.js"), indexCode, "utf8");
    await fs.writeFile(path.join(artifactDir, "dist", "routes.js"), routesCode, "utf8");

    // 5. 计算依赖摘要
    const depsDigest = computeDigest(
      JSON.stringify({ manifest, indexCode, routesCode, publishedAt: new Date().toISOString() })
    );

    // 6. 创建artifact数据库记录
    const artifactRow = await createArtifact({
      pool,
      artifactId,
      tenantId,
      spaceId,
      type: "skill_package",
      format: "dir",
      contentType: "application/x-skill-draft",
      contentText: JSON.stringify({ draftId, skillName }),
      source: {
        kind: "skill_draft",
        draftId,
        skillName,
        depsDigest,
        publishedBy,
        publishedAt: new Date().toISOString(),
      },
    });

    // 7. 注册为tool（使planningKernel能发现这个skill）
    const toolContract = manifest?.contract ?? {};
    const toolIo = manifest?.io ?? {};
    
    await publishToolVersion({
      pool,
      tenantId,
      name: skillName,
      publish: {
        displayName: manifest?.identity?.displayName ?? { "zh-CN": skillName, "en-US": skillName },
        description: manifest?.identity?.description ?? { "zh-CN": draft.description, "en-US": draft.description },
        scope: toolContract?.scope ?? "write",
        resourceType: toolContract?.resourceType ?? "custom",
        action: toolContract?.action ?? "execute",
        idempotencyRequired: toolContract?.idempotencyRequired ?? false,
        riskLevel: toolContract?.riskLevel ?? "medium",
        approvalRequired: toolContract?.approvalRequired ?? false,
        inputSchema: toolIo?.inputSchema ?? {},
        outputSchema: toolIo?.outputSchema ?? {},
        artifactRef: `artifact:${artifactId}`,
        depsDigest,
      },
    });

    // 8. 更新草稿状态为published
    await updateSkillDraftStatus({
      pool,
      tenantId,
      draftId,
      status: "published",
      approvedBy: publishedBy,
    });

    return {
      success: true,
      artifactId,
      artifactDir,
      toolName: skillName,
      depsDigest,
      publishedAt: new Date().toISOString(),
    };
  } catch (error: any) {
    // 回滚：删除已创建的目录
    await fs.rm(artifactDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`发布失败: ${error?.message ?? error}`);
  }
}

/**
 * 获取已发布的自定义Skill列表
 */
export async function listPublishedCustomSkills(params: {
  pool: Pool;
  tenantId: string;
  limit?: number;
}): Promise<
  Array<{
    toolName: string;
    displayName: Record<string, string> | null;
    description: Record<string, string> | null;
    artifactRef: string | null;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }>
> {
  const { pool, tenantId, limit = 100 } = params;
  const result = await pool.query(
    `SELECT name, display_name, description, artifact_ref, enabled, created_at, updated_at
     FROM tools
     WHERE tenant_id = $1
       AND layer = 'extension'
       AND artifact_ref IS NOT NULL
     ORDER BY updated_at DESC
     LIMIT $2`,
    [tenantId, limit]
  );
  return result.rows.map((row: any) => ({
    toolName: row.name,
    displayName: row.display_name,
    description: row.description,
    artifactRef: row.artifact_ref,
    enabled: row.enabled ?? true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
