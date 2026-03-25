"use client";

import { useState, useCallback, useRef, useEffect } from "react";

// ─── Block Types ────────────────────────────────────────────────────────────

export type BlockType = "text" | "heading" | "heading2" | "heading3" | "code" | "image" | "divider" | "list" | "todo" | "quote" | "callout" | "table" | "embed" | "toggle";

export interface Block {
  id: string;
  type: BlockType;
  content: string;
  meta?: Record<string, any>;
  children?: Block[];
}

export interface BlockEditorProps {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  readOnly?: boolean;
  locale?: string;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

let _blockIdCounter = 0;
function generateBlockId(): string { return `blk_${Date.now()}_${++_blockIdCounter}`; }
function createBlock(type: BlockType, content = ""): Block { return { id: generateBlockId(), type, content }; }

interface BlockMeta {
  icon: string;
  label: string;
  desc: string;
  group: string;
}

const BLOCK_META: Record<BlockType, BlockMeta> = {
  text:     { icon: "📝", label: "Text",      desc: "Paragraph",        group: "Basic" },
  heading:  { icon: "H1",  label: "Heading 1", desc: "Large heading",    group: "Basic" },
  heading2: { icon: "H2",  label: "Heading 2", desc: "Medium heading",   group: "Basic" },
  heading3: { icon: "H3",  label: "Heading 3", desc: "Small heading",    group: "Basic" },
  list:     { icon: "📋", label: "List",      desc: "Bullet list",       group: "Basic" },
  todo:     { icon: "☑️",  label: "Todo",      desc: "Checklist item",   group: "Basic" },
  quote:    { icon: "\u201c",   label: "Quote",     desc: "Quote block",      group: "Basic" },
  callout:  { icon: "💡", label: "Callout",   desc: "Highlighted note",  group: "Basic" },
  divider:  { icon: "─",   label: "Divider",  desc: "Horizontal rule",   group: "Basic" },
  toggle:   { icon: "▶",   label: "Toggle",   desc: "Collapsible block", group: "Advanced" },
  code:     { icon: "💻", label: "Code",     desc: "Code block",        group: "Advanced" },
  image:    { icon: "🖼️", label: "Image",    desc: "Image embed",       group: "Media" },
  embed:    { icon: "🔗", label: "Embed",    desc: "External embed",    group: "Media" },
  table:    { icon: "📊", label: "Table",    desc: "Simple table",      group: "Advanced" },
};

// ─── Slash Command Menu ────────────────────────────────────────────────────

function SlashMenu(props: { filter: string; onSelect: (type: BlockType) => void; onClose: () => void }) {
  const { filter, onSelect, onClose } = props;
  const [activeIdx, setActiveIdx] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  const allTypes = Object.entries(BLOCK_META) as [BlockType, BlockMeta][];
  const filtered = allTypes.filter(([, m]) =>
    m.label.toLowerCase().includes(filter.toLowerCase()) || m.desc.toLowerCase().includes(filter.toLowerCase()),
  );

  useEffect(() => {
    const timer = setTimeout(() => setActiveIdx(0), 0);
    return () => clearTimeout(timer);
  }, [filter]);
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, filtered.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
      else if (e.key === "Enter" && filtered.length > 0) { e.preventDefault(); onSelect(filtered[activeIdx][0]); }
      else if (e.key === "Escape") { onClose(); }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [filtered, activeIdx, onSelect, onClose]);

  if (filtered.length === 0) return null;

  const groups = [...new Set(filtered.map(([, m]) => m.group))];

  return (
    <div ref={menuRef} style={{
      position: "absolute", left: 44, top: "100%", zIndex: 50, marginTop: 4,
      width: 260, maxHeight: 320, overflowY: "auto",
      background: "var(--sl-surface, #fff)", border: "1px solid var(--sl-border, #e5e7eb)",
      borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)",
      padding: "6px 0",
    }}>
      {groups.map((group) => (
        <div key={group}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--sl-muted, #94a3b8)", padding: "8px 14px 4px", textTransform: "uppercase", letterSpacing: "0.06em" }}>{group}</div>
          {filtered.filter(([, m]) => m.group === group).map(([type, meta]) => {
            const idx = filtered.findIndex(([t]) => t === type);
            const isActive = idx === activeIdx;
            return (
              <div key={type}
                onClick={() => onSelect(type)}
                onMouseEnter={() => setActiveIdx(idx)}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "7px 14px", cursor: "pointer",
                  background: isActive ? "var(--sl-hover, rgba(99,102,241,0.08))" : "transparent",
                  borderRadius: 6, margin: "0 4px", transition: "background 0.1s",
                }}>
                <span style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, background: "var(--sl-bg, #f8fafc)", border: "1px solid var(--sl-border, #e5e7eb)", fontSize: 13, flexShrink: 0 }}>{meta.icon}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--sl-fg, #1e293b)" }}>{meta.label}</div>
                  <div style={{ fontSize: 11, color: "var(--sl-muted, #94a3b8)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta.desc}</div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ─── Inline Rich Text Helper ─────────────────────────────────────────────────
// Renders **bold** and *italic* markers in read-only text blocks.

function RichText({ text, style }: { text: string; style?: React.CSSProperties }) {
  // Split by **bold** then *italic*
  const parts: React.ReactNode[] = [];
  const boldRegex = /\*\*(.+?)\*\*/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = boldRegex.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push(<span key={key++}>{text.slice(lastIdx, match.index)}</span>);
    parts.push(<strong key={key++} style={{ color: "#6366f1", fontWeight: 700 }}>{match[1]}</strong>);
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) parts.push(<span key={key++}>{text.slice(lastIdx)}</span>);
  if (parts.length === 0) parts.push(<span key={0}>{text}</span>);
  return <span style={style}>{parts}</span>;
}

// ─── Block Renderer ─────────────────────────────────────────────────────────

function BlockRenderer(props: {
  block: Block; readOnly: boolean; focused: boolean;
  onUpdate: (id: string, content: string) => void;
  onRemove: (id: string) => void;
  onFocus: (id: string) => void;
  onSlash: (id: string) => void;
  onMetaUpdate: (id: string, meta: Record<string, any>) => void;
}) {
  const { block, readOnly, onUpdate, onFocus, onSlash, onMetaUpdate } = props;
  const meta = BLOCK_META[block.type] ?? BLOCK_META.text;
  const [hovered, setHovered] = useState(false);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "/" || (val.length === 1 && val === "/")) { onSlash(block.id); }
    onUpdate(block.id, val);
  }, [block.id, onUpdate, onSlash]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "/" && block.content === "") { onSlash(block.id); }
  }, [block.id, block.content, onSlash]);

  // Clean document flow — minimal chrome
  const baseStyle: React.CSSProperties = {
    display: "flex", alignItems: "flex-start", position: "relative",
    padding: readOnly ? "1px 0" : "2px 4px",
    borderRadius: readOnly ? 0 : 6,
    transition: "background 0.15s",
    background: hovered && !readOnly ? "rgba(99,102,241,0.03)" : "transparent",
  };

  // Drag handle — only visible on hover in edit mode
  const gripStyle: React.CSSProperties = {
    width: 20, display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "grab", fontSize: 11, color: "var(--sl-muted, #cbd5e1)",
    flexShrink: 0, marginTop: 3, userSelect: "none",
    opacity: hovered ? 0.6 : 0, transition: "opacity 0.15s",
  };

  const inputBase: React.CSSProperties = {
    flex: 1, padding: "2px 0", border: "none", borderRadius: 0,
    background: "transparent", color: "var(--sl-fg, #1e293b)",
    outline: "none", resize: "none" as const, lineHeight: 1.7,
    fontFamily: "inherit", width: "100%",
  };

  // ─── Divider ───────────────────────────────────────────
  if (block.type === "divider") {
    return (
      <div style={{ ...baseStyle, padding: "6px 0" }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        {!readOnly && <span style={gripStyle}>⋮⋮</span>}
        <div style={{ flex: 1, padding: "4px 0" }}>
          <hr style={{ border: "none", height: 1, background: "linear-gradient(90deg, transparent, var(--sl-border, #d1d5db), transparent)" }} />
        </div>
      </div>
    );
  }

  // ─── Todo ──────────────────────────────────────────────
  if (block.type === "todo") {
    const checked = block.meta?.checked ?? false;
    return (
      <div style={{ ...baseStyle, gap: 8, padding: readOnly ? "1px 0" : "2px 4px" }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        {!readOnly && <span style={gripStyle}>⋮⋮</span>}
        <input
          type="checkbox"
          checked={checked}
          onChange={() => !readOnly && onMetaUpdate(block.id, { checked: !checked })}
          readOnly={readOnly}
          style={{ width: 16, height: 16, accentColor: "#6366f1", cursor: readOnly ? "default" : "pointer", marginTop: 3, flexShrink: 0 }}
        />
        {readOnly ? (
          <div style={{ ...inputBase, fontSize: 14, textDecoration: checked ? "line-through" : "none", color: checked ? "var(--sl-muted, #94a3b8)" : "var(--sl-fg, #1e293b)" }}>{block.content}</div>
        ) : (
          <input style={{ ...inputBase, textDecoration: checked ? "line-through" : "none", color: checked ? "var(--sl-muted, #94a3b8)" : "var(--sl-fg, #1e293b)", fontSize: 14 }}
            value={block.content} onChange={handleChange} onFocus={() => onFocus(block.id)} onKeyDown={handleKeyDown}
            placeholder="Todo item..." />
        )}
      </div>
    );
  }

  // ─── List (bullet points) ──────────────────────────────
  if (block.type === "list") {
    const lines = block.content ? block.content.split("\n") : [""];
    return (
      <div style={baseStyle} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        {!readOnly && <span style={gripStyle}>⋮⋮</span>}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, padding: "2px 0" }}>
          {readOnly ? (
            lines.map((line, i) => (
              <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10, fontSize: 14, lineHeight: 1.7, paddingLeft: 4 }}>
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--sl-fg, #475569)", flexShrink: 0, opacity: 0.35, position: "relative", top: -1 }} />
                <RichText text={line} />
              </div>
            ))
          ) : (
            <textarea style={{ ...inputBase, fontSize: 14, paddingLeft: 16 }}
              value={block.content} onChange={handleChange} onFocus={() => onFocus(block.id)} onKeyDown={handleKeyDown}
              rows={Math.max(lines.length, 1)} placeholder="List items (one per line)..." />
          )}
        </div>
      </div>
    );
  }

  // ─── Callout ───────────────────────────────────────────
  if (block.type === "callout") {
    const icon = block.meta?.icon ?? "💡";
    return (
      <div style={baseStyle} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        {!readOnly && <span style={gripStyle}>⋮⋮</span>}
        <div style={{ flex: 1, display: "flex", gap: 8, padding: "10px 14px", borderRadius: 8, background: "rgba(241,245,249,0.8)", borderLeft: "3px solid var(--sl-muted, #94a3b8)" }}>
          <span style={{ fontSize: 16, lineHeight: 1.5, flexShrink: 0 }}>{icon}</span>
          {readOnly ? (
            <div style={{ ...inputBase, fontSize: 14, color: "var(--sl-fg, #334155)", lineHeight: 1.7 }}><RichText text={block.content} /></div>
          ) : (
            <textarea style={{ ...inputBase, fontSize: 14 }} value={block.content} onChange={handleChange}
              onFocus={() => onFocus(block.id)} onKeyDown={handleKeyDown} rows={1} placeholder="Callout..." />
          )}
        </div>
      </div>
    );
  }

  // ─── Toggle ────────────────────────────────────────────
  if (block.type === "toggle") {
    const open = block.meta?.open ?? false;
    const childContent = block.meta?.childContent ?? "";
    return (
      <div style={baseStyle} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        {!readOnly && <span style={gripStyle}>⋮⋮</span>}
        <div style={{ flex: 1 }}>
          <div
            onClick={() => onMetaUpdate(block.id, { open: !open })}
            style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "2px 0" }}
          >
            <span style={{ fontSize: 10, transition: "transform 0.2s", transform: open ? "rotate(90deg)" : "none", display: "inline-block", color: "var(--sl-muted, #94a3b8)" }}>▶</span>
            {readOnly ? (
              <span style={{ flex: 1, fontWeight: 600, fontSize: 14, color: "var(--sl-fg, #1e293b)" }}>{block.content}</span>
            ) : (
              <input style={{ ...inputBase, fontWeight: 600, fontSize: 14, flex: 1 }} value={block.content} onChange={handleChange}
                onFocus={() => onFocus(block.id)} onKeyDown={handleKeyDown} placeholder="Toggle title..."
                onClick={(e) => e.stopPropagation()} />
            )}
          </div>
          {open && (
            <div style={{ paddingLeft: 18, marginTop: 2, borderLeft: "2px solid var(--sl-border, #e5e7eb)" }}>
              {readOnly ? (
                <div style={{ fontSize: 14, color: "var(--sl-fg, #475569)", lineHeight: 1.7, padding: "2px 0" }}>
                  {childContent || <span style={{ color: "var(--sl-muted, #cbd5e1)" }}>...</span>}
                </div>
              ) : (
                <textarea
                  style={{ ...inputBase, fontSize: 14, color: "var(--sl-fg, #475569)" }}
                  value={childContent}
                  onChange={(e) => onMetaUpdate(block.id, { childContent: e.target.value })}
                  rows={2}
                  placeholder="Toggle content..."
                />
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Code ──────────────────────────────────────────────
  if (block.type === "code") {
    const codeFont = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    return (
      <div style={baseStyle} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        {!readOnly && <span style={gripStyle}>⋮⋮</span>}
        <div style={{ flex: 1, padding: "12px 16px", borderRadius: 6, background: "#1e293b", overflowX: "auto" }}>
          {readOnly ? (
            <pre style={{ margin: 0 }}><code style={{ fontFamily: codeFont, fontSize: 13, color: "#e2e8f0", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{block.content || <span style={{ color: "#64748b" }}>Code</span>}</code></pre>
          ) : (
            <textarea style={{ ...inputBase, fontSize: 13, fontFamily: codeFont, color: "#e2e8f0", lineHeight: 1.6, background: "transparent" }}
              value={block.content} onChange={handleChange} onFocus={() => onFocus(block.id)} onKeyDown={handleKeyDown}
              rows={4} placeholder="Code..." />
          )}
        </div>
      </div>
    );
  }

  // ─── Quote ─────────────────────────────────────────────
  if (block.type === "quote") {
    return (
      <div style={baseStyle} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        {!readOnly && <span style={gripStyle}>⋮⋮</span>}
        <div style={{ flex: 1, paddingLeft: 16, borderLeft: "2px solid var(--sl-border, #d1d5db)", fontStyle: "italic" }}>
          {readOnly ? (
            <div style={{ ...inputBase, fontSize: 14, color: "var(--sl-fg, #64748b)", lineHeight: 1.7 }}><RichText text={block.content} /></div>
          ) : (
            <textarea style={{ ...inputBase, fontSize: 14, fontStyle: "italic", color: "var(--sl-fg, #64748b)" }}
              value={block.content} onChange={handleChange} onFocus={() => onFocus(block.id)} onKeyDown={handleKeyDown}
              rows={1} placeholder="Quote..." />
          )}
        </div>
      </div>
    );
  }

  // ─── Headings & Text (generic) ─────────────────────────
  const isHeading = block.type.startsWith("heading");
  const fontSize = block.type === "heading" ? 24 : block.type === "heading2" ? 20 : block.type === "heading3" ? 16 : 14;
  const fontWeight = isHeading ? 700 : 400;
  const lineHeight = block.type === "heading" ? 1.3 : block.type === "heading2" ? 1.35 : 1.7;
  // Extra top margin for headings (document rhythm)
  const marginTop = block.type === "heading" ? 16 : block.type === "heading2" ? 10 : block.type === "heading3" ? 6 : 0;

  return (
    <div style={{ ...baseStyle, marginTop }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {!readOnly && <span style={gripStyle}>⋮⋮</span>}
      <div style={{ flex: 1 }}>
        {readOnly ? (
          <div style={{ ...inputBase, fontSize, fontWeight, lineHeight, whiteSpace: "pre-wrap" }}>
            {block.content ? <RichText text={block.content} style={{ fontSize, fontWeight: fontWeight as any, lineHeight }} /> : null}
          </div>
        ) : (
          <textarea style={{ ...inputBase, fontSize, fontWeight, lineHeight }}
            value={block.content} onChange={handleChange} onFocus={() => onFocus(block.id)} onKeyDown={handleKeyDown}
            rows={1} placeholder={`${meta.label}...`} />
        )}
      </div>
    </div>
  );
}

// ─── Block Editor Widget ────────────────────────────────────────────────────

export function BlockEditorWidget(props: BlockEditorProps) {
  const { blocks, onChange, readOnly = false } = props;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [slashBlockId, setSlashBlockId] = useState<string | null>(null);
  const [slashFilter, setSlashFilter] = useState("");

  const handleUpdate = useCallback((id: string, content: string) => {
    if (slashBlockId === id) {
      const after = content.slice(content.lastIndexOf("/") + 1);
      setSlashFilter(after);
    }
    onChange(blocks.map((b) => (b.id === id ? { ...b, content } : b)));
  }, [blocks, onChange, slashBlockId]);

  const handleRemove = useCallback((id: string) => onChange(blocks.filter((b) => b.id !== id)), [blocks, onChange]);

  const handleAdd = useCallback((type: BlockType, afterId?: string) => {
    const newBlock = createBlock(type);
    if (afterId) {
      const idx = blocks.findIndex((b) => b.id === afterId);
      const newBlocks = [...blocks];
      newBlocks[idx] = { ...newBlocks[idx], content: newBlocks[idx].content.replace(/\/[^/]*$/, "") };
      newBlocks.splice(idx + 1, 0, newBlock);
      onChange(newBlocks);
    } else {
      onChange([...blocks, newBlock]);
    }
    setSlashBlockId(null);
    setSlashFilter("");
  }, [blocks, onChange]);

  const handleSlash = useCallback((id: string) => {
    setSlashBlockId(id);
    setSlashFilter("");
  }, []);

  const handleMetaUpdate = useCallback((id: string, metaUpdate: Record<string, any>) => {
    onChange(blocks.map((b) => (b.id === id ? { ...b, meta: { ...b.meta, ...metaUpdate } } : b)));
  }, [blocks, onChange]);

  // Clean document container — no visible border/card in readOnly
  const containerStyle: React.CSSProperties = readOnly
    ? { padding: "8px 4px", minHeight: 60 }
    : { padding: "12px 8px", border: "1px solid var(--sl-border, #e5e7eb)", borderRadius: 10, background: "var(--sl-bg, #fff)", minHeight: 80 };

  return (
    <div style={containerStyle}>
      {/* Blocks — natural document flow */}
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {blocks.map((block) => (
          <div key={block.id} style={{ position: "relative" }}>
            <BlockRenderer block={block} readOnly={readOnly} focused={focusedId === block.id}
              onUpdate={handleUpdate} onRemove={handleRemove} onFocus={setFocusedId} onSlash={handleSlash} onMetaUpdate={handleMetaUpdate} />
            {slashBlockId === block.id && (
              <SlashMenu filter={slashFilter} onSelect={(type) => handleAdd(type, block.id)} onClose={() => { setSlashBlockId(null); setSlashFilter(""); }} />
            )}
          </div>
        ))}
      </div>

      {/* Empty state */}
      {blocks.length === 0 && (
        <div style={{ padding: readOnly ? "20px 8px" : "32px 8px", textAlign: "center", color: "var(--sl-muted, #94a3b8)" }}>
          <div style={{ fontSize: 14, color: "var(--sl-muted, #cbd5e1)" }}>
            {readOnly ? "" : "Type / insert content"}
          </div>
        </div>
      )}

      {/* Subtle add hint at bottom (edit mode only) */}
      {!readOnly && blocks.length > 0 && (
        <div
          onClick={() => handleAdd("text")}
          style={{ padding: "8px 4px", cursor: "text", color: "var(--sl-muted, #cbd5e1)", fontSize: 14, transition: "color 0.15s" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--sl-muted, #94a3b8)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--sl-muted, #cbd5e1)")}
        >
          Type / insert content...
        </div>
      )}
    </div>
  );
}

export default BlockEditorWidget;
