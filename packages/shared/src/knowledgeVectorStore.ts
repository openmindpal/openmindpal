export type VectorStoreModeV1 = "external" | "fallback";

export type VectorStoreRefV1 = {
  mode: VectorStoreModeV1;
  impl: string;
  endpointDigest8?: string;
};

export type VectorStoreCapabilitiesV1 = {
  kind: "vectorStore.capabilities.v1";
  supportsUpsert: boolean;
  supportsDelete: boolean;
  supportsQuery: boolean;
  vectorType: "int32" | "float32";
  distance: "overlap" | "cosine" | "dot";
  maxK: number;
};

export type VectorStoreChunkEmbeddingV1 = {
  chunkId: string;
  documentId: string;
  documentVersion: number;
  embeddingModelRef: string;
  vector: number[];
  updatedAt: string;
};

export type VectorStoreQueryResultItemV1 = {
  chunkId: string;
  score: number;
};

export type VectorStoreQueryResponseV1 = {
  results: VectorStoreQueryResultItemV1[];
  degraded: boolean;
  degradeReason: string | null;
};

