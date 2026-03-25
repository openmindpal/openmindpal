import { context, propagation } from "@opentelemetry/api";

export function attachJobTraceCarrier<T extends Record<string, any>>(data: T): T {
  const enabled = String(process.env.OTEL_ENABLED ?? "").toLowerCase() === "1" || String(process.env.OTEL_ENABLED ?? "").toLowerCase() === "true";
  if (!enabled) return data;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (!Object.keys(carrier).length) return data;
  return { ...data, __trace: carrier };
}

