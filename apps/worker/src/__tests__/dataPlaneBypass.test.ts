import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function readEntityProcessorSource() {
  const cwd = process.cwd().replaceAll("\\", "/");
  const isWorkerCwd = cwd.endsWith("/apps/worker");
  const p = isWorkerCwd
    ? path.resolve(process.cwd(), "src/workflow/processor/entity.ts")
    : path.resolve(process.cwd(), "apps/worker/src/workflow/processor/entity.ts");
  return fs.readFile(p, "utf8");
}

function extractBlock(src: string, marker: string) {
  const idx = src.indexOf(marker);
  if (idx < 0) return "";
  const tail = src.slice(idx);
  const nextIdx = tail.indexOf("\nexport async function", marker.startsWith("export async function") ? marker.length : 0);
  if (nextIdx < 0) return tail;
  return tail.slice(0, nextIdx);
}

describe("worker data plane bypass gate", () => {
  it("entity.create/update/delete 不直连 entity_records（改走受控入口）", async () => {
    const src = await readEntityProcessorSource();
    const createBlock = extractBlock(src, "export async function executeEntityCreate");
    const updateBlock = extractBlock(src, "export async function executeEntityUpdate");
    const deleteBlock = extractBlock(src, "export async function executeEntityDelete");

    const forbidden = [/INSERT\s+INTO\s+entity_records/i, /UPDATE\s+entity_records/i, /DELETE\s+FROM\s+entity_records/i];
    for (const re of forbidden) {
      expect(createBlock).not.toMatch(re);
      expect(updateBlock).not.toMatch(re);
      expect(deleteBlock).not.toMatch(re);
    }
  });
});

