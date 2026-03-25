import { describe, expect, it } from "vitest";
import { parseToolCallsFromOutput } from "./llm";

describe("parseToolCallsFromOutput", () => {
  it("returns parseErrorCount when tool_call block JSON is invalid", () => {
    const out = parseToolCallsFromOutput("x\n```tool_call\n{not json}\n```\ny");
    expect(out.toolCalls.length).toBe(0);
    expect(out.parseErrorCount).toBe(1);
    expect(out.cleanText).toBe("xy");
  });

  it("parses tool calls from array", () => {
    const out = parseToolCallsFromOutput('```tool_call\n[{"toolRef":"a@1","inputDraft":{"k":1}}]\n```');
    expect(out.parseErrorCount).toBe(0);
    expect(out.toolCalls).toEqual([{ toolRef: "a@1", inputDraft: { k: 1 } }]);
  });
});
