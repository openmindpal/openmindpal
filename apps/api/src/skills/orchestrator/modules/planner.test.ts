import { describe, expect, it, vi } from "vitest";

vi.mock("../../../modules/tools/resolve", () => ({
  resolveEffectiveToolRef: async (p: any) => `${String(p?.name ?? "")}@1`,
}));

vi.mock("../../../modules/tools/toolRepo", () => ({
  getToolVersionByRef: async () => ({ status: "released", inputSchema: { fields: {} } }),
  getToolDefinition: async (_pool: any, _tenantId: string, name: string) => {
    if (name === "entity.create") return { name, scope: "write", resourceType: "entity", action: "create", riskLevel: "low", approvalRequired: false };
    if (name === "entity.update") return { name, scope: "write", resourceType: "entity", action: "update", riskLevel: "low", approvalRequired: false };
    return { name, scope: "read", resourceType: "knowledge", action: "search", riskLevel: "low", approvalRequired: false };
  },
}));

vi.mock("../../../modules/governance/toolGovernanceRepo", () => ({
  isToolEnabled: async () => true,
}));

vi.mock("../../../modules/auth/authz", () => ({
  authorize: async () => ({ decision: "allow" }),
}));

import { buildHeuristicPlanV4 } from "./planner";

describe("planner", () => {
  it("buildHeuristicPlanV4 按启发式对候选打分并优先选择 create", async () => {
    const res = await buildHeuristicPlanV4({
      pool: {} as any,
      tenantId: "t1",
      spaceId: "s1",
      subjectId: "u1",
      goal: "创建一个新的记录",
      suggestions: [
        { toolRef: "entity.update", inputDraft: {} },
        { toolRef: "entity.create", inputDraft: {} },
      ],
      allowedTools: null,
      allowWrites: true,
      maxSteps: 1,
    });
    expect(res.planSteps.length).toBe(1);
    expect(res.planSteps[0].toolRef).toBe("entity.create@1");
    expect(Array.isArray(res.planSteps[0].selection?.reasons)).toBe(true);
    expect((res.planSteps[0].selection?.reasons ?? []).includes("match:create_intent")).toBe(true);
    expect(res.planSteps[0].selection?.rejectedCandidatesDigest?.sha256_8?.length).toBe(8);
  });
});
