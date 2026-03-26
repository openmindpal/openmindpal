/**
 * Skill Semantic Router
 *
 * 技能语义路由器：
 * - 使用时：根据用户意图精准选择技能
 * - 创建时：检测相似技能防止重复
 * - 歧义时：展示差异让用户选择
 */
import type { Pool } from "pg";
import {
  findSimilarSkills,
  detectDuplicateSkill,
  computeMinhash,
  minhashOverlapScore,
  type SimilarSkill,
} from "./skillSemanticRepo";

// ─── Types ───────────────────────────────────────────────────────────
export interface RouteResult {
  /** 是否成功路由到单一技能 */
  resolved: boolean;
  /** 最佳匹配的技能（resolved=true时有值） */
  bestMatch: SimilarSkill | null;
  /** 置信度（0-1） */
  confidence: number;
  /** 是否存在歧义（多个高相似技能） */
  ambiguous: boolean;
  /** 候选技能列表（歧义时展示） */
  candidates: SimilarSkill[];
  /** 路由建议 */
  suggestion: RouteSuggestion;
}

export type RouteSuggestion =
  | { type: "use"; skillName: string; reason: string }
  | { type: "choose"; options: Array<{ skillName: string; description: string }> }
  | { type: "create"; reason: string }
  | { type: "none"; reason: string };

export interface DuplicateCheckResult {
  /** 是否建议创建 */
  shouldCreate: boolean;
  /** 相似技能列表 */
  similar: SimilarSkill[];
  /** 建议动作 */
  recommendation: "create" | "reuse" | "differentiate";
  /** 提示消息 */
  message: Record<string, string>;
}

// ─── 阈值配置 ─────────────────────────────────────────────────────────
const THRESHOLD = {
  /** 高置信度：直接使用 */
  HIGH_CONFIDENCE: 0.85,
  /** 中置信度：可能有歧义 */
  MEDIUM_CONFIDENCE: 0.65,
  /** 低置信度：无匹配 */
  LOW_CONFIDENCE: 0.4,
  /** 歧义判定：多个技能相似度差距小于此值 */
  AMBIGUITY_GAP: 0.15,
  /** 重复判定：相似度高于此值认为重复 */
  DUPLICATE: 0.75,
};

// ─── 使用时路由 ─────────────────────────────────────────────────────
/**
 * 根据用户意图路由到最合适的技能
 *
 * @param params.intent 用户意图文本（如"查天气"）
 * @returns 路由结果
 */
export async function routeByIntent(params: {
  pool: Pool;
  tenantId: string;
  intent: string;
}): Promise<RouteResult> {
  const { pool, tenantId, intent } = params;

  // 查找相似技能
  const similar = await findSimilarSkills({
    pool,
    tenantId,
    query: intent,
    limit: 10,
    minSimilarity: THRESHOLD.LOW_CONFIDENCE,
    onlyEnabled: true,
  });

  // 无匹配
  if (similar.length === 0) {
    return {
      resolved: false,
      bestMatch: null,
      confidence: 0,
      ambiguous: false,
      candidates: [],
      suggestion: { type: "none", reason: "未找到匹配的技能" },
    };
  }

  const best = similar[0]!;
  const second = similar[1];

  // 高置信度：直接使用
  if (best.similarity >= THRESHOLD.HIGH_CONFIDENCE) {
    return {
      resolved: true,
      bestMatch: best,
      confidence: best.similarity,
      ambiguous: false,
      candidates: similar,
      suggestion: {
        type: "use",
        skillName: best.skillName,
        reason: `高度匹配（${Math.round(best.similarity * 100)}%）`,
      },
    };
  }

  // 检查歧义：多个技能相似度接近
  const hasAmbiguity =
    second &&
    best.similarity >= THRESHOLD.MEDIUM_CONFIDENCE &&
    best.similarity - second.similarity < THRESHOLD.AMBIGUITY_GAP;

  if (hasAmbiguity) {
    // 找出所有接近最高分的技能
    const ambiguousCandidates = similar.filter(
      (s) => best.similarity - s.similarity < THRESHOLD.AMBIGUITY_GAP
    );

    return {
      resolved: false,
      bestMatch: best,
      confidence: best.similarity,
      ambiguous: true,
      candidates: ambiguousCandidates,
      suggestion: {
        type: "choose",
        options: ambiguousCandidates.map((s) => ({
          skillName: s.skillName,
          description: getDescriptionText(s.description) || s.skillName,
        })),
      },
    };
  }

  // 中等置信度：使用最佳匹配但标记不确定
  if (best.similarity >= THRESHOLD.MEDIUM_CONFIDENCE) {
    return {
      resolved: true,
      bestMatch: best,
      confidence: best.similarity,
      ambiguous: false,
      candidates: similar,
      suggestion: {
        type: "use",
        skillName: best.skillName,
        reason: `最佳匹配（${Math.round(best.similarity * 100)}%）`,
      },
    };
  }

  // 低置信度：无明确匹配
  return {
    resolved: false,
    bestMatch: best,
    confidence: best.similarity,
    ambiguous: false,
    candidates: similar,
    suggestion: {
      type: "none",
      reason: `未找到高度匹配的技能，最相似的是 ${best.skillName}（${Math.round(best.similarity * 100)}%）`,
    },
  };
}

// ─── 创建时检测重复 ─────────────────────────────────────────────────
/**
 * 创建技能前检测是否存在相似技能
 *
 * @param params.skillName 新技能名称
 * @param params.description 新技能描述
 * @returns 重复检测结果
 */
export async function checkBeforeCreate(params: {
  pool: Pool;
  tenantId: string;
  skillName: string;
  description: string;
}): Promise<DuplicateCheckResult> {
  const { pool, tenantId, skillName, description } = params;

  const result = await detectDuplicateSkill({
    pool,
    tenantId,
    skillName,
    description,
    threshold: THRESHOLD.DUPLICATE,
  });

  // 构建提示消息
  let message: Record<string, string>;
  switch (result.recommendation) {
    case "reuse":
      const top = result.similar[0];
      message = {
        "zh-CN": `检测到高度相似的技能：${top?.skillName}（相似度${Math.round((top?.similarity ?? 0) * 100)}%）。建议直接使用已有技能，或修改后再创建。`,
        "en-US": `Found highly similar skill: ${top?.skillName} (${Math.round((top?.similarity ?? 0) * 100)}% similar). Recommend using existing skill or modify before creating.`,
      };
      break;
    case "differentiate":
      message = {
        "zh-CN": `检测到${result.similar.length}个相似技能。如确需创建，请确保功能有明显差异。`,
        "en-US": `Found ${result.similar.length} similar skills. If you must create, please ensure distinct functionality.`,
      };
      break;
    default:
      message = {
        "zh-CN": "未检测到重复技能，可以创建。",
        "en-US": "No duplicate detected, you can create.",
      };
  }

  return {
    shouldCreate: result.recommendation === "create",
    similar: result.similar,
    recommendation: result.recommendation,
    message,
  };
}

// ─── 歧义消解 ─────────────────────────────────────────────────────────
/**
 * 生成歧义消解提示（用于对话展示）
 */
export function formatAmbiguityPrompt(candidates: SimilarSkill[], locale: string = "zh-CN"): string {
  const isZh = locale.startsWith("zh");

  if (isZh) {
    const lines = ["找到多个相似技能，请选择："];
    candidates.forEach((c, i) => {
      const desc = getDescriptionText(c.description, "zh-CN") || c.skillName;
      lines.push(`${i + 1}. ${c.skillName} - ${desc}（相似度${Math.round(c.similarity * 100)}%）`);
    });
    return lines.join("\n");
  } else {
    const lines = ["Found multiple similar skills, please choose:"];
    candidates.forEach((c, i) => {
      const desc = getDescriptionText(c.description, "en-US") || c.skillName;
      lines.push(`${i + 1}. ${c.skillName} - ${desc} (${Math.round(c.similarity * 100)}% similar)`);
    });
    return lines.join("\n");
  }
}

/**
 * 生成重复提示（用于创建时展示）
 */
export function formatDuplicatePrompt(result: DuplicateCheckResult, locale: string = "zh-CN"): string {
  const isZh = locale.startsWith("zh");

  if (result.shouldCreate) {
    return isZh ? "可以创建新技能。" : "You can create a new skill.";
  }

  if (result.recommendation === "reuse") {
    const top = result.similar[0];
    if (!top) return result.message[locale] || result.message["zh-CN"] || "";

    if (isZh) {
      return `建议使用已有技能：${top.skillName}\n描述：${getDescriptionText(top.description, "zh-CN") || "无"}\n相似度：${Math.round(top.similarity * 100)}%`;
    } else {
      return `Recommend using existing skill: ${top.skillName}\nDescription: ${getDescriptionText(top.description, "en-US") || "N/A"}\nSimilarity: ${Math.round(top.similarity * 100)}%`;
    }
  }

  // differentiate
  if (isZh) {
    const names = result.similar.slice(0, 3).map((s) => s.skillName).join("、");
    return `检测到相似技能：${names}\n如确需创建，请确保功能有明显差异。`;
  } else {
    const names = result.similar.slice(0, 3).map((s) => s.skillName).join(", ");
    return `Found similar skills: ${names}\nIf you must create, please ensure distinct functionality.`;
  }
}

// ─── Helper ─────────────────────────────────────────────────────────
function getDescriptionText(
  desc: Record<string, string> | null | undefined,
  locale?: string
): string | null {
  if (!desc) return null;
  if (locale) {
    return desc[locale] || desc["zh-CN"] || desc["en-US"] || Object.values(desc)[0] || null;
  }
  return desc["zh-CN"] || desc["en-US"] || Object.values(desc)[0] || null;
}
