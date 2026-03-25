import type { I18nText } from "./api";
import type { ApiError } from "./apiError";

export type SearchParams = Record<string, string | string[] | undefined>;

export type FieldType = "string" | "number" | "boolean" | "json" | "datetime" | "reference";

export type FieldDef = {
  type?: FieldType;
  required?: boolean;
  displayName?: I18nText | string;
  writable?: boolean;
  /** For type=="reference": the target entity name (e.g. "customer") */
  referenceEntity?: string;
  /** For type=="reference": which field of the target entity to display in the picker (e.g. "name") */
  displayField?: string;
  /** For type=="reference": which fields to search against when filtering (defaults to [displayField]) */
  searchFields?: string[];
  /** Cascading dependency on a sibling field */
  dependsOn?: {
    /** sibling field name whose value this depends on */
    field: string;
    /** field on the referenced entity to match against */
    filterField: string;
  };
};

export type EffectiveSchema = {
  displayName?: I18nText | string;
  fields?: Record<string, FieldDef>;
};

export type UiNavItem = {
  name: string;
  title?: I18nText | string;
  pageType: string;
  href: string;
  target?: string;
};

export type UiNavigation = {
  items?: UiNavItem[];
};

export type UiActionBinding = {
  action?: string;
  toolRef: string;
};

export type UiLayout = {
  variant?: string;
  density?: "comfortable" | "compact";
};

export type UiBlock = {
  slot: string;
  componentId: string;
  props?: Record<string, unknown>;
};

export type UiListUi = {
  columns?: string[];
  filters?: string[];
  sortOptions?: Array<{ field: string; direction: "asc" | "desc" }>;
  pageSize?: number;
};

export type UiDetailUi = {
  fieldOrder?: string[];
  groups?: Array<{ title?: I18nText | string; fields: string[] }>;
};

export type UiFormUi = {
  fieldOrder?: string[];
  groups?: Array<{ title?: I18nText | string; fields: string[] }>;
};

export type UiPageUi = {
  layout?: UiLayout;
  blocks?: UiBlock[];
  list?: UiListUi;
  detail?: UiDetailUi;
  form?: UiFormUi;
};

export type UiDataBinding =
  | { target: "entities.list"; entityName: string }
  | { target: "entities.query"; entityName: string; schemaName?: string; query?: Record<string, unknown> }
  | { target: "entities.get"; entityName: string; idParam?: string }
  | { target: "schema.effective"; entityName: string; schemaName?: string };

export type UiPageVersion = {
  name: string;
  pageType: string;
  title?: I18nText | string;
  version?: number;
  params?: Record<string, unknown>;
  dataBindings?: UiDataBinding[];
  actionBindings?: UiActionBinding[];
  ui?: UiPageUi;
};

/* ─── Shared orchestrator/chat types (§08 AI Orchestrator) ────────────── */

export type ToolSuggestion = {
  suggestionId?: string;
  toolRef?: string;
  inputDraft?: unknown;
  scope?: string;
  resourceType?: string;
  action?: string;
  riskLevel?: string;
  approvalRequired?: boolean;
  idempotencyKey?: string;
};

export type TurnResponse = ApiError & {
  turnId?: string;
  conversationId?: string;
  replyText?: Record<string, string> | string;
  uiDirective?: unknown;
  toolSuggestions?: ToolSuggestion[];
};

export type ExecuteResponse = ApiError & {
  jobId?: string;
  runId?: string;
  stepId?: string;
  approvalId?: string;
  idempotencyKey?: string;
  receipt?: { status?: string; correlation?: Record<string, unknown> };
};
