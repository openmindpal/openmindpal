/**
 * Skill Semantic Repository
 *
 * 技能语义向量存储与检索：
 * - 为每个技能生成语义向量（名称+描述+参数）
 * - 支持语义相似度检索
 * - 支持重复/相似技能检测
 */
import crypto from "node:crypto";
import type { Pool } from "pg";

// ─── Minhash 语义向量工具（与系统其他模块对齐）───────────────────────
const MINHASH_K = 16;

function tokenize(text: string): string[] {
  const out: string[] = [];
  const s = text.toLowerCase();
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = ch.charCodeAt(0);
    // CJK 统一表意文字区间：每个汉字作为独立 token
    if (code >= 0x4e00 && code <= 0x9fff) {
      if (buf.length >= 2) out.push(buf);
      buf = "";
      out.push(ch);
      if (out.length >= 512) break;
      continue;
    }
    const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "-";
    if (ok) buf += ch;
    else {
      if (buf.length >= 2) out.push(buf);
      buf = "";
    }
    if (out.length >= 512) break;
  }
  if (buf.length >= 2) out.push(buf);
  return out;
}

function hash32(str: string): number {
  const h = crypto.createHash("sha256").update(str, "utf8").digest();
  return h.readInt32BE(0);
}

export function computeMinhash(text: string, k: number = MINHASH_K): number[] {
  const toks = tokenize(text);
  const mins = new Array<number>(k).fill(2147483647);
  for (const t of toks) {
    for (let i = 0; i < k; i++) {
      const v = hash32(`${i}:${t}`);
      if (v < mins[i]!) mins[i] = v;
    }
  }
  return mins.map((x) => (x === 2147483647 ? 0 : x));
}

/** 计算两个 minhash 向量的 overlap 得分（0~1） */
export function minhashOverlapScore(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let hit = 0;
  for (const v of a) if (setB.has(v)) hit++;
  return a.length ? hit / a.length : 0;
}

// ─── Types ───────────────────────────────────────────────────────────
export interface SkillSemanticRow {
  skillName: string;
  tenantId: string;
  displayName: Record<string, string> | null;
  description: Record<string, string> | null;
  semanticText: string;
  semanticMinhash: number[];
  layer: string;
  enabled: boolean;
  updatedAt: Date;
}

export interface SimilarSkill {
  skillName: string;
  displayName: Record<string, string> | null;
  description: Record<string, string> | null;
  similarity: number;
  layer: string;
  enabled: boolean;
}

// ─── 构建语义文本 ─────────────────────────────────────────────────────
/**
 * 从技能元数据构建语义文本（用于向量化）
 * 包含：名称 + 显示名 + 描述 + 输入参数名
 */
export function buildSkillSemanticText(params: {
  name: string;
  displayName?: Record<string, string> | null;
  description?: Record<string, string> | null;
  inputSchema?: any;
}): string {
  const parts: string[] = [];

  // 名称（去掉点号，拆分单词）
  parts.push(params.name.replace(/\./g, " "));

  // 显示名（中英文）
  if (params.displayName) {
    const zhName = params.displayName["zh-CN"] || params.displayName["zh"];
    const enName = params.displayName["en-US"] || params.displayName["en"];
    if (zhName) parts.push(zhName);
    if (enName) parts.push(enName);
  }

  // 描述（中英文）
  if (params.description) {
    const zhDesc = params.description["zh-CN"] || params.description["zh"];
    const enDesc = params.description["en-US"] || params.description["en"];
    if (zhDesc) parts.push(zhDesc);
    if (enDesc) parts.push(enDesc);
  }

  // 输入参数名（帮助区分相似功能）
  if (params.inputSchema?.fields && typeof params.inputSchema.fields === "object") {
    const fieldNames = Object.keys(params.inputSchema.fields);
    parts.push(...fieldNames);
  }

  return parts.join(" ").slice(0, 2000);
}

// ─── 数据库操作 ─────────────────────────────────────────────────────
/**
 * 更新技能语义向量（创建或更新时调用）
 */
export async function upsertSkillSemantic(params: {
  pool: Pool;
  tenantId: string;
  skillName: string;
  displayName?: Record<string, string> | null;
  description?: Record<string, string> | null;
  inputSchema?: any;
  layer?: string;
  enabled?: boolean;
}): Promise<void> {
  const semanticText = buildSkillSemanticText({
    name: params.skillName,
    displayName: params.displayName,
    description: params.description,
    inputSchema: params.inputSchema,
  });
  const semanticMinhash = computeMinhash(semanticText);

  await params.pool.query(
    `
    INSERT INTO skill_semantics (tenant_id, skill_name, display_name, description, semantic_text, semantic_minhash, layer, enabled)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (tenant_id, skill_name) DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, skill_semantics.display_name),
      description = COALESCE(EXCLUDED.description, skill_semantics.description),
      semantic_text = EXCLUDED.semantic_text,
      semantic_minhash = EXCLUDED.semantic_minhash,
      layer = COALESCE(EXCLUDED.layer, skill_semantics.layer),
      enabled = COALESCE(EXCLUDED.enabled, skill_semantics.enabled),
      updated_at = now()
    `,
    [
      params.tenantId,
      params.skillName,
      params.displayName ?? null,
      params.description ?? null,
      semanticText,
      semanticMinhash,
      params.layer ?? "extension",
      params.enabled ?? true,
    ]
  );
}

/**
 * 查找相似技能（用于创建前检测 + 使用时路由）
 */
export async function findSimilarSkills(params: {
  pool: Pool;
  tenantId: string;
  query: string;
  limit?: number;
  minSimilarity?: number;
  onlyEnabled?: boolean;
}): Promise<SimilarSkill[]> {
  const { pool, tenantId, query, limit = 10, minSimilarity = 0.3, onlyEnabled = true } = params;

  const queryMinhash = computeMinhash(query);

  // 查询所有技能的语义向量
  const whereClause = onlyEnabled
    ? "WHERE tenant_id = $1 AND enabled = true"
    : "WHERE tenant_id = $1";

  const res = await pool.query(
    `
    SELECT skill_name, display_name, description, semantic_minhash, layer, enabled
    FROM skill_semantics
    ${whereClause}
    ORDER BY updated_at DESC
    LIMIT 500
    `,
    [tenantId]
  );

  // 计算相似度并排序
  const scored: SimilarSkill[] = [];
  for (const row of res.rows as any[]) {
    const mh = Array.isArray(row.semantic_minhash) ? (row.semantic_minhash as number[]) : [];
    const similarity = minhashOverlapScore(queryMinhash, mh);

    if (similarity >= minSimilarity) {
      scored.push({
        skillName: row.skill_name,
        displayName: row.display_name,
        description: row.description,
        similarity: Math.round(similarity * 100) / 100,
        layer: row.layer,
        enabled: row.enabled,
      });
    }
  }

  // 按相似度降序排列
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

/**
 * 检测是否存在高度相似的技能（创建前防重）
 */
export async function detectDuplicateSkill(params: {
  pool: Pool;
  tenantId: string;
  skillName: string;
  description: string;
  threshold?: number;
}): Promise<{
  hasDuplicate: boolean;
  similar: SimilarSkill[];
  recommendation: "create" | "reuse" | "differentiate";
}> {
  const { pool, tenantId, skillName, description, threshold = 0.75 } = params;

  const query = `${skillName.replace(/\./g, " ")} ${description}`;
  const similar = await findSimilarSkills({
    pool,
    tenantId,
    query,
    limit: 5,
    minSimilarity: 0.5,
    onlyEnabled: false,
  });

  // 过滤掉自己
  const others = similar.filter((s) => s.skillName !== skillName);

  // 判断是否有高度相似的
  const highSimilar = others.filter((s) => s.similarity >= threshold);
  const mediumSimilar = others.filter((s) => s.similarity >= 0.6 && s.similarity < threshold);

  let recommendation: "create" | "reuse" | "differentiate" = "create";
  if (highSimilar.length > 0) {
    recommendation = "reuse"; // 建议复用已有
  } else if (mediumSimilar.length > 0) {
    recommendation = "differentiate"; // 建议差异化命名
  }

  return {
    hasDuplicate: highSimilar.length > 0,
    similar: others.slice(0, 5),
    recommendation,
  };
}

/**
 * 删除技能语义记录
 */
export async function deleteSkillSemantic(params: {
  pool: Pool;
  tenantId: string;
  skillName: string;
}): Promise<void> {
  await params.pool.query(
    "DELETE FROM skill_semantics WHERE tenant_id = $1 AND skill_name = $2",
    [params.tenantId, params.skillName]
  );
}

/**
 * 批量同步内置技能的语义向量（启动时调用）
 */
export async function syncBuiltinSkillSemantics(params: {
  pool: Pool;
  tenantId: string;
  skills: Array<{
    name: string;
    displayName?: Record<string, string> | null;
    description?: Record<string, string> | null;
    inputSchema?: any;
    layer?: string;
  }>;
}): Promise<number> {
  let synced = 0;
  for (const skill of params.skills) {
    await upsertSkillSemantic({
      pool: params.pool,
      tenantId: params.tenantId,
      skillName: skill.name,
      displayName: skill.displayName,
      description: skill.description,
      inputSchema: skill.inputSchema,
      layer: skill.layer ?? "builtin",
      enabled: true,
    });
    synced++;
  }
  return synced;
}
