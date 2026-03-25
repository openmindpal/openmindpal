export function openSse(params: {
  req: any;
  reply: any;
  headers?: Record<string, string>;
}) {
  const req = params.req;
  const reply = params.reply;

  const ctrl = new AbortController();

  const sseHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...(params.headers ?? {}),
  };

  const origin = req.headers?.origin as string | undefined;
  if (origin) {
    const existing = reply.getHeader?.("access-control-allow-origin");
    if (existing) {
      sseHeaders["Access-Control-Allow-Origin"] = String(existing);
      sseHeaders["Access-Control-Allow-Credentials"] = "true";
      sseHeaders["Vary"] = "origin";
    }
  }

  reply.raw.writeHead(200, sseHeaders);
  if (typeof (reply.raw as any).flushHeaders === "function") (reply.raw as any).flushHeaders();

  let closed = false;
  const onClose = () => {
    closed = true;
    try {
      ctrl.abort();
    } catch {
    }
  };
  req.raw.on("close", onClose);
  reply.raw.on("close", onClose);

  function sendEvent(event: string, data: unknown) {
    if (closed) return;
    try {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      ctrl.abort();
    } catch {
    }
    try {
      req.raw.off("close", onClose);
      reply.raw.off("close", onClose);
    } catch {
    }
    try {
      reply.raw.end();
    } catch {
    }
  }

  return {
    sendEvent,
    close,
    abortController: ctrl,
    signal: ctrl.signal,
    isClosed: () => closed,
  };
}
