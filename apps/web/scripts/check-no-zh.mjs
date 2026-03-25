import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.cwd(), "src");
const exts = new Set([".ts", ".tsx"]);
const zhRe = /[\u4e00-\u9fff]/;

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(p)));
    else if (e.isFile() && exts.has(path.extname(e.name))) files.push(p);
  }
  return files;
}

const files = await walk(root);
const hits = [];

for (const f of files) {
  const content = await fs.readFile(f, "utf8");
  if (!zhRe.test(content)) continue;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (zhRe.test(lines[i])) hits.push({ file: f, line: i + 1, text: lines[i].slice(0, 200) });
  }
}

if (hits.length) {
  console.error("Chinese characters found in TS/TSX. Move UI text to locales/*.json.");
  for (const h of hits.slice(0, 50)) {
    const rel = path.relative(process.cwd(), h.file);
    console.error(`- ${rel}:${h.line}: ${h.text}`);
  }
  process.exit(1);
}

