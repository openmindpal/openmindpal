/**
 * GUI 自动化插件 — 本地视觉闭环（Local Vision Loop）
 *
 * ============================================================
 * 解决问题：
 *   原链路：截图→上传云端→大模型分析→云端下发坐标→本地执行（每步 2 次跨公网）
 *   新链路：云端一次性下发动作计划→本地闭环执行（仅 2 次跨网通信）
 *
 * 工作原理：
 *   1. 云端编排大脑分析用户意图，生成"动作计划"（PlanStep[]）
 *   2. device-agent 一次性接收整个计划
 *   3. 本地 Vision Loop：截图 → 本地 OCR 定位 → 执行操作 → 验证 → 下一步
 *   4. 全部完成（或失败）后，一次性上报结果
 *
 * 延迟对比（假设 N 个 GUI 步骤）：
 *   原方案：N × 2 × RTT（每步截图+下发 = 2 次跨网）
 *   新方案：2 × RTT（取计划 + 报结果）+ N × 本地耗时（~200ms/步）
 * ============================================================
 *
 * 工具前缀：device.gui
 */
import type { DeviceToolPlugin, ToolExecutionContext, ToolExecutionResult } from "../pluginRegistry";
import { apiPostJson } from "../api";
import {
  captureScreen,
  cleanupCapture,
  ocrScreen,
  findTextInOcrResults,
  clickMouse,
  doubleClick,
  typeText,
  pressKey,
  pressCombo,
  moveMouse,
  scroll,
  type OcrMatch,
  type ScreenCapture,
} from "./localVision";

// ── 动作计划类型 ─────────────────────────────────────────────────

/** 单个计划步骤 */
export type PlanStep =
  | { action: "click";        target: TargetSpec; button?: "left" | "right" }
  | { action: "doubleClick";  target: TargetSpec }
  | { action: "type";         target?: TargetSpec; text: string }
  | { action: "pressKey";     key: string }
  | { action: "pressCombo";   keys: string[] }
  | { action: "scroll";       direction: "up" | "down"; clicks?: number }
  | { action: "moveTo";       target: TargetSpec }
  | { action: "wait";         ms: number }
  | { action: "waitForText";  text: string; timeoutMs?: number }
  | { action: "assertText";   text: string; present?: boolean }
  | { action: "screenshot" };

/** 目标定位方式：文字 / 绝对坐标 / 相对坐标 */
export type TargetSpec =
  | { text: string; index?: number; fuzzy?: boolean }
  | { x: number; y: number }
  | { xPercent: number; yPercent: number };

/** 执行计划时每步的结果 */
type StepResult = {
  step: number;
  action: string;
  status: "ok" | "failed";
  detail?: any;
  durationMs: number;
};

// ── 辅助函数 ────────────────────────────────────────────────────

function isTargetCoord(t: TargetSpec): t is { x: number; y: number } {
  return "x" in t && "y" in t;
}
function isTargetPercent(t: TargetSpec): t is { xPercent: number; yPercent: number } {
  return "xPercent" in t && "yPercent" in t;
}
function isTargetText(t: TargetSpec): t is { text: string; index?: number; fuzzy?: boolean } {
  return "text" in t;
}

/**
 * 解析目标为绝对屏幕坐标。
 * - 绝对坐标 → 直接返回
 * - 百分比坐标 → 按屏幕尺寸换算
 * - 文字 → 本地 OCR 截图后定位（核心闭环）
 */
async function resolveTarget(
  target: TargetSpec,
  ocrCache: { capture: ScreenCapture | null; results: OcrMatch[] | null },
): Promise<{ x: number; y: number } | { error: string }> {
  if (isTargetCoord(target)) return { x: target.x, y: target.y };

  // 需要截图 + OCR
  if (!ocrCache.capture) {
    ocrCache.capture = await captureScreen();
    ocrCache.results = await ocrScreen(ocrCache.capture);
  }

  if (isTargetPercent(target)) {
    return {
      x: Math.round((target.xPercent / 100) * ocrCache.capture.width),
      y: Math.round((target.yPercent / 100) * ocrCache.capture.height),
    };
  }

  if (isTargetText(target)) {
    const match = findTextInOcrResults(ocrCache.results!, target.text, { fuzzy: target.fuzzy });
    if (!match) return { error: `未找到文字: "${target.text}"` };
    return { x: match.x, y: match.y };
  }

  return { error: "无效的目标定位方式" };
}

function hasError(r: { x: number; y: number } | { error: string }): r is { error: string } {
  return "error" in r;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── GUI 步骤间延迟（毫秒），给 UI 渲染留出时间 ───────────────────
const INTER_STEP_DELAY_MS = Number(process.env.DEVICE_AGENT_GUI_STEP_DELAY_MS ?? "200");

// ── 核心：本地视觉闭环执行引擎 ──────────────────────────────────

async function executeStep(
  step: PlanStep,
  ocrCache: { capture: ScreenCapture | null; results: OcrMatch[] | null },
): Promise<{ status: "ok" | "failed"; detail?: any }> {
  switch (step.action) {
    case "click": {
      const pos = await resolveTarget(step.target, ocrCache);
      if (hasError(pos)) return { status: "failed", detail: pos.error };
      await clickMouse(pos.x, pos.y, step.button ?? "left");
      // 点击后界面会变化，清除 OCR 缓存
      if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
      return { status: "ok", detail: { x: pos.x, y: pos.y } };
    }

    case "doubleClick": {
      const pos = await resolveTarget(step.target, ocrCache);
      if (hasError(pos)) return { status: "failed", detail: pos.error };
      await doubleClick(pos.x, pos.y);
      if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
      return { status: "ok", detail: { x: pos.x, y: pos.y } };
    }

    case "type": {
      if (step.target) {
        const pos = await resolveTarget(step.target, ocrCache);
        if (hasError(pos)) return { status: "failed", detail: pos.error };
        await clickMouse(pos.x, pos.y);
        await sleep(100);
      }
      await typeText(step.text);
      if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
      return { status: "ok", detail: { textLen: step.text.length } };
    }

    case "pressKey": {
      await pressKey(step.key);
      if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
      return { status: "ok", detail: { key: step.key } };
    }

    case "pressCombo": {
      await pressCombo(step.keys);
      if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
      return { status: "ok", detail: { keys: step.keys } };
    }

    case "scroll": {
      await scroll(step.direction, step.clicks ?? 3);
      if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
      return { status: "ok" };
    }

    case "moveTo": {
      const pos = await resolveTarget(step.target, ocrCache);
      if (hasError(pos)) return { status: "failed", detail: pos.error };
      await moveMouse(pos.x, pos.y);
      return { status: "ok", detail: { x: pos.x, y: pos.y } };
    }

    case "wait": {
      await sleep(step.ms);
      return { status: "ok" };
    }

    case "waitForText": {
      const timeout = step.timeoutMs ?? 10_000;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
        ocrCache.capture = await captureScreen();
        ocrCache.results = await ocrScreen(ocrCache.capture);
        const found = findTextInOcrResults(ocrCache.results, step.text, { fuzzy: true });
        if (found) return { status: "ok", detail: { text: step.text, foundAt: { x: found.x, y: found.y } } };
        await sleep(500);
      }
      return { status: "failed", detail: `等待文字 "${step.text}" 超时 (${timeout}ms)` };
    }

    case "assertText": {
      if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
      ocrCache.capture = await captureScreen();
      ocrCache.results = await ocrScreen(ocrCache.capture);
      const found = findTextInOcrResults(ocrCache.results, step.text, { fuzzy: true });
      const present = step.present !== false;
      if (present && !found) return { status: "failed", detail: `断言失败: 未找到 "${step.text}"` };
      if (!present && found) return { status: "failed", detail: `断言失败: 不应出现 "${step.text}"` };
      return { status: "ok" };
    }

    case "screenshot": {
      if (ocrCache.capture) { await cleanupCapture(ocrCache.capture); ocrCache.capture = null; ocrCache.results = null; }
      ocrCache.capture = await captureScreen();
      ocrCache.results = null;
      return { status: "ok", detail: { filePath: ocrCache.capture.filePath } };
    }

    default:
      return { status: "failed", detail: `未知动作: ${(step as any).action}` };
  }
}

// ── 工具处理函数 ─────────────────────────────────────────────────

/**
 * device.gui.runPlan — 批量执行 GUI 动作计划（核心工具）
 *
 * 云端一次性下发完整计划，本地闭环执行，大幅降低延迟。
 * input.plan: PlanStep[]
 * input.stopOnError: boolean（默认 true）
 * input.screenshotOnError: boolean（默认 true，失败时截图上传作为证据）
 */
async function execRunPlan(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const plan: PlanStep[] = Array.isArray(ctx.input.plan) ? ctx.input.plan : [];
  if (!plan.length) return { status: "failed", errorCategory: "input_invalid", outputDigest: { reason: "空的动作计划" } };

  const stopOnError = ctx.input.stopOnError !== false;
  const screenshotOnError = ctx.input.screenshotOnError !== false;
  const maxSteps = Math.min(plan.length, 100); // 安全上限

  const stepResults: StepResult[] = [];
  const ocrCache: { capture: ScreenCapture | null; results: OcrMatch[] | null } = { capture: null, results: null };

  let allOk = true;

  try {
    for (let i = 0; i < maxSteps; i++) {
      const t0 = Date.now();
      const result = await executeStep(plan[i], ocrCache);
      const durationMs = Date.now() - t0;

      stepResults.push({
        step: i,
        action: plan[i].action,
        status: result.status,
        detail: result.detail,
        durationMs,
      });

      if (result.status === "failed") {
        allOk = false;
        if (stopOnError) {
          // 失败时截图上传证据
          if (screenshotOnError) {
            try {
              const errCapture = await captureScreen();
              const buf = await import("node:fs/promises").then((f) => f.readFile(errCapture.filePath));
              const base64 = buf.toString("base64");
              await apiPostJson({
                apiBase: ctx.cfg.apiBase,
                path: "/device-agent/evidence/upload",
                token: ctx.cfg.deviceToken,
                body: {
                  deviceExecutionId: ctx.execution.deviceExecutionId,
                  contentBase64: base64,
                  contentType: "image/png",
                  format: "png",
                  label: `gui_error_step_${i}`,
                },
              });
              await cleanupCapture(errCapture);
            } catch { /* 证据上传失败不影响主流程 */ }
          }
          break;
        }
      }

      // 步骤间延迟，给 UI 渲染留出时间
      if (i < maxSteps - 1 && plan[i].action !== "wait") {
        await sleep(INTER_STEP_DELAY_MS);
      }
    }
  } finally {
    if (ocrCache.capture) await cleanupCapture(ocrCache.capture);
  }

  const completedSteps = stepResults.length;
  const failedSteps = stepResults.filter((s) => s.status === "failed").length;
  const totalDurationMs = stepResults.reduce((s, r) => s + r.durationMs, 0);

  return {
    status: allOk ? "succeeded" : "failed",
    errorCategory: allOk ? undefined : "gui_step_failed",
    outputDigest: {
      totalSteps: plan.length,
      completedSteps,
      failedSteps,
      totalDurationMs,
      steps: stepResults,
    },
  };
}

/**
 * device.gui.findAndClick — 截图 + 本地 OCR 找到文字 + 点击
 * 单步快捷操作，等价于 runPlan([{ action: "click", target: { text } }])
 */
async function execFindAndClick(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const text = String(ctx.input.text ?? "");
  if (!text) return { status: "failed", errorCategory: "input_invalid", outputDigest: { reason: "缺少 text 参数" } };

  const capture = await captureScreen();
  try {
    const results = await ocrScreen(capture);
    const match = findTextInOcrResults(results, text, { fuzzy: true });
    if (!match) return { status: "failed", errorCategory: "element_not_found", outputDigest: { text, ocrCount: results.length } };
    await clickMouse(match.x, match.y, ctx.input.button ?? "left");
    return { status: "succeeded", outputDigest: { text, x: match.x, y: match.y, confidence: match.confidence } };
  } finally {
    await cleanupCapture(capture);
  }
}

/**
 * device.gui.findAndType — 找到目标元素 + 点击 + 输入文字
 */
async function execFindAndType(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const target = String(ctx.input.target ?? "");
  const text = String(ctx.input.text ?? "");
  if (!text) return { status: "failed", errorCategory: "input_invalid", outputDigest: { reason: "缺少 text 参数" } };

  const capture = await captureScreen();
  try {
    if (target) {
      const results = await ocrScreen(capture);
      const match = findTextInOcrResults(results, target, { fuzzy: true });
      if (!match) return { status: "failed", errorCategory: "element_not_found", outputDigest: { target, ocrCount: results.length } };
      await clickMouse(match.x, match.y);
      await sleep(100);
    }
    await typeText(text);
    return { status: "succeeded", outputDigest: { target, textLen: text.length } };
  } finally {
    await cleanupCapture(capture);
  }
}

/**
 * device.gui.readScreen — 截图 + 本地 OCR 返回屏幕所有文字
 * 用于云端大模型"看一眼"当前屏幕内容，但 OCR 在本地完成、只回传文字摘要
 */
async function execReadScreen(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const capture = await captureScreen();
  try {
    const results = await ocrScreen(capture);
    // 只返回文字和位置，不传图片，带宽极低
    const texts = results.map((r) => ({
      text: r.text,
      x: r.bbox.x,
      y: r.bbox.y,
      w: r.bbox.w,
      h: r.bbox.h,
    }));
    return {
      status: "succeeded",
      outputDigest: {
        screenWidth: capture.width,
        screenHeight: capture.height,
        ocrItemCount: texts.length,
        items: texts.slice(0, 500), // 最多 500 个元素
      },
    };
  } finally {
    await cleanupCapture(capture);
  }
}

/**
 * device.gui.screenshot — 截图并上传（保留，用于云端需要看原图的场景）
 */
async function execScreenshot(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const capture = await captureScreen();
  try {
    const buf = await import("node:fs/promises").then((f) => f.readFile(capture.filePath));
    const base64 = buf.toString("base64");
    const up = await apiPostJson<{ artifactId: string; evidenceRef: string }>({
      apiBase: ctx.cfg.apiBase,
      path: "/device-agent/evidence/upload",
      token: ctx.cfg.deviceToken,
      body: { deviceExecutionId: ctx.execution.deviceExecutionId, contentBase64: base64, contentType: "image/png", format: "png" },
    });
    if (up.status !== 200) return { status: "failed", errorCategory: "upstream_error", outputDigest: { status: up.status } };
    return { status: "succeeded", outputDigest: { ok: true, artifactId: up.json?.artifactId ?? null }, evidenceRefs: up.json?.evidenceRef ? [up.json.evidenceRef] : [] };
  } finally {
    await cleanupCapture(capture);
  }
}

// ── 工具路由表 ───────────────────────────────────────────────────

const TOOL_HANDLERS: Record<string, (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>> = {
  "device.gui.runPlan":      execRunPlan,
  "device.gui.findAndClick": execFindAndClick,
  "device.gui.findAndType":  execFindAndType,
  "device.gui.readScreen":   execReadScreen,
  "device.gui.screenshot":   execScreenshot,
};

// ── 导出插件 ────────────────────────────────────────────────────

const guiAutomationPlugin: DeviceToolPlugin = {
  name: "gui-automation",
  toolPrefixes: ["device.gui"],

  async execute(ctx) {
    const handler = TOOL_HANDLERS[ctx.toolName];
    if (!handler) {
      return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolName: ctx.toolName, plugin: "gui-automation" } };
    }
    return handler(ctx);
  },
};

export default guiAutomationPlugin;
