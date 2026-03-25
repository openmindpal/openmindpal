import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type DeviceAgentConfig = {
  apiBase: string;
  deviceId: string;
  deviceToken: string;
  enrolledAt: string;
  deviceType: "desktop" | "mobile";
  os: string;
  agentVersion: string;
};

export function defaultConfigPath() {
  return path.join(os.homedir(), ".openslin", "device-agent.json");
}

export async function loadConfigFile(p: string): Promise<DeviceAgentConfig | null> {
  try {
    const txt = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(txt);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as DeviceAgentConfig;
  } catch {
    return null;
  }
}

export async function saveConfigFile(p: string, cfg: DeviceAgentConfig) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(cfg, null, 2), "utf8");
}

