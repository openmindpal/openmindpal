/**
 * Device-Agent Plugin Registry — 设备代理插件注册中心
 *
 * 核心框架不硬编码任何具体设备逻辑，所有场景通过注册插件扩展：
 *   桌面 PC ：device.file.*, device.browser.*, device.desktop.*, device.clipboard.*
 *   工厂    ：device.plc.*, device.scada.*, device.conveyor.*
 *   汽车    ：device.vehicle.*, device.can.*, device.obd.*
 *   智慧园区：device.gate.*, device.light.*, device.camera.*, device.elevator.*
 *   机器人  ：device.robot.*, device.arm.*, device.sensor.*
 *   智能家居：device.home.*, device.appliance.*
 *   城市    ：device.traffic.*, device.environment.*, device.energy.*
 */

// ── 类型定义 ──────────────────────────────────────────────────────

/** 插件执行时收到的上下文 */
export type ToolExecutionContext = {
  cfg: { apiBase: string; deviceToken: string };
  execution: { deviceExecutionId: string; toolRef: string; input?: any };
  toolName: string;
  input: Record<string, any>;
  policy: any;
  requireUserPresence: boolean;
  confirmFn: (q: string) => Promise<boolean>;
};

/** 插件返回的执行结果 */
export type ToolExecutionResult = {
  status: "succeeded" | "failed";
  errorCategory?: string;
  outputDigest?: any;
  evidenceRefs?: string[];
};

/** 设备工具插件接口 */
export interface DeviceToolPlugin {
  /** 插件唯一名称，如 "desktop", "factory.plc", "robot.ros2", "campus.gate" */
  name: string;
  /** 本插件处理的工具名前缀，如 ["device.file", "device.browser"] */
  toolPrefixes: string[];
  /** 插件初始化（连接硬件、加载驱动等），可选 */
  init?(): Promise<void>;
  /** 插件销毁（断开连接、释放资源），可选 */
  dispose?(): Promise<void>;
  /** 执行工具 */
  execute(ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
}

// ── 全局插件注册表 ────────────────────────────────────────────────

const _plugins: Map<string, DeviceToolPlugin> = new Map();

/** 注册插件。重复注册同名插件会抛出异常 */
export function registerPlugin(plugin: DeviceToolPlugin): void {
  if (_plugins.has(plugin.name)) {
    throw new Error(`plugin_already_registered: ${plugin.name}`);
  }
  _plugins.set(plugin.name, plugin);
}

/** 注销插件 */
export function unregisterPlugin(name: string): boolean {
  return _plugins.delete(name);
}

/** 根据工具名查找能处理它的插件（最长前缀匹配） */
export function findPluginForTool(toolName: string): DeviceToolPlugin | null {
  let best: DeviceToolPlugin | null = null;
  let bestLen = 0;
  for (const p of _plugins.values()) {
    for (const prefix of p.toolPrefixes) {
      if (toolName === prefix || toolName.startsWith(prefix + ".")) {
        if (prefix.length > bestLen) {
          best = p;
          bestLen = prefix.length;
        }
      }
    }
  }
  return best;
}

/** 列出所有已注册插件 */
export function listPlugins(): DeviceToolPlugin[] {
  return Array.from(_plugins.values());
}

/** 清空所有插件（仅用于测试） */
export function clearPlugins(): void {
  _plugins.clear();
}

/** 销毁所有已注册插件（调用 dispose），用于优雅关闭。 */
export async function disposeAllPlugins(): Promise<void> {
  const errors: string[] = [];
  for (const p of _plugins.values()) {
    if (typeof p.dispose === "function") {
      try {
        await p.dispose();
      } catch (e: any) {
        errors.push(`${p.name}: ${e?.message ?? "unknown"}`);
      }
    }
  }
  _plugins.clear();
  if (errors.length) {
    process.stderr.write(`plugin_dispose_errors: ${errors.join("; ")}\n`);
  }
}

// ── 外部插件加载 ──────────────────────────────────────────────────

/**
 * 从指定目录加载外部插件。
 * 目录下每个 .js 文件应默认导出一个 DeviceToolPlugin 对象。
 *
 * 示例目录结构：
 *   /opt/device-plugins/
 *     factory-plc-plugin.js    → export default { name: "factory.plc", toolPrefixes: ["device.plc"], execute: ... }
 *     campus-gate-plugin.js   → export default { name: "campus.gate", toolPrefixes: ["device.gate"], execute: ... }
 *     robot-ros2-plugin.js    → export default { name: "robot.ros2", toolPrefixes: ["device.robot"], execute: ... }
 */
export async function loadPluginsFromDir(dirPath: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const nodePath = await import("node:path");
  const loaded: string[] = [];

  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (e: any) {
    throw new Error(`plugin_dir_read_failed: ${dirPath} - ${e?.message ?? "unknown"}`);
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".js")) continue;

    const fullPath = nodePath.join(dirPath, entry.name);
    try {
      const mod = await import(fullPath);
      const plugin: any = mod.default ?? mod;
      if (
        !plugin ||
        typeof plugin !== "object" ||
        !plugin.name ||
        !Array.isArray(plugin.toolPrefixes) ||
        typeof plugin.execute !== "function"
      ) {
        process.stderr.write(`plugin_invalid_export: ${fullPath}（需导出 { name, toolPrefixes, execute }）\n`);
        continue;
      }
      if (typeof plugin.init === "function") await plugin.init();
      registerPlugin(plugin as DeviceToolPlugin);
      loaded.push(plugin.name);
    } catch (e: any) {
      process.stderr.write(`plugin_load_failed: ${fullPath} - ${e?.message ?? "unknown"}\n`);
    }
  }

  return loaded;
}
