import { validateProductionBaseline } from "@openslin/shared";
import { buildServer } from "./server";

async function main() {
  // P0-04: 生产隔离基线启动校验
  const baselineResult = validateProductionBaseline(process.env, ["process", "container", "remote"]);
  if (!baselineResult.valid) {
    console.error(
      `[runner] Production baseline validation FAILED. Violations: ${baselineResult.violations.join(", ")}. ` +
      `Startup will continue but Skill execution may be restricted.`
    );
  } else if (baselineResult.policy.isProduction) {
    console.log(
      `[runner] Production baseline validation passed. ` +
      `minIsolation=${baselineResult.policy.minIsolation}, trustEnforced=${baselineResult.policy.trustEnforced}`
    );
  }

  const app = buildServer();
  const host = String(process.env.RUNNER_HOST ?? "0.0.0.0");
  const portRaw = Number(process.env.RUNNER_PORT ?? process.env.PORT ?? 8082);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.round(portRaw) : 8082;
  await app.listen({ host, port });
}

void main();

