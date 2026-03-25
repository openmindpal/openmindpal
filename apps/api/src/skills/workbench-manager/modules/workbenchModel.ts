export type WorkbenchScope = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
};

export type WorkbenchPluginRow = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  workbenchKey: string;
  displayName: any | null;
  description: any | null;
  status: string;
  createdBySubjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkbenchPluginVersionRow = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  workbenchKey: string;
  version: number;
  status: "draft" | "released";
  artifactRef: string;
  manifestJson: any;
  manifestDigest: string;
  publishedAt: string;
  createdBySubjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkbenchActiveVersionRow = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  workbenchKey: string;
  activeVersion: number;
  updatedAt: string;
};

export type WorkbenchCanaryConfigRow = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  workbenchKey: string;
  canaryVersion: number;
  canarySubjectIds: string[];
  updatedAt: string;
};
