import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import crypto from "node:crypto";

vi.mock("../modules/auth/authz", () => {
  return {
    authorize: vi.fn(async (params: any) => {
      const subjectId = String(params?.subjectId ?? "");
      const action = String(params?.action ?? "");
      if (action === "read") return { decision: "allow" };
      if (action === "update") return { decision: subjectId === "writer" ? "allow" : "deny" };
      return { decision: "deny" };
    }),
  };
});

import { yjsRoutes } from "../skills/yjs-collab/routes";

const messageSync = 0;
const syncUpdate = 2;

function encodeSyncUpdate(update: Uint8Array) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  encoding.writeVarUint(enc, syncUpdate);
  encoding.writeVarUint8Array(enc, update);
  return encoding.toUint8Array(enc);
}

function waitForText(doc: Y.Doc, expected: string) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const t = doc.getText("content");
    const check = () => {
      if (t.toString() === expected) return resolve();
      if (Date.now() - started > 1500) return reject(new Error("timeout"));
      setTimeout(check, 25);
    };
    check();
  });
}

describe("yjs websocket", () => {
  let app: any;
  let base: string;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    (app as any).decorate("db", {
      query: async (sql: string) => {
        const s = String(sql);
        if (s.includes("SELECT state_b64 FROM yjs_documents")) return { rowCount: 0, rows: [] };
        if (s.includes("SELECT payload FROM entity_records")) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      },
    });

    app.register(websocket);
    app.addHook("onRequest", async (req: any) => {
      const url = new URL(req.url, "http://localhost");
      const as = url.searchParams.get("as") ?? "";
      req.ctx = { locale: "en-US", traceId: "t-ws", requestId: "r-ws", subject: { subjectId: as, tenantId: "tenant_dev", spaceId: "space_dev" } };
    });
    app.register(yjsRoutes);
    const addr = await app.listen({ port: 0, host: "127.0.0.1" });
    base = String(addr).replace(/^http:/, "ws:");
  });

  afterAll(async () => {
    await app.close();
  });

  it("只读连接不可提交 update", async () => {
    const noteId = crypto.randomUUID();
    const writerDoc = new Y.Doc();
    const observerDoc = new Y.Doc();
    const WS: any = (globalThis as any).WebSocket;
    const writerWs: any = new WS(`${base}/ws/yjs/notes/${encodeURIComponent(noteId)}?as=writer`);
    const observerWs: any = new WS(`${base}/ws/yjs/notes/${encodeURIComponent(noteId)}?as=observer`);
    const readerWs: any = new WS(`${base}/ws/yjs/notes/${encodeURIComponent(noteId)}?as=reader`);
    writerWs.binaryType = "arraybuffer";
    observerWs.binaryType = "arraybuffer";
    readerWs.binaryType = "arraybuffer";

    const applyTo = (doc: Y.Doc) => async (evt: any) => {
      if (typeof evt.data === "string") return;
      const u8 = evt.data instanceof ArrayBuffer ? new Uint8Array(evt.data) : null;
      if (!u8) return;
      const dec = decoding.createDecoder(u8);
      const mt = decoding.readVarUint(dec);
      if (mt !== messageSync) return;
      const st = decoding.readVarUint(dec);
      if (st !== syncUpdate) return;
      const update = decoding.readVarUint8Array(dec);
      Y.applyUpdate(doc, update);
    };
    observerWs.addEventListener("message", await applyTo(observerDoc));

    await new Promise<void>((resolve) => {
      let c = 0;
      const onOpen = () => {
        c += 1;
        if (c === 3) resolve();
      };
      writerWs.addEventListener("open", onOpen);
      observerWs.addEventListener("open", onOpen);
      readerWs.addEventListener("open", onOpen);
    });

    const writerText = writerDoc.getText("content");
    let baseUpdate: Uint8Array | null = null;
    writerDoc.on("update", (u: Uint8Array) => {
      baseUpdate = u;
    });
    writerText.insert(0, "base");
    expect(baseUpdate).not.toBeNull();
    writerWs.send(encodeSyncUpdate(baseUpdate!));
    await waitForText(observerDoc, "base");

    const readerDoc = new Y.Doc();
    const readerText = readerDoc.getText("content");
    let hackedUpdate: Uint8Array | null = null;
    readerDoc.on("update", (u: Uint8Array) => {
      hackedUpdate = u;
    });
    readerText.insert(0, "hacked");
    expect(hackedUpdate).not.toBeNull();
    readerWs.send(encodeSyncUpdate(hackedUpdate!));

    await new Promise((r) => setTimeout(r, 300));
    expect(observerDoc.getText("content").toString()).toBe("base");

    writerWs.close();
    observerWs.close();
    readerWs.close();
  });
});
