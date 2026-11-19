// OpenCrewBot 2.0 Multi-Scope Persistent Memory Store
import { createHash } from "node:crypto";
import type { InValue } from "@libsql/client";
import { db } from "./db";
import { cosineSimilarity, getEmbeddingProvider, lexicalSimilarity } from "./memory-embeddings";
import type {
  MemoryCategory,
  MemoryChunk,
  MemoryRecord,
  MemoryScope,
  MemorySearchOptions,
  MemorySearchResult,
  MemorySourceType,
} from "./memory-types";

// ── Record Operations ──────────────────────────────────────────────────────

export async function saveMemoryRecord(record: MemoryRecord): Promise<void> {
  const client = await db();
  await client.execute({
    sql: `INSERT INTO memory_records (
      id, scope, scope_id, category, source_type, source_author,
      source_conversation_id, source_task_id, content, original_ref,
      confidence, created_at, updated_at, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      category = excluded.category,
      source_type = excluded.source_type,
      source_author = excluded.source_author,
      source_conversation_id = excluded.source_conversation_id,
      source_task_id = excluded.source_task_id,
      content = excluded.content,
      original_ref = excluded.original_ref,
      confidence = excluded.confidence,
      updated_at = excluded.updated_at,
      data = excluded.data`,
    args: [
      record.id,
      record.scope,
      record.scopeId,
      record.category,
      record.sourceType,
      record.sourceAuthor ?? null,
      record.sourceConversationId ?? null,
      record.sourceTaskId ?? null,
      record.content,
      record.originalRef ?? null,
      record.confidence,
      record.createdAt,
      record.updatedAt,
      JSON.stringify(record.data ?? {}),
    ],
  });
}

export async function getMemoryRecord(id: string): Promise<MemoryRecord | null> {
  const client = await db();
  const res = await client.execute({
    sql: "SELECT * FROM memory_records WHERE id = ?",
    args: [id],
  });
  const row = res.rows[0];
  if (!row) return null;
  return rowToMemoryRecord(row);
}

export async function listMemoryRecords(
  scope: MemoryScope,
  scopeId: string,
  category?: MemoryCategory,
): Promise<MemoryRecord[]> {
  const client = await db();
  let sql = "SELECT * FROM memory_records WHERE scope = ? AND scope_id = ?";
  const args: InValue[] = [scope, scopeId];
  if (category) {
    sql += " AND category = ?";
    args.push(category);
  }
  sql += " ORDER BY created_at ASC";

  const res = await client.execute({ sql, args });
  return res.rows.map(rowToMemoryRecord);
}

export async function deleteMemoryRecord(id: string): Promise<void> {
  const client = await db();
  await client.execute({
    sql: "DELETE FROM memory_records WHERE id = ?",
    args: [id],
  });
  // Clean up associated chunks and embeddings
  const chunks = await client.execute({
    sql: "SELECT id FROM memory_chunks WHERE record_id = ?",
    args: [id],
  });
  for (const c of chunks.rows) {
    await client.execute({ sql: "DELETE FROM memory_embeddings WHERE chunk_id = ?", args: [String(c.id)] });
  }
  await client.execute({
    sql: "DELETE FROM memory_chunks WHERE record_id = ?",
    args: [id],
  });
}

// ── Chunking & Embedding Operations ────────────────────────────────────────

function sha256(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

export function chunkText(content: string, maxChunkLength = 400): string[] {
  const clean = content.trim();
  if (!clean) return [];

  // Split on section headers, bullet lists, or blank lines
  const rawParts = clean.split(/(?=\n## |\n- |\n\n)/g).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];

  for (const part of rawParts) {
    if (part.length <= maxChunkLength) {
      chunks.push(part);
    } else {
      // Split large blocks by lines
      const lines = part.split("\n").filter(Boolean);
      let current = "";
      for (const line of lines) {
        if (current && (current.length + line.length > maxChunkLength)) {
          chunks.push(current.trim());
          current = "";
        }
        current = current ? `${current}\n${line}` : line;
      }
      if (current) chunks.push(current.trim());
    }
  }

  return chunks.length ? chunks : [clean];
}

export async function indexRecordChunks(record: MemoryRecord): Promise<void> {
  const client = await db();
  const provider = getEmbeddingProvider();
  const available = await provider.isAvailable().catch(() => false);

  const textChunks = chunkText(record.content);
  const existingChunksRes = await client.execute({
    sql: "SELECT id, content_hash FROM memory_chunks WHERE record_id = ?",
    args: [record.id],
  });
  const existingChunks = new Map(existingChunksRes.rows.map((r) => [String(r.id), String(r.content_hash)]));

  const newChunks: MemoryChunk[] = [];
  const currentHashes = new Set<string>();

  for (let i = 0; i < textChunks.length; i++) {
    const text = textChunks[i];
    const hash = sha256(text);
    currentHashes.add(hash);

    const chunkId = `${record.id}-c${i}-${hash.slice(0, 8)}`;
    newChunks.push({
      id: chunkId,
      recordId: record.id,
      scope: record.scope,
      scopeId: record.scopeId,
      chunkIndex: i,
      content: text,
      sourceRef: record.originalRef ?? `${record.scope}:${record.scopeId}`,
      contentHash: hash,
      createdAt: new Date().toISOString(),
    });
  }

  // Remove stale chunks
  for (const [id, hash] of existingChunks.entries()) {
    if (!currentHashes.has(hash)) {
      await client.execute({ sql: "DELETE FROM memory_embeddings WHERE chunk_id = ?", args: [id] });
      await client.execute({ sql: "DELETE FROM memory_chunks WHERE id = ?", args: [id] });
    }
  }

  // Save new chunks and embeddings
  for (const chunk of newChunks) {
    await client.execute({
      sql: `INSERT INTO memory_chunks (
        id, record_id, scope, scope_id, chunk_index, content, source_ref, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET content = excluded.content, content_hash = excluded.content_hash`,
      args: [
        chunk.id,
        chunk.recordId,
        chunk.scope,
        chunk.scopeId,
        chunk.chunkIndex,
        chunk.content,
        chunk.sourceRef,
        chunk.contentHash,
        chunk.createdAt,
      ],
    });

    if (available) {
      try {
        const vec = await provider.embed(chunk.content);
        await client.execute({
          sql: `INSERT INTO memory_embeddings (
            chunk_id, provider, model, dimensions, embedding, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(chunk_id) DO UPDATE SET
            provider = excluded.provider,
            model = excluded.model,
            dimensions = excluded.dimensions,
            embedding = excluded.embedding`,
          args: [
            chunk.id,
            provider.name,
            provider.model,
            provider.dimensions,
            JSON.stringify(vec),
            new Date().toISOString(),
          ],
        });
      } catch {
        // Fall back gracefully if embedding failed
      }
    }
  }
}

// ── Semantic Search Operations ─────────────────────────────────────────────

export async function searchMemories(
  query: string,
  options: MemorySearchOptions = {},
): Promise<MemorySearchResult[]> {
  const client = await db();
  const limit = options.limit ?? 5;
  const minScore = options.minScore ?? 0.25;
  const provider = getEmbeddingProvider();

  let sql = `
    SELECT c.id as chunk_id, c.record_id, c.scope, c.scope_id, c.content, c.source_ref,
           e.embedding, e.provider as emb_provider, r.category, r.confidence
    FROM memory_chunks c
    LEFT JOIN memory_embeddings e ON c.id = e.chunk_id
    LEFT JOIN memory_records r ON c.record_id = r.id
    WHERE 1=1
  `;
  const args: InValue[] = [];

  if (options.scope && options.scope !== "all") {
    sql += " AND c.scope = ?";
    args.push(options.scope);
  }

  if (options.scopeId) {
    sql += " AND c.scope_id = ?";
    args.push(options.scopeId);
  }

  // Cross-scope isolation: if room scope, only allow permitted room IDs
  if (options.allowedRoomIds && options.allowedRoomIds.length > 0) {
    const placeholders = options.allowedRoomIds.map(() => "?").join(",");
    sql += ` AND (c.scope != 'room' OR c.scope_id IN (${placeholders}))`;
    args.push(...options.allowedRoomIds);
  } else if (options.scope === "room" && !options.scopeId) {
    // If searching rooms generally without IDs, restrict to empty
    return [];
  }

  const res = await client.execute({ sql, args });
  const rows = res.rows;
  if (!rows.length) return [];

  // Determine if vector search is possible
  let queryEmbedding: number[] | null = null;
  const available = await provider.isAvailable().catch(() => false);
  if (available) {
    try {
      queryEmbedding = await provider.embed(query);
    } catch {
      queryEmbedding = null;
    }
  }

  const results: MemorySearchResult[] = [];

  for (const row of rows) {
    let score = 0;
    let mode: "vector" | "lexical_fallback" = "lexical_fallback";

    if (queryEmbedding && row.embedding) {
      try {
        const chunkVec = JSON.parse(String(row.embedding)) as number[];
        score = cosineSimilarity(queryEmbedding, chunkVec);
        mode = "vector";
      } catch {
        score = lexicalSimilarity(query, String(row.content));
      }
    } else {
      score = lexicalSimilarity(query, String(row.content));
    }

    if (score >= minScore) {
      results.push({
        chunkId: String(row.chunk_id),
        recordId: String(row.record_id),
        scope: String(row.scope) as MemoryScope,
        scopeId: String(row.scope_id),
        content: String(row.content),
        score,
        searchMode: mode,
        sourceRef: row.source_ref ? String(row.source_ref) : undefined,
        category: row.category ? (String(row.category) as MemoryCategory) : undefined,
        confidence: row.confidence ? (String(row.confidence) as "verified") : undefined,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ── Markdown Synchronization ───────────────────────────────────────────────

/**
 * Synchronizes Markdown text from disk into persistent database records and chunks.
 * Preserves user modifications while ensuring semantic search index stays in sync.
 */
export async function syncMarkdownToStore(
  scope: MemoryScope,
  scopeId: string,
  markdown: string,
  filePath?: string,
  sourceAuthor = "user",
): Promise<void> {
  const client = await db();
  const clean = markdown.trim();
  const now = new Date().toISOString();

  // If empty, clear records and chunks for this scope
  if (!clean) {
    await clearScope(scope, scopeId);
    return;
  }

  // Parse lines into sections or items
  const lines = clean.split("\n");
  let currentSection = "General";
  const items: Array<{ category: MemoryCategory; content: string; section: string }> = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#")) {
      currentSection = line.replace(/^#+\s*/, "").trim();
      continue;
    }

    let category: MemoryCategory = "fact";
    const lower = currentSection.toLowerCase();
    if (lower.includes("preference")) category = "preference";
    else if (lower.includes("decision")) category = "decision";
    else if (lower.includes("instruction") || lower.includes("rule")) category = "instruction";
    else if (lower.includes("finding") || lower.includes("research")) category = "finding";

    items.push({
      category,
      content: line.startsWith("- ") ? line.slice(2).trim() : line,
      section: currentSection,
    });
  }

  // Store whole file as master record
  const masterRecordId = `md:${scope}:${scopeId}`;
  const masterRecord: MemoryRecord = {
    id: masterRecordId,
    scope,
    scopeId,
    category: "general",
    sourceType: "user_edit",
    sourceAuthor,
    content: clean,
    originalRef: filePath ?? `${scope}:${scopeId}/MEMORY.md`,
    confidence: "verified",
    createdAt: now,
    updatedAt: now,
    data: { itemCount: items.length },
  };

  await saveMemoryRecord(masterRecord);
  await indexRecordChunks(masterRecord);

  // Store discrete items
  const activeIds = new Set<string>([masterRecordId]);
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const itemId = `rec:${scope}:${scopeId}:${idx}:${sha256(item.content).slice(0, 8)}`;
    activeIds.add(itemId);

    const rec: MemoryRecord = {
      id: itemId,
      scope,
      scopeId,
      category: item.category,
      sourceType: "user_edit",
      sourceAuthor,
      content: item.content,
      originalRef: `${filePath ?? "MEMORY.md"}#${item.section}`,
      confidence: "verified",
      createdAt: now,
      updatedAt: now,
      data: { section: item.section },
    };
    await saveMemoryRecord(rec);
  }

  // Delete orphaned records that were removed from the markdown file
  const existingRes = await client.execute({
    sql: "SELECT id FROM memory_records WHERE scope = ? AND scope_id = ?",
    args: [scope, scopeId],
  });
  for (const row of existingRes.rows) {
    const rowId = String(row.id);
    if (!activeIds.has(rowId)) {
      await deleteMemoryRecord(rowId);
    }
  }
}

export async function clearScope(scope: MemoryScope, scopeId: string): Promise<void> {
  const client = await db();
  const records = await client.execute({
    sql: "SELECT id FROM memory_records WHERE scope = ? AND scope_id = ?",
    args: [scope, scopeId],
  });
  for (const r of records.rows) {
    await deleteMemoryRecord(String(r.id));
  }
  await client.execute({
    sql: "DELETE FROM memory_summaries WHERE scope = ? AND scope_id = ?",
    args: [scope, scopeId],
  });
}

function rowToMemoryRecord(r: Record<string, unknown>): MemoryRecord {
  return {
    id: String(r.id),
    scope: String(r.scope) as MemoryScope,
    scopeId: String(r.scope_id),
    category: String(r.category) as MemoryCategory,
    sourceType: String(r.source_type) as MemorySourceType,
    sourceAuthor: r.source_author ? String(r.source_author) : undefined,
    sourceConversationId: r.source_conversation_id ? String(r.source_conversation_id) : undefined,
    sourceTaskId: r.source_task_id ? String(r.source_task_id) : undefined,
    content: String(r.content),
    originalRef: r.original_ref ? String(r.original_ref) : undefined,
    confidence: String(r.confidence) as "verified",
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    data: r.data ? (JSON.parse(String(r.data)) as Record<string, unknown>) : undefined,
  };
}
