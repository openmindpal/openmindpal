import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

const IGNORE_DIRS = new Set(["node_modules", ".git", ".next", "dist", "coverage", ".turbo"]);
const IGNORE_FILES = new Set(["package-lock.json"]);
const IGNORE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip"]);

const BLOCKLIST = [
  { name: "private_key_pem", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "aws_access_key_id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "aws_secret_access_key", re: /\baws_secret_access_key\b\s*[:=]\s*[A-Za-z0-9/+=]{30,}/i },
  { name: "github_pat", re: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "openai_key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
];

function shouldIgnoreFile(p) {
  const base = path.basename(p);
  if (IGNORE_FILES.has(base)) return true;
  const ext = path.extname(base).toLowerCase();
  if (IGNORE_EXT.has(ext)) return true;
  return false;
}

function shouldIgnoreDir(name) {
  return IGNORE_DIRS.has(name);
}

async function walk(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) {
      if (e.name === ".github") {
      } else if (e.name === ".env.example") {
      }
    }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (shouldIgnoreDir(e.name)) continue;
      out.push(...(await walk(full)));
      continue;
    }
    if (e.isFile()) {
      if (shouldIgnoreFile(full)) continue;
      out.push(full);
    }
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).replaceAll("\\", "/");
}

function isIgnoredEnvExample(p) {
  return rel(p) === ".env.example";
}

async function main() {
  const files = await walk(ROOT);
  const findings = [];

  for (const f of files) {
    if (isIgnoredEnvExample(f)) continue;
    let buf;
    try {
      buf = await readFile(f, "utf8");
    } catch {
      continue;
    }
    if (!buf) continue;
    for (const rule of BLOCKLIST) {
      const m = buf.match(rule.re);
      if (m) {
        findings.push({ file: rel(f), rule: rule.name });
        break;
      }
    }
  }

  if (findings.length) {
    const msg = findings.map((x) => `- ${x.file}: ${x.rule}`).join("\n");
    console.error(`secret-scan: blocked patterns found\n${msg}`);
    process.exit(1);
  }

  console.log("secret-scan: ok");
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(2);
});
