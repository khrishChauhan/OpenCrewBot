// OpenCrewBot 2.0 Automatic Memory Summarizer
import { createHash, randomUUID } from "node:crypto";
import { db } from "./db";
import { isMock } from "./config";
import type { MemoryScope, MemorySummaryRecord } from "./memory-types";

/**
 * Size threshold in characters above which memory is automatically summarized
 * for prompt injection (~500 tokens / 40-50 lines).
 */
export const MEMORY_SUMMARIZE_THRESHOLD = 2000;

/** Number of recent bullet points/lines kept intact even when summarized */
export const RECENT_MEMORIES_COUNT = 8;

export interface BoundedMemoryResult {
  summary: string | null;
  recentNotes: string;
  isSummarized: boolean;
  totalLength: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

/**
 * Checks if a scope's memory exceeds the summarization threshold.
 */
export function needsSummarization(content: string, threshold = MEMORY_SUMMARIZE_THRESHOLD): boolean {
  return content.trim().length > threshold;
}

/**
 * Splits memory into older entries that should be summarized and recent entries that should remain raw.
 */
export function partitionMemory(content: string): { olderText: string; recentText: string } {
  const lines = content.trim().split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= RECENT_MEMORIES_COUNT) {
    return { olderText: "", recentText: content.trim() };
  }

  const olderLines = lines.slice(0, lines.length - RECENT_MEMORIES_COUNT);
  const recentLines = lines.slice(lines.length - RECENT_MEMORIES_COUNT);

  return {
    olderText: olderLines.join("\n"),
    recentText: recentLines.join("\n"),
  };
}

/**
 * Generates or retrieves a cached summary of memory content without modifying the source file.
 */
export async function getOrGenerateSummary(
  scope: MemoryScope,
  scopeId: string,
  content: string,
): Promise<MemorySummaryRecord | null> {
  const clean = content.trim();
  if (!clean || !needsSummarization(clean)) return null;

  const client = await db();
  const currentHash = sha256(clean);

  // Check if existing summary is still fresh
  const cachedRes = await client.execute({
    sql: "SELECT * FROM memory_summaries WHERE scope = ? AND scope_id = ?",
    args: [scope, scopeId],
  });

  const row = cachedRes.rows[0];
  if (row && String(row.source_hash) === currentHash) {
    return {
      id: String(row.id),
      scope: String(row.scope) as MemoryScope,
      scopeId: String(row.scope_id),
      summary: String(row.summary),
      sourceHash: String(row.source_hash),
      sourceCount: Number(row.source_count),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  // Generate new summary
  const { olderText } = partitionMemory(clean);
  const summaryText = await generateSummaryText(olderText, scope, scopeId);
  const now = new Date().toISOString();

  const record: MemorySummaryRecord = {
    id: row ? String(row.id) : `sum:${scope}:${scopeId}:${randomUUID().slice(0, 8)}`,
    scope,
    scopeId,
    summary: summaryText,
    sourceHash: currentHash,
    sourceCount: clean.length,
    createdAt: row ? String(row.created_at) : now,
    updatedAt: now,
  };

  await client.execute({
    sql: `INSERT INTO memory_summaries (id, scope, scope_id, summary, source_hash, source_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope, scope_id) DO UPDATE SET
            summary = excluded.summary,
            source_hash = excluded.source_hash,
            source_count = excluded.source_count,
            updated_at = excluded.updated_at`,
    args: [
      record.id,
      record.scope,
      record.scopeId,
      record.summary,
      record.sourceHash,
      record.sourceCount,
      record.createdAt,
      record.updatedAt,
    ],
  });

  return record;
}

/**
 * Deterministic extractive and structured summarizer.
 * Extracts durable preferences, decisions, core facts, and rules into concise bullets.
 */
async function generateSummaryText(
  text: string,
  scope: MemoryScope,
  scopeId: string,
): Promise<string> {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const preferences: string[] = [];
  const decisions: string[] = [];
  const instructions: string[] = [];
  const facts: string[] = [];

  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const cleanLine = line.replace(/^[-\s*]+/, "").trim();
    if (!cleanLine) continue;

    const lower = cleanLine.toLowerCase();
    if (lower.includes("prefer") || lower.includes("like") || lower.includes("favorite")) {
      preferences.push(cleanLine);
    } else if (lower.includes("decid") || lower.includes("agreed") || lower.includes("approved")) {
      decisions.push(cleanLine);
    } else if (lower.includes("must") || lower.includes("always") || lower.includes("never") || lower.includes("rule")) {
      instructions.push(cleanLine);
    } else {
      facts.push(cleanLine);
    }
  }

  const sections: string[] = [
    `*Summary of historical memory for ${scope}:${scopeId} (${isMock() ? "deterministic extraction" : "condensed summary"}):*`,
  ];

  if (preferences.length) {
    sections.push("### Preferences & Styles\n" + preferences.slice(-5).map((p) => `- ${p}`).join("\n"));
  }
  if (decisions.length) {
    sections.push("### Established Decisions\n" + decisions.slice(-5).map((d) => `- ${d}`).join("\n"));
  }
  if (instructions.length) {
    sections.push("### Core Directives\n" + instructions.slice(-5).map((i) => `- ${i}`).join("\n"));
  }
  if (facts.length && !preferences.length && !decisions.length && !instructions.length) {
    sections.push("### Key Facts\n" + facts.slice(-6).map((f) => `- ${f}`).join("\n"));
  }

  return sections.join("\n\n");
}

/**
 * Builds a bounded memory context for model prompt injection.
 * Integrates persistent summary + recent notes to prevent prompt overflow.
 */
export async function getBoundedMemoryPrompt(
  scope: MemoryScope,
  scopeId: string,
  rawContent: string,
): Promise<BoundedMemoryResult> {
  const clean = rawContent.trim();
  if (!clean) {
    return { summary: null, recentNotes: "", isSummarized: false, totalLength: 0 };
  }

  if (!needsSummarization(clean)) {
    return {
      summary: null,
      recentNotes: clean,
      isSummarized: false,
      totalLength: clean.length,
    };
  }

  const summaryRecord = await getOrGenerateSummary(scope, scopeId, clean);
  const { recentText } = partitionMemory(clean);

  return {
    summary: summaryRecord?.summary ?? null,
    recentNotes: recentText,
    isSummarized: true,
    totalLength: (summaryRecord?.summary?.length ?? 0) + recentText.length,
  };
}
