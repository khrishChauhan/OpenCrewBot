// OpenCrewBot 2.0 Embedding Provider Abstraction & Similarity Functions
import { isMock } from "./config";
import type { EmbeddingProvider } from "./memory-types";

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Normalized token overlap / lexical score between query and document text.
 * Returned score is between 0 and 1.
 */
export function lexicalSimilarity(query: string, text: string): number {
  const qTokens = tokenize(query);
  const dTokens = tokenize(text);
  if (qTokens.size === 0 || dTokens.size === 0) return 0;

  let matches = 0;
  for (const q of qTokens) {
    if (dTokens.has(q)) matches++;
  }

  // Jaccard similarity combined with query recall
  const recall = matches / qTokens.size;
  const union = new Set([...qTokens, ...dTokens]).size;
  const jaccard = matches / union;
  return 0.7 * recall + 0.3 * jaccard;
}

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
  return new Set(words);
}

// ── Mock Semantic Embedding Provider ───────────────────────────────────────

/**
 * Deterministic semantic vector provider using feature hashing with L2 normalization.
 * Generates genuine 64-dimensional float unit vectors for testing and mock mode without external network calls.
 * Semantically identical or overlapping texts yield high cosine similarity (>0.7), while disparate topics yield near 0.
 */
export class MockSemanticEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock-semantic-vector";
  readonly model = "mock-dense-v1";
  readonly isMock = true;
  readonly dimensions = 64;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async embed(text: string): Promise<number[]> {
    return this.generateVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.generateVector(t));
  }

  private generateVector(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const cleaned = text.toLowerCase().trim();
    if (!cleaned) return vector;

    // 1. Word tokens
    const words = cleaned.replace(/[^a-z0-9_\s]/g, " ").split(/\s+/).filter(Boolean);

    // 2. Character tri-grams for subword similarity
    const ngrams: string[] = [];
    for (const w of words) {
      if (w.length <= 3) {
        ngrams.push(w);
      } else {
        for (let i = 0; i <= w.length - 3; i++) {
          ngrams.push(w.slice(i, i + 3));
        }
      }
    }

    // Hash tokens into dimensions
    for (const token of [...words, ...ngrams]) {
      let hash = 0;
      for (let i = 0; i < token.length; i++) {
        hash = (hash << 5) - hash + token.charCodeAt(i);
        hash |= 0;
      }
      const dim = Math.abs(hash) % this.dimensions;
      const sign = (hash & 1) === 0 ? 1 : -1;
      vector[dim] += sign * (token.length > 3 ? 1.5 : 1.0);
    }

    // L2 Normalize
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) {
      norm += vector[i] * vector[i];
    }
    const mag = Math.sqrt(norm);
    if (mag > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        vector[i] /= mag;
      }
    }

    return vector;
  }
}

// ── Ollama Embedding Provider ──────────────────────────────────────────────

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama";
  readonly model: string;
  readonly baseUrl: string;
  readonly isMock = false;
  readonly dimensions: number;

  constructor(options?: { baseUrl?: string; model?: string; dimensions?: number }) {
    this.baseUrl = (options?.baseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
    this.model = options?.model || process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
    this.dimensions = options?.dimensions || 768;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`Ollama embedding request failed: HTTP ${res.status}`);
    }

    const data = (await res.json()) as { embedding?: number[] };
    if (!data.embedding || !Array.isArray(data.embedding)) {
      throw new Error("Ollama returned malformed embedding structure.");
    }

    return data.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

// ── Provider Factory & Global Registry ──────────────────────────────────────

let customProvider: EmbeddingProvider | null = null;

export function setCustomEmbeddingProvider(provider: EmbeddingProvider | null): void {
  customProvider = provider;
}

export function getEmbeddingProvider(): EmbeddingProvider {
  if (customProvider) return customProvider;

  // In test environments or when mock mode is set, use deterministic mock vector provider
  if (isMock() || process.env.NODE_ENV === "test") {
    return new MockSemanticEmbeddingProvider();
  }

  // Live environment: check Ollama
  return new OllamaEmbeddingProvider();
}
