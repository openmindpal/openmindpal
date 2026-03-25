"use client";

import { useState, useCallback } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

export type Priority = "urgent" | "high" | "medium" | "low" | "none";

export interface KanbanCard {
  id: string;
  title: string;
  description?: string;
  priority: Priority;
  labels?: string[];
  assignee?: string;
  dueDate?: string;
}

export interface KanbanColumn {
  id: string;
  title: string;
  color: string;
  cards: KanbanCard[];
  limit?: number;
}

export interface KanbanBoardProps {
  columns: KanbanColumn[];
  onChange: (columns: KanbanColumn[]) => void;
  readOnly?: boolean;
  locale?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let _kanbanIdCounter = 0;
function kId(prefix: string): string { return `${prefix}_${Date.now()}_${++_kanbanIdCounter}`; }

const PRIORITY_META: Record<Priority, { icon: string; color: string; label: string }> = {
  urgent: { icon: "🔴", color: "#ef4444", label: "Urgent" },
  high:   { icon: "🟠", color: "#f97316", label: "High" },
  medium: { icon: "🟡", color: "#eab308", label: "Medium" },
  low:    { icon: "🔵", color: "#3b82f6", label: "Low" },
  none:   { icon: "⚪", color: "#94a3b8", label: "None" },
};

const COLUMN_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

const LABEL_COLORS = [
  { bg: "#ede9fe", fg: "#7c3aed", name: "Feature" },
  { bg: "#dbeafe", fg: "#2563eb", name: "Bug" },
  { bg: "#dcfce7", fg: "#16a34a", name: "Enhancement" },
  { bg: "#fef3c7", fg: "#d97706", name: "Review" },
  { bg: "#fce7f3", fg: "#db2777", name: "Design" },
  { bg: "#e0f2fe", fg: "#0284c7", name: "Research" },
];

const KB_CSS = `
.__kb_card{transition:box-shadow .2s,transform .15s}
.__kb_card:hover{box-shadow:0 6px 20px rgba(0,0,0,.08)!important;transform:translateY(-2px)}
.__kb_card:active{transform:scale(.97);box-shadow:0 2px 8px rgba(99,102,241,.15)!important}
.__kb_card:hover .__kb_accent{opacity:.9!important}
.__kb_card:hover .__kb_rmv{opacity:1!important}
.__kb_col{transition:border .15s,background .15s,box-shadow .15s}
.__kb_addbtn{transition:all .15s}
.__kb_addbtn:hover{background:rgba(99,102,241,.06)!important;border-color:#c7d2fe!important;color:#6366f1!important}
.__kb_addcol:hover{background:rgba(99,102,241,.04)!important;border-color:#c7d2fe!important;color:#6366f1!important}
`;

// ─── Card Component ─────────────────────────────────────────────────────────

function CardItem(props: {
  card: KanbanCard; colId: string; readOnly: boolean;
  onUpdate: (colId: string, cardId: string, updates: Partial<KanbanCard>) => void;
  onRemove: (colId: string, cardId: string) => void;
  onDragStart: (colId: string, cardId: string) => void;
}) {
  const { card, colId, readOnly, onUpdate, onRemove, onDragStart } = props;
  const [expanded, setExpanded] = useState(false);
  const pm = PRIORITY_META[card.priority];

  const cardStyle: React.CSSProperties = {
    background: "var(--sl-surface, #fff)",
    border: "1px solid var(--sl-border, #e5e7eb)",
    borderRadius: 10,
    padding: "10px 12px",
    cursor: readOnly ? "default" : "grab",
    boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
    position: "relative",
  };

  return (
    <div
      className="__kb_card"
      style={cardStyle}
      draggable={!readOnly}
      onDragStart={() => onDragStart(colId, card.id)}
    >
      {/* Priority indicator */}
      <div className="__kb_accent" style={{ position: "absolute", top: 0, left: 10, right: 10, height: 2.5, background: pm.color, borderRadius: "0 0 3px 3px", opacity: card.priority === "none" ? 0 : 0.6, transition: "opacity .2s" }} />

      {/* Labels */}
      {card.labels && card.labels.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
          {card.labels.map((lbl, i) => {
            const lc = LABEL_COLORS.find((l) => l.name === lbl) ?? LABEL_COLORS[i % LABEL_COLORS.length];
            return (
              <span key={lbl} style={{
                fontSize: 10, fontWeight: 600, padding: "1px 8px", borderRadius: 12,
                background: lc.bg, color: lc.fg,
              }}>{lbl}</span>
            );
          })}
        </div>
      )}

      {/* Title */}
      {readOnly ? (
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--sl-fg, #1e293b)", lineHeight: 1.4 }}>{card.title}</div>
      ) : (
        <input
          value={card.title}
          onChange={(e) => onUpdate(colId, card.id, { title: e.target.value })}
          style={{ width: "100%", fontSize: 13, fontWeight: 600, border: "none", background: "transparent", color: "var(--sl-fg, #1e293b)", outline: "none", padding: 0 }}
        />
      )}

      {/* Description preview */}
      {card.description && (
        <div style={{ fontSize: 11.5, color: "var(--sl-muted, #64748b)", marginTop: 4, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: expanded ? 10 : 2, WebkitBoxOrient: "vertical" as any }}
          onClick={() => setExpanded(!expanded)}>
          {card.description}
        </div>
      )}

      {/* Footer row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
        <span style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 2 }} title={pm.label}>
          <span>{pm.icon}</span>
        </span>
        {card.assignee && (
          <span style={{
            width: 20, height: 20, borderRadius: "50%",
            background: "linear-gradient(135deg, #6366f1, #0ea5e9)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 9, fontWeight: 700, color: "#fff",
          }} title={card.assignee}>
            {card.assignee.slice(0, 2).toUpperCase()}
          </span>
        )}
        {card.dueDate && (
          <span style={{ fontSize: 10, color: "var(--sl-muted, #94a3b8)", marginLeft: "auto" }}>📅 {card.dueDate}</span>
        )}
        {!readOnly && (
          <button className="__kb_rmv" onClick={() => onRemove(colId, card.id)}
            style={{ marginLeft: "auto", fontSize: 10, cursor: "pointer", background: "none", border: "none", color: "var(--sl-danger, #ef4444)", padding: 2, opacity: 0 }}>✕</button>
        )}
      </div>

      {/* Edit controls */}
      {!readOnly && expanded && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--sl-border, #f1f5f9)", display: "flex", gap: 4, flexWrap: "wrap" }}>
          <select value={card.priority} onChange={(e) => onUpdate(colId, card.id, { priority: e.target.value as Priority })}
            style={{ fontSize: 10, padding: "2px 4px", borderRadius: 4, border: "1px solid var(--sl-border, #e5e7eb)" }}>
            {Object.entries(PRIORITY_META).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
          </select>
          <input value={card.assignee ?? ""} onChange={(e) => onUpdate(colId, card.id, { assignee: e.target.value || undefined })}
            placeholder="Assignee" style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--sl-border, #e5e7eb)", width: 70 }} />
          <input type="date" value={card.dueDate ?? ""} onChange={(e) => onUpdate(colId, card.id, { dueDate: e.target.value || undefined })}
            style={{ fontSize: 10, padding: "2px 4px", borderRadius: 4, border: "1px solid var(--sl-border, #e5e7eb)" }} />
        </div>
      )}
    </div>
  );
}

// ─── Column Component ───────────────────────────────────────────────────────

function Column(props: {
  col: KanbanColumn; readOnly: boolean;
  onUpdate: (colId: string, updates: Partial<KanbanColumn>) => void;
  onRemove: (colId: string) => void;
  onCardUpdate: (colId: string, cardId: string, updates: Partial<KanbanCard>) => void;
  onCardRemove: (colId: string, cardId: string) => void;
  onCardAdd: (colId: string) => void;
  onDragStart: (colId: string, cardId: string) => void;
  onDragOver: (colId: string) => void;
  onDrop: (colId: string) => void;
  isDragOver: boolean;
}) {
  const { col, readOnly, onUpdate, onRemove, onCardUpdate, onCardRemove, onCardAdd, onDragStart, onDragOver, onDrop, isDragOver } = props;
  const count = col.cards.length;
  const isOverLimit = col.limit != null && count > col.limit;

  return (
    <div
      className="__kb_col"
      onDragOver={(e) => { e.preventDefault(); onDragOver(col.id); }}
      onDrop={() => onDrop(col.id)}
      style={{
        minWidth: 280, maxWidth: 320, flex: "0 0 300px",
        display: "flex", flexDirection: "column",
        background: isDragOver ? "rgba(99,102,241,0.04)" : "var(--sl-bg, #f8fafc)",
        borderRadius: 14, padding: "0 0 8px",
        border: isDragOver ? "2px dashed #6366f1" : "1px solid var(--sl-border, #e5e7eb)",
        boxShadow: isDragOver ? "0 0 0 3px rgba(99,102,241,.08)" : "none",
      }}
    >
      {/* Column header */}
      <div style={{ padding: "12px 14px 8px", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: col.color, flexShrink: 0 }} />
        {readOnly ? (
          <strong style={{ fontSize: 13, fontWeight: 700, color: "var(--sl-fg, #1e293b)", flex: 1 }}>{col.title}</strong>
        ) : (
          <input value={col.title} onChange={(e) => onUpdate(col.id, { title: e.target.value })}
            style={{ fontSize: 13, fontWeight: 700, border: "none", background: "transparent", color: "var(--sl-fg, #1e293b)", flex: 1, outline: "none" }} />
        )}
        <span style={{
          fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10,
          background: isOverLimit ? "#fef2f2" : "var(--sl-surface, #fff)",
          color: isOverLimit ? "#ef4444" : "var(--sl-muted, #94a3b8)",
          border: `1px solid ${isOverLimit ? "#fecaca" : "var(--sl-border, #e5e7eb)"}`,
        }}>
          {count}{col.limit != null ? `/${col.limit}` : ""}
        </span>
        {!readOnly && (
          <button onClick={() => onRemove(col.id)} style={{ fontSize: 10, cursor: "pointer", background: "none", border: "none", color: "var(--sl-muted, #cbd5e1)", padding: 2 }}>✕</button>
        )}
      </div>

      {/* Cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 10px", flex: 1, overflowY: "auto", maxHeight: 500 }}>
        {col.cards.map((card) => (
          <CardItem key={card.id} card={card} colId={col.id} readOnly={readOnly}
            onUpdate={onCardUpdate} onRemove={onCardRemove} onDragStart={onDragStart} />
        ))}
      </div>

      {/* Add card */}
      {!readOnly && (
        <button onClick={() => onCardAdd(col.id)}
          className="__kb_addbtn"
          style={{
            margin: "8px 10px 0", padding: "6px 0", fontSize: 12, fontWeight: 500,
            border: "1px dashed var(--sl-border, #e5e7eb)", borderRadius: 8,
            background: "transparent", color: "var(--sl-muted, #94a3b8)", cursor: "pointer",
          }}>
          + Add card
        </button>
      )}
    </div>
  );
}

// ─── Kanban Board Widget ────────────────────────────────────────────────────

export function KanbanBoardWidget(props: KanbanBoardProps) {
  const { columns, onChange, readOnly = false } = props;
  const [dragState, setDragState] = useState<{ fromCol: string; cardId: string } | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  const handleColUpdate = useCallback((colId: string, updates: Partial<KanbanColumn>) => {
    onChange(columns.map((c) => (c.id === colId ? { ...c, ...updates } : c)));
  }, [columns, onChange]);

  const handleColRemove = useCallback((colId: string) => {
    onChange(columns.filter((c) => c.id !== colId));
  }, [columns, onChange]);

  const handleCardUpdate = useCallback((colId: string, cardId: string, updates: Partial<KanbanCard>) => {
    onChange(columns.map((c) => c.id === colId ? { ...c, cards: c.cards.map((card) => card.id === cardId ? { ...card, ...updates } : card) } : c));
  }, [columns, onChange]);

  const handleCardRemove = useCallback((colId: string, cardId: string) => {
    onChange(columns.map((c) => c.id === colId ? { ...c, cards: c.cards.filter((card) => card.id !== cardId) } : c));
  }, [columns, onChange]);

  const handleCardAdd = useCallback((colId: string) => {
    const newCard: KanbanCard = { id: kId("card"), title: "New task", priority: "none" };
    onChange(columns.map((c) => c.id === colId ? { ...c, cards: [...c.cards, newCard] } : c));
  }, [columns, onChange]);

  const handleDragStart = useCallback((colId: string, cardId: string) => {
    setDragState({ fromCol: colId, cardId });
  }, []);

  const handleDrop = useCallback((toColId: string) => {
    if (!dragState) return;
    const { fromCol, cardId } = dragState;
    if (fromCol === toColId) { setDragState(null); setDragOverCol(null); return; }
    const fromColumn = columns.find((c) => c.id === fromCol);
    const card = fromColumn?.cards.find((c) => c.id === cardId);
    if (!card) return;
    onChange(columns.map((c) => {
      if (c.id === fromCol) return { ...c, cards: c.cards.filter((cd) => cd.id !== cardId) };
      if (c.id === toColId) return { ...c, cards: [...c.cards, card] };
      return c;
    }));
    setDragState(null);
    setDragOverCol(null);
  }, [dragState, columns, onChange]);

  const handleAddColumn = useCallback(() => {
    const idx = columns.length;
    const newCol: KanbanColumn = {
      id: kId("col"), title: "New Column",
      color: COLUMN_COLORS[idx % COLUMN_COLORS.length], cards: [],
    };
    onChange([...columns, newCol]);
  }, [columns, onChange]);

  return (
    <div>
      <style>{KB_CSS}</style>
      {/* Board */}
      <div style={{ display: "flex", gap: 14, overflowX: "auto", padding: "4px 0 12px", alignItems: "flex-start" }}>
        {columns.map((col) => (
          <Column key={col.id} col={col} readOnly={readOnly}
            onUpdate={handleColUpdate} onRemove={handleColRemove}
            onCardUpdate={handleCardUpdate} onCardRemove={handleCardRemove} onCardAdd={handleCardAdd}
            onDragStart={handleDragStart} onDragOver={setDragOverCol} onDrop={handleDrop}
            isDragOver={dragOverCol === col.id} />
        ))}

        {/* Add column */}
        {!readOnly && (
          <button onClick={handleAddColumn}
            className="__kb_addcol"
            style={{
              minWidth: 220, height: 80, display: "flex", alignItems: "center", justifyContent: "center",
              border: "2px dashed var(--sl-border, #e5e7eb)", borderRadius: 14,
              background: "transparent", color: "var(--sl-muted, #94a3b8)",
              fontSize: 13, fontWeight: 500, cursor: "pointer", transition: "all 0.15s",
              flexShrink: 0,
            }}>
            + Add Column
          </button>
        )}
      </div>

      {/* Empty state */}
      {columns.length === 0 && (
        <div style={{
          padding: 48, textAlign: "center", color: "var(--sl-muted, #94a3b8)",
          border: "2px dashed var(--sl-border, #e5e7eb)", borderRadius: 16,
          background: "linear-gradient(135deg, rgba(99,102,241,0.02), rgba(14,165,233,0.02))",
        }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--sl-fg, #475569)" }}>
            {readOnly ? "No board configured" : "Click '+ Add Column' to create your first column"}
          </div>
        </div>
      )}
    </div>
  );
}

export default KanbanBoardWidget;
