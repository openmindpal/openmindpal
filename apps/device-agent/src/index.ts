#!/usr/bin/env node
import os from "node:os";
import { parseCli, getStringOpt } from "./cli";
import { defaultConfigPath, loadConfigFile, saveConfigFile } from "./config";
import { apiPostJson } from "./api";
import { runLoop } from "./agent";
import { confirmPrompt } from "./prompt";
import { safeError, safeLog, sha256_8 } from "./log";
import { registerPlugin, loadPluginsFromDir, listPlugins } from "./pluginRegistry";
import desktopPlugin from "./plugins/desktopPlugin";
import guiAutomationPlugin from "./plugins/guiAutomationPlugin";

function resolveApiBase(opts: Record<string, string | boolean>) {
  return getStringOpt(opts, "apiBase") || process.env.API_BASE || "http://localhost:3001";
}

function agentVersion() {
  return process.env.AGENT_VERSION || "1.0.0";
}

function detectOs() {
  return process.env.AGENT_OS || `${os.platform()}-${os.release()}`;
}

function detectDeviceType(opts: Record<string, string | boolean>) {
  const v = getStringOpt(opts, "deviceType");
  return v === "mobile" ? "mobile" : "desktop";
}

async function cmdPair(opts: Record<string, string | boolean>) {
  const pairingCode = getStringOpt(opts, "pairingCode");
  if (!pairingCode) throw new Error("missing_pairingCode");
  const apiBase = resolveApiBase(opts);
  const deviceType = detectDeviceType(opts);
  const osName = detectOs();
  const v = agentVersion();
  const cfgPath = getStringOpt(opts, "config") || defaultConfigPath();

  const r = await apiPostJson<{ deviceId: string; deviceToken: string }>({
    apiBase,
    path: "/device-agent/pair",
    body: { pairingCode, deviceType, os: osName, agentVersion: v },
  });
  if (r.status !== 200) throw new Error(`pair_failed_${r.status}`);
  const deviceId = String((r.json as any).deviceId);
  const deviceToken = String((r.json as any).deviceToken);
  if (!deviceId || !deviceToken) throw new Error("pair_invalid_response");

  await saveConfigFile(cfgPath, { apiBase, deviceId, deviceToken, enrolledAt: new Date().toISOString(), deviceType, os: osName, agentVersion: v });
  safeLog(`paired: deviceId=${deviceId} tokenSha256_8=${sha256_8(deviceToken)} config=${cfgPath}`);
}

async function initPlugins() {
  // 1. 注册内置插件
  registerPlugin(desktopPlugin);
  registerPlugin(guiAutomationPlugin);

  // 2. 从环境变量指定的目录加载外部插件（逗号分隔多个目录）
  const pluginDirs = process.env.DEVICE_AGENT_PLUGIN_DIRS;
  if (pluginDirs) {
    for (const dir of pluginDirs.split(",").map((d) => d.trim()).filter(Boolean)) {
      try {
        const loaded = await loadPluginsFromDir(dir);
        if (loaded.length) safeLog(`plugins_loaded: dir=${dir} plugins=${loaded.join(",")}`);
      } catch (e: any) {
        safeError(`plugin_dir_error: ${dir} - ${e?.message ?? "unknown"}`);
      }
    }
  }

  const all = listPlugins();
  safeLog(`plugins_ready: ${all.map((p) => p.name).join(", ")} (${all.length} 个插件)`);
}

async function cmdRun(opts: Record<string, string | boolean>) {
  const cfgPath = getStringOpt(opts, "config") || defaultConfigPath();
  const cfg = await loadConfigFile(cfgPath);
  if (!cfg) throw new Error("missing_config");
  const heartbeatIntervalMs = Number(getStringOpt(opts, "heartbeatMs") || "30000");
  const pollIntervalMs = Number(getStringOpt(opts, "pollMs") || "5000");
  await runLoop({
    cfg,
    confirmFn: async (q) => confirmPrompt({ question: q, defaultNo: true }),
    heartbeatIntervalMs,
    pollIntervalMs,
  });
}

async function main() {
  // 在执行任何命令前先加载插件
  await initPlugins();

  const { command, options } = parseCli(process.argv);
  try {
    if (command === "pair") await cmdPair(options);
    else if (command === "run") await cmdRun(options);
    else {
      safeLog("openslin-device-agent commands:");
      safeLog("  pair --pairingCode <code> [--apiBase <url>] [--config <path>] [--deviceType desktop|mobile]");
      safeLog("  run [--config <path>] [--heartbeatMs <ms>] [--pollMs <ms>]");
      safeLog("");
      safeLog("外部插件：设置 DEVICE_AGENT_PLUGIN_DIRS 环境变量指向插件目录（逗号分隔多个目录）");
      safeLog(`已加载插件：${listPlugins().map((p) => p.name).join(", ")}`);
    }
  } catch (e: any) {
    safeError(String(e?.message ?? "failed"));
    process.exitCode = 1;
  }
}

main();

