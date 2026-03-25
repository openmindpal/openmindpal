/**
 * Built-in Skill Route Contract.
 *
 * Defines the interface that every "built-in Skill" must implement
 * so the Skill Route Loader in server.ts can discover and register
 * them automatically – replacing the hardcoded scoped.register() calls.
 *
 * Third-party dynamic Skills run in sandboxed processes and do NOT use
 * this interface; they go through the Skill Runtime (apps/runner/).
 */
import type { FastifyPluginAsync } from "fastify";

/* ------------------------------------------------------------------ */
/*  Skill Layer — three-tier classification                            */
/* ------------------------------------------------------------------ */

/**
 * kernel       — Core platform tool declarations (entity CRUD etc.), no HTTP routes.
 *                Always auto-enabled. Part of the OS minimum viable kernel.
 * builtin      — Built-in capability plugins shipped with the platform
 *                (orchestrator, model-gateway, knowledge, memory, safety …).
 *                Registered at startup, enabled by governance.
 * extension    — Optional / upper-layer capabilities that can be loaded on demand
 *                (analytics, media-pipeline, replay-viewer, ai-event-reasoning …).
 *                Registered only when explicitly configured.
 */
export type SkillLayer = "kernel" | "builtin" | "extension";

/* ------------------------------------------------------------------ */
/*  Skill Manifest v2 (built-in variant)                               */
/* ------------------------------------------------------------------ */

export interface SkillManifestV2 {
  /** Unique skill identity. */
  identity: {
    /** Dot-separated name, e.g. "nl2ui.generator" */
    name: string;
    /** Semver version. */
    version: string;
  };

  /**
   * Classification layer for this skill.
   * Determines auto-enable policy, startup behaviour and governance defaults.
   * @default "builtin"
   */
  layer?: SkillLayer;

  /** HTTP route prefixes this skill owns, e.g. ["/nl2ui", "/ui"]. */
  routes?: string[];

  /** Frontend page routes, e.g. ["/gov/models", "/settings/models"]. */
  frontend?: string[];

  /**
   * Core primitives this skill depends on.
   * e.g. ["schemas", "entities", "tools", "audit", "rbac"]
   */
  dependencies?: string[];

  /**
   * Other built-in skills this skill depends on.
   * e.g. ["nl2ui.generator"]
   */
  skillDependencies?: string[];

  /**
   * Tool operations this skill provides.
   * Auto-discovery reads these to register tool_definitions.
   */
  tools?: SkillToolDeclaration[];
}

/** Tool declaration within a skill manifest. */
export interface SkillToolDeclaration {
  name: string;
  displayName?: Record<string, string>;
  description?: Record<string, string>;
  scope: "read" | "write";
  resourceType: string;
  action: string;
  idempotencyRequired?: boolean;
  riskLevel?: "low" | "medium" | "high";
  approvalRequired?: boolean;
  inputSchema?: any;
  outputSchema?: any;
}

/* ------------------------------------------------------------------ */
/*  Built-in Skill Plugin Contract                                     */
/* ------------------------------------------------------------------ */

export interface BuiltinSkillPlugin {
  /** Manifest describing this skill's identity and routes. */
  manifest: SkillManifestV2;

  /** Fastify plugin that registers all HTTP routes for this skill. */
  routes: FastifyPluginAsync;
}

/** Resolve the effective layer — defaults to "builtin" when omitted. */
export function resolveSkillLayer(plugin: BuiltinSkillPlugin): SkillLayer {
  return plugin.manifest.layer ?? "builtin";
}

/* ------------------------------------------------------------------ */
/*  Skill Registry (populated at startup)                              */
/* ------------------------------------------------------------------ */

const _registry = new Map<string, BuiltinSkillPlugin>();
let _registrySealed = false;

export function registerBuiltinSkill(plugin: BuiltinSkillPlugin): void {
  if (_registrySealed) {
    throw new Error(`Cannot register skill after registry is sealed: ${plugin.manifest.identity.name}`);
  }
  const name = plugin.manifest.identity.name;
  if (_registry.has(name)) {
    throw new Error(`Duplicate built-in skill registration: ${name}`);
  }
  _registry.set(name, plugin);
}

/**
 * Seal the registry — no further registrations allowed.
 * Call after all skills are registered to enforce startup-time determinism.
 */
export function sealBuiltinSkillRegistry(): void {
  _registrySealed = true;
}

/** Whether the registry has been sealed (init complete). */
export function isBuiltinSkillRegistrySealed(): boolean {
  return _registrySealed;
}

export function getBuiltinSkills(): ReadonlyMap<string, BuiltinSkillPlugin> {
  return _registry;
}

export function getBuiltinSkill(name: string): BuiltinSkillPlugin | undefined {
  return _registry.get(name);
}

/**
 * Validate that all skill dependencies are satisfied.
 * Call after all skills have been registered.
 */
export function validateSkillDependencies(): string[] {
  const errors: string[] = [];
  for (const [name, plugin] of _registry) {
    for (const dep of plugin.manifest.skillDependencies ?? []) {
      if (!_registry.has(dep)) {
        errors.push(`Skill "${name}" depends on "${dep}" which is not registered.`);
      }
    }
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/*  Startup Consistency Check                                          */
/* ------------------------------------------------------------------ */

export interface StartupCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    totalSkills: number;
    kernelCount: number;
    builtinCount: number;
    extensionCount: number;
    sealed: boolean;
  };
}

/**
 * Run a comprehensive consistency check of the skill registry.
 * Should be called after initBuiltinSkills() and seal, before serving requests.
 *
 * Checks:
 *  1. Registry is sealed
 *  2. All skill dependencies are satisfied
 *  3. At least one kernel skill exists
 *  4. Layer assignments are valid
 *  5. No skill name conflicts with route prefixes of another skill
 */
export function runStartupConsistencyCheck(): StartupCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Registry sealed?
  if (!_registrySealed) {
    errors.push("Registry is NOT sealed — initBuiltinSkills() may not have been called.");
  }

  // 2. Dependency check
  const depErrors = validateSkillDependencies();
  errors.push(...depErrors);

  // 3. Layer counts
  let kernelCount = 0;
  let builtinCount = 0;
  let extensionCount = 0;
  const validLayers: Set<string> = new Set(["kernel", "builtin", "extension"]);

  for (const [name, plugin] of _registry) {
    const layer = resolveSkillLayer(plugin);
    if (!validLayers.has(layer)) {
      errors.push(`Skill "${name}" has invalid layer "${layer}".`);
    }
    if (layer === "kernel") kernelCount++;
    else if (layer === "builtin") builtinCount++;
    else if (layer === "extension") extensionCount++;
  }

  if (kernelCount === 0) {
    errors.push("No kernel-layer skill registered — entity operations will be unavailable.");
  }

  // 4. Duplicate route prefix detection
  const routePrefixMap = new Map<string, string>();
  for (const [name, plugin] of _registry) {
    for (const prefix of plugin.manifest.routes ?? []) {
      const existing = routePrefixMap.get(prefix);
      if (existing && existing !== name) {
        warnings.push(`Route prefix "${prefix}" claimed by both "${existing}" and "${name}".`);
      } else {
        routePrefixMap.set(prefix, name);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      totalSkills: _registry.size,
      kernelCount,
      builtinCount,
      extensionCount,
      sealed: _registrySealed,
    },
  };
}
