"use client";

import { useState, useCallback, useMemo } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ColumnType = "text" | "number" | "date" | "boolean" | "select" | "url" | "email";
export type SortDir = "asc" | "desc" | null;

export interface GridColumn {
  id: string;
  label: string;
  type: ColumnType;
  width?: number;
  options?: string[];         // for "select" type
  filterable?: boolean;
  frozen?: boolean;
}

export interface GridRow {
  id: string;
  cells: Record<string, any>;
}

export interface DataGridProps {
  columns: GridColumn[];
  rows: GridRow[];
  onColumnsChange?: (columns: GridColumn[]) => void;
  onRowsChange: (rows: GridRow[]) => void;
  readOnly?: boolean;
  pageSize?: number;
  locale?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let _gridIdCounter = 0;
function gId(prefix: string): string { return `${prefix}_${Date.now()}_${++_gridIdCounter}`; }

const TYPE_ICON: Record<ColumnType, string> = {
  text: "Aa", number: "#", date: "📅", boolean: "☑", select: "▾", url: "🔗", email: "✉",
};

function compareCells(a: any, b: any, type: ColumnType): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (type === "number") return Number(a) - Number(b);
  if (type === "date") return new Date(a).getTime() - new Date(b).getTime();
  if (type === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
  return String(a).localeCompare(String(b));
}

// ─── Shared CSS ─────────────────────────────────────────────────────────────

const GRID_CSS = `
.__dg_row{transition:background .12s}
.__dg_row:hover{background:rgba(99,102,241,.04)!important}
.__dg_th{transition:background .12s}
.__dg_th:hover{background:rgba(99,102,241,.04)}
.__dg_filter:focus{border-color:#6366f1!important;box-shadow:0 0 0 2px rgba(99,102,241,.1)}
.__dg_btn{transition:all .15s}
.__dg_btn:hover{background:rgba(99,102,241,.06)!important;border-color:#c7d2fe!important}
.__dg_pgbtn{transition:all .15s}
.__dg_pgbtn:hover:not(:disabled){background:#eef2ff!important;border-color:#c7d2fe!important;color:#6366f1!important}
`;

// ─── Cell Renderer ──────────────────────────────────────────────────────────

function CellEditor(props: {
  col: GridColumn; value: any; readOnly: boolean;
  onChange: (val: any) => void;
}) {
  const { col, value, readOnly, onChange } = props;

  const cellStyle: React.CSSProperties = {
    width: "100%", border: "none", background: "transparent",
    color: "var(--sl-fg, #1e293b)", fontSize: 12.5, padding: "0 2px",
    outline: "none", fontFamily: "inherit",
  };

  if (readOnly) {
    if (col.type === "boolean") return <span style={{ fontSize: 14 }}>{value ? "✅" : "⬜"}</span>;
    if (col.type === "url") return <a href={String(value ?? "")} target="_blank" rel="noopener noreferrer" style={{ color: "#6366f1", fontSize: 12, textDecoration: "underline" }}>{String(value ?? "")}</a>;
    if (col.type === "email") return <a href={`mailto:${value ?? ""}`} style={{ color: "#6366f1", fontSize: 12 }}>{String(value ?? "")}</a>;
    if (col.type === "select") {
      const v = String(value ?? "");
      const idx = col.options?.indexOf(v) ?? 0;
      const colors = ["#ede9fe", "#dbeafe", "#dcfce7", "#fef3c7", "#fce7f3"];
      const fgColors = ["#7c3aed", "#2563eb", "#16a34a", "#d97706", "#db2777"];
      return v ? <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 10, background: colors[idx % colors.length], color: fgColors[idx % fgColors.length] }}>{v}</span> : <span style={{ color: "var(--sl-muted)" }}>—</span>;
    }
    return <span style={{ fontSize: 12.5, color: "var(--sl-fg, #1e293b)" }}>{String(value ?? "")}</span>;
  }

  switch (col.type) {
    case "boolean":
      return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} style={{ cursor: "pointer" }} />;
    case "number":
      return <input type="number" value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} style={cellStyle} />;
    case "date":
      return <input type="date" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} style={cellStyle} />;
    case "select":
      return (
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} style={{ ...cellStyle, cursor: "pointer" }}>
          <option value="">—</option>
          {col.options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      );
    case "url":
    case "email":
      return <input type={col.type === "email" ? "email" : "url"} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} style={cellStyle} placeholder={col.type === "url" ? "https://..." : "email@..."} />;
    default:
      return <input type="text" value={value ?? ""} onChange={(e) => onChange(e.target.value)} style={cellStyle} />;
  }
}

// ─── Data Grid Widget ───────────────────────────────────────────────────────

export function DataGridWidget(props: DataGridProps) {
  const { columns, rows, onColumnsChange, onRowsChange, readOnly = false, pageSize = 25 } = props;
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(0);
  const [editingCell, setEditingCell] = useState<{ rowId: string; colId: string } | null>(null);
  const [selectedRow, setSelectedRow] = useState<string | null>(null);

  // Filter
  const filtered = useMemo(() => {
    let result = [...rows];
    for (const [colId, filterVal] of Object.entries(filters)) {
      if (!filterVal) continue;
      const fl = filterVal.toLowerCase();
      result = result.filter((r) => String(r.cells[colId] ?? "").toLowerCase().includes(fl));
    }
    return result;
  }, [rows, filters]);

  // Sort
  const sorted = useMemo(() => {
    if (!sortCol || !sortDir) return filtered;
    const col = columns.find((c) => c.id === sortCol);
    if (!col) return filtered;
    return [...filtered].sort((a, b) => {
      const cmp = compareCells(a.cells[sortCol], b.cells[sortCol], col.type);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortCol, sortDir, columns]);

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const paged = sorted.slice(page * pageSize, (page + 1) * pageSize);

  const handleSort = useCallback((colId: string) => {
    if (sortCol === colId) {
      setSortDir(sortDir === "asc" ? "desc" : sortDir === "desc" ? null : "asc");
      if (sortDir === "desc") setSortCol(null);
    } else {
      setSortCol(colId);
      setSortDir("asc");
    }
  }, [sortCol, sortDir]);

  const handleCellChange = useCallback((rowId: string, colId: string, val: any) => {
    onRowsChange(rows.map((r) => r.id === rowId ? { ...r, cells: { ...r.cells, [colId]: val } } : r));
  }, [rows, onRowsChange]);

  const handleAddRow = useCallback(() => {
    const newRow: GridRow = { id: gId("row"), cells: {} };
    onRowsChange([...rows, newRow]);
    setPage(Math.floor(rows.length / pageSize));
  }, [rows, onRowsChange, pageSize]);

  const handleRemoveRow = useCallback((rowId: string) => {
    onRowsChange(rows.filter((r) => r.id !== rowId));
    setSelectedRow(null);
  }, [rows, onRowsChange]);

  const handleAddColumn = useCallback(() => {
    if (!onColumnsChange) return;
    const newCol: GridColumn = { id: gId("col"), label: `Column ${columns.length + 1}`, type: "text" };
    onColumnsChange([...columns, newCol]);
  }, [columns, onColumnsChange]);

  const handleRemoveColumn = useCallback((colId: string) => {
    if (!onColumnsChange) return;
    onColumnsChange(columns.filter((c) => c.id !== colId));
    onRowsChange(rows.map((r) => {
      const cells = { ...r.cells };
      delete cells[colId];
      return { ...r, cells };
    }));
  }, [columns, rows, onColumnsChange, onRowsChange]);

  const thStyle: React.CSSProperties = {
    textAlign: "left", padding: "8px 10px", fontSize: 11, fontWeight: 700,
    color: "var(--sl-muted, #64748b)", textTransform: "uppercase", letterSpacing: "0.04em",
    borderBottom: "2px solid var(--sl-border, #e5e7eb)", cursor: "pointer",
    background: "var(--sl-surface, #fff)", position: "sticky", top: 0,
    userSelect: "none", whiteSpace: "nowrap",
  };

  const tdStyle: React.CSSProperties = {
    padding: "6px 10px", borderBottom: "1px solid var(--sl-border, #f1f5f9)",
    fontSize: 12.5, color: "var(--sl-fg, #1e293b)",
  };

  return (
    <div style={{ border: "1px solid var(--sl-border, #e5e7eb)", borderRadius: 14, overflow: "hidden", background: "var(--sl-bg, #fff)" }}>
      <style>{GRID_CSS}</style>
      {/* Toolbar */}
      <div style={{ display: "flex", gap: 8, padding: "8px 14px", borderBottom: "1px solid var(--sl-border, #e5e7eb)", background: "var(--sl-surface, #fff)", alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--sl-fg, #1e293b)" }}>
          {sorted.length} rows
        </span>
        {Object.values(filters).some(Boolean) && (
          <button onClick={() => setFilters({})} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", color: "var(--sl-fg)", cursor: "pointer" }}>
            Clear filters
          </button>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
          {!readOnly && (
            <>
              <button onClick={handleAddRow} className="__dg_btn" style={{ fontSize: 11, padding: "4px 10px", borderRadius: 7, border: "1px solid var(--sl-border, #e5e7eb)", background: "var(--sl-surface, #fff)", color: "var(--sl-fg)", cursor: "pointer", fontWeight: 500 }}>
                + Row
              </button>
              {onColumnsChange && (
                <button onClick={handleAddColumn} className="__dg_btn" style={{ fontSize: 11, padding: "4px 10px", borderRadius: 7, border: "1px solid var(--sl-border, #e5e7eb)", background: "var(--sl-surface, #fff)", color: "var(--sl-fg)", cursor: "pointer", fontWeight: 500 }}>
                  + Column
                </button>
              )}
              {selectedRow && (
                <button onClick={() => handleRemoveRow(selectedRow)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 7, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", color: "var(--sl-danger, #ef4444)", cursor: "pointer", fontWeight: 500 }}>
                  🗑️ Row
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Table */}
      <div style={{ overflow: "auto", maxHeight: 520 }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
          <thead>
            <tr>
              {!readOnly && <th style={{ ...thStyle, width: 32 }}>#</th>}
              {columns.map((col) => (
                <th key={col.id} className="__dg_th" style={{ ...thStyle, width: col.width ?? undefined }} onClick={() => handleSort(col.id)}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: 9, opacity: 0.6 }}>{TYPE_ICON[col.type]}</span>
                    <span>{col.label}</span>
                    {sortCol === col.id && <span style={{ fontSize: 10 }}>{sortDir === "asc" ? "▲" : "▼"}</span>}
                    {!readOnly && onColumnsChange && (
                      <button onClick={(e) => { e.stopPropagation(); handleRemoveColumn(col.id); }}
                        style={{ marginLeft: "auto", fontSize: 9, cursor: "pointer", background: "none", border: "none", color: "var(--sl-muted)", padding: 1, opacity: 0.5 }}>✕</button>
                    )}
                  </div>
                </th>
              ))}
            </tr>
            {/* Filter row */}
            <tr>
              {!readOnly && <td style={{ padding: "2px 4px", borderBottom: "1px solid var(--sl-border)" }} />}
              {columns.map((col) => (
                <td key={col.id} style={{ padding: "2px 6px", borderBottom: "1px solid var(--sl-border, #e5e7eb)" }}>
                  <input
                    value={filters[col.id] ?? ""}
                    onChange={(e) => { setFilters({ ...filters, [col.id]: e.target.value }); setPage(0); }}
                    placeholder="Filter..."
                    className="__dg_filter"
                    style={{ width: "100%", fontSize: 10, padding: "3px 6px", borderRadius: 5, border: "1px solid var(--sl-border, #e5e7eb)", background: "var(--sl-bg, #f8fafc)", color: "var(--sl-fg)", outline: "none", transition: "border-color .15s,box-shadow .15s" }}
                  />
                </td>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.map((row, ri) => {
              const isSelected = selectedRow === row.id;
              return (
                <tr key={row.id} className="__dg_row" onClick={() => setSelectedRow(isSelected ? null : row.id)}
                  style={{ background: isSelected ? "rgba(99,102,241,0.06)" : ri % 2 === 0 ? "transparent" : "var(--sl-bg, #fafbfc)", cursor: "pointer" }}>
                  {!readOnly && (
                    <td style={{ ...tdStyle, fontSize: 10, color: "var(--sl-muted)", textAlign: "center" }}>{page * pageSize + ri + 1}</td>
                  )}
                  {columns.map((col) => (
                    <td key={col.id} style={tdStyle}
                      onDoubleClick={() => !readOnly && setEditingCell({ rowId: row.id, colId: col.id })}>
                      <CellEditor col={col} value={row.cells[col.id]} readOnly={readOnly && !(editingCell?.rowId === row.id && editingCell?.colId === col.id)}
                        onChange={(val) => handleCellChange(row.id, col.id, val)} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "8px 14px", borderTop: "1px solid var(--sl-border, #e5e7eb)", background: "var(--sl-surface, #fff)" }}>
          <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}
            className="__dg_pgbtn"
            style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", color: "var(--sl-fg)", cursor: page === 0 ? "default" : "pointer", opacity: page === 0 ? 0.4 : 1 }}>
            ← Prev
          </button>
          <span style={{ fontSize: 11, color: "var(--sl-muted)" }}>
            Page {page + 1} of {totalPages}
          </span>
          <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}
            className="__dg_pgbtn"
            style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", color: "var(--sl-fg)", cursor: page >= totalPages - 1 ? "default" : "pointer", opacity: page >= totalPages - 1 ? 0.4 : 1 }}>
            Next →
          </button>
        </div>
      )}

      {/* Empty state */}
      {rows.length === 0 && (
        <div style={{
          padding: 40, textAlign: "center", color: "var(--sl-muted, #94a3b8)",
        }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>📊</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--sl-fg, #475569)" }}>
            {readOnly ? "No data" : "Click '+ Row' to add data"}
          </div>
        </div>
      )}
    </div>
  );
}

export default DataGridWidget;
