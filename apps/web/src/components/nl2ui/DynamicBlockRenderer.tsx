"use client";

import React, { useMemo, useState, useCallback, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { BlockEditorWidget, type Block } from "@/components/workbench/widgets/BlockEditorWidget";
import { DataGridWidget, type GridColumn, type GridRow } from "@/components/workbench/widgets/DataGridWidget";
import { KanbanBoardWidget, type KanbanColumn } from "@/components/workbench/widgets/KanbanBoardWidget";
import { BiDashboardWidget, type MetricCard } from "@/components/workbench/widgets/BiDashboardWidget";
import { ChartWidget } from "@/components/workbench/widgets/ChartWidget";
import { TimelineWidget } from "@/components/workbench/widgets/TimelineWidget";
import { CalendarWidget } from "@/components/workbench/widgets/CalendarWidget";
import { StatsRowWidget } from "@/components/workbench/widgets/StatsRowWidget";
import { useNl2UiData, toGridData, toKanbanData, toCardListData, toBiData, toChartData, toTimelineData, toCalendarData, toStatsData, type DataMap, type BindingResult, type EntityRecord } from "./useNl2UiData";
import { useNl2UiActions, type ActionBinding } from "./useNl2UiActions";
import { text as i18nText } from "@/lib/api";
import { t } from "@/lib/i18n";
import { ReferencePicker } from "./ReferencePicker";
import { useLayoutEditor, EditableArea, computeContainerHeight, type AreaLayoutItem } from "./LayoutEditor";

// ─── Style prefs → CSS token mapping ─────────────────────────────────────

interface StylePrefs {
  fontSize?: "small" | "medium" | "large";
  cardStyle?: "minimal" | "modern" | "classic";
  colorTheme?: "blue" | "green" | "warm" | "dark";
  density?: "compact" | "comfortable";
}

const COLOR_THEMES: Record<string, { primary: string; primaryLight: string; accent: string; hoverBg: string; accentRgb: string }> = {
  blue:  { primary: "#6366f1", primaryLight: "#e0e7ff", accent: "#818cf8", hoverBg: "rgba(99,102,241,.04)",  accentRgb: "99,102,241" },
  green: { primary: "#10b981", primaryLight: "#d1fae5", accent: "#34d399", hoverBg: "rgba(16,185,129,.04)", accentRgb: "16,185,129" },
  warm:  { primary: "#f59e0b", primaryLight: "#fef3c7", accent: "#fbbf24", hoverBg: "rgba(245,158,11,.04)", accentRgb: "245,158,11" },
  dark:  { primary: "#6366f1", primaryLight: "#334155", accent: "#818cf8", hoverBg: "rgba(99,102,241,.08)", accentRgb: "99,102,241" },
};

const FONT_SIZES: Record<string, { base: number; sm: number; heading: number; title: number }> = {
  small:  { base: 12, sm: 10, heading: 13, title: 14 },
  medium: { base: 13, sm: 11, heading: 14, title: 16 },
  large:  { base: 15, sm: 12, heading: 16, title: 18 },
};

const DENSITY: Record<string, { gap: number; pad: number; radius: number }> = {
  compact:     { gap: 8,  pad: 10, radius: 6 },
  comfortable: { gap: 16, pad: 16, radius: 12 },
};

const CARD_STYLES: Record<string, { shadow: string; borderWidth: number; radius: number }> = {
  minimal: { shadow: "none",                             borderWidth: 1, radius: 6 },
  modern:  { shadow: "0 1px 3px rgba(0,0,0,0.04)",       borderWidth: 1, radius: 12 },
  classic: { shadow: "0 1px 2px rgba(0,0,0,0.06)",       borderWidth: 2, radius: 4 },
};

/** Parse stylePrefs into CSS custom properties */
function resolveStyleTokens(prefs?: StylePrefs): Record<string, string> {
  const p = prefs ?? {};
  const color  = COLOR_THEMES[p.colorTheme ?? "blue"] ?? COLOR_THEMES.blue!;
  const font   = FONT_SIZES[p.fontSize ?? "medium"] ?? FONT_SIZES.medium!;
  const dense  = DENSITY[p.density ?? "comfortable"] ?? DENSITY.comfortable!;
  const card   = CARD_STYLES[p.cardStyle ?? "modern"] ?? CARD_STYLES.modern!;
  const isDark = p.colorTheme === "dark";

  return {
    "--n2u-primary":       color.primary,
    "--n2u-primary-light": color.primaryLight,
    "--n2u-accent":        color.accent,
    "--n2u-hover-bg":      color.hoverBg,
    "--n2u-accent-rgb":    color.accentRgb,
    "--n2u-font-base":     `${font.base}px`,
    "--n2u-font-sm":       `${font.sm}px`,
    "--n2u-font-heading":  `${font.heading}px`,
    "--n2u-font-title":    `${font.title}px`,
    "--n2u-gap":           `${dense.gap}px`,
    "--n2u-pad":           `${dense.pad}px`,
    "--n2u-radius":        `${dense.radius}px`,
    "--n2u-card-radius":   `${card.radius}px`,
    "--n2u-card-shadow":   card.shadow,
    "--n2u-card-border":   `${card.borderWidth}px`,
    // Override global theme variables
    "--sl-fg":      isDark ? "#e2e8f0" : "#1e293b",
    "--sl-muted":   isDark ? "#94a3b8" : "#64748b",
    "--sl-surface": isDark ? "#1e293b" : "#fff",
    "--sl-bg":      isDark ? "#0f172a" : "#f8fafc",
    "--sl-border":  isDark ? "#334155" : "#e5e7eb",
  };
}

/** Generate scoped CSS overrides for widget class styles */
function buildScopedThemeCSS(scopeClass: string, prefs?: StylePrefs): string {
  const p = prefs ?? {};
  const color = COLOR_THEMES[p.colorTheme ?? "blue"] ?? COLOR_THEMES.blue!;
  const isDark = p.colorTheme === "dark";
  const darkBg = isDark ? "background:#0f172a;color:#e2e8f0;" : "";
  return `
.${scopeClass}{${darkBg}}
.${scopeClass} .__dg_row:hover{background:${color.hoverBg}!important}
.${scopeClass} .__dg_th:hover{background:${color.hoverBg}}
.${scopeClass} .__cl_card:hover{box-shadow:0 8px 24px rgba(${color.accentRgb},.12),0 1.5px 4px rgba(0,0,0,.04)!important}
.${scopeClass} .__st_card:hover{box-shadow:0 6px 20px rgba(${color.accentRgb},.12)!important}
.${scopeClass} .__cw_bar:hover{filter:brightness(1.12)}
.${scopeClass} .__cw_dot:hover{--dot-c:${color.primary}}
`;
}

/**
 * Dynamic Block Renderer - renders UI dynamically based on model-generated config.
 * T1: Uses real data via dataBindings calling platform APIs.
 */

export interface GeneratedArea {
  name: string;
  componentId: string;
  props?: Record<string, any>;
  dataBindingIds?: string[];
}

export interface GeneratedLayout {
  variant: "single-column" | "split-horizontal" | "split-vertical" | "grid";
  areas: GeneratedArea[];
}

export interface Nl2UiConfig {
  ui: {
    layout: GeneratedLayout;
    blocks: Block[];
  };
  dataBindings: Array<{
    id: string;
    target: string;
    params: any;
    filters?: any;
    sort?: { field: string; direction: "asc" | "desc" };
  }>;
  actionBindings?: ActionBinding[];
  appliedStylePrefs?: any;
  /** Model-generated reply text */
  replyText?: string;
  /** Model-generated next action suggestions */
  suggestions?: string[];
  metadata?: {
    generatedAt: string;
    modelUsed: string;
    confidence: number;
  };
}

interface DynamicBlockRendererProps {
  config: Nl2UiConfig;
  readOnly?: boolean;
  locale?: string;
  onBlockChange?: (blocks: Block[]) => void;
  /** Card click callback - used for drill-down interactions (e.g. CardList) */
  onCardClick?: (card: { title: string; id?: string; [key: string]: any }) => void;
  /** Whether to show layout editing controls */
  enableLayoutEdit?: boolean;
  initialLayoutItems?: import("./LayoutEditor").AreaLayoutItem[];
  onLayoutChange?: (items: import("./LayoutEditor").AreaLayoutItem[]) => void;
}

/**
 * Get CSS Grid template for the given layout variant
 */
function getGridTemplate(variant: string): React.CSSProperties["gridTemplateColumns"] {
  switch (variant) {
    case "split-vertical":
      return "1fr 1fr";
    case "split-horizontal":
      return undefined;
    case "grid":
      return "repeat(3, 1fr)";
    default:
      return "1fr";
  }
}

/* ─── Loading skeleton ────────────────────────────────────────────── */

function AreaSkeleton({ name }: { name: string }) {
  return (
    <div
      key={name}
      style={{
        padding: "var(--n2u-pad, 24px)",
        borderRadius: "var(--n2u-card-radius, 14px)",
        border: "1px solid var(--sl-border, #e5e7eb)",
        background: "var(--sl-surface, #fff)",
        minHeight: 160,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ height: 14, width: "40%", borderRadius: 6, background: "rgba(15,23,42,0.06)", animation: "pulse 1.5s infinite" }} />
      <div style={{ height: 10, width: "90%", borderRadius: 4, background: "rgba(15,23,42,0.04)", animation: "pulse 1.5s infinite" }} />
      <div style={{ height: 10, width: "75%", borderRadius: 4, background: "rgba(15,23,42,0.04)", animation: "pulse 1.5s infinite" }} />
      <div style={{ height: 10, width: "60%", borderRadius: 4, background: "rgba(15,23,42,0.04)", animation: "pulse 1.5s infinite" }} />
    </div>
  );
}

function AreaError({ name, error, onRetry, locale }: { name: string; error: string; onRetry?: () => void; locale: string }) {
  return (
    <div
      key={name}
      style={{
        padding: 20,
        borderRadius: 12,
        border: "1px solid #fecaca",
        background: "#fef2f2",
        color: "#991b1b",
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>⚠️ {name}</div>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: onRetry ? 8 : 0 }}>{error}</div>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            fontSize: 11,
            padding: "4px 12px",
            borderRadius: 6,
            border: "1px solid #fca5a5",
            background: "white",
            color: "#dc2626",
            cursor: "pointer",
          }}
        >
          ↻ {t(locale, "runs.action.retry")}
        </button>
      )}
    </div>
  );
}

/* ─── Inline Record Form ─────────────────────────────────────── */

function InlineRecordForm({
  schema,
  initialValues,
  onSubmit,
  onCancel,
  locale,
  title,
  submitting,
}: {
  schema: import("@/lib/types").EffectiveSchema | null;
  initialValues?: Record<string, unknown>;
  onSubmit: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
  locale: string;
  title: string;
  submitting: boolean;
}) {
  const fields = (schema?.fields ?? {}) as Record<string, import("@/lib/types").FieldDef>;
  const isEditMode = !!initialValues;
  // T12: Field-level security - in create mode show only writable fields; in edit mode show all readable fields but lock non-writable ones.
  const fieldKeys = Object.keys(fields)
    .filter((k) => !['id', 'createdAt', 'updatedAt', 'revision'].includes(k))
    .filter((k) => isEditMode ? true : fields[k]?.writable !== false)
    .slice(0, 10);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const k of fieldKeys) {
      const v = initialValues?.[k];
      init[k] = v != null ? String(v) : "";
    }
    return init;
  });

  // Load display labels for reference fields
  const [referenceLabels, setReferenceLabels] = useState<Record<string, string>>({});
  React.useEffect(() => {
    fieldKeys.forEach((k) => {
      if (fields[k]?.type === "reference" && values[k]) {
        loadReferenceLabel(k, fields[k], values[k]);
      }
    });
    // Reload reference labels when initialValues or schema changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initialValues), schema]);

  const loadReferenceLabel = async (fieldKey: string, fieldDef: any, id: string) => {
    const entityName = fieldDef.referenceEntity;
    const displayField = fieldDef.displayField ?? "name";
    if (!entityName || !id) return;
    try {
      const res = await import("@/lib/api").then((m) => m.apiFetch(`/entities/${encodeURIComponent(entityName)}/${encodeURIComponent(id)}`));
      if (!res.ok) return;
      const json = await res.json();
      const label = String(json?.payload?.[displayField] ?? json?.payload?.name ?? "");
      setReferenceLabels((prev) => ({ ...prev, [fieldKey]: label }));
    } catch {
      // Ignore errors
    }
  };

  const handleSubmit = () => {
    const payload: Record<string, unknown> = {};
    for (const k of fieldKeys) {
      const raw = values[k];
      if (raw === "" || raw === undefined) continue;
      const fType = fields[k]?.type;
      if (fType === "number") payload[k] = Number(raw) || 0;
      else if (fType === "boolean") payload[k] = raw === "true";
      else payload[k] = raw;
    }
    onSubmit(payload);
  };

  return (
    <div style={{ padding: "var(--n2u-pad, 16px)", borderRadius: "var(--n2u-radius, 12px)", border: "1px solid var(--sl-border, #e2e8f0)", background: "var(--sl-surface, #f8fafc)", marginBottom: 8 }}>
      <div style={{ fontSize: "var(--n2u-font-base, 13px)", fontWeight: 600, marginBottom: 12, color: "var(--sl-fg, #1e293b)" }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
        {fieldKeys.map((k) => {
          const fType = fields[k]?.type;
          const isRef = fType === "reference";
          const labelText = i18nText(fields[k]?.displayName ?? k, locale) || k;
          
          if (isRef) {
            const dep = fields[k]?.dependsOn;
            const cascadeFilter = dep && values[dep.field]
              ? { field: dep.filterField, value: String(values[dep.field]) }
              : null;
            const refLabel = referenceLabels[k];
            return (
              <div key={k}>
                <label style={{ display: "block", fontSize: 11, color: "#64748b", marginBottom: 3 }}>
                  {labelText}
                </label>
                <ReferencePicker
                  fieldDef={{
                    referenceEntity: fields[k]?.referenceEntity ?? "",
                    displayField: fields[k]?.displayField ?? "name",
                    searchFields: fields[k]?.searchFields,
                    required: fields[k]?.required,
                  }}
                  value={values[k]}
                  onChange={(val) => {
                    setValues((v) => ({ ...v, [k]: val }));
                    setReferenceLabels((prev) => ({ ...prev, [k]: val }));
                  }}
                  disabled={fields[k]?.writable === false}
                  placeholder={`Search ${fields[k]?.referenceEntity ?? "..."}`}
                  cascadeFilter={cascadeFilter}
                />
                {refLabel && refLabel !== values[k] && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "var(--sl-muted, #64748b)" }}>
                    {refLabel}
                  </div>
                )}
              </div>
            );
          }
          
          return (
            <div key={k}>
              <label style={{ display: "block", fontSize: 11, color: "#64748b", marginBottom: 3 }}>
                {labelText}
              </label>
              <input
                type={fType === "number" ? "number" : "text"}
                value={values[k] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                readOnly={fields[k]?.writable === false}
                style={{
                  width: "100%", padding: "5px 8px", borderRadius: 6,
                  border: "1px solid var(--sl-border, #e2e8f0)", fontSize: 12,
                  background: fields[k]?.writable === false ? "var(--sl-surface, #f1f5f9)" : "white",
                  color: fields[k]?.writable === false ? "var(--sl-muted, #94a3b8)" : "var(--sl-fg, #1e293b)",
                  cursor: fields[k]?.writable === false ? "not-allowed" : "text",
                }}
              />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button onClick={onCancel} disabled={submitting} style={{ fontSize: 12, padding: "5px 14px", borderRadius: 6, border: "1px solid #e2e8f0", background: "white", color: "#64748b", cursor: "pointer" }}>
          Cancel
        </button>
        <button onClick={handleSubmit} disabled={submitting} style={{ fontSize: 12, padding: "5px 14px", borderRadius: 6, border: "none", background: "var(--n2u-primary, #6366f1)", color: "white", cursor: "pointer", opacity: submitting ? 0.6 : 1 }}>
          {submitting ? "Submitting..." : "Submit"}
        </button>
      </div>
    </div>
  );
}

/* ─── Result Toast ───────────────────────────────────────────── */

function ActionResultToast({ result, onDismiss }: { result: import("./useNl2UiActions").ActionResult; onDismiss: () => void }) {
  let message: string;
  let isPositive = result.ok;

  if (!result.ok) {
    message = result.error ?? "Failed";
    isPositive = false;
  } else if (result.status === "needs_approval") {
    message = "Submitted, awaiting approval";
  } else {
    message = "Submitted";
  }

  const approvalHref = result.approvalId ? `/gov/approvals/${encodeURIComponent(result.approvalId)}` : "";
  const runHref = result.runId ? `/runs/${encodeURIComponent(result.runId)}` : "";

  return (
    <div style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12, display: "flex", gap: 8, alignItems: "center", border: isPositive ? "1px solid #bbf7d0" : "1px solid #fecaca", background: isPositive ? "#f0fdf4" : "#fef2f2", color: isPositive ? "#166534" : "#991b1b" }}>
      <span>{isPositive ? "✓" : "✕"}</span>
      <span>{message}</span>
      {result.ok && result.status === "needs_approval" && approvalHref && (
        <Link href={approvalHref} style={{ color: "inherit", textDecoration: "underline", fontSize: 12 }}>
          View approval
        </Link>
      )}
      {result.ok && runHref && (
        <Link href={runHref} style={{ color: "inherit", textDecoration: "underline", fontSize: 12 }}>
          View run
        </Link>
      )}
      <button onClick={onDismiss} style={{ marginLeft: "auto", background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 11, opacity: 0.7 }}>✕</button>
    </div>
  );
}

/* ─── Stateful BlockEditor wrapper ────────────────────────────── */

/**
 * BlockEditor wrapper with local state.
 * Keeps typed content in React state to avoid losing edits on re-render.
 */
function StatefulBlockEditor({
  initialBlocks,
  locale,
  onBlockChange,
}: {
  initialBlocks: Block[];
  locale?: string;
  onBlockChange?: (blocks: Block[]) => void;
}) {
  const [blocks, setBlocks] = useState<Block[]>(initialBlocks);

  const handleChange = useCallback(
    (newBlocks: Block[]) => {
      setBlocks(newBlocks);
      onBlockChange?.(newBlocks);
    },
    [onBlockChange],
  );

  return (
    <BlockEditorWidget
      blocks={blocks}
      onChange={handleChange}
      readOnly={false}
      locale={locale}
    />
  );
}

/* ─── Area renderer (with real data) ───────────────────────────── */

function RealAreaRenderer({
  area,
  dataMap,
  locale,
  onRetry,
  actions,
  onCardClick,
  allowDemoFallback,
}: {
  area: GeneratedArea;
  dataMap: DataMap;
  locale: string;
  onRetry?: () => void;
  actions?: ReturnType<typeof useNl2UiActions>;
  onCardClick?: (card: { title: string; id?: string; [key: string]: any }) => void;
  allowDemoFallback?: boolean;
}) {
  const { componentId, props = {}, dataBindingIds = [] } = area;

  // Find the primary data binding result for this area
  const primaryBindingId = dataBindingIds[0];
  const bindingResult: BindingResult | null = primaryBindingId ? dataMap[primaryBindingId] ?? null : null;

  function coerceMockItems(): EntityRecord[] {
    const raw = (props as any).mockItems;
    if (!Array.isArray(raw) || raw.length === 0) return [];
    return raw.map((it: any, idx: number) => {
      if (it && typeof it === "object" && "payload" in it) {
        const id = String((it as any).id ?? `m_${idx}`);
        const payload = (it as any).payload && typeof (it as any).payload === "object" ? (it as any).payload : {};
        return { ...(it as any), id, payload };
      }
      const id = String((it as any)?.id ?? `m_${idx}`);
      const payload = it && typeof it === "object" ? it : { value: it };
      return { id, payload };
    });
  }

  // Loading state
  if (bindingResult?.loading) {
    return <AreaSkeleton name={area.name} />;
  }

  // Error state — fall back to mockItems (demo data) if available
  if (bindingResult?.error) {
    const mockItems = allowDemoFallback ? coerceMockItems() : [];
    if (!mockItems.length) {
      return <AreaError name={props.title || area.name} error={bindingResult.error} onRetry={onRetry} locale={locale} />;
    }
  }

  const mockItems = coerceMockItems();
  const items = (bindingResult?.items?.length ? bindingResult.items : mockItems) ?? [];
  const schema = bindingResult?.schema ?? null;
  const hasData = items.length > 0;

  // Derive entityName from area props or data binding
  const entityName = props.entityName ?? "";
  const canCreate = actions && entityName;
  const canEdit = actions && entityName;
  const canDelete = actions && entityName;

  switch (componentId) {
    case "BlockEditor": {
      const initialBlocks: Block[] = props.initialBlocks || [];
      return (
        <StatefulBlockEditor
          key={area.name}
          initialBlocks={initialBlocks}
          locale={locale}
        />
      );
    }

    case "DataGrid": {
      const { columns, rows } = hasData
        ? toGridData(items, schema, locale, bindingResult?.refLabels)
        : { columns: [] as GridColumn[], rows: [] as GridRow[] };

      // Add action column if edit/delete available
      const actionColumns = (canEdit || canDelete) ? [
        ...columns,
        { id: "__actions", label: "Actions", type: "text" as const },
      ] : columns;

      return (
        <div key={area.name}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: `8px var(--n2u-pad, 14px) 4px` }}>
            {props.title && (
              <div style={{ fontSize: "var(--n2u-font-heading, 14px)", fontWeight: 700, color: "var(--sl-fg, #1e293b)" }}>
                {props.title}
              </div>
            )}
            {canCreate && (
              <button
                onClick={() => actions.openCreateForm()}
                style={{ fontSize: "var(--n2u-font-base, 12px)", padding: "4px 12px", borderRadius: "var(--n2u-radius, 6px)", border: "none", background: "var(--n2u-primary, #6366f1)", color: "white", cursor: "pointer" }}
              >
                + New
              </button>
            )}
          </div>
          {/* Inline create form */}
          {actions?.state.showCreateForm && schema && (
            <div style={{ padding: "0 14px" }}>
              <InlineRecordForm
                schema={schema}
                onSubmit={(payload) => actions.createRecord(entityName, payload)}
                onCancel={() => actions.closeCreateForm()}
                locale={locale}
                title={`New ${entityName}`}
                submitting={actions.state.executing}
              />
            </div>
          )}
          {/* Inline edit form */}
          {actions?.state.editingRecord && schema && (
            <div style={{ padding: "0 14px" }}>
              <InlineRecordForm
                schema={schema}
                initialValues={actions.state.editingRecord.payload}
                onSubmit={(patch) => actions.updateRecord(entityName, actions.state.editingRecord!.id, patch)}
                onCancel={() => actions.closeEditForm()}
                locale={locale}
                title={`Edit ${entityName}`}
                submitting={actions.state.executing}
              />
            </div>
          )}
          <DataGridWidget
            columns={actionColumns}
            rows={rows}
            onRowsChange={() => {}}
            readOnly={true}
            locale={locale}
          />
          {/* Row action buttons (rendered as overlay) */}
          {(canEdit || canDelete) && hasData && (
            <div style={{ padding: "0 14px" }}>
              {items.map((item) => (
                <div key={item.id} style={{ display: "inline-flex", gap: 4, marginRight: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: "#94a3b8" }}>#{String(item.id).slice(0, 6)}</span>
                  {canEdit && (
                    <button onClick={() => actions.openEditForm(item.id, item.payload ?? {})} style={{ fontSize: "var(--n2u-font-sm, 10px)", padding: "1px 6px", borderRadius: 4, border: "1px solid var(--sl-border, #e2e8f0)", background: "var(--sl-surface, white)", color: "var(--n2u-primary, #6366f1)", cursor: "pointer" }}>
                      Edit
                    </button>
                  )}
                  {canDelete && (
                    <button onClick={() => actions.deleteRecord(entityName, item.id)} style={{ fontSize: "var(--n2u-font-sm, 10px)", padding: "1px 6px", borderRadius: 4, border: "1px solid #fecaca", background: "var(--sl-surface, white)", color: "#dc2626", cursor: "pointer" }}>
                      Delete
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {!hasData && !bindingResult?.loading && (
            <div style={{ textAlign: "center", padding: "var(--n2u-pad, 16px)", color: "var(--sl-muted, #94a3b8)", fontSize: "var(--n2u-font-base, 13px)" }}>
              {t(locale, "nl2ui.noData")}
            </div>
          )}
        </div>
      );
    }

    case "KanbanBoard": {
      const kanbanColumns = hasData
        ? toKanbanData(items, schema, locale)
        : [];

      const kanbanCols: KanbanColumn[] = kanbanColumns.map((col) => ({
        id: col.id,
        title: col.title,
        color: col.color,
        cards: col.cards.map((c) => ({
          id: c.id,
          title: c.title,
          description: c.description,
          priority: "none" as const,
          labels: c.labels,
        })),
      }));

      return (
        <div key={area.name}>
          {props.title && (
            <div style={{ fontSize: "var(--n2u-font-heading, 14px)", fontWeight: 700, padding: "8px 0 4px", color: "var(--sl-fg, #1e293b)" }}>
              {props.title}
            </div>
          )}
          <KanbanBoardWidget
            columns={kanbanCols}
            onChange={() => {}}
            readOnly={true}
            locale={locale}
          />
        </div>
      );
    }

    case "BiDashboard": {
      const biData = hasData ? toBiData(items, schema, locale) : null;

      // Build metric cards from real data
      const metricCards: MetricCard[] = [];
      if (biData) {
        metricCards.push({
          id: "total",
          title: "Total",
          chartType: "number",
          sortOrder: 0,
        });
        if (biData.statusGroups.length > 0) {
          metricCards.push({
            id: "status_dist",
            title: "Status Distribution",
            chartType: "pie",
            sortOrder: 1,
          });
        }
      }

      const dashData: Record<string, any[]> = {};
      if (biData) {
        dashData["total"] = [{ value: biData.totalCount }];
        dashData["status_dist"] = biData.statusGroups;
      }

      return (
        <div key={area.name}>
          {props.title && (
            <div style={{ fontSize: "var(--n2u-font-heading, 14px)", fontWeight: 700, padding: "8px 0 4px", color: "var(--sl-fg, #1e293b)" }}>
              {props.title}
            </div>
          )}
          <BiDashboardWidget
            cards={metricCards}
            onChange={() => {}}
            readOnly={true}
            data={dashData}
            locale={locale}
          />
        </div>
      );
    }

    case "ChartWidget": {
      const chartType = (props.chartType as "bar" | "line" | "pie") || "bar";
      const chartData = hasData ? toChartData(items, schema, locale, props.valueField, props.labelField) : [];

      return (
        <div key={area.name}>
          <ChartWidget
            chartType={chartType}
            data={chartData}
            title={props.title}
            locale={locale}
          />
          {!hasData && !bindingResult?.loading && (
            <div style={{ textAlign: "center", padding: "var(--n2u-pad, 16px)", color: "var(--sl-muted, #94a3b8)", fontSize: "var(--n2u-font-base, 13px)" }}>
              {t(locale, "nl2ui.noData")}
            </div>
          )}
        </div>
      );
    }

    case "TimelineWidget": {
      const timelineEvents = hasData ? toTimelineData(items, schema, locale) : [];

      return (
        <div key={area.name}>
          <TimelineWidget
            events={timelineEvents}
            title={props.title}
            locale={locale}
          />
        </div>
      );
    }

    case "CalendarWidget": {
      const calendarEvents = hasData ? toCalendarData(items, schema, locale) : [];

      return (
        <div key={area.name}>
          <CalendarWidget
            events={calendarEvents}
            title={props.title}
            locale={locale}
          />
        </div>
      );
    }

    case "StatsRow": {
      const statsItems = hasData ? toStatsData(items, schema, locale) : [];
      return (
        <div key={area.name} style={{ padding: "8px 16px" }}>
          <StatsRowWidget
            stats={statsItems}
            title={props.title}
            locale={locale}
          />
        </div>
      );
    }

    case "CardList": {
      const cardItems = hasData ? toCardListData(items, schema, locale) : [];
      const title = props.title || "List";

      return (
        <div
          key={area.name}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: "var(--n2u-gap, 16px)",
            padding: "var(--n2u-pad, 16px)",
          }}
        >
          <style>{`
.__cl_card{transition:box-shadow .2s,transform .15s}
.__cl_card:hover{box-shadow:0 8px 24px rgba(99,102,241,.1),0 1.5px 4px rgba(0,0,0,.04)!important;transform:translateY(-2px)}
.__cl_card:hover .__cl_accent{opacity:1!important}
.__cl_img{object-fit:cover;transition:transform .3s}
.__cl_card:hover .__cl_img{transform:scale(1.04)}
          `}</style>
          <h3 style={{ gridColumn: "1 / -1", margin: "0 0 8px 0", fontSize: "var(--n2u-font-heading, 14px)", fontWeight: 700, color: "var(--sl-fg, #1e293b)", display: "flex", alignItems: "center", gap: 8 }}>
            {title}
            <span style={{ fontSize: 10, fontWeight: 400, color: "#94a3b8", padding: "1px 8px", borderRadius: 10, background: "var(--sl-bg,#f1f5f9)" }}>{cardItems.length}</span>
          </h3>
          {cardItems.length === 0 && (
            <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: 32, color: "var(--sl-muted, #94a3b8)", fontSize: "var(--n2u-font-base, 13px)" }}>
              <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.5 }}>📋</div>
              {t(locale, "nl2ui.noData")}
            </div>
          )}
          {cardItems.map((item, idx) => {
            const hasImage = !!item.image;
            const accentColors = ['#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6'];
            const accentColorsLight = ['#818cf8','#38bdf8','#34d399','#fbbf24','#f87171','#a78bfa'];
            return (
            <div
              key={idx}
              className="__cl_card"
              onClick={() => onCardClick?.({ title: item.title, id: (item as any).id, description: item.description })}
              style={{
                borderRadius: "var(--n2u-card-radius, 12px)",
                background: "var(--sl-surface, #fff)",
                border: "var(--n2u-card-border, 1px) solid var(--sl-border, #e5e7eb)",
                boxShadow: "var(--n2u-card-shadow, 0 1px 3px rgba(0,0,0,0.04))",
                position: "relative",
                overflow: "hidden",
                display: "flex", flexDirection: "column",
                cursor: onCardClick ? "pointer" : "default",
              }}
            >
              {/* Cover image or accent line */}
              {hasImage ? (
                <div style={{ width: "100%", height: 140, overflow: "hidden", background: "#f1f5f9", flexShrink: 0, position: "relative" }}>
                  <Image className="__cl_img" src={item.image} alt="" fill unoptimized style={{ objectFit: "cover", display: "block" }} />
                </div>
              ) : (
                <div className="__cl_accent" style={{ height: 3, background: `linear-gradient(90deg, ${accentColors[idx % 6]}, ${accentColorsLight[idx % 6]})`, opacity: 0.5, transition: "opacity .2s" }} />
              )}
              <div style={{ padding: "var(--n2u-pad, 16px)" }}>
                <div style={{ fontWeight: 600, fontSize: "var(--n2u-font-heading, 14px)", marginBottom: 6, color: "var(--sl-fg, #1e293b)" }}>{item.title}</div>
                {item.description && (
                  <div style={{ fontSize: 12.5, color: "var(--sl-muted, #64748b)", marginBottom: 10, lineHeight: 1.55, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as any }}>
                    {item.description}
                  </div>
                )}
                {item.fields.length > 0 && (
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4, paddingTop: 8, borderTop: "1px solid var(--sl-border, #f1f5f9)" }}>
                    {item.fields.map((f, fi) => (
                      <div key={fi} style={{ fontSize: "var(--n2u-font-sm, 11px)" }}>
                        <span style={{ color: "var(--sl-muted, #94a3b8)", fontSize: 10, textTransform: "uppercase", letterSpacing: ".03em" }}>{f.label} </span>
                        <span style={{ color: "var(--sl-fg, #475569)", fontWeight: 600, display: "block" }}>{f.value || "—"}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            );
          })}
        </div>
      );
    }

    default: {
      // T11: Unknown components fallback to DataGrid
      console.warn(`[NL2UI] Unknown componentId "${componentId}", falling back to DataGrid`);
      const { columns: fbCols, rows: fbRows } = hasData
        ? toGridData(items, schema, locale, bindingResult?.refLabels)
        : { columns: [] as GridColumn[], rows: [] as GridRow[] };
      return (
        <div key={area.name}>
          {props.title && (
            <div style={{ fontSize: "var(--n2u-font-heading, 14px)", fontWeight: 700, padding: "8px 14px 4px", color: "var(--sl-fg, #1e293b)" }}>
              {props.title}
              <span style={{ fontSize: 10, marginLeft: 8, color: "#94a3b8", fontWeight: 400 }}>
                {`(fallback from ${componentId})`}
              </span>
            </div>
          )}
          <DataGridWidget
            columns={fbCols}
            rows={fbRows}
            onRowsChange={() => {}}
            readOnly={true}
            locale={locale}
          />
          {!hasData && !bindingResult?.loading && (
            <div style={{ textAlign: "center", padding: "var(--n2u-pad, 16px)", color: "var(--sl-muted, #94a3b8)", fontSize: "var(--n2u-font-base, 13px)" }}>
              {t(locale, "nl2ui.noData")}
            </div>
          )}
        </div>
      );
    }
  }
}

/**
 * DynamicBlockRenderer main component.
 * Fetches real data via useNl2UiData based on dataBindings.
 */
export function DynamicBlockRenderer(props: DynamicBlockRendererProps) {
  const areasKey = props.config.ui.layout.areas.map((a) => a.name).join(",");
  return <DynamicBlockRendererInner key={areasKey} {...props} />;
}

function DynamicBlockRendererInner(props: DynamicBlockRendererProps) {
  const { config, readOnly = false, locale = "zh-CN", onBlockChange, onCardClick, enableLayoutEdit = false, initialLayoutItems, onLayoutChange } = props;
  const { layout, blocks } = config.ui;
  const stylePrefs = config.appliedStylePrefs as StylePrefs | undefined;

  // Style prefs → CSS variables
  const tokens = useMemo(() => resolveStyleTokens(stylePrefs), [stylePrefs]);
  const scopeClass = "__n2u_themed";
  const themeCSS = useMemo(() => buildScopedThemeCSS(scopeClass, stylePrefs), [stylePrefs]);

  // Fetch data via dataBindings
  const { data: dataMap, refresh } = useNl2UiData(config.dataBindings, locale);

  // T9: ActionBinding - write actions
  const actions = useNl2UiActions(config.actionBindings ?? [], locale, refresh);

  // Any binding loading
  const anyLoading = Object.values(dataMap).some((r) => r.loading);

  const containerRef = useRef<HTMLDivElement>(null);

  // Layout editor (free-form) — restore saved positions + change callback
  const layoutEditor = useLayoutEditor(layout.variant, layout.areas, containerRef, {
    initialItems: initialLayoutItems,
    onLayoutChange,
  });

  // Whether we're in free-form mode (editing or already customized)
  const isFreeForm = layoutEditor.editing || layoutEditor.items !== null;

  // Compute layout styles
  const containerStyle: React.CSSProperties = useMemo(() => {
    if (isFreeForm && layoutEditor.items) {
      // Free-form absolute positioning mode
      return {
        position: "relative" as const,
        minHeight: computeContainerHeight(layoutEditor.items),
        padding: "var(--n2u-pad, 16px)",
        ...tokens as any,
      };
    }
    // Original CSS Grid mode (no customization yet)
    const baseStyle: React.CSSProperties = {
      display: "grid",
      gap: "var(--n2u-gap, 16px)" as any,
      padding: "var(--n2u-pad, 16px)" as any,
      minHeight: 120,
      ...tokens as any,
    };

    if (layout.variant === "split-horizontal") {
      baseStyle.gridTemplateRows = "1fr 1fr";
    } else if (layout.variant === "grid") {
      baseStyle.gridTemplateColumns = "repeat(auto-fit, minmax(280px, 1fr))";
    } else {
      baseStyle.gridTemplateColumns = getGridTemplate(layout.variant);
    }

    return baseStyle;
  }, [layout.variant, tokens, isFreeForm, layoutEditor.items]);

  // Build a lookup: areaName → AreaLayoutItem
  const itemMap = useMemo(() => {
    if (!layoutEditor.items) return {} as Record<string, AreaLayoutItem>;
    const m: Record<string, AreaLayoutItem> = {};
    for (const it of layoutEditor.items) m[it.areaName] = it;
    return m;
  }, [layoutEditor.items]);

  // zIndex lookup
  const zMap = layoutEditor.zMap;

  return (
    <div ref={containerRef} className={scopeClass} style={containerStyle}>
      {/* Inject theme override CSS */}
      <style>{themeCSS}</style>
      {/* Edit mode visual hints */}
      {layoutEditor.editing && (
        <style>{`
          .__n2u_themed { background: radial-gradient(circle, rgba(99,102,241,0.04) 1px, transparent 1px) !important; background-size: 20px 20px !important; }
        `}</style>
      )}
      {/* Top toolbar (only when layout editing is enabled) */}
      {enableLayoutEdit && (
      <div style={{ position: isFreeForm ? "relative" as const : undefined, zIndex: 9999, display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: isFreeForm ? 8 : 0, ...(isFreeForm ? {} : { gridColumn: "1 / -1" }) }}>
        {layoutEditor.editing && (
          <span style={{ fontSize: 11, color: "#6366f1", fontWeight: 600, marginRight: "auto", display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#6366f1", animation: "pulse 1s ease-in-out infinite" }} />
            {t(locale, "nl2ui.layout.editHint")}
          </span>
        )}
        {anyLoading && (
          <span style={{ fontSize: "var(--n2u-font-sm, 11px)", color: "var(--sl-muted, #94a3b8)" }}>
            {t(locale, "action.loading")}...
          </span>
        )}
        <button
          onClick={refresh}
          disabled={anyLoading}
          style={{
            fontSize: "var(--n2u-font-sm, 11px)",
            padding: "3px 10px",
            borderRadius: "var(--n2u-radius, 6px)",
            border: "1px solid var(--sl-border, #e5e7eb)",
            background: "var(--sl-surface, #fff)",
            color: "var(--sl-muted, #64748b)",
            cursor: anyLoading ? "default" : "pointer",
            opacity: anyLoading ? 0.5 : 1,
          }}
        >
          ↻ {t(locale, "action.refresh")}
        </button>
        {enableLayoutEdit && layoutEditor.items !== null && !layoutEditor.editing && (
          <button
            onClick={layoutEditor.resetLayout}
            style={{
              fontSize: "var(--n2u-font-sm, 11px)",
              padding: "3px 10px",
              borderRadius: "var(--n2u-radius, 6px)",
              border: "1px solid #fca5a5",
              background: "#fff5f5",
              color: "#dc2626",
              cursor: "pointer",
            }}
          >
            ↺ {t(locale, "nl2ui.layout.reset")}
          </button>
        )}
        {enableLayoutEdit && (
          <button
            onClick={layoutEditor.toggleEditing}
            style={{
              fontSize: "var(--n2u-font-sm, 11px)",
              padding: "3px 12px",
              borderRadius: "var(--n2u-radius, 6px)",
              border: layoutEditor.editing ? "1px solid #6366f1" : "1px solid var(--sl-border, #e5e7eb)",
              background: layoutEditor.editing ? "#eef2ff" : "var(--sl-surface, #fff)",
              color: layoutEditor.editing ? "#6366f1" : "var(--sl-muted, #64748b)",
              cursor: "pointer",
              fontWeight: layoutEditor.editing ? 600 : 400,
              transition: "all .15s",
            }}
          >
            {layoutEditor.editing
              ? `✓ ${t(locale, "nl2ui.layout.editDone")}`
              : t(locale, "nl2ui.layout.editMode")}
          </button>
        )}
      </div>
      )}

      {/* Action result toast */}
      {actions.state.lastResult && (
        <div style={{ position: isFreeForm ? "relative" as const : undefined, zIndex: 9998, ...(isFreeForm ? {} : { gridColumn: "1 / -1" }) }}>
          <ActionResultToast result={actions.state.lastResult} onDismiss={actions.clearResult} />
        </div>
      )}

      {/* Render all areas */}
      {layout.areas.map((area) => {
        const layoutItem = itemMap[area.name];

        const areaContent = (
          <RealAreaRenderer
            key={area.name}
            area={area}
            dataMap={dataMap}
            locale={locale}
            onRetry={refresh}
            actions={readOnly ? undefined : actions}
            onCardClick={onCardClick}
            allowDemoFallback={readOnly}
          />
        );

        // Edit mode: free-form with drag & resize handles
        if (layoutEditor.editing && layoutItem) {
          return (
            <EditableArea
              key={area.name}
              item={layoutItem}
              zIndex={(zMap[area.name] ?? 0) + 10}
              onMove={layoutEditor.handleMove}
              onResize={layoutEditor.handleResize}
              onBringToFront={layoutEditor.bringToFront}
            >
              {areaContent}
            </EditableArea>
          );
        }

        // Customized (non-edit mode): absolute positioning preserved
        if (layoutItem && isFreeForm) {
          return (
            <div key={area.name} style={{
              position: "absolute",
              left: layoutItem.x,
              top: layoutItem.y + 44, // offset for toolbar height
              width: layoutItem.width,
              height: layoutItem.height,
              overflow: "auto",
              borderRadius: "var(--n2u-card-radius, 12px)",
              border: "1px solid var(--sl-border, #e5e7eb)",
              background: "var(--sl-surface, #fff)",
            }}>
              {areaContent}
            </div>
          );
        }

        // Default grid mode
        return <div key={area.name}>{areaContent}</div>;
      })}

      {/* Render blocks at the bottom (if any) */}
      {blocks && blocks.length > 0 && (
        <div style={{ position: isFreeForm ? "relative" as const : undefined, zIndex: 1, ...(isFreeForm ? { marginTop: (layoutEditor.containerHeight ?? 0) + 8 } : { gridColumn: "1 / -1", marginTop: 16 }) }}>
          <StatefulBlockEditor
            initialBlocks={blocks}
            locale={locale}
            onBlockChange={onBlockChange}
          />
        </div>
      )}
    </div>
  );
}

export default DynamicBlockRenderer;
