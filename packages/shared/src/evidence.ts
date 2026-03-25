export type EvidenceSourceRef = {
  documentId: string;
  version: number;
  chunkId: string;
};

export type EvidenceRef = {
  retrievalLogId: string | null;
  sourceRef: EvidenceSourceRef;
  document: { title: string; sourceType: string };
  location: { chunkIndex: number; startOffset: number; endOffset: number };
  snippet: string;
  snippetDigest: { len: number; sha256_8: string };
  rankReason?: any;
  policyRef?: { strategyRef: string | null; rankPolicy: string | null; vectorStoreRef: any | null; retrievalLogId: string | null };
  accessScope?: { tenantId: string; spaceId: string; subjectId: string | null };
  snippetAllowed?: boolean;
};

export type EvidencePolicy = "required" | "optional" | "none";

export type AnswerEnvelope = {
  answer: string;
  evidencePolicy: EvidencePolicy;
  evidence?: EvidenceRef[];
  traceId?: string;
};
