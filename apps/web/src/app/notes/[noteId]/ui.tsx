"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { API_BASE, text } from "@/lib/api";
import { Badge, Card, PageHeader } from "@/components/ui";

const messageSync = 0;
const messageAwareness = 1;

const syncStep1 = 0;
const syncStep2 = 1;
const syncUpdate = 2;

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg = msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

function wsBaseFromApiBase(apiBase: string) {
  return apiBase.startsWith("https://") ? apiBase.replace(/^https:/, "wss:") : apiBase.replace(/^http:/, "ws:");
}

function applyTextChange(ytext: Y.Text, oldStr: string, newStr: string) {
  if (oldStr === newStr) return;
  let start = 0;
  const oldLen = oldStr.length;
  const newLen = newStr.length;
  while (start < oldLen && start < newLen && oldStr[start] === newStr[start]) start += 1;
  let endOld = oldLen - 1;
  let endNew = newLen - 1;
  while (endOld >= start && endNew >= start && oldStr[endOld] === newStr[endNew]) {
    endOld -= 1;
    endNew -= 1;
  }
  const delCount = endOld - start + 1;
  const insText = newStr.slice(start, endNew + 1);
  if (delCount > 0) ytext.delete(start, delCount);
  if (insText) ytext.insert(start, insText);
}

export default function NoteEditorClient(props: { locale: string; noteId: string; initial: unknown; initialStatus: number }) {
  const initialError = useMemo(() => {
    if (props.initialStatus < 400) return "";
    return errText(props.locale, (props.initial as any) ?? { errorCode: String(props.initialStatus) });
  }, [props.initial, props.initialStatus, props.locale]);

  const [connected, setConnected] = useState(false);
  const [synced, setSynced] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  const [error, setError] = useState("");
  const [peerCount, setPeerCount] = useState(0);

  const docRef = useRef<Y.Doc | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);
  const awarenessRef = useRef<awarenessProtocol.Awareness | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const valueRef = useRef<string>("");
  const canWriteRef = useRef<boolean>(false);
  const applyingRemoteRef = useRef(false);

  const [value, setValue] = useState<string>(String(((props.initial as any)?.payload ?? {})?.content ?? ""));

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    canWriteRef.current = canWrite;
  }, [canWrite]);

  useEffect(() => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    const awareness = new awarenessProtocol.Awareness(doc);
    docRef.current = doc;
    ytextRef.current = ytext;
    awarenessRef.current = awareness;

    const onDocUpdate = (update: Uint8Array, origin: any) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!canWriteRef.current) return;
      if (origin === "remote") return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, messageSync);
      encoding.writeVarUint(enc, syncUpdate);
      encoding.writeVarUint8Array(enc, update);
      ws.send(encoding.toUint8Array(enc));
    };
    doc.on("update", onDocUpdate);

    const onTextChange = () => {
      if (applyingRemoteRef.current) return;
      setValue(ytext.toString());
    };
    ytext.observe(onTextChange);

    const wsUrl = `${wsBaseFromApiBase(API_BASE)}/ws/yjs/notes/${encodeURIComponent(props.noteId)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setConnected(true);
      setError("");
      setSynced(false);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, messageSync);
      encoding.writeVarUint(enc, syncStep1);
      encoding.writeVarUint8Array(enc, Y.encodeStateVector(doc));
      ws.send(encoding.toUint8Array(enc));

      const color = `hsl(${Math.floor(Math.random() * 360)}, 70%, 45%)`;
      awareness.setLocalStateField("user", { color });
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, messageAwareness);
      encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]));
      ws.send(encoding.toUint8Array(aw));
    });

    ws.addEventListener("close", () => {
      setConnected(false);
    });

    ws.addEventListener("error", () => {
      setError("ws_error");
    });

    ws.addEventListener("message", async (evt) => {
      const data = evt.data;
      if (typeof data === "string") {
        try {
          const j = JSON.parse(data);
          if (j && typeof j === "object" && (j as any).type === "meta") {
            setCanWrite(Boolean((j as any).canWrite));
          }
        } catch {
        }
        return;
      }
      const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : null;
      if (!buf) return;
      const dec = decoding.createDecoder(buf);
      const messageType = decoding.readVarUint(dec);
      if (messageType === messageSync) {
        const st = decoding.readVarUint(dec);
        if (st === syncStep1) {
          const sv = decoding.readVarUint8Array(dec);
          const update = Y.encodeStateAsUpdate(doc, sv);
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, messageSync);
          encoding.writeVarUint(enc, syncStep2);
          encoding.writeVarUint8Array(enc, update);
          ws.send(encoding.toUint8Array(enc));
          return;
        }
        if (st === syncStep2 || st === syncUpdate) {
          const update = decoding.readVarUint8Array(dec);
          applyingRemoteRef.current = true;
          try {
            Y.applyUpdate(doc, update, "remote");
            setSynced(true);
            setValue(ytext.toString());
          } finally {
            applyingRemoteRef.current = false;
          }
        }
        return;
      }
      if (messageType === messageAwareness) {
        const update = decoding.readVarUint8Array(dec);
        awarenessProtocol.applyAwarenessUpdate(awareness, update, "remote");
      }
    });

    const onAwarenessChange = () => {
      setPeerCount(Array.from(awareness.getStates().keys()).length);
    };
    (awareness as any).on?.("change", onAwarenessChange);
    onAwarenessChange();

    return () => {
      try {
        ytext.unobserve(onTextChange);
      } catch {
      }
      try {
        doc.off("update", onDocUpdate as any);
      } catch {
      }
      try {
        (awareness as any).off?.("change", onAwarenessChange);
      } catch {
      }
      try {
        ws.close();
      } catch {
      }
      try {
        doc.destroy();
      } catch {
      }
      docRef.current = null;
      ytextRef.current = null;
      awarenessRef.current = null;
      wsRef.current = null;
    };
  }, [props.noteId, props.locale]);

  return (
    <div>
      <PageHeader
        title={`Note ${props.noteId}`}
        description={
          <>
            <Badge>{props.initialStatus}</Badge>
            <span style={{ marginLeft: 8 }}>{connected ? "connected" : "disconnected"}</span>
            <span style={{ marginLeft: 8 }}>{synced ? "synced" : "syncing"}</span>
            <span style={{ marginLeft: 8 }}>{canWrite ? "rw" : "ro"}</span>
            <span style={{ marginLeft: 8 }}>peers={peerCount}</span>
          </>
        }
        actions={
          <>
            <Link href={`/tasks?lang=${encodeURIComponent(props.locale)}`}>tasks</Link>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title="Collaborative content (Yjs)">
          <textarea
            style={{ width: "100%", minHeight: 360, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
            value={value}
            disabled={!canWrite || !synced}
            onChange={(e) => {
              const ytext = ytextRef.current;
              if (!ytext) return;
              const oldStr = valueRef.current;
              const newStr = e.target.value;
              valueRef.current = newStr;
              setValue(newStr);
              if (!canWriteRef.current) return;
              ytext.doc?.transact(() => applyTextChange(ytext, oldStr, newStr), "local");
            }}
            onSelect={(e) => {
              const el = e.target as HTMLTextAreaElement;
              const awareness = awarenessRef.current;
              if (!awareness) return;
              awareness.setLocalStateField("cursor", { index: el.selectionStart, length: Math.max(0, el.selectionEnd - el.selectionStart) });
              const ws = wsRef.current;
              if (!ws || ws.readyState !== WebSocket.OPEN) return;
              const enc = encoding.createEncoder();
              encoding.writeVarUint(enc, messageAwareness);
              encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]));
              ws.send(encoding.toUint8Array(enc));
            }}
          />
        </Card>
      </div>
    </div>
  );
}
