"use client";

import { useEffect, useMemo, useRef } from "react";
import { t } from "@/lib/i18n";

function joinPath(parts: string[]) {
  return parts.filter(Boolean).map((p) => encodeURIComponent(p)).join("/");
}

type BridgeReq = { id: string; kind: string; payload?: unknown };

export default function WorkbenchHostClient(props: { locale: string; workbenchKey: string; initial: unknown; initialStatus: number }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const effective: any = props.initial && typeof props.initial === "object" ? (props.initial as any) : null;
  const manifest = effective?.manifest ?? null;
  const entry = manifest?.entrypoint ?? null;
  const assetPath = typeof entry?.assetPath === "string" ? entry.assetPath : "";

  const iframeSrc = useMemo(() => {
    const p = assetPath.split("/").filter(Boolean);
    if (!p.length) return "";
    return `/w-assets/${encodeURIComponent(props.workbenchKey)}/${joinPath(p)}`;
  }, [assetPath, props.workbenchKey]);

  useEffect(() => {
    const onMessage = async (ev: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      if (ev.source !== win) return;
      const data: any = ev.data;
      if (!data || typeof data !== "object") return;
      const id = String(data.id ?? "");
      const kind = String(data.kind ?? "");
      if (!id || !kind) return;
      const payload = data.payload;

      let respStatus = 500;
      let respBody: any = null;
      try {
        const res = await fetch(`/api/workbenches/${encodeURIComponent(props.workbenchKey)}/bridge`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, kind, payload } satisfies BridgeReq),
        });
        respStatus = res.status;
        respBody = await res.json().catch(() => null);
      } catch (e: any) {
        respStatus = 500;
        respBody = { errorCode: "NETWORK_ERROR", message: String(e?.message ?? e) };
      }

      win.postMessage({ id, ok: respStatus >= 200 && respStatus < 300, status: respStatus, body: respBody }, window.location.origin);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [props.workbenchKey]);

  if (props.initialStatus === 401) return <div>{t(props.locale, "workbench.host.unauthorized")}</div>;
  if (props.initialStatus === 403) return <div>{t(props.locale, "workbench.host.forbidden")}</div>;
  if (props.initialStatus !== 200) return <div>{t(props.locale, "workbench.host.loadFailed")}</div>;
  if (!iframeSrc) return <div>{t(props.locale, "workbench.host.missingEntrypoint")}</div>;

  return (
    <div style={{ width: "100%", height: "calc(100vh - 140px)" }}>
      <iframe ref={iframeRef} src={iframeSrc} sandbox="allow-scripts" style={{ width: "100%", height: "100%", border: 0 }} />
    </div>
  );
}
