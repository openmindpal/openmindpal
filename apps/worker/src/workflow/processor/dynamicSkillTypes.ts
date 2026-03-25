import type { EgressEvent } from "./runtime";

export type DynamicSkillExecResult = {
  output: any;
  egress: EgressEvent[];
  depsDigest: string;
  runtimeBackend: "process" | "container" | "remote" | "local";
  degraded: boolean;
  runnerSummary?: any;
};
