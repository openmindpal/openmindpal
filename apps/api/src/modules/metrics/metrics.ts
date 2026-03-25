type CounterKey = string;

type HistogramKey = string;
type GaugeKey = string;

function keyOf(parts: Record<string, string>) {
  const keys = Object.keys(parts).sort();
  return keys.map((k) => `${k}=${parts[k]}`).join("|");
}

function escapeLabelValue(v: string) {
  return v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\"", "\\\"");
}

function renderLabels(labels: Record<string, string>) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const kv = keys.map((k) => `${k}="${escapeLabelValue(labels[k] ?? "")}"`).join(",");
  return `{${kv}}`;
}

type Histogram = {
  buckets: number[];
  bucketCounts: number[];
  count: number;
  sum: number;
};

export function createMetricsRegistry() {
  const startedAtMs = Date.now();
  const counters = new Map<CounterKey, { labels: Record<string, string>; value: number }>();
  const histograms = new Map<HistogramKey, { labels: Record<string, string>; h: Histogram }>();
  const gauges = new Map<GaugeKey, { labels: Record<string, string>; value: number }>();

  const durationBucketsMs = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

  function incCounter(name: string, labels: Record<string, string>, by = 1) {
    const k = `${name}|${keyOf(labels)}`;
    const cur = counters.get(k);
    if (cur) {
      cur.value += by;
      return;
    }
    counters.set(k, { labels: { ...labels, __name__: name }, value: by });
  }

  function observeHistogram(name: string, labels: Record<string, string>, value: number, buckets: number[]) {
    const k = `${name}|${keyOf(labels)}`;
    let cur = histograms.get(k);
    if (!cur) {
      cur = {
        labels: { ...labels, __name__: name },
        h: { buckets: [...buckets], bucketCounts: new Array(buckets.length + 1).fill(0), count: 0, sum: 0 },
      };
      histograms.set(k, cur);
    }
    cur.h.count += 1;
    cur.h.sum += value;
    let idx = buckets.findIndex((b) => value <= b);
    if (idx < 0) idx = buckets.length;
    cur.h.bucketCounts[idx] += 1;
  }

  function setGauge(name: string, labels: Record<string, string>, value: number) {
    const k = `${name}|${keyOf(labels)}`;
    const cur = gauges.get(k);
    if (cur) {
      cur.value = value;
      return;
    }
    gauges.set(k, { labels: { ...labels, __name__: name }, value });
  }

  function observeRequest(params: { method: string; route: string; statusCode: number; latencyMs: number }) {
    const statusClass = `${Math.floor(params.statusCode / 100)}xx`;
    incCounter("openslin_http_requests_total", { method: params.method, route: params.route, status_class: statusClass }, 1);
    observeHistogram("openslin_http_request_duration_ms", { method: params.method, route: params.route }, params.latencyMs, durationBucketsMs);
  }

  function incAuthzDenied(params: { resourceType: string; action: string }) {
    incCounter("openslin_authz_denied_total", { resource_type: params.resourceType, action: params.action }, 1);
  }

  function incAuditWriteFailed(params: { errorCode: string }) {
    incCounter("openslin_audit_write_failed_total", { error_code: params.errorCode }, 1);
  }

  function incAuditOutboxDispatch(params: { result: "ok" | "failed" }, by: number) {
    if (by <= 0) return;
    incCounter("openslin_audit_outbox_dispatch_total", { result: params.result }, by);
  }

  function incAuditOutboxEnqueue(params: { result: "ok" | "failed"; kind: string }) {
    incCounter("openslin_audit_outbox_enqueue_total", { result: params.result, kind: params.kind }, 1);
  }

  function setAuditOutboxBacklog(params: { status: string; count: number }) {
    setGauge("openslin_audit_outbox_backlog", { status: params.status }, params.count);
  }

  function incModelChat(params: { result: "success" | "denied" | "error" }) {
    incCounter("openslin_model_chat_total", { result: params.result }, 1);
  }

  function incModelCandidateSkipped(params: { reason: string }) {
    incCounter("openslin_model_chat_candidate_skipped_total", { reason: params.reason }, 1);
  }

  function incAgentPlanFailed(params: { runtime: "agent-runtime" | "collab-runtime"; category: string }) {
    incCounter("openslin_agent_plan_failed_total", { runtime: params.runtime, category: params.category }, 1);
  }

  function incAlertFired(params: { alert: string }) {
    incCounter("openslin_alert_fired_total", { alert: params.alert }, 1);
  }

  function incGovernancePipelineAction(params: { action: string; result: "ok" | "denied" | "error" }) {
    incCounter("openslin_governance_pipeline_actions_total", { action: params.action, result: params.result }, 1);
  }

  function incGovernanceGateFailed(params: { gateType: string }) {
    incCounter("openslin_governance_gate_failed_total", { gate_type: params.gateType }, 1);
  }

  function incEvalRun(params: { action: "enqueue" | "succeeded" | "failed" | "passed" | "not_passed" }) {
    incCounter("openslin_eval_run_total", { action: params.action }, 1);
  }

  function setWorkflowQueueBacklog(params: { status: string; count: number }) {
    setGauge("openslin_workflow_queue_backlog", { status: params.status }, params.count);
  }

  function setWorkerHeartbeatAgeSeconds(params: { worker: string; ageSeconds: number }) {
    setGauge("openslin_worker_heartbeat_age_seconds", { worker: params.worker }, params.ageSeconds);
  }

  function setWorkerWorkflowStepCount(params: { result: "success" | "error"; count: number }) {
    setGauge("openslin_worker_workflow_steps_processed", { result: params.result }, params.count);
  }

  function setWorkerToolExecuteCount(params: { result: "success" | "error"; count: number }) {
    setGauge("openslin_worker_tool_execute_processed", { result: params.result }, params.count);
  }

  function setCollabRunBacklog(params: { status: string; count: number }) {
    setGauge("openslin_collab_runs_backlog", { status: params.status }, params.count);
  }

  function setCollabEventCount1h(params: { type: string; count: number }) {
    setGauge("openslin_collab_events_1h_total", { type: params.type }, params.count);
  }

  function setCollabRunDurationAvgMs1h(params: { value: number }) {
    setGauge("openslin_collab_run_duration_ms_avg_1h", {}, params.value);
  }

  function setCollabStepsTotal(params: { actorRole: string; status: string; count: number }) {
    setGauge("openslin_collab_steps_total", { actor_role: params.actorRole, status: params.status }, params.count);
  }

  function setCollabBlockedTotal(params: { actorRole: string; reason: string; count: number }) {
    setGauge("openslin_collab_blocked_total", { actor_role: params.actorRole, reason: params.reason }, params.count);
  }

  function setCollabNeedsApprovalTotal(params: { actorRole: string; count: number }) {
    setGauge("openslin_collab_needs_approval_total", { actor_role: params.actorRole }, params.count);
  }

  function setCollabStepDurationBucket1h(params: { actorRole: string; le: string; count: number }) {
    setGauge("openslin_collab_step_duration_ms_bucket", { actor_role: params.actorRole, le: params.le }, params.count);
  }

  function setCollabStepDurationCount1h(params: { actorRole: string; count: number }) {
    setGauge("openslin_collab_step_duration_ms_count", { actor_role: params.actorRole }, params.count);
  }

  function setCollabStepDurationSumMs1h(params: { actorRole: string; sumMs: number }) {
    setGauge("openslin_collab_step_duration_ms_sum", { actor_role: params.actorRole }, params.sumMs);
  }

  function observeKnowledgeSearch(params: { result: "ok" | "denied" | "error"; latencyMs: number }) {
    incCounter("openslin_knowledge_search_total", { result: params.result }, 1);
    observeHistogram("openslin_knowledge_search_duration_ms", { result: params.result }, params.latencyMs, durationBucketsMs);
  }

  function observeKnowledgeEvidenceResolve(params: { result: "ok" | "denied" | "not_found" | "error"; latencyMs: number }) {
    incCounter("openslin_knowledge_evidence_resolve_total", { result: params.result }, 1);
    observeHistogram("openslin_knowledge_evidence_resolve_duration_ms", { result: params.result }, params.latencyMs, durationBucketsMs);
  }

  function observeSyncPush(params: { result: "ok" | "denied" | "error"; latencyMs: number; conflicts: number; deduped: number }) {
    incCounter("openslin_sync_push_total", { result: params.result }, 1);
    observeHistogram("openslin_sync_push_duration_ms", { result: params.result }, params.latencyMs, durationBucketsMs);
    incCounter("openslin_sync_push_conflicts_total", { result: params.result }, Math.max(0, params.conflicts));
    incCounter("openslin_sync_push_deduped_total", { result: params.result }, Math.max(0, params.deduped));
  }

  function observeSyncPull(params: { result: "ok" | "denied" | "error"; latencyMs: number; opsReturned: number }) {
    incCounter("openslin_sync_pull_total", { result: params.result }, 1);
    observeHistogram("openslin_sync_pull_duration_ms", { result: params.result }, params.latencyMs, durationBucketsMs);
    observeHistogram("openslin_sync_pull_ops_returned", { result: params.result }, params.opsReturned, [0, 1, 2, 5, 10, 20, 50, 100, 200, 500]);
  }

  function renderPrometheus() {
    const lines: string[] = [];

    const uptimeSec = (Date.now() - startedAtMs) / 1000;
    lines.push("# HELP openslin_process_uptime_seconds Process uptime in seconds.");
    lines.push("# TYPE openslin_process_uptime_seconds gauge");
    lines.push(`openslin_process_uptime_seconds ${uptimeSec.toFixed(3)}`);

    lines.push("# HELP openslin_http_requests_total Total HTTP requests.");
    lines.push("# TYPE openslin_http_requests_total counter");

    lines.push("# HELP openslin_http_request_duration_ms HTTP request duration in milliseconds.");
    lines.push("# TYPE openslin_http_request_duration_ms histogram");

    lines.push("# HELP openslin_authz_denied_total Total authorization denials.");
    lines.push("# TYPE openslin_authz_denied_total counter");

    lines.push("# HELP openslin_audit_write_failed_total Total audit write failures.");
    lines.push("# TYPE openslin_audit_write_failed_total counter");

    lines.push("# HELP openslin_audit_outbox_dispatch_total Total outbox dispatch results.");
    lines.push("# TYPE openslin_audit_outbox_dispatch_total counter");

    lines.push("# HELP openslin_audit_outbox_enqueue_total Total outbox enqueue results.");
    lines.push("# TYPE openslin_audit_outbox_enqueue_total counter");

    lines.push("# HELP openslin_audit_outbox_backlog Audit outbox backlog by status.");
    lines.push("# TYPE openslin_audit_outbox_backlog gauge");

    lines.push("# HELP openslin_model_chat_total Total model chat calls by result.");
    lines.push("# TYPE openslin_model_chat_total counter");

    lines.push("# HELP openslin_model_chat_candidate_skipped_total Total skipped model candidates by reason.");
    lines.push("# TYPE openslin_model_chat_candidate_skipped_total counter");

    lines.push("# HELP openslin_governance_pipeline_actions_total Total governance pipeline actions.");
    lines.push("# TYPE openslin_governance_pipeline_actions_total counter");

    lines.push("# HELP openslin_governance_gate_failed_total Total governance gate failures.");
    lines.push("# TYPE openslin_governance_gate_failed_total counter");

    lines.push("# HELP openslin_workflow_queue_backlog Workflow queue backlog by status.");
    lines.push("# TYPE openslin_workflow_queue_backlog gauge");

    lines.push("# HELP openslin_worker_heartbeat_age_seconds Worker heartbeat age in seconds.");
    lines.push("# TYPE openslin_worker_heartbeat_age_seconds gauge");

    lines.push("# HELP openslin_worker_workflow_steps_processed Worker processed workflow steps (gauge snapshot).");
    lines.push("# TYPE openslin_worker_workflow_steps_processed gauge");

    lines.push("# HELP openslin_worker_tool_execute_processed Worker processed tool executions (gauge snapshot).");
    lines.push("# TYPE openslin_worker_tool_execute_processed gauge");

    lines.push("# HELP openslin_collab_runs_backlog Collab run backlog by status.");
    lines.push("# TYPE openslin_collab_runs_backlog gauge");

    lines.push("# HELP openslin_collab_events_1h_total Collab events count in last hour.");
    lines.push("# TYPE openslin_collab_events_1h_total gauge");

    lines.push("# HELP openslin_collab_run_duration_ms_avg_1h Average collab run duration in ms (last hour).");
    lines.push("# TYPE openslin_collab_run_duration_ms_avg_1h gauge");

    lines.push("# HELP openslin_collab_steps_total Collab steps count by actor role and status (snapshot).");
    lines.push("# TYPE openslin_collab_steps_total gauge");

    lines.push("# HELP openslin_collab_blocked_total Collab blocked events by actor role and reason (snapshot).");
    lines.push("# TYPE openslin_collab_blocked_total gauge");

    lines.push("# HELP openslin_collab_needs_approval_total Collab needs approval events by actor role (snapshot).");
    lines.push("# TYPE openslin_collab_needs_approval_total gauge");

    lines.push("# HELP openslin_collab_step_duration_ms_bucket Collab step duration histogram buckets in ms (snapshot).");
    lines.push("# TYPE openslin_collab_step_duration_ms_bucket gauge");

    lines.push("# HELP openslin_collab_step_duration_ms_count Collab step duration histogram count (snapshot).");
    lines.push("# TYPE openslin_collab_step_duration_ms_count gauge");

    lines.push("# HELP openslin_collab_step_duration_ms_sum Collab step duration histogram sum in ms (snapshot).");
    lines.push("# TYPE openslin_collab_step_duration_ms_sum gauge");

    lines.push("# HELP openslin_knowledge_search_total Total knowledge search calls by result.");
    lines.push("# TYPE openslin_knowledge_search_total counter");

    lines.push("# HELP openslin_knowledge_search_duration_ms Knowledge search duration in milliseconds.");
    lines.push("# TYPE openslin_knowledge_search_duration_ms histogram");

    lines.push("# HELP openslin_knowledge_evidence_resolve_total Total evidence resolve calls by result.");
    lines.push("# TYPE openslin_knowledge_evidence_resolve_total counter");

    lines.push("# HELP openslin_knowledge_evidence_resolve_duration_ms Evidence resolve duration in milliseconds.");
    lines.push("# TYPE openslin_knowledge_evidence_resolve_duration_ms histogram");

    lines.push("# HELP openslin_sync_push_total Total sync push calls by result.");
    lines.push("# TYPE openslin_sync_push_total counter");

    lines.push("# HELP openslin_sync_push_duration_ms Sync push duration in milliseconds.");
    lines.push("# TYPE openslin_sync_push_duration_ms histogram");

    lines.push("# HELP openslin_sync_push_conflicts_total Total sync push conflicts by result.");
    lines.push("# TYPE openslin_sync_push_conflicts_total counter");

    lines.push("# HELP openslin_sync_push_deduped_total Total sync push deduped ops by result.");
    lines.push("# TYPE openslin_sync_push_deduped_total counter");

    lines.push("# HELP openslin_sync_pull_total Total sync pull calls by result.");
    lines.push("# TYPE openslin_sync_pull_total counter");

    lines.push("# HELP openslin_sync_pull_duration_ms Sync pull duration in milliseconds.");
    lines.push("# TYPE openslin_sync_pull_duration_ms histogram");

    lines.push("# HELP openslin_sync_pull_ops_returned Ops returned by sync pull.");
    lines.push("# TYPE openslin_sync_pull_ops_returned histogram");

    for (const v of counters.values()) {
      const { __name__, ...labels } = v.labels as any;
      lines.push(`${__name__}${renderLabels(labels)} ${v.value}`);
    }

    for (const v of gauges.values()) {
      const { __name__, ...labels } = v.labels as any;
      lines.push(`${__name__}${renderLabels(labels)} ${v.value}`);
    }

    for (const v of histograms.values()) {
      const { __name__, ...labels } = v.labels as any;
      let cumulative = 0;
      for (let i = 0; i < v.h.bucketCounts.length; i++) {
        cumulative += v.h.bucketCounts[i] ?? 0;
        const le = i < v.h.buckets.length ? String(v.h.buckets[i]) : "+Inf";
        lines.push(`${__name__}_bucket${renderLabels({ ...labels, le })} ${cumulative}`);
      }
      lines.push(`${__name__}_count${renderLabels(labels)} ${v.h.count}`);
      lines.push(`${__name__}_sum${renderLabels(labels)} ${v.h.sum.toFixed(3)}`);
    }

    return lines.join("\n") + "\n";
  }

  return {
    observeRequest,
    incAuthzDenied,
    incAuditWriteFailed,
    incAuditOutboxDispatch,
    incAuditOutboxEnqueue,
    setAuditOutboxBacklog,
    incModelChat,
    incModelCandidateSkipped,
    incAgentPlanFailed,
    incGovernancePipelineAction,
    incGovernanceGateFailed,
    incEvalRun,
    setWorkflowQueueBacklog,
    setWorkerHeartbeatAgeSeconds,
    setWorkerWorkflowStepCount,
    setWorkerToolExecuteCount,
    setCollabRunBacklog,
    setCollabEventCount1h,
    setCollabRunDurationAvgMs1h,
    setCollabStepsTotal,
    setCollabBlockedTotal,
    setCollabNeedsApprovalTotal,
    setCollabStepDurationBucket1h,
    setCollabStepDurationCount1h,
    setCollabStepDurationSumMs1h,
    observeKnowledgeSearch,
    observeKnowledgeEvidenceResolve,
    observeSyncPush,
    observeSyncPull,
    incAlertFired,
    renderPrometheus,
  };
}

export type MetricsRegistry = ReturnType<typeof createMetricsRegistry>;
