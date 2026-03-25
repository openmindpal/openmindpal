export function renderTemplateText(text: string, params: any) {
  if (!text) return "";
  const ctx = params && typeof params === "object" ? params : {};
  return String(text).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, k) => {
    const v = (ctx as any)[k];
    if (v === null || v === undefined) return "";
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
    return "";
  });
}

