import { Errors } from "../../lib/errors";

export type UiComponentSpec = {
  componentId: string;
  allowedPageTypes: string[];
};

const registry: UiComponentSpec[] = [
  { componentId: "EntityList.Table", allowedPageTypes: ["entity.list"] },
  { componentId: "EntityList.Cards", allowedPageTypes: ["entity.list"] },
  { componentId: "EntityDetail.Panel", allowedPageTypes: ["entity.detail"] },
  { componentId: "EntityForm.Single", allowedPageTypes: ["entity.new", "entity.edit"] },
];

export function listUiComponentRegistryComponentIds(): string[] {
  return registry.map((x) => x.componentId);
}

export function validateUiAgainstRegistry(params: { pageType: string; ui: any }) {
  const ui = params.ui && typeof params.ui === "object" ? params.ui : {};
  const blocks = Array.isArray((ui as any).blocks) ? (ui as any).blocks : [];
  for (const b of blocks) {
    const componentId = typeof b?.componentId === "string" ? b.componentId : "";
    if (!componentId) throw Errors.uiConfigDenied("blocks.componentId 缺失");
    const spec = registry.find((x) => x.componentId === componentId);
    if (!spec) throw Errors.uiConfigDenied("非法 componentId");
    if (!spec.allowedPageTypes.includes(params.pageType)) throw Errors.uiConfigDenied("componentId 与 pageType 不匹配");
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
