import { buildServer } from "./server";

async function main() {
  const app = buildServer();
  const host = String(process.env.RUNNER_HOST ?? "0.0.0.0");
  const portRaw = Number(process.env.RUNNER_PORT ?? process.env.PORT ?? 8082);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.round(portRaw) : 8082;
  await app.listen({ host, port });
}

void main();

