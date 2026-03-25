"use client";

import { Badge, type BadgeTone } from "./Badge";
import { t } from "@/lib/i18n";

export function StatusBadge(props: { locale: string; status: number | string | null | undefined }) {
  const raw = props.status;
  const code = typeof raw === "number" ? raw : Number(raw);

  if (!raw && raw !== 0) {
    return <Badge tone="neutral">{t(props.locale, "status.notLoaded")}</Badge>;
  }
  if (!Number.isFinite(code) || code === 0) {
    return <Badge tone="neutral">{t(props.locale, "status.notLoaded")}</Badge>;
  }

  let tone: BadgeTone;
  let label: string;

  if (code >= 200 && code < 300) {
    tone = "success";
    label = t(props.locale, "status.ok");
  } else if (code === 404) {
    tone = "warning";
    label = t(props.locale, "status.notFound");
  } else if (code === 401 || code === 403) {
    tone = "danger";
    label = t(props.locale, "status.forbidden");
  } else if (code >= 400 && code < 500) {
    tone = "warning";
    label = t(props.locale, "status.clientError");
  } else if (code >= 500) {
    tone = "danger";
    label = t(props.locale, "status.serverError");
  } else {
    tone = "neutral";
    label = String(code);
  }

  return <Badge tone={tone}>{label}</Badge>;
}
