"use client";

import { useState, useCallback } from "react";
import { apiFetch, text as i18nText } from "@/lib/api";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ActionBinding {
  action: "create" | "update" | "delete";
  entityName: string;
  /** Tool reference, e.g. "entity.create" — resolved by platform to effective version */
  toolRef?: string;
  /** Risk level: low/medium/high (informational, actual enforcement by Tool system) */
  riskLevel?: string;
}

/** Default toolRef per action — maps to platform-registered Tools */
const DEFAULT_TOOL_REFS: Record<string, string> = {
  create: "entity.create",
  update: "entity.update",
  delete: "entity.delete",
};

export interface ActionResult {
  ok: boolean;
  jobId?: string;
  /** Run ID from Tool execution receipt */
  runId?: string;
  /** Step ID from Tool execution receipt */
  stepId?: string;
  approvalId?: string;
  /** Execution status: queued = processing, needs_approval = awaiting approval */
  status?: "queued" | "needs_approval";
  error?: string;
}

export interface ActionState {
  executing: boolean;
  lastResult: ActionResult | null;
  /** Currently editing record (for update form) */
  editingRecord: { id: string; payload: Record<string, unknown> } | null;
  /** Whether the create form is open */
  showCreateForm: boolean;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * useNl2UiActions — provides write actions for NL2UI-generated UIs.
 *
 * All writes go through the platform tool execution pipeline (POST /tools/:toolRef/execute),
 * including governance, approval, capability envelope, and audit chain.
 */
export function useNl2UiActions(
  actionBindings: ActionBinding[],
  locale: string,
  onRefresh?: () => void,
): {
  state: ActionState;
  createRecord: (entityName: string, payload: Record<string, unknown>) => void;
  updateRecord: (entityName: string, id: string, patch: Record<string, unknown>) => void;
  deleteRecord: (entityName: string, id: string) => void;
  openCreateForm: () => void;
  closeCreateForm: () => void;
  openEditForm: (id: string, payload: Record<string, unknown>) => void;
  closeEditForm: () => void;
  clearResult: () => void;
} {
  const [state, setState] = useState<ActionState>({
    executing: false,
    lastResult: null,
    editingRecord: null,
    showCreateForm: false,
  });

  const genIdemKey = () => {
    if (typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function") {
      return `nl2ui-${(crypto as any).randomUUID()}`;
    }
    return `nl2ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const resolveToolRef = useCallback((action: string, entityName: string): string => {
    const binding = actionBindings.find((b) => b.action === action && b.entityName === entityName)
      ?? actionBindings.find((b) => b.action === action);
    return binding?.toolRef || DEFAULT_TOOL_REFS[action] || `entity.${action}`;
  }, [actionBindings]);

  // ─── Generic Tool Execute ─────────────────────────────────────────────
  const executeTool = useCallback(async (
    toolRef: string,
    input: Record<string, unknown>,
    closeForm: Partial<{ showCreateForm: boolean; editingRecord: null }>,
  ) => {
    setState((s) => ({ ...s, executing: true, lastResult: null }));
    try {
      const idemKey = genIdemKey();
      const res = await apiFetch(`/orchestrator/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify({ toolRef, input, idempotencyKey: idemKey }),
      });
      const json: any = await res.json().catch(() => null);
      if (!res.ok) {
        const errMsg = json?.message
          ? (typeof json.message === "object" ? i18nText(json.message, locale) : String(json.message))
          : `HTTP ${res.status}`;
        setState((s) => ({ ...s, executing: false, lastResult: { ok: false, error: errMsg }, ...closeForm }));
        return;
      }
      const status = json?.receipt?.status ?? "queued";
      setState((s) => ({
        ...s,
        executing: false,
        lastResult: { ok: true, jobId: json?.jobId, runId: json?.runId, stepId: json?.stepId, approvalId: json?.approvalId, status },
        ...closeForm,
      }));
      // Refresh data after successful queue (the tool system will process async)
      if (status === "queued") {
        // Delay refresh slightly to give the worker time to process
        setTimeout(() => onRefresh?.(), 1500);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, executing: false, lastResult: { ok: false, error: msg }, ...closeForm }));
    }
  }, [locale, onRefresh]);

  // ─── Public API — all operations go through Tool system ─────────────
  const createRecord = useCallback((entityName: string, payload: Record<string, unknown>) => {
    const toolRef = resolveToolRef("create", entityName);
    void executeTool(toolRef, { entityName, payload, schemaName: "core" }, { showCreateForm: false });
  }, [executeTool, resolveToolRef]);

  const updateRecord = useCallback((entityName: string, id: string, patch: Record<string, unknown>) => {
    const toolRef = resolveToolRef("update", entityName);
    void executeTool(toolRef, { entityName, id, payload: patch, schemaName: "core" }, { editingRecord: null });
  }, [executeTool, resolveToolRef]);

  const deleteRecord = useCallback((entityName: string, id: string) => {
    /* Confirm before delete to avoid mistakes */
    const confirmed = typeof window !== "undefined"
      ? window.confirm("Delete this record? This action cannot be undone.")
      : true;
    if (!confirmed) return;
    const toolRef = resolveToolRef("delete", entityName);
    void executeTool(toolRef, { entityName, id, schemaName: "core" }, {});
  }, [executeTool, resolveToolRef]);

  // ─── Form controls ─────────────────────────────────────────────────
  const openCreateForm = useCallback(() => {
    setState((s) => ({ ...s, showCreateForm: true, editingRecord: null, lastResult: null }));
  }, []);

  const closeCreateForm = useCallback(() => {
    setState((s) => ({ ...s, showCreateForm: false }));
  }, []);

  const openEditForm = useCallback((id: string, payload: Record<string, unknown>) => {
    setState((s) => ({ ...s, editingRecord: { id, payload }, showCreateForm: false, lastResult: null }));
  }, []);

  const closeEditForm = useCallback(() => {
    setState((s) => ({ ...s, editingRecord: null }));
  }, []);

  const clearResult = useCallback(() => {
    setState((s) => ({ ...s, lastResult: null }));
  }, []);

  return {
    state,
    createRecord,
    updateRecord,
    deleteRecord,
    openCreateForm,
    closeCreateForm,
    openEditForm,
    closeEditForm,
    clearResult,
  };
}
