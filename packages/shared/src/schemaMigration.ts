export const SUPPORTED_SCHEMA_MIGRATION_KINDS = ["backfill_required_field", "rename_field_dual_write"] as const;

export type SchemaMigrationKind = (typeof SUPPORTED_SCHEMA_MIGRATION_KINDS)[number];

export function isSupportedSchemaMigrationKind(kind: string): kind is SchemaMigrationKind {
  return (SUPPORTED_SCHEMA_MIGRATION_KINDS as readonly string[]).includes(kind);
}
