export type SyncConflictClass =
  | "base_version_stale"
  | "field_write_write"
  | "schema_mismatch"
  | "authz_denied"
  | "validation_failed"
  | "unknown";

export type SyncConflictView = {
  opId: string;
  targetRef: string;
  conflictClass: SyncConflictClass;
  reasonCode: string;
  baseVersion?: number | null;
  serverVersion?: number | null;
  fieldPaths?: string[] | null;
  hints?: string[] | null;
  candidatesSummary?: unknown;
  proposal?: {
    kind: "auto_apply_patch_if_unset";
    decision: "provide_merged_patch";
    mergedPatchDigest12: string;
    touchedFields: string[];
  } | null;
};

export type SyncMergeTranscript = {
  mergeId: string;
  accepted: unknown[];
  rejected: unknown[];
  conflicts: SyncConflictView[];
  sideEffectsSummary?: unknown;
};

export type SyncMergeSummary = {
  mergeId: string;
  inputDigest: string;
  mergeDigest: string;
  acceptedCount: number;
  rejectedCount: number;
  conflictsCount: number;
};

export type SyncConflictTicketStatus = "open" | "resolved" | "abandoned";

export type SyncConflictTicketSummary = {
  ticketId: string;
  mergeId: string;
  status: SyncConflictTicketStatus;
  conflictCount: number;
  updatedAt: string;
};
