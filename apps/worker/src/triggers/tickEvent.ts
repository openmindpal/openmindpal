import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { fireEventTrigger, toTrigger, type TriggerDefinitionRow } from "./runner";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function safePath(path: unknown) {
  const raw = String(path ?? "").trim();
  if (!raw) return null;
  const segs = raw.split(".").map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0 || segs.length > 12) return null;
  const ok = segs.every((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s.length <= 100);
  if (!ok) return null;
  return segs;
}

function getByPath(obj: any, path: string[]) {
  let cur: any = obj;
  for (const p of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as any)[p];
  }
  return cur;
}

function matchFilter(filter: any, event: any) {
  if (!filter) return { matched: true, reason: "matched" };
  if (!isPlainObject(filter)) return { matched: false, reason: "filter_invalid" };
  if (filter.provider && String(filter.provider) !== String(event.provider ?? "")) return { matched: false, reason: "provider_mismatch" };
  if (filter.workspaceId && String(filter.workspaceId) !== String(event.workspaceId ?? "")) return { matched: false, reason: "workspace_mismatch" };
  if (filter.spaceId && String(filter.spaceId) !== String(event.spaceId ?? "")) return { matched: false, reason: "space_mismatch" };
  if (filter.eventType && String(filter.eventType) !== String(event.eventType ?? "")) return { matched: false, reason: "event_type_mismatch" };
  const pe = (filter as any).payloadEq;
  if (pe !== undefined) {
    if (!isPlainObject(pe)) return { matched: false, reason: "payload_eq_invalid" };
    const p = safePath((pe as any).path);
    if (!p) return { matched: false, reason: "payload_path_invalid" };
    const got = getByPath(event.payload ?? null, p);
    const want = (pe as any).value;
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) return { matched: false, reason: "payload_eq_mismatch" };
  }
  return { matched: true, reason: "matched" };
}

function watermarkKey(source: string) {
  return source === "governance.audit" ? "audit" : "ingress";
}

export async function tickEventTriggers(params: { pool: Pool; queue: Queue }) {
  const triggersRes = await params.pool.query(
    `
      SELECT *
      FROM trigger_definitions
      WHERE status = 'enabled' AND type = 'event'
      ORDER BY updated_at ASC
      LIMIT 50
    `,
  );
  for (const r of triggersRes.rows as any[]) {
    const trigger = toTrigger(r);
    const source = String(trigger.eventSource ?? "");
    const now = new Date();
    const traceId = `trigger:${trigger.triggerId}:${Date.now()}`;

    const wm = isPlainObject(trigger.eventWatermark) ? trigger.eventWatermark : {};
    if (source === "ingress.envelope") {
      const lastAt = typeof (wm as any).lastCreatedAt === "string" ? String((wm as any).lastCreatedAt) : "1970-01-01T00:00:00.000Z";
      const lastId = typeof (wm as any).lastId === "string" ? String((wm as any).lastId) : "00000000-0000-0000-0000-000000000000";
      const args: any[] = [trigger.tenantId, lastAt, lastAt, lastId];
      let idx = 4;
      let where = "tenant_id = $1 AND (created_at > $2 OR (created_at = $3 AND id > $4))";
      if (trigger.spaceId) {
        args.push(trigger.spaceId);
        where += ` AND space_id = $${++idx}`;
      }
      const evRes = await params.pool.query(
        `
          SELECT id, tenant_id, space_id, provider, workspace_id, event_id, body_json, created_at
          FROM channel_ingress_events
          WHERE ${where}
          ORDER BY created_at ASC, id ASC
          LIMIT 50
        `,
        args,
      );
      let newLastAt = lastAt;
      let newLastId = lastId;
      let missCount = 0;
      for (const ev of evRes.rows as any[]) {
        newLastAt = String(ev.created_at);
        newLastId = String(ev.id);
        const payload = ev.body_json ?? null;
        const eventType = payload && typeof payload === "object" ? String((payload as any).type ?? "") : "";
        const eventObj = {
          source,
          provider: String(ev.provider ?? ""),
          workspaceId: String(ev.workspace_id ?? ""),
          spaceId: ev.space_id ? String(ev.space_id) : null,
          eventId: String(ev.event_id ?? ""),
          eventType,
          payload,
        };
        const m = matchFilter(trigger.eventFilter, eventObj);
        if (!m.matched && m.reason !== "provider_mismatch" && m.reason !== "workspace_mismatch" && missCount < 5) {
          missCount += 1;
          await fireEventTrigger({
            pool: params.pool,
            queue: params.queue,
            trigger,
            scheduledAt: now.toISOString(),
            traceId,
            event: { ...eventObj, payload },
            eventRef: { source: "channel_ingress_events", id: String(ev.id) },
            matchReason: m.reason,
            matched: false,
          });
        }
        if (m.matched) {
          await fireEventTrigger({
            pool: params.pool,
            queue: params.queue,
            trigger,
            scheduledAt: now.toISOString(),
            traceId,
            event: { ...eventObj, payload },
            eventRef: { source: "channel_ingress_events", id: String(ev.id) },
            matchReason: "matched",
            matched: true,
          });
        }
      }
      const nextWm = { ...wm, lastCreatedAt: newLastAt, lastId: newLastId, source: watermarkKey(source) };
      await params.pool.query("UPDATE trigger_definitions SET event_watermark_json = $2::jsonb, updated_at = now() WHERE trigger_id = $1", [trigger.triggerId, nextWm]);
      continue;
    }

    if (source === "governance.audit") {
      const lastTs = typeof (wm as any).lastTimestamp === "string" ? String((wm as any).lastTimestamp) : "1970-01-01T00:00:00.000Z";
      const lastEventId = typeof (wm as any).lastEventId === "string" ? String((wm as any).lastEventId) : "00000000-0000-0000-0000-000000000000";
      const args: any[] = [trigger.tenantId, lastTs, lastTs, lastEventId];
      let idx = 4;
      let where = "tenant_id = $1 AND (timestamp > $2 OR (timestamp = $3 AND event_id > $4))";
      if (trigger.spaceId) {
        args.push(trigger.spaceId);
        where += ` AND space_id = $${++idx}`;
      }
      const evRes = await params.pool.query(
        `
          SELECT event_id, tenant_id, space_id, resource_type, action, input_digest, output_digest, timestamp
          FROM audit_events
          WHERE ${where}
          ORDER BY timestamp ASC, event_id ASC
          LIMIT 50
        `,
        args,
      );
      let newLastTs = lastTs;
      let newLastEventId = lastEventId;
      let missCount = 0;
      for (const ev of evRes.rows as any[]) {
        newLastTs = String(ev.timestamp);
        newLastEventId = String(ev.event_id);
        const eventType = `${String(ev.resource_type ?? "")}.${String(ev.action ?? "")}`;
        const payload = { inputDigest: ev.input_digest ?? null, outputDigest: ev.output_digest ?? null };
        const eventObj = {
          source,
          provider: null,
          workspaceId: null,
          spaceId: ev.space_id ? String(ev.space_id) : null,
          eventId: String(ev.event_id ?? ""),
          eventType,
          payload,
        };
        const m = matchFilter(trigger.eventFilter, eventObj);
        if (!m.matched && missCount < 5) {
          missCount += 1;
          await fireEventTrigger({
            pool: params.pool,
            queue: params.queue,
            trigger,
            scheduledAt: now.toISOString(),
            traceId,
            event: eventObj,
            eventRef: { source: "audit_events", eventId: String(ev.event_id) },
            matchReason: m.reason,
            matched: false,
          });
        }
        if (m.matched) {
          await fireEventTrigger({
            pool: params.pool,
            queue: params.queue,
            trigger,
            scheduledAt: now.toISOString(),
            traceId,
            event: eventObj,
            eventRef: { source: "audit_events", eventId: String(ev.event_id) },
            matchReason: "matched",
            matched: true,
          });
        }
      }
      const nextWm = { ...wm, lastTimestamp: newLastTs, lastEventId: newLastEventId, source: watermarkKey(source) };
      await params.pool.query("UPDATE trigger_definitions SET event_watermark_json = $2::jsonb, updated_at = now() WHERE trigger_id = $1", [trigger.triggerId, nextWm]);
      continue;
    }
  }
}
