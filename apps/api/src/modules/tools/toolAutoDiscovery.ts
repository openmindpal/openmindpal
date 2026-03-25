/**
 * Tool Auto-Discovery.
 *
 * Automatically discovers and registers tools from THREE sources:
 * 1. Built-in skill plugins (manifest.tools declarations) — e.g. memory.read, nl2ui.generate
 * 2. External skill packages (skills/ directory manifest.json) — e.g. collab.guard, sleep
 * 3. Built-in skill identity (any plugin without explicit tools) — registered as builtin_skill
 *
 * For each discovered tool, ensures:
 * - tool_definitions row exists
 * - tool_versions row (v1, released) exists
 * - tool_active_versions row exists (pointing to @1)
 * - tool_rollouts row exists (enabled at tenant level)
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { getBuiltinSkills, isBuiltinSkillRegistrySealed, resolveSkillLayer } from "../../lib/skillPlugin";
import type { SkillLayer } from "../../lib/skillPlugin";

/* ------------------------------------------------------------------ */
/*  Common tool shape                                                  */
/* ------------------------------------------------------------------ */

interface DiscoveredTool {
  name: string;
  displayName: Record<string, string> | null;
  description: Record<string, string> | null;
  scope: "read" | "write";
  resourceType: string;
  action: string;
  idempotencyRequired: boolean;
  riskLevel: "low" | "medium" | "high";
  approvalRequired: boolean;
  inputSchema: any;
  outputSchema: any;
  artifactRef: string | null;
  /** Source layer classification. */
  sourceLayer: SkillLayer;
}

/* ------------------------------------------------------------------ */
/*  Skill directory scanning                                           */
/* ------------------------------------------------------------------ */

function getSkillRoots(): string[] {
  const raw = String(process.env.SKILL_PACKAGE_ROOTS ?? "");
  const parts = raw.split(/[;,]/g).map((x) => x.trim()).filter(Boolean);
  const reg = String(process.env.SKILL_REGISTRY_DIR ?? "").trim();
  const registryRoot = path.resolve(reg || path.resolve(process.cwd(), ".data", "skill-registry"));
  if (parts.length) return Array.from(new Set([...parts.map((p) => path.resolve(p)), registryRoot]));
  const defaults = [path.resolve(process.cwd(), "skills"), path.resolve(process.cwd(), "..", "..", "skills")];
  const bases: string[] = [];
  for (const d of defaults) {
    try { require("node:fs").statSync(d); bases.push(d); } catch { /* skip */ }
  }
  return Array.from(new Set([...(bases.length ? bases : [defaults[0]]), registryRoot]));
}

/* Reuse DiscoveredTool for directory scanning (same shape) */

async function scanSkillDirectories(): Promise<DiscoveredTool[]> {
  const roots = getSkillRoots();
  const skills: DiscoveredTool[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const manifestPath = path.join(root, entry, "manifest.json");
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const manifest = JSON.parse(raw);
        const name = String(manifest?.identity?.name ?? "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);

        const contract = manifest?.contract ?? {};
        const io = manifest?.io ?? {};
        const scope = contract.scope === "write" ? "write" : "read";
        const riskLevel = ["low", "medium", "high"].includes(contract.riskLevel) ? contract.riskLevel : "low";

        skills.push({
          name,
          displayName: null,
          description: null,
          scope: scope as "read" | "write",
          resourceType: String(contract.resourceType ?? "tool"),
          action: String(contract.action ?? "execute"),
          idempotencyRequired: Boolean(contract.idempotencyRequired),
          riskLevel: riskLevel as "low" | "medium" | "high",
          approvalRequired: Boolean(contract.approvalRequired),
          inputSchema: io.inputSchema ?? null,
          outputSchema: io.outputSchema ?? null,
          artifactRef: path.join(root, entry),
          sourceLayer: "extension" as SkillLayer,
        });
      } catch {
        // skip invalid manifests
      }
    }
  }
  return skills;
}

/* ------------------------------------------------------------------ */
/*  Collect from built-in skill plugin registry (manifest.tools)       */
/* ------------------------------------------------------------------ */

function collectBuiltinSkillTools(seen: Set<string>): DiscoveredTool[] {
  const tools: DiscoveredTool[] = [];
  if (!isBuiltinSkillRegistrySealed()) {
    // Registry not yet initialized — this is a programming error if called after server startup.
    // During seed (before buildServer) this is expected; log and skip.
    console.warn("[tool-discovery] built-in skill registry not sealed yet — skipping builtin tools. " +
      "If this happens during server startup, it indicates a startup-ordering bug.");
    return tools;
  }
  const builtinSkills = getBuiltinSkills();
  for (const [skillName, skill] of builtinSkills) {
    const layer = resolveSkillLayer(skill);
    // 1. Register explicit tool declarations from manifest.tools
    const declared = skill.manifest.tools ?? [];
    for (const td of declared) {
      if (!td.name || seen.has(td.name)) continue;
      seen.add(td.name);
      tools.push({
        name: td.name,
        displayName: td.displayName ?? null,
        description: td.description ?? null,
        scope: td.scope,
        resourceType: td.resourceType,
        action: td.action,
        idempotencyRequired: td.idempotencyRequired ?? false,
        riskLevel: td.riskLevel ?? "low",
        approvalRequired: td.approvalRequired ?? false,
        inputSchema: td.inputSchema ?? null,
        outputSchema: td.outputSchema ?? null,
        artifactRef: null,
        sourceLayer: layer,
      });
    }
    // 2. If no explicit tools and skill itself not yet registered, register the skill identity
    if (!declared.length && !seen.has(skillName)) {
      seen.add(skillName);
      const displayName = skillName.replace(/\./g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      tools.push({
        name: skillName,
        displayName: { "zh-CN": displayName, "en-US": displayName },
        description: null,
        scope: "read",
        resourceType: "builtin_skill",
        action: "invoke",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: null,
        outputSchema: null,
        artifactRef: null,
        sourceLayer: layer,
      });
    }
  }
  return tools;
}

/* ------------------------------------------------------------------ */
/*  Auto-registration                                                  */
/* ------------------------------------------------------------------ */

export async function autoDiscoverAndRegisterTools(pool: Pool): Promise<{ registered: number; skipped: number }> {
  // 1. Find all tenants
  const tenantRes = await pool.query("SELECT id FROM tenants ORDER BY id");
  if (!tenantRes.rowCount) return { registered: 0, skipped: 0 };
  const tenantIds = tenantRes.rows.map((r: any) => String(r.id));

  // 2. Collect tools from all sources (order: built-in manifest.tools > skills/ directory > skill identity fallback)
  const seen = new Set<string>();
  const allTools: DiscoveredTool[] = [];

  // Source A: Built-in skill plugin manifest.tools (e.g. entity.create, memory.read, nl2ui.generate)
  const builtinTools = collectBuiltinSkillTools(seen);
  allTools.push(...builtinTools);

  // Source B: External skill packages from skills/ directories (e.g. collab.guard, sleep, math.add)
  const scannedSkills = await scanSkillDirectories();
  for (const sk of scannedSkills) {
    if (seen.has(sk.name)) continue;
    seen.add(sk.name);
    allTools.push(sk);
  }

  let registered = 0;
  let skipped = 0;

  for (const tenantId of tenantIds) {
    // Get all spaces for this tenant (for rollout enabling)
    const spaceRes = await pool.query("SELECT id FROM spaces WHERE tenant_id = $1 ORDER BY id", [tenantId]);
    const spaceIds = spaceRes.rows.map((r: any) => String(r.id));

    for (const tool of allTools) {
      try {
        // Upsert tool_definitions
        await pool.query(
          `
            INSERT INTO tool_definitions (tenant_id, name, display_name, description, scope, resource_type, action, idempotency_required, risk_level, approval_required, source_layer)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (tenant_id, name) DO UPDATE
            SET display_name = COALESCE(tool_definitions.display_name, EXCLUDED.display_name),
                description = COALESCE(tool_definitions.description, EXCLUDED.description),
                scope = COALESCE(tool_definitions.scope, EXCLUDED.scope),
                resource_type = COALESCE(tool_definitions.resource_type, EXCLUDED.resource_type),
                action = COALESCE(tool_definitions.action, EXCLUDED.action),
                idempotency_required = COALESCE(tool_definitions.idempotency_required, EXCLUDED.idempotency_required),
                source_layer = COALESCE(EXCLUDED.source_layer, tool_definitions.source_layer),
                updated_at = now()
          `,
          [
            tenantId,
            tool.name,
            tool.displayName ? JSON.stringify(tool.displayName) : null,
            tool.description ? JSON.stringify(tool.description) : null,
            tool.scope,
            tool.resourceType,
            tool.action,
            tool.idempotencyRequired,
            tool.riskLevel,
            tool.approvalRequired,
            tool.sourceLayer,
          ],
        );

        // Upsert tool_versions (version 1)
        const toolRef = `${tool.name}@1`;
        await pool.query(
          `
            INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, input_schema, output_schema, artifact_ref)
            VALUES ($1, $2, 1, $3, 'released', $4, $5, $6)
            ON CONFLICT (tenant_id, name, version) DO UPDATE
            SET input_schema = COALESCE(tool_versions.input_schema, EXCLUDED.input_schema),
                output_schema = COALESCE(tool_versions.output_schema, EXCLUDED.output_schema),
                artifact_ref = COALESCE(EXCLUDED.artifact_ref, tool_versions.artifact_ref)
          `,
          [tenantId, tool.name, toolRef, tool.inputSchema, tool.outputSchema, tool.artifactRef],
        );

        // Upsert tool_active_versions
        await pool.query(
          `
            INSERT INTO tool_active_versions (tenant_id, name, active_tool_ref)
            VALUES ($1, $2, $3)
            ON CONFLICT (tenant_id, name) DO NOTHING
          `,
          [tenantId, tool.name, toolRef],
        );

        // Upsert tool_rollouts — only auto-enable for kernel layer tools
        if (tool.sourceLayer === "kernel") {
          await pool.query(
            `
              INSERT INTO tool_rollouts (tenant_id, scope_type, scope_id, tool_ref, enabled)
              VALUES ($1, 'tenant', $1, $2, true)
              ON CONFLICT (tenant_id, scope_type, scope_id, tool_ref) DO NOTHING
            `,
            [tenantId, toolRef],
          );
          for (const spaceId of spaceIds) {
            await pool.query(
              `
                INSERT INTO tool_rollouts (tenant_id, scope_type, scope_id, tool_ref, enabled)
                VALUES ($1, 'space', $2, $3, true)
                ON CONFLICT (tenant_id, scope_type, scope_id, tool_ref) DO NOTHING
              `,
              [tenantId, spaceId, toolRef],
            );
          }
        }
        // Non-kernel tools: no auto-enable — must be enabled via governance

        registered++;
      } catch {
        skipped++;
      }
    }
  }

  return { registered, skipped };
}
