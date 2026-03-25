-- 122: AI Event Reasoning Skill
-- Three-tier decision engine: fast rules → pattern match → LLM reasoning

-- Reasoning decision log
CREATE TABLE IF NOT EXISTS event_reasoning_logs (
  reasoning_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  space_id        TEXT,
  event_source_id TEXT,                         -- channel_ingress_events.id or audit_events.event_id
  event_type      TEXT NOT NULL,                -- e.g. "temperature.alert", "device.heartbeat_lost"
  provider        TEXT,
  workspace_id    TEXT,
  event_payload   JSONB,                        -- redacted event payload digest (not raw)

  -- Decision result
  tier            TEXT NOT NULL DEFAULT 'rule', -- 'rule' | 'pattern' | 'llm'
  decision        TEXT NOT NULL DEFAULT 'ignore', -- 'execute' | 'escalate' | 'ignore' | 'error'
  confidence      REAL,                         -- 0.0~1.0 for pattern/llm tiers
  reasoning_text  TEXT,                         -- LLM reasoning output (tier=llm only)

  -- Action taken
  action_kind     TEXT,                         -- 'workflow' | 'notify' | 'tool' | null
  action_ref      TEXT,                         -- e.g. toolRef or notification templateId
  action_input    JSONB,                        -- redacted action input digest
  run_id          UUID,                         -- linked workflow run if created
  step_id         UUID,

  -- Rule/pattern match details
  matched_rule_id TEXT,                         -- which rule or pattern matched
  match_digest    JSONB,                        -- match details for observability

  -- Timing & trace
  latency_ms      INT,
  trace_id        TEXT,
  error_category  TEXT,
  error_digest    JSONB,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_reasoning_logs_tenant_created_idx
  ON event_reasoning_logs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS event_reasoning_logs_tenant_decision_idx
  ON event_reasoning_logs (tenant_id, decision, created_at DESC);

CREATE INDEX IF NOT EXISTS event_reasoning_logs_event_source_idx
  ON event_reasoning_logs (tenant_id, event_source_id);

-- Reasoning rules (user-defined fast rules + pattern templates)
CREATE TABLE IF NOT EXISTS event_reasoning_rules (
  rule_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  space_id        TEXT,
  name            TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'enabled', -- enabled | disabled
  tier            TEXT NOT NULL DEFAULT 'rule',    -- 'rule' | 'pattern'
  priority        INT NOT NULL DEFAULT 100,        -- lower = higher priority

  -- Matching criteria
  event_type_pattern TEXT,                      -- glob pattern e.g. "temperature.*"
  provider_pattern   TEXT,                      -- glob pattern e.g. "iot.*"
  condition_expr     JSONB,                     -- structured condition expression

  -- Action to take when matched
  decision        TEXT NOT NULL DEFAULT 'execute',
  action_kind     TEXT,
  action_ref      TEXT,
  action_input_template JSONB,                  -- input template with {{event.*}} placeholders

  created_by_subject_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS event_reasoning_rules_tenant_status_idx
  ON event_reasoning_rules (tenant_id, status, priority ASC);
