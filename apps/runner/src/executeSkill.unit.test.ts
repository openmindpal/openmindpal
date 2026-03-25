import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeSkillInSandbox } from "./executeSkill";

async function mkSkillDir(params: { root: string; entryJs: string }) {
  const dir = await fs.mkdtemp(path.join(params.root, "skill_"));
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({ identity: { name: "test.cpu", version: "1.0.0" }, entry: "index.js" }, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(dir, "index.js"), params.entryJs, "utf8");
  return dir;
}

describe("executeSkillInSandbox cpuTimeLimitMs", () => {
  it("terminates CPU-bound skill and returns resource_exhausted", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openslin_runner_test_"));
    const skillRoot = path.join(tmp, "skills");
    await fs.mkdir(skillRoot, { recursive: true });
    const artifactDir = await mkSkillDir({
      root: skillRoot,
      entryJs: `exports.execute = async function () { while (true) {} }`,
    });

    const prev = process.env.SKILL_PACKAGE_ROOTS;
    process.env.SKILL_PACKAGE_ROOTS = skillRoot;
    try {
      await expect(
        executeSkillInSandbox({
          toolRef: "test.cpu@1",
          tenantId: "t",
          spaceId: "s",
          subjectId: "u",
          traceId: "trace",
          idempotencyKey: null,
          input: {},
          limits: { cpuTimeLimitMs: 50, timeoutMs: 10_000, maxConcurrency: 1 },
          networkPolicy: { allowedDomains: [], rules: [] } as any,
          artifactRef: artifactDir,
          expectedDepsDigest: null,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/resource_exhausted:cpu_time_limit/);
    } finally {
      if (prev === undefined) delete process.env.SKILL_PACKAGE_ROOTS;
      else process.env.SKILL_PACKAGE_ROOTS = prev;
    }
  }, 20_000);
});
