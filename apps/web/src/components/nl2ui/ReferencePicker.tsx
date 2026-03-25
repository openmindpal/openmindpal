"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { apiFetch } from "@/lib/api";
import type { FieldDef } from "@/lib/types";

/**
 * ReferencePicker - search and select a referenced entity (e.g. customer, product).
 *
 * Usage:
 * <ReferencePicker
 *   fieldDef={{ referenceEntity: "customer", displayField: "name" }}
 *   value={selectedCustomerId}
 *   onChange={(id) => setSelectedCustomerId(id)}
 * />
 */
export function ReferencePicker({
  fieldDef,
  value,
  onChange,
  disabled = false,
  placeholder,
  cascadeFilter,
}: {
  fieldDef: Pick<FieldDef, "referenceEntity" | "displayField" | "searchFields"> & { required?: boolean };
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Extra filter applied when a parent field value is set (for cascading) */
  cascadeFilter?: { field: string; value: string } | null;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const entityName = fieldDef.referenceEntity ?? "";
  const displayField = fieldDef.displayField ?? "name";
  const searchFields = useMemo(
    () => (Array.isArray(fieldDef.searchFields) && fieldDef.searchFields.length ? fieldDef.searchFields : [displayField]),
    [displayField, fieldDef.searchFields],
  );
  const cascadeField = cascadeFilter?.field ?? "";
  const cascadeValue = cascadeFilter?.value ?? "";

  // Debounced search
  useEffect(() => {
    if (!showDropdown || !query.trim()) {
      return;
    }

    const timer = setTimeout(() => {
      loadOptions(query);
    }, 300);

    return () => clearTimeout(timer);
  }, [query, showDropdown, cascadeValue, loadOptions]);

  // When cascade parent value changes, reset selection if incompatible
  const prevCascadeRef = useRef(cascadeFilter?.value);
  useEffect(() => {
    if (prevCascadeRef.current !== cascadeValue) {
      prevCascadeRef.current = cascadeValue;
      // Clear current selection when parent changes
      if (value) {
        onChange("");
        setQuery("");
        setOptions([]);
      }
    }
  }, [cascadeValue, onChange, value]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const loadOptions = useCallback(async (searchText: string) => {
    if (!entityName) return;
    setLoading(true);
    try {
      const searchFilter = searchFields.length > 1
        ? { or: searchFields.map((field) => ({ field, op: "contains" as const, value: searchText })) }
        : { field: searchFields[0], op: "contains" as const, value: searchText };

      // Build combined filters (search + cascade)
      const filterConds: unknown[] = [searchFilter];
      if (cascadeField && cascadeValue) {
        filterConds.push({ field: cascadeField, op: "eq" as const, value: cascadeValue });
      }

      const res = await apiFetch(`/entities/${encodeURIComponent(entityName)}/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaName: "core",
          limit: 20,
          select: [displayField],
          filters: { and: filterConds },
        }),
      });

      if (!res.ok) throw new Error("Failed to fetch options");

      const json = await res.json();
      const items = Array.isArray(json.items) ? json.items : [];
      const opts = items.map((item: any) => ({
        id: String(item.id ?? ""),
        label: String(item.payload?.[displayField] ?? item.payload?.name ?? item.id ?? ""),
      }));
      setOptions(opts);
    } catch (err) {
      console.error("ReferencePicker load error:", err);
      setOptions([]);
    } finally {
      setLoading(false);
    }
  }, [cascadeField, cascadeValue, displayField, entityName, searchFields]);

  const handleSelect = useCallback(
    (option: { id: string; label: string }) => {
      onChange(option.id);
      setQuery(option.label);
      setShowDropdown(false);
      setHighlightedIndex(-1);
    },
    [onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.min(prev + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < options.length) {
        handleSelect(options[highlightedIndex]!);
      }
    } else if (e.key === "Escape") {
      setShowDropdown(false);
    }
  };

  // If value exists on init, load its display label
  useEffect(() => {
    if (value && !query) {
      loadSingleOption(value);
    }
  }, [loadSingleOption, query, value]);

  const loadSingleOption = useCallback(async (id: string) => {
    if (!entityName || !id) return;
    try {
      const res = await apiFetch(`/entities/${encodeURIComponent(entityName)}/${encodeURIComponent(id)}`);
      if (!res.ok) return;
      const json = await res.json();
      const label = String(json?.payload?.[displayField] ?? json?.payload?.name ?? "");
      setQuery(label);
    } catch {
      // Ignore errors
    }
  }, [displayField, entityName]);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setShowDropdown(true);
          if (!e.target.value) {
            onChange("");
          }
        }}
        onFocus={() => setShowDropdown(true)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder ?? `Search ${entityName}...`}
        style={{
          width: "100%",
          padding: "8px 12px",
          borderRadius: "6px",
          border: "1px solid #e2e8f0",
          fontSize: "14px",
          background: disabled ? "#f1f5f9" : "white",
          cursor: disabled ? "not-allowed" : "text",
        }}
      />
      {showDropdown && (query.trim() || loading) && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 1000,
            marginTop: "4px",
            maxHeight: "240px",
            overflowY: "auto",
            background: "white",
            border: "1px solid #e2e8f0",
            borderRadius: "6px",
            boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
          }}
        >
          {loading && (
            <div style={{ padding: "8px 12px", color: "#64748b", fontSize: "13px" }}>Loading...</div>
          )}
          {!loading && options.length === 0 && query.trim() && (
            <div style={{ padding: "8px 12px", color: "#64748b", fontSize: "13px" }}>No matches</div>
          )}
          {!loading &&
            options.map((option, index) => (
              <div
                key={option.id}
                onClick={() => handleSelect(option)}
                onMouseEnter={() => setHighlightedIndex(index)}
                style={{
                  padding: "8px 12px",
                  cursor: "pointer",
                  background: index === highlightedIndex ? "#f1f5f9" : "transparent",
                  fontSize: "13px",
                }}
              >
                {option.label}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
