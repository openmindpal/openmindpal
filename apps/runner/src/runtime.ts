/**
 * runtime.ts — Runner 运行时模块 (核心已迁移至 @openslin/shared)
 *
 * 统一从共享层导入核心实现，保留 Runner 独有的 Egress 审计功能。
 * @see packages/shared/src/runtime.ts
 */

// ─── 从 @openslin/shared 导入统一实现 ────────────────────────────────────────────
export {
  isPlainObject,
  normalizeNetworkPolicy,
  isAllowedHost,
  isAllowedEgress,
} from "@openslin/shared";

export type {
  NetworkPolicyRule,
  NetworkPolicy,
  EgressEvent,
  EgressCheck,
} from "@openslin/shared";

// 重新导入类型以供本地使用
import type { EgressEvent } from "@openslin/shared";

// ── Egress 审计日志持久化 ──────────────────────────────────────────
export type EgressAuditEntry = {
  timestamp: string;
  requestId: string;
  toolRef: string;
  tenantId: string;
  host: string;
  method: string;
  allowed: boolean;
  policyMatch?: EgressEvent["policyMatch"];
  status?: number;
  errorCategory?: string;
};

const egressAuditBuffer: EgressAuditEntry[] = [];
const EGRESS_AUDIT_FLUSH_SIZE = Number(process.env.EGRESS_AUDIT_FLUSH_SIZE ?? "50") || 50;
const EGRESS_AUDIT_FLUSH_INTERVAL_MS = Number(process.env.EGRESS_AUDIT_FLUSH_INTERVAL_MS ?? "5000") || 5000;
let egressFlushTimer: ReturnType<typeof setInterval> | null = null;
let egressAuditSink: ((entries: EgressAuditEntry[]) => Promise<void>) | null = null;

export function setEgressAuditSink(sink: (entries: EgressAuditEntry[]) => Promise<void>) {
  egressAuditSink = sink;
  if (!egressFlushTimer) {
    egressFlushTimer = setInterval(() => flushEgressAuditBuffer(), EGRESS_AUDIT_FLUSH_INTERVAL_MS);
    egressFlushTimer.unref();
  }
}

export function pushEgressAudit(ctx: { requestId: string; toolRef: string; tenantId: string }, events: EgressEvent[]) {
  const now = new Date().toISOString();
  for (const ev of events) {
    egressAuditBuffer.push({
      timestamp: now,
      requestId: ctx.requestId,
      toolRef: ctx.toolRef,
      tenantId: ctx.tenantId,
      host: ev.host,
      method: ev.method,
      allowed: ev.allowed,
      policyMatch: ev.policyMatch,
      status: ev.status,
      errorCategory: ev.errorCategory,
    });
  }
  if (egressAuditBuffer.length >= EGRESS_AUDIT_FLUSH_SIZE) {
    void flushEgressAuditBuffer();
  }
}

async function flushEgressAuditBuffer() {
  if (!egressAuditBuffer.length || !egressAuditSink) return;
  const batch = egressAuditBuffer.splice(0, EGRESS_AUDIT_FLUSH_SIZE);
  try {
    await egressAuditSink(batch);
  } catch {
    // 失败时将条目放回缓冲区头部以便重试
    egressAuditBuffer.unshift(...batch);
  }
}

