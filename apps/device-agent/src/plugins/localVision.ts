/**
 * Local Vision — 本地视觉闭环底层原语
 *
 * 解决 GUI 自动化"截图→云端分析→返回坐标→本地操作"的跨公网延迟问题。
 * 所有截图、OCR 定位、鼠标/键盘操作均在设备本地完成，不出公网。
 *
 * 支持平台：Windows（PowerShell/.NET）、macOS（screencapture/cliclick）、Linux（scrot/xdotool/tesseract）
 */
import crypto from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── 类型定义 ──────────────────────────────────────────────────────

export type BoundingBox = { x: number; y: number; w: number; h: number };

export type OcrMatch = {
  text: string;
  confidence: number;
  bbox: BoundingBox;
};

export type ScreenCapture = {
  filePath: string;
  width: number;
  height: number;
  base64?: string;
};

// ── 屏幕截图 ─────────────────────────────────────────────────────

function tmpPng(): string {
  return path.join(os.tmpdir(), `lvl_${crypto.randomUUID()}.png`);
}

async function spawnAsync(
  cmd: string,
  args: string[],
  opts?: { stdin?: string; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = childProcess.spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: opts?.timeoutMs ?? 15_000,
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    if (opts?.stdin) { p.stdin.write(opts.stdin); p.stdin.end(); } else { p.stdin.end(); }
    p.on("error", reject);
    p.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** 本地截取当前屏幕，返回 PNG 文件路径 */
export async function captureScreen(): Promise<ScreenCapture> {
  const out = tmpPng();

  if (process.platform === "win32") {
    // Windows: 使用 .NET System.Drawing 截图
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
      "$bmp = New-Object System.Drawing.Bitmap $b.Width,$b.Height",
      "$g = [System.Drawing.Graphics]::FromImage($bmp)",
      "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)",
      `$bmp.Save('${out.replaceAll("'", "''")}')`,
      "$g.Dispose(); $bmp.Dispose()",
      "Write-Output \"$($b.Width)x$($b.Height)\"",
    ].join("; ");
    const r = await spawnAsync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    if (r.code !== 0) throw new Error(`screenshot_failed: exit ${r.code}`);
    const m = r.stdout.trim().match(/(\d+)x(\d+)/);
    return { filePath: out, width: Number(m?.[1] ?? 1920), height: Number(m?.[2] ?? 1080) };
  }

  if (process.platform === "darwin") {
    await spawnAsync("screencapture", ["-x", out]);
    // sips 获取尺寸
    const info = await spawnAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", out]);
    const wm = info.stdout.match(/pixelWidth:\s*(\d+)/);
    const hm = info.stdout.match(/pixelHeight:\s*(\d+)/);
    return { filePath: out, width: Number(wm?.[1] ?? 1920), height: Number(hm?.[1] ?? 1080) };
  }

  // Linux: scrot 或 gnome-screenshot
  await spawnAsync("scrot", [out]);
  return { filePath: out, width: 1920, height: 1080 };
}

/** 清理截图临时文件 */
export async function cleanupCapture(capture: ScreenCapture): Promise<void> {
  await fs.unlink(capture.filePath).catch(() => {});
}

// ── 本地 OCR 文字识别 ────────────────────────────────────────────

/**
 * 对截图进行本地 OCR，返回所有识别到的文字区域。
 *
 * 引擎优先级：
 *   Windows → Windows.Media.Ocr（内置，无需安装）
 *   其他    → tesseract CLI
 *
 * 环境变量 DEVICE_AGENT_OCR_ENGINE 可强制指定："windows-ocr" | "tesseract"
 * 环境变量 DEVICE_AGENT_OCR_LANG   指定 OCR 语言，默认 "chi_sim+eng"（中文+英文）
 */
export async function ocrScreen(capture: ScreenCapture): Promise<OcrMatch[]> {
  const engine = (process.env.DEVICE_AGENT_OCR_ENGINE ?? "auto").toLowerCase();

  if (engine === "windows-ocr" || (engine === "auto" && process.platform === "win32")) {
    return ocrWindows(capture);
  }
  return ocrTesseract(capture);
}

/** Windows 内置 OCR（Windows.Media.Ocr，Win10+ 免安装） */
async function ocrWindows(capture: ScreenCapture): Promise<OcrMatch[]> {
  // 通过 PowerShell 调用 WinRT OCR API，输出 JSON 格式结果
  const script = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime]

function Await($WinRtTask,$ResultType){
  $asTask = $WinRtTask.GetType().GetMethod('AsTask',[Type[]]@($WinRtTask.GetType()))
  if(!$asTask){$asTask=[System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'}|Select -First 1}
  $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null,@($WinRtTask))
  $netTask.Wait()
  $netTask.Result
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${capture.filePath.replaceAll("'", "''")}')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$items = @()
foreach($line in $result.Lines){
  foreach($word in $line.Words){
    $r = $word.BoundingRect
    $items += @{text=$word.Text; x=[int]$r.X; y=[int]$r.Y; w=[int]$r.Width; h=[int]$r.Height}
  }
}
$items | ConvertTo-Json -Compress
`.trim();

  const r = await spawnAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeoutMs: 20_000 },
  );
  if (r.code !== 0) {
    // Windows OCR 失败则回退到 tesseract
    return ocrTesseract(capture);
  }
  try {
    const raw = JSON.parse(r.stdout.trim() || "[]");
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr
      .filter((x: any) => x && x.text)
      .map((x: any) => ({
        text: String(x.text),
        confidence: 0.9,
        bbox: { x: Number(x.x ?? 0), y: Number(x.y ?? 0), w: Number(x.w ?? 0), h: Number(x.h ?? 0) },
      }));
  } catch {
    return [];
  }
}

/** Tesseract OCR（跨平台，需安装 tesseract CLI） */
async function ocrTesseract(capture: ScreenCapture): Promise<OcrMatch[]> {
  const lang = process.env.DEVICE_AGENT_OCR_LANG ?? "chi_sim+eng";
  const tsvOut = capture.filePath + ".tsv";

  const r = await spawnAsync("tesseract", [capture.filePath, capture.filePath, "-l", lang, "tsv"], { timeoutMs: 30_000 });
  if (r.code !== 0) return [];

  try {
    const tsv = await fs.readFile(tsvOut, "utf8");
    const lines = tsv.split("\n").filter(Boolean);
    if (lines.length < 2) return [];

    const results: OcrMatch[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split("\t");
      // TSV 列: level page_num block_num par_num line_num word_num left top width height conf text
      if (cols.length < 12) continue;
      const conf = Number(cols[10]);
      const text = cols[11]?.trim();
      if (!text || conf < 30) continue;
      results.push({
        text,
        confidence: conf / 100,
        bbox: { x: Number(cols[6]), y: Number(cols[7]), w: Number(cols[8]), h: Number(cols[9]) },
      });
    }
    await fs.unlink(tsvOut).catch(() => {});
    return results;
  } catch {
    return [];
  }
}

// ── 文字定位：在 OCR 结果中查找目标文字 ──────────────────────────

/** 在 OCR 结果中查找包含指定文字的区域，返回中心坐标 */
export function findTextInOcrResults(
  results: OcrMatch[],
  target: string,
  opts?: { fuzzy?: boolean },
): { x: number; y: number; bbox: BoundingBox; confidence: number } | null {
  const t = target.toLowerCase();

  // 精确匹配优先
  for (const r of results) {
    if (r.text.toLowerCase() === t) {
      return { x: r.bbox.x + r.bbox.w / 2, y: r.bbox.y + r.bbox.h / 2, bbox: r.bbox, confidence: r.confidence };
    }
  }
  // 包含匹配
  for (const r of results) {
    if (r.text.toLowerCase().includes(t) || t.includes(r.text.toLowerCase())) {
      return { x: r.bbox.x + r.bbox.w / 2, y: r.bbox.y + r.bbox.h / 2, bbox: r.bbox, confidence: r.confidence * 0.8 };
    }
  }

  // 模糊匹配：合并相邻词块
  if (opts?.fuzzy) {
    const sorted = [...results].sort((a, b) => (a.bbox.y - b.bbox.y) || (a.bbox.x - b.bbox.x));
    for (let i = 0; i < sorted.length; i++) {
      let combined = sorted[i].text;
      let endIdx = i;
      for (let j = i + 1; j < sorted.length && j <= i + 5; j++) {
        if (Math.abs(sorted[j].bbox.y - sorted[i].bbox.y) > sorted[i].bbox.h * 1.5) break;
        combined += sorted[j].text;
        endIdx = j;
        if (combined.toLowerCase().includes(t)) {
          const x0 = sorted[i].bbox.x;
          const y0 = sorted[i].bbox.y;
          const x1 = sorted[endIdx].bbox.x + sorted[endIdx].bbox.w;
          const y1 = Math.max(sorted[i].bbox.y + sorted[i].bbox.h, sorted[endIdx].bbox.y + sorted[endIdx].bbox.h);
          const bbox: BoundingBox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          return { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2, bbox, confidence: 0.6 };
        }
      }
    }
  }

  return null;
}

// ── 鼠标控制 ────────────────────────────────────────────────────

export async function moveMouse(x: number, y: number): Promise<void> {
  const ix = Math.round(x);
  const iy = Math.round(y);

  if (process.platform === "win32") {
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${ix},${iy})`;
    await spawnAsync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    return;
  }
  if (process.platform === "darwin") {
    await spawnAsync("cliclick", [`m:${ix},${iy}`]);
    return;
  }
  await spawnAsync("xdotool", ["mousemove", String(ix), String(iy)]);
}

export async function clickMouse(x: number, y: number, button: "left" | "right" = "left"): Promise<void> {
  const ix = Math.round(x);
  const iy = Math.round(y);

  if (process.platform === "win32") {
    const btn = button === "right" ? "RightButton" : "LeftButton";
    // 先移动再点击
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${ix},${iy})`,
      "Start-Sleep -Milliseconds 50",
      `Add-Type @'`,
      `using System; using System.Runtime.InteropServices;`,
      `public class MouseSim {`,
      `  [DllImport("user32.dll")] public static extern void mouse_event(uint f,int x,int y,int d,int i);`,
      `  public static void Click(bool right){`,
      `    uint down = right ? 0x0008u : 0x0002u;`,
      `    uint up   = right ? 0x0010u : 0x0004u;`,
      `    mouse_event(down,0,0,0,0); mouse_event(up,0,0,0,0);`,
      `  }`,
      `}`,
      `'@`,
      `[MouseSim]::Click(${button === "right" ? "$true" : "$false"})`,
    ].join("\n");
    await spawnAsync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    return;
  }
  if (process.platform === "darwin") {
    const cmd = button === "right" ? "rc" : "c";
    await spawnAsync("cliclick", [`${cmd}:${ix},${iy}`]);
    return;
  }
  const btn = button === "right" ? "3" : "1";
  await spawnAsync("xdotool", ["mousemove", String(ix), String(iy), "click", btn]);
}

export async function doubleClick(x: number, y: number): Promise<void> {
  await clickMouse(x, y);
  await new Promise((r) => setTimeout(r, 80));
  await clickMouse(x, y);
}

// ── 键盘控制 ────────────────────────────────────────────────────

export async function typeText(text: string): Promise<void> {
  if (process.platform === "win32") {
    // 使用 SendKeys 输入文字（对特殊字符做转义）
    const escaped = text
      .replace(/[+^%~(){}[\]]/g, "{$&}")
      .replace(/\n/g, "{ENTER}");
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped.replaceAll("'", "''")}')`;
    await spawnAsync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    return;
  }
  if (process.platform === "darwin") {
    // cliclick type
    await spawnAsync("cliclick", [`t:${text}`]);
    return;
  }
  await spawnAsync("xdotool", ["type", "--clearmodifiers", text]);
}

export async function pressKey(key: string): Promise<void> {
  if (process.platform === "win32") {
    const keyMap: Record<string, string> = {
      enter: "{ENTER}", tab: "{TAB}", escape: "{ESC}", backspace: "{BS}",
      delete: "{DEL}", up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
      home: "{HOME}", end: "{END}", pageup: "{PGUP}", pagedown: "{PGDN}",
      f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}",
    };
    const k = keyMap[key.toLowerCase()] ?? `{${key.toUpperCase()}}`;
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${k}')`;
    await spawnAsync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    return;
  }
  if (process.platform === "darwin") {
    await spawnAsync("cliclick", [`kp:${key}`]);
    return;
  }
  await spawnAsync("xdotool", ["key", key]);
}

/** 组合键，如 ["ctrl", "a"] → Ctrl+A */
export async function pressCombo(keys: string[]): Promise<void> {
  if (process.platform === "win32") {
    const modMap: Record<string, string> = { ctrl: "^", alt: "%", shift: "+" };
    let prefix = "";
    let main = "";
    for (const k of keys) {
      const lo = k.toLowerCase();
      if (modMap[lo]) { prefix += modMap[lo]; }
      else { main = lo; }
    }
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${prefix}${main}')`;
    await spawnAsync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    return;
  }
  if (process.platform === "darwin") {
    await spawnAsync("cliclick", [`kp:${keys.join("+")}`]);
    return;
  }
  await spawnAsync("xdotool", ["key", keys.join("+")]);
}

// ── 滚轮 ────────────────────────────────────────────────────────

export async function scroll(direction: "up" | "down", clicks: number = 3): Promise<void> {
  if (process.platform === "win32") {
    const delta = direction === "up" ? 120 * clicks : -(120 * clicks);
    const script = [
      `Add-Type @'`,
      `using System; using System.Runtime.InteropServices;`,
      `public class WheelSim {`,
      `  [DllImport("user32.dll")] public static extern void mouse_event(uint f,int x,int y,int d,int i);`,
      `  public static void Scroll(int d){ mouse_event(0x0800,0,0,d,0); }`,
      `}`,
      `'@`,
      `[WheelSim]::Scroll(${delta})`,
    ].join("\n");
    await spawnAsync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    return;
  }
  if (process.platform === "darwin") {
    // AppleScript
    return;
  }
  const btn = direction === "up" ? "4" : "5";
  for (let i = 0; i < clicks; i++) {
    await spawnAsync("xdotool", ["click", btn]);
  }
}
