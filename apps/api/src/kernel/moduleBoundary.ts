/**
 * moduleBoundary.ts — 模块边界检查规则
 *
 * 强制的导入边界约束：
 *   1. kernel/ 不得 import skills/ 下的任何模块
 *   2. skills/ 只能 import kernel/ 和 modules/ (不能 import 其他 skills/)
 *   3. routes/ 只能 import modules/ 和 kernel/（通过 skills 的 routes export）
 *   4. packages/shared/ 不得 import apps/ 下任何模块
 *
 * 目标目录结构:
 *   apps/api/src/
 *   ├── kernel/           — 执行内核 + 规划内核 + 状态机 + 不变式
 *   │   ├── executionKernel.ts
 *   │   ├── planningKernel.ts
 *   │   ├── stateMachine.ts (re-export from shared)
 *   │   └── invariants.ts
 *   ├── modules/          — 业务模块（auth, governance, tools, audit 等）
 *   ├── skills/           — 能力插件（builtin + extension）
 *   │   ├── registry.ts   — 能力注册表
 *   │   └── [skill-name]/ — 各能力实现
 *   ├── routes/           — HTTP 路由层
 *   └── lib/              — 共享工具函数
 *
 *   packages/shared/src/  — API/Worker 共享类型和函数
 *   apps/worker/src/      — Worker 进程（workflow processor）
 */

// ---------------------------------------------------------------------------
// Boundary rules
// ---------------------------------------------------------------------------

export interface BoundaryRule {
  /** 规则名称 */
  name: string;
  /** 源模块 glob 模式 */
  source: string;
  /** 禁止导入的目标模式 */
  forbidden: string[];
  /** 允许的例外 */
  exceptions?: string[];
  /** 严重级别 */
  severity: "error" | "warn";
}

export const MODULE_BOUNDARY_RULES: BoundaryRule[] = [
  {
    name: "kernel-no-import-skills",
    source: "apps/api/src/kernel/**",
    forbidden: ["../skills/**", "../../skills/**"],
    severity: "error",
  },
  {
    name: "kernel-no-import-routes",
    source: "apps/api/src/kernel/**",
    forbidden: ["../routes/**", "../../routes/**"],
    severity: "error",
  },
  {
    name: "shared-no-import-apps",
    source: "packages/shared/src/**",
    forbidden: ["../../../apps/**", "../../apps/**"],
    severity: "error",
  },
  {
    name: "skills-no-cross-import",
    source: "apps/api/src/skills/*/modules/**",
    forbidden: ["../../*/modules/**"],
    exceptions: ["../modules/**"], // 自身 modules 下可互相引用
    severity: "warn",
  },
];

// ---------------------------------------------------------------------------
// Violation detection (static analysis helper)
// ---------------------------------------------------------------------------

export interface BoundaryViolation {
  rule: string;
  file: string;
  importPath: string;
  severity: "error" | "warn";
}

/**
 * 检查单个文件的 import 语句是否违反边界规则。
 * 用于 CI lint 或启动时自检。
 *
 * @param filePath   相对于 workspace root 的文件路径
 * @param imports    该文件中所有 import from 的路径列表
 */
export function checkBoundaryViolations(
  filePath: string,
  imports: string[],
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];

  for (const rule of MODULE_BOUNDARY_RULES) {
    if (!matchGlob(filePath, rule.source)) continue;

    for (const imp of imports) {
      const isForbidden = rule.forbidden.some((pattern) => matchImportPattern(imp, pattern));
      const isException = rule.exceptions?.some((pattern) => matchImportPattern(imp, pattern)) ?? false;
      if (isForbidden && !isException) {
        violations.push({
          rule: rule.name,
          file: filePath,
          importPath: imp,
          severity: rule.severity,
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Simple glob/pattern matchers (no external deps)
// ---------------------------------------------------------------------------

/** 简化的 glob 匹配（支持 ** 和 *） */
function matchGlob(path: string, pattern: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const regex = pattern
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*");
  return new RegExp(`^${regex}$`).test(normalized);
}

/** 检查 import 路径是否匹配禁止模式 */
function matchImportPattern(importPath: string, pattern: string): boolean {
  // 简化：检查 import 路径是否包含模式的关键部分
  const patternParts = pattern.replace(/\.\.\//g, "").replace(/\*\*/g, "").replace(/\*/g, "");
  const normalizedImport = importPath.replace(/\\/g, "/");
  if (patternParts && normalizedImport.includes(patternParts.replace(/\//g, "/"))) return true;
  // 精确 glob 匹配
  return matchGlob(normalizedImport, pattern);
}
