import crypto from "node:crypto";
import { z } from "zod";
import { Errors } from "../../lib/errors";

function stable(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stable);
  const keys = Object.keys(v).sort();
  const out: any = {};
  for (const k of keys) out[k] = stable((v as any)[k]);
  return out;
}

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function isSafeDomainPattern(s: string) {
  if (!s) return false;
  if (s.length > 255) return false;
  if (s.includes("://")) return false;
  if (s.includes("/")) return false;
  if (s.includes("@")) return false;
  return /^[a-zA-Z0-9.*-]+(\.[a-zA-Z0-9-]+)+$/.test(s);
}

const DATA_BINDING_KIND = z.enum(["entities.query", "entities.get", "schema.effective"]);
const ACTION_BINDING_KIND = z.enum(["tools.invoke", "workflows.invoke"]);

const WorkbenchManifestSchemaV1 = z.object({
  apiVersion: z.literal("workbench.openslin/v1"),
  workbenchKey: z.string().min(1).max(200),
  entrypoint: z.object({
    type: z.literal("iframe"),
    assetPath: z.string().min(1).max(500),
  }),
  capabilities: z
    .object({
      dataBindings: z
        .array(
          z.object({
            kind: DATA_BINDING_KIND,
            allow: z.any().optional(),
            limit: z.coerce.number().int().positive().max(1000).optional(),
          }),
        )
        .optional(),
      actionBindings: z
        .array(
          z.object({
            kind: ACTION_BINDING_KIND,
            allow: z.any().optional(),
          }),
        )
        .optional(),
      egressPolicy: z
        .object({
          allowedDomains: z.array(z.string()).max(200).optional(),
        })
        .optional(),
    })
    .optional(),
  ui: z
    .object({
      displayName: z.any().optional(),
      description: z.any().optional(),
    })
    .optional(),
});

export type WorkbenchManifestV1 = z.infer<typeof WorkbenchManifestSchemaV1>;

export function validateWorkbenchManifestV1(input: unknown): { manifest: WorkbenchManifestV1; digest: string } {
  const parsed = WorkbenchManifestSchemaV1.safeParse(input);
  if (!parsed.success) throw Errors.badRequest(parsed.error.issues[0]?.message || "manifest 非法");

  const m = parsed.data;
  const domains = m.capabilities?.egressPolicy?.allowedDomains ?? [];
  for (const d of domains) {
    if (!isSafeDomainPattern(d)) throw Errors.badRequest("egressPolicy.allowedDomains 含非法域名");
  }
  if (domains.length > 0) throw Errors.workbenchManifestDenied("V1 禁止 workbench 插件直接出站");

  const digest = sha256Hex(JSON.stringify(stable(m)));
  return { manifest: m, digest };
}
