// OpenCrewBot 2.0 Multi-Scope Persistent Memory Types
export type MemoryScope = "agent" | "room" | "project" | "user" | "decision";

export type MemoryCategory =
  | "fact"
  | "preference"
  | "decision"
  | "instruction"
  | "finding"
  | "summary"
  | "general";

export type MemorySourceType =
  | "user_edit"
  | "agent_observation"
  | "verified_finding"
  | "decision"
  | "summary";

export type MemoryConfidence = "verified" | "unverified" | "inferred";

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  scopeId: string;
  category: MemoryCategory;
  sourceType: MemorySourceType;
  sourceAuthor?: string;
  sourceConversationId?: string;
  sourceTaskId?: string;
  content: string;
  originalRef?: string;
  confidence: MemoryConfidence;
  createdAt: string;
  updatedAt: string;
  data?: Record<string, unknown>;
}

export interface MemoryChunk {
  id: string;
  recordId: string;
  scope: MemoryScope;
  scopeId: string;
  chunkIndex: number;
  content: string;
  sourceRef: string;
  contentHash: string;
  createdAt: string;
}

export interface MemoryEmbedding {
  chunkId: string;
  provider: string;
  model: string;
  dimensions: number;
  embedding: number[];
  createdAt: string;
}

export interface MemorySummaryRecord {
  id: string;
  scope: MemoryScope;
  scopeId: string;
  summary: string;
  sourceHash: string;
  sourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult {
  chunkId: string;
  recordId: string;
  scope: MemoryScope;
  scopeId: string;
  content: string;
  score: number;
  searchMode: "vector" | "lexical_fallback";
  sourceRef?: string;
  category?: MemoryCategory;
  confidence?: MemoryConfidence;
}

export interface MemorySearchOptions {
  scope?: MemoryScope | "all";
  scopeId?: string;
  limit?: number;
  minScore?: number;
  categories?: MemoryCategory[];
  allowedRoomIds?: string[];
}

export interface EmbeddingProvider {
  name: string;
  model: string;
  isMock: boolean;
  dimensions: number;
  isAvailable(): Promise<boolean>;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
