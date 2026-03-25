import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const enabled = String(process.env.OTEL_ENABLED ?? "").toLowerCase() === "1" || String(process.env.OTEL_ENABLED ?? "").toLowerCase() === "true";

function parseHeaders(raw: string | undefined) {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  const out: Record<string, string> = {};
  for (const part of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

if (enabled) {
  const diagEnabled = String(process.env.OTEL_DIAG ?? "").toLowerCase() === "1" || String(process.env.OTEL_DIAG ?? "").toLowerCase() === "true";
  if (diagEnabled) diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

  const exporter = new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
  });

  const sdk = new NodeSDK({
    resource: new Resource({ [SEMRESATTRS_SERVICE_NAME]: "openslin-api" }),
    traceExporter: exporter,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();

  process.on("SIGTERM", () => {
    sdk.shutdown().catch(() => null);
  });
}
