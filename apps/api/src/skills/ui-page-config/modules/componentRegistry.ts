import { Errors } from "../../../lib/errors";

export type UiComponentSpec = {
  componentId: string;
  allowedPageTypes: string[];
  maxPerPage?: number;
  requiredProps?: string[];
};

const registry: UiComponentSpec[] = [
  { componentId: "EntityList.Table", allowedPageTypes: ["entity.list"], maxPerPage: 1 },
  { componentId: "EntityList.Cards", allowedPageTypes: ["entity.list"], maxPerPage: 1 },
  { componentId: "EntityDetail.Panel", allowedPageTypes: ["entity.detail"], maxPerPage: 3 },
  { componentId: "EntityForm.Single", allowedPageTypes: ["entity.new", "entity.edit"], maxPerPage: 1 },
  { componentId: "Chart.Bar", allowedPageTypes: ["dashboard", "entity.detail"], maxPerPage: 10 },
  { componentId: "Chart.Line", allowedPageTypes: ["dashboard", "entity.detail"], maxPerPage: 10 },
  { componentId: "Chart.Pie", allowedPageTypes: ["dashboard"], maxPerPage: 10 },
  { componentId: "Widget.Summary", allowedPageTypes: ["dashboard", "entity.list"], maxPerPage: 6 },
  { componentId: "Widget.Markdown", allowedPageTypes: ["dashboard", "entity.detail"], maxPerPage: 5 },
];

/* ─── Dynamic registry from DB (governance) ─── */
let dynamicRegistry: UiComponentSpec[] | null = null;
let dynamicRegistryExpiresAt = 0;

export function setDynamicRegistry(specs: UiComponentSpec[]) {
  dynamicRegistry = specs;
  dynamicRegistryExpiresAt = Date.now() + 60_000; // 1 min TTL
}

function getEffectiveRegistry(): UiComponentSpec[] {
  if (dynamicRegistry && dynamicRegistryExpiresAt > Date.now()) {
    return [...registry, ...dynamicRegistry];
  }
  return registry;
}

export function listUiComponentRegistryComponentIds(): string[] {
  return getEffectiveRegistry().map((x) => x.componentId);
}

export function getComponentSpec(componentId: string): UiComponentSpec | null {
  return getEffectiveRegistry().find((x) => x.componentId === componentId) ?? null;
}

export function isComponentAllowed(componentId: string): boolean {
  return getEffectiveRegistry().some((x) => x.componentId === componentId);
}

export function validateUiAgainstRegistry(params: { pageType: string; ui: any }) {
  const effectiveRegistry = getEffectiveRegistry();
  const ui = params.ui && typeof params.ui === "object" ? params.ui : {};
  const blocks = Array.isArray((ui as any).blocks) ? (ui as any).blocks : [];
  const countMap = new Map<string, number>();

  for (const b of blocks) {
    const componentId = typeof b?.componentId === "string" ? b.componentId : "";
    if (!componentId) throw Errors.uiConfigDenied("blocks.componentId 缺失");
    const spec = effectiveRegistry.find((x) => x.componentId === componentId);
    if (!spec) throw Errors.uiConfigDenied(`非法 componentId: ${componentId}`);
    if (!spec.allowedPageTypes.includes(params.pageType)) throw Errors.uiConfigDenied(`componentId ${componentId} 与 pageType ${params.pageType} 不匹配`);
    /* maxPerPage check */
    const cnt = (countMap.get(componentId) ?? 0) + 1;
    countMap.set(componentId, cnt);
    if (spec.maxPerPage && cnt > spec.maxPerPage) {
      throw Errors.uiConfigDenied(`componentId ${componentId} 超出单页最大数量 ${spec.maxPerPage}`);
    }
    /* requiredProps check */
    if (spec.requiredProps) {
      const props = b.props && typeof b.props === "object" ? b.props : {};
      for (const rp of spec.requiredProps) {
        if (!(rp in props)) throw Errors.uiConfigDenied(`componentId ${componentId} 缺少必要属性 ${rp}`);
      }
    }
  }

  const layout = (ui as any).layout;
  const variant = typeof layout?.variant === "string" ? layout.variant : "";
  if (variant) {
    const ok =
      (params.pageType === "entity.list" && ["table", "cards"].includes(variant)) ||
      (params.pageType === "entity.detail" && ["panel", "tabs"].includes(variant)) ||
      (params.pageType === "entity.new" && ["single", "twoColumn"].includes(variant)) ||
      (params.pageType === "entity.edit" && ["single", "twoColumn"].includes(variant));
    if (!ok) throw Errors.uiConfigDenied("非法 layout.variant");
  }
}

/* --- Runtime enforcement middleware helper --- architecture-01 section 3.2 --- */

export async function enforceComponentWhitelist(params: {
  pool: { query: (sql: string, args: any[]) => Promise<any> };
  tenantId: string;
  pageType: string;
  ui: any;
}) {
  /* Load tenant-specific component extensions from governance table */
  try {
    const res = await params.pool.query(
      `SELECT component_id, allowed_page_types, max_per_page, required_props
       FROM ui_component_registry_items WHERE tenant_id = $1 AND status = 'active'`,
      [params.tenantId],
    );
    const tenantSpecs: UiComponentSpec[] = res.rows.map((r: any) => ({
      componentId: String(r.component_id),
      allowedPageTypes: Array.isArray(r.allowed_page_types) ? r.allowed_page_types : [],
      maxPerPage: typeof r.max_per_page === "number" ? r.max_per_page : undefined,
      requiredProps: Array.isArray(r.required_props) ? r.required_props : undefined,
    }));
    if (tenantSpecs.length) setDynamicRegistry(tenantSpecs);
  } catch { /* table may not exist yet, skip */ }

  /* Validate against merged registry */
  validateUiAgainstRegistry({ pageType: params.pageType, ui: params.ui });
}
