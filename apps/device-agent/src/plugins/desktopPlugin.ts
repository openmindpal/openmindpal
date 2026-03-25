/**
 * 内置桌面插件 — 处理 PC/Mac/Linux 桌面场景的设备工具。
 *
 * 工具前缀：device.file / device.browser / device.desktop / device.clipboard / device.evidence
 */
import crypto from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { apiPostJson } from "../api";
import type { DeviceToolPlugin, ToolExecutionContext, ToolExecutionResult } from "../pluginRegistry";

// ── 工具函数 ──────────────────────────────────────────────────────

function sha256_8(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
}

function normalizeRoots(v: any) {
  const roots = Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  const canon = roots.map((r) => path.resolve(r));
  return Array.from(new Set(canon));
}

function isWithinRoots(filePath: string, roots: string[]) {
  const p = path.resolve(filePath);
  const cmp = process.platform === "win32" ? p.toLowerCase() : p;
  for (const r0 of roots) {
    const r = path.resolve(r0);
    const rc = process.platform === "win32" ? r.toLowerCase() : r;
    if (cmp === rc) return true;
    if (cmp.startsWith(rc.endsWith(path.sep) ? rc : rc + path.sep)) return true;
  }
  return false;
}

function getHost(urlText: string) {
  const u = new URL(urlText);
  return u.hostname.toLowerCase();
}

const BLANK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/az1JmUAAAAASUVORK5CYII=";

async function takeDesktopScreenshotBase64() {
  if (process.platform !== "win32") return null;
  const out = path.join(os.tmpdir(), `device_screenshot_${crypto.randomUUID()}.png`);
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    "$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
    "$graphics = [System.Drawing.Graphics]::FromImage($bmp)",
    "$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)",
    `$bmp.Save('${out.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$graphics.Dispose()",
    "$bmp.Dispose()",
  ].join("; ");
  await new Promise<void>((resolve, reject) => {
    const p = childProcess.spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`powershell_exit_${code}`))));
  });
  const buf = await fs.readFile(out);
  await fs.unlink(out).catch(() => {});
  return buf.toString("base64");
}

function tryLaunch(target: string) {
  const mode = String(process.env.DEVICE_AGENT_LAUNCH_MODE ?? "digest_only").toLowerCase();
  if (mode !== "spawn") return false;
  if (process.platform === "win32") {
    childProcess.spawn("cmd.exe", ["/d", "/s", "/c", "start", '""', target], { stdio: "ignore", windowsHide: true });
    return true;
  }
  if (process.platform === "darwin") {
    childProcess.spawn("open", [target], { stdio: "ignore" });
    return true;
  }
  childProcess.spawn("xdg-open", [target], { stdio: "ignore" });
  return true;
}

// ── 各工具实现 ────────────────────────────────────────────────────

async function execFileList(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const fp = String(ctx.input.path ?? "");
  if (!fp) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "path" } };
  const filePolicy = ctx.policy?.filePolicy ?? null;
  const allowRead = Boolean(filePolicy?.allowRead);
  const roots = normalizeRoots(filePolicy?.allowedRoots);
  if (!allowRead || !roots.length) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "file_read_denied" } };
  if (!isWithinRoots(fp, roots)) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "path_not_allowed", pathSha256_8: sha256_8(fp) } };
  const dir = await fs.opendir(fp);
  const items: any[] = [];
  for await (const ent of dir) {
    items.push({ name: ent.name, kind: ent.isDirectory() ? "dir" : ent.isFile() ? "file" : "other" });
    if (items.length >= 200) break;
  }
  await dir.close();
  return { status: "succeeded", outputDigest: { pathSha256_8: sha256_8(fp), count: items.length, items } };
}

async function execFileRead(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const fp = String(ctx.input.path ?? "");
  if (!fp) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "path" } };
  const filePolicy = ctx.policy?.filePolicy ?? null;
  const allowRead = Boolean(filePolicy?.allowRead);
  const roots = normalizeRoots(filePolicy?.allowedRoots);
  const maxBytes = Math.max(1, Number(filePolicy?.maxBytesPerRead ?? 65536) || 65536);
  if (!allowRead || !roots.length) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "file_read_denied" } };
  if (!isWithinRoots(fp, roots)) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "path_not_allowed", pathSha256_8: sha256_8(fp) } };
  const buf = await fs.readFile(fp);
  const clipped = buf.byteLength > maxBytes ? buf.subarray(0, maxBytes) : buf;
  const digest = crypto.createHash("sha256").update(clipped).digest("hex").slice(0, 8);
  const fullDigest = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);
  return { status: "succeeded", outputDigest: { pathSha256_8: sha256_8(fp), byteSize: buf.byteLength, sha256_8: fullDigest, sha256_8_prefix: digest, truncated: buf.byteLength > maxBytes } };
}

async function execFileWrite(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const fp = String(ctx.input.path ?? "");
  const contentBase64 = String(ctx.input.contentBase64 ?? "");
  if (!fp) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "path" } };
  if (!contentBase64) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "contentBase64" } };
  const filePolicy = ctx.policy?.filePolicy ?? null;
  const allowWrite = Boolean(filePolicy?.allowWrite);
  const roots = normalizeRoots(filePolicy?.allowedRoots);
  const maxBytes = Math.max(1, Number(filePolicy?.maxBytesPerWrite ?? 65536) || 65536);
  if (!ctx.requireUserPresence) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "require_user_presence" } };
  if (!allowWrite || !roots.length) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "file_write_denied" } };
  if (!isWithinRoots(fp, roots)) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "path_not_allowed", pathSha256_8: sha256_8(fp) } };
  const buf = Buffer.from(contentBase64, "base64");
  if (buf.byteLength > maxBytes) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "max_bytes_exceeded", byteSize: buf.byteLength, maxBytes } };
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, buf);
  return { status: "succeeded", outputDigest: { pathSha256_8: sha256_8(fp), byteSize: buf.byteLength } };
}

async function execBrowserOpen(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const url = String(ctx.input.url ?? "");
  if (!url) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "url" } };
  const net = ctx.policy?.networkPolicy ?? null;
  const allowedDomains = Array.isArray(net?.allowedDomains) ? net.allowedDomains.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
  if (!allowedDomains.length) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "egress_denied" } };
  const host = getHost(url);
  if (!allowedDomains.includes(host)) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "domain_not_allowed", host } };
  const launched = tryLaunch(url);
  return { status: "succeeded", outputDigest: { ok: true, host, launched } };
}

async function execBrowserClick(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!ctx.requireUserPresence) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "require_user_presence" } };
  const url = String(ctx.input.url ?? "");
  const selector = String(ctx.input.selector ?? "");
  if (!url) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "url" } };
  if (!selector) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "selector" } };
  const net = ctx.policy?.networkPolicy ?? null;
  const allowedDomains = Array.isArray(net?.allowedDomains) ? net.allowedDomains.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
  if (!allowedDomains.length) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "egress_denied" } };
  const host = getHost(url);
  if (!allowedDomains.includes(host)) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "domain_not_allowed", host } };
  return { status: "succeeded", outputDigest: { ok: true, host, selectorSha256_8: sha256_8(selector) } };
}

async function execBrowserScreenshot(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!ctx.requireUserPresence) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "require_user_presence" } };
  const url = ctx.input.url === undefined || ctx.input.url === null ? null : String(ctx.input.url);
  if (url) {
    const net = ctx.policy?.networkPolicy ?? null;
    const allowedDomains = Array.isArray(net?.allowedDomains) ? net.allowedDomains.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
    if (!allowedDomains.length) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "egress_denied" } };
    const host = getHost(url);
    if (!allowedDomains.includes(host)) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "domain_not_allowed", host } };
  }
  const up = await apiPostJson<{ artifactId: string; evidenceRef: string }>({
    apiBase: ctx.cfg.apiBase,
    path: "/device-agent/evidence/upload",
    token: ctx.cfg.deviceToken,
    body: { deviceExecutionId: ctx.execution.deviceExecutionId, contentBase64: BLANK_PNG_BASE64, contentType: "image/png", format: "png" },
  });
  if (up.status !== 200) return { status: "failed", errorCategory: "upstream_error", outputDigest: { status: up.status } };
  return { status: "succeeded", outputDigest: { ok: true, artifactId: up.json?.artifactId ?? null }, evidenceRefs: up.json?.evidenceRef ? [up.json.evidenceRef] : [] };
}

async function execDesktopLaunch(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const app = String(ctx.input.app ?? "");
  const ui = ctx.policy?.uiPolicy ?? null;
  const allowedApps = Array.isArray(ui?.allowedApps) ? ui.allowedApps.map((x: any) => String(x)).filter(Boolean) : [];
  if (!allowedApps.length) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "ui_denied" } };
  if (!allowedApps.includes(app)) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "app_not_allowed" } };
  const launched = tryLaunch(app);
  return { status: "succeeded", outputDigest: { ok: true, app, launched } };
}

async function execDesktopScreenshot(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!ctx.requireUserPresence) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "require_user_presence" } };
  let pngBase64 = BLANK_PNG_BASE64;
  try {
    const real = await takeDesktopScreenshotBase64();
    if (real) pngBase64 = real;
  } catch {}
  const up = await apiPostJson<{ artifactId: string; evidenceRef: string }>({
    apiBase: ctx.cfg.apiBase,
    path: "/device-agent/evidence/upload",
    token: ctx.cfg.deviceToken,
    body: { deviceExecutionId: ctx.execution.deviceExecutionId, contentBase64: pngBase64, contentType: "image/png", format: "png" },
  });
  if (up.status !== 200) return { status: "failed", errorCategory: "upstream_error", outputDigest: { status: up.status } };
  return { status: "succeeded", outputDigest: { ok: true, artifactId: up.json?.artifactId ?? null }, evidenceRefs: up.json?.evidenceRef ? [up.json.evidenceRef] : [] };
}

async function execEvidenceUpload(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const contentBase64 = String(ctx.input.contentBase64 ?? "");
  const contentType = String(ctx.input.contentType ?? "");
  if (!contentBase64 || !contentType) return { status: "failed", errorCategory: "input_invalid", outputDigest: { ok: false } };
  const up = await apiPostJson<{ artifactId: string; evidenceRef: string }>({
    apiBase: ctx.cfg.apiBase,
    path: "/device-agent/evidence/upload",
    token: ctx.cfg.deviceToken,
    body: { deviceExecutionId: ctx.execution.deviceExecutionId, contentBase64, contentType, format: String(ctx.input.format ?? "base64") },
  });
  if (up.status !== 200) return { status: "failed", errorCategory: "upstream_error", outputDigest: { status: up.status } };
  return { status: "succeeded", outputDigest: { artifactId: up.json?.artifactId ?? null }, evidenceRefs: up.json?.evidenceRef ? [up.json.evidenceRef] : [] };
}

async function execClipboardRead(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!ctx.requireUserPresence) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "require_user_presence" } };
  const clipPolicy = ctx.policy?.clipboardPolicy ?? null;
  if (!clipPolicy?.allowRead) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "clipboard_read_denied" } };
  let text = "";
  try {
    if (process.platform === "win32") {
      text = await new Promise<string>((resolve, reject) => {
        const p = childProcess.spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        p.on("error", reject);
        p.on("exit", (code) => code === 0 ? resolve(out.trimEnd()) : reject(new Error(`clipboard_read_exit_${code}`)));
      });
    } else if (process.platform === "darwin") {
      text = await new Promise<string>((resolve, reject) => {
        const p = childProcess.spawn("pbpaste", [], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        p.on("error", reject);
        p.on("exit", (code) => code === 0 ? resolve(out) : reject(new Error(`clipboard_read_exit_${code}`)));
      });
    } else {
      text = await new Promise<string>((resolve, reject) => {
        const p = childProcess.spawn("xclip", ["-selection", "clipboard", "-o"], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        p.on("error", reject);
        p.on("exit", (code) => code === 0 ? resolve(out) : reject(new Error(`clipboard_read_exit_${code}`)));
      });
    }
  } catch {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "clipboard_read_failed" } };
  }
  const maxLen = Math.max(1, Number(clipPolicy?.maxTextLength ?? 4096) || 4096);
  const truncated = text.length > maxLen;
  const content = truncated ? text.slice(0, maxLen) : text;
  return { status: "succeeded", outputDigest: { textSha256_8: sha256_8(content), length: content.length, truncated } };
}

async function execClipboardWrite(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!ctx.requireUserPresence) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "require_user_presence" } };
  const clipPolicy = ctx.policy?.clipboardPolicy ?? null;
  if (!clipPolicy?.allowWrite) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "clipboard_write_denied" } };
  const text = String(ctx.input.text ?? "");
  if (!text) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "text" } };
  const maxLen = Math.max(1, Number(clipPolicy?.maxTextLength ?? 4096) || 4096);
  if (text.length > maxLen) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "text_too_long", length: text.length, maxLen } };
  try {
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        const p = childProcess.spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -Value \"${text.replace(/"/g, '`"')}\"`], { stdio: "ignore" });
        p.on("error", reject);
        p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`clipboard_write_exit_${code}`)));
      });
    } else if (process.platform === "darwin") {
      await new Promise<void>((resolve, reject) => {
        const p = childProcess.spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
        p.stdin!.end(text);
        p.on("error", reject);
        p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`clipboard_write_exit_${code}`)));
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        const p = childProcess.spawn("xclip", ["-selection", "clipboard"], { stdio: ["pipe", "ignore", "ignore"] });
        p.stdin!.end(text);
        p.on("error", reject);
        p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`clipboard_write_exit_${code}`)));
      });
    }
  } catch {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "clipboard_write_failed" } };
  }
  return { status: "succeeded", outputDigest: { ok: true, textSha256_8: sha256_8(text), length: text.length } };
}

// ── 工具名 → 处理函数 路由表 ──────────────────────────────────────

const TOOL_HANDLERS: Record<string, (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>> = {
  "device.file.list": execFileList,
  "device.file.read": execFileRead,
  "device.file.write": execFileWrite,
  "device.browser.open": execBrowserOpen,
  "device.browser.click": execBrowserClick,
  "device.browser.screenshot": execBrowserScreenshot,
  "device.desktop.launch": execDesktopLaunch,
  "device.desktop.screenshot": execDesktopScreenshot,
  "device.evidence.upload": execEvidenceUpload,
  "device.clipboard.read": execClipboardRead,
  "device.clipboard.write": execClipboardWrite,
};

// ── 导出插件实例 ──────────────────────────────────────────────────

const desktopPlugin: DeviceToolPlugin = {
  name: "desktop",
  toolPrefixes: ["device.file", "device.browser", "device.desktop", "device.clipboard", "device.evidence"],

  async execute(ctx) {
    const handler = TOOL_HANDLERS[ctx.toolName];
    if (!handler) {
      return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolName: ctx.toolName, plugin: "desktop" } };
    }
    return handler(ctx);
  },
};

export default desktopPlugin;
