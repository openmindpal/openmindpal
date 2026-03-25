import { describe, expect, it, vi } from "vitest";
import { memoryWrite } from "./processor";

describe("memoryWrite merge", () => {
  it("merges into existing entry when minhash overlap is high", async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT id, embedding_minhash")) {
        return { rows: [{ id: "11111111-1111-1111-1111-111111111111", embedding_minhash: new Array(16).fill(0) }], rowCount: 1 } as any;
      }
      if (sql.includes("UPDATE memory_entries")) {
        return { rows: [{ id: "11111111-1111-1111-1111-111111111111", scope: "user", type: "other", title: null, created_at: new Date().toISOString() }], rowCount: 1 } as any;
      }
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`);
    });
    const pool = { query: q } as any;
    const out = await memoryWrite({
      pool,
      tenantId: "tenant_dev",
      spaceId: "space_dev",
      subjectId: "admin",
      input: { scope: "user", type: "other", contentText: "a", writePolicy: "confirmed" },
    });
    expect(String(out.entry.id)).toBe("11111111-1111-1111-1111-111111111111");
    expect(q).toHaveBeenCalled();
    expect(q.mock.calls.some((c) => String(c[0]).includes("UPDATE memory_entries"))).toBe(true);
    expect(q.mock.calls.some((c) => String(c[0]).includes("INSERT INTO memory_entries"))).toBe(false);
  });

  it("inserts new entry when no merge candidates exist", async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT id, embedding_minhash")) return { rows: [], rowCount: 0 } as any;
      if (sql.includes("INSERT INTO memory_entries")) {
        return { rows: [{ id: "22222222-2222-2222-2222-222222222222", scope: "user", type: "other", title: null, created_at: new Date().toISOString() }], rowCount: 1 } as any;
      }
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`);
    });
    const pool = { query: q } as any;
    const out = await memoryWrite({
      pool,
      tenantId: "tenant_dev",
      spaceId: "space_dev",
      subjectId: "admin",
      input: { scope: "user", type: "other", contentText: "a", writePolicy: "confirmed" },
    });
    expect(String(out.entry.id)).toBe("22222222-2222-2222-2222-222222222222");
    expect(q.mock.calls.some((c) => String(c[0]).includes("INSERT INTO memory_entries"))).toBe(true);
  });
});

