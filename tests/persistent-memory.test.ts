import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/server/db";
import {
  readMemory,
  writeMemory,
  readScopeMemory,
  writeScopeMemory,
  appendScopeMemory,
  editScopeMemory,
  scopeMemoryPath,
  deleteScopeMemory,
  syncScopeMemory,
  memoryForPrompt,
} from "@/lib/server/memory-files";
import {
  saveMemoryRecord,
  chunkText,
  indexRecordChunks,
  searchMemories,
} from "@/lib/server/memory-store";
import {
  cosineSimilarity,
  lexicalSimilarity,
  MockSemanticEmbeddingProvider,
} from "@/lib/server/memory-embeddings";
import {
  needsSummarization,
  partitionMemory,
  getOrGenerateSummary,
  getBoundedMemoryPrompt,
  MEMORY_SUMMARIZE_THRESHOLD,
} from "@/lib/server/memory-summarizer";
import { toolCategory, toolLabel } from "@/lib/server/tools";
import type { MemoryRecord } from "@/lib/server/memory-types";

describe("Phase 4: Persistent Memory Enhancement", () => {
  const testAgentId = "test-agent-p4";
  const testRoomId1 = "room-alpha";
  const testRoomId2 = "room-beta";
  const testProjectId = "proj-x";
  const testUserId = "user-123";

  beforeEach(() => {
    deleteScopeMemory("agent", testAgentId);
    deleteScopeMemory("room", testRoomId1);
    deleteScopeMemory("room", testRoomId2);
    deleteScopeMemory("project", testProjectId);
    deleteScopeMemory("user", testUserId);
  });

  afterEach(() => {
    deleteScopeMemory("agent", testAgentId);
    deleteScopeMemory("room", testRoomId1);
    deleteScopeMemory("room", testRoomId2);
    deleteScopeMemory("project", testProjectId);
    deleteScopeMemory("user", testUserId);
  });

  // ── 1. Multi-Scope Storage & File Compatibility ──────────────────────────

  describe("1. Multi-Scope Memory Files & Backwards Compatibility", () => {
    it("preserves exact agent MEMORY.md path and file format", () => {
      writeMemory(testAgentId, "# Agent Memory\n- Uses TypeScript strictly\n- Prefers functional code");
      const path = scopeMemoryPath("agent", testAgentId);
      expect(fs.existsSync(path)).toBe(true);
      expect(path).toContain(join("workspaces", testAgentId, "MEMORY.md"));

      const content = readMemory(testAgentId);
      expect(content).toContain("Uses TypeScript strictly");
      expect(content).toContain("Prefers functional code");
    });

    it("creates isolated shared room memory files at rooms/<roomId>/MEMORY.md", () => {
      writeScopeMemory("room", testRoomId1, "# Room Alpha Memory\n- Architecture: Event-driven\n- Sprint goal: Release v2");
      writeScopeMemory("room", testRoomId2, "# Room Beta Memory\n- Architecture: Monolithic\n- Sprint goal: Bug fixing");

      const path1 = scopeMemoryPath("room", testRoomId1);
      const path2 = scopeMemoryPath("room", testRoomId2);

      expect(fs.existsSync(path1)).toBe(true);
      expect(fs.existsSync(path2)).toBe(true);
      expect(path1).toContain(join("rooms", testRoomId1, "MEMORY.md"));
      expect(path2).toContain(join("rooms", testRoomId2, "MEMORY.md"));

      const mem1 = readScopeMemory("room", testRoomId1);
      const mem2 = readScopeMemory("room", testRoomId2);

      expect(mem1).toContain("Architecture: Event-driven");
      expect(mem1).not.toContain("Architecture: Monolithic");
      expect(mem2).toContain("Architecture: Monolithic");
      expect(mem2).not.toContain("Architecture: Event-driven");
    });

    it("creates project memory and user preference memory files in designated paths", () => {
      writeScopeMemory("project", testProjectId, "# Project X\n- Deadline: 2026-12-31\n- Lead: Chief");
      writeScopeMemory("user", testUserId, "# User Preferences\n- Concise responses\n- Dark mode enabled");

      const projPath = scopeMemoryPath("project", testProjectId);
      const userPath = scopeMemoryPath("user", testUserId);

      expect(fs.existsSync(projPath)).toBe(true);
      expect(fs.existsSync(userPath)).toBe(true);
      expect(projPath).toContain(join("projects", testProjectId, "MEMORY.md"));
      expect(userPath).toContain(join("users", testUserId, "PREFERENCES.md"));

      expect(readScopeMemory("project", testProjectId)).toContain("Deadline: 2026-12-31");
      expect(readScopeMemory("user", testUserId)).toContain("Concise responses");
    });

    it("appends and edits memory across different scopes safely", () => {
      appendScopeMemory("room", testRoomId1, "Team agreed on API format v2", "Decisions");
      let mem = readScopeMemory("room", testRoomId1);
      expect(mem).toContain("## Decisions");
      expect(mem).toContain("Team agreed on API format v2");

      const editRes = editScopeMemory("room", testRoomId1, "API format v2", "API format v3");
      expect(editRes.ok).toBe(true);
      mem = readScopeMemory("room", testRoomId1);
      expect(mem).toContain("API format v3");
      expect(mem).not.toContain("API format v2");
    });
  });

  // ── 2. Vector Math & Embeddings Provider ─────────────────────────────────

  describe("2. Vector Math & MockSemanticEmbeddingProvider", () => {
    const provider = new MockSemanticEmbeddingProvider();

    it("calculates exact cosine similarity between normalized vectors", () => {
      const v1 = [1, 0, 0];
      const v2 = [1, 0, 0];
      const v3 = [0, 1, 0];
      const v4 = [-1, 0, 0];

      expect(cosineSimilarity(v1, v2)).toBeCloseTo(1.0, 5);
      expect(cosineSimilarity(v1, v3)).toBeCloseTo(0.0, 5);
      expect(cosineSimilarity(v1, v4)).toBeCloseTo(-1.0, 5);
    });

    it("produces deterministic high similarity for semantically related queries", async () => {
      const vecTypeScript1 = await provider.embed("TypeScript strict type checking");
      const vecTypeScript2 = await provider.embed("TypeScript strict type check compiler");
      const vecGardening = await provider.embed("planting tomatoes in organic soil");

      const simRelated = cosineSimilarity(vecTypeScript1, vecTypeScript2);
      const simUnrelated = cosineSimilarity(vecTypeScript1, vecGardening);

      expect(simRelated).toBeGreaterThan(0.65);
      expect(simUnrelated).toBeLessThan(0.35);
      expect(simRelated).toBeGreaterThan(simUnrelated);
    });

    it("calculates lexical similarity fallback accurately", () => {
      const query = "database postgres schema migration";
      const targetHigh = "We ran the postgres database schema migration yesterday.";
      const targetLow = "The quick brown fox jumps over the lazy dog.";

      const scoreHigh = lexicalSimilarity(query, targetHigh);
      const scoreLow = lexicalSimilarity(query, targetLow);

      expect(scoreHigh).toBeGreaterThan(0.4);
      expect(scoreLow).toBeLessThan(0.1);
    });
  });

  // ── 3. Chunking & Semantic Search ────────────────────────────────────────

  describe("3. Chunking & Semantic Vector Search", () => {
    it("chunks text intelligently by headers, lists, and line limits", () => {
      const markdown = `
# System Guidelines
- Rule 1: Always validate user input.
- Rule 2: Never expose raw passwords.

## Architecture Decisions
We decided to adopt an event-driven architecture using SQLite WAL mode.
This ensures zero contention between background workers and interactive turns.
`;
      const chunks = chunkText(markdown, 120);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks.some((c) => c.includes("Rule 1"))).toBe(true);
      expect(chunks.some((c) => c.includes("Architecture Decisions"))).toBe(true);
    });

    it("indexes memory records into chunks and embeddings table", async () => {
      const record: MemoryRecord = {
        id: "rec-test-1",
        scope: "agent",
        scopeId: testAgentId,
        category: "decision",
        sourceType: "user_edit",
        content: "We decided to migrate database schema to version 4 with vector search support.",
        confidence: "verified",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await saveMemoryRecord(record);
      await indexRecordChunks(record);

      const client = await db();
      const chunksRes = await client.execute({
        sql: "SELECT * FROM memory_chunks WHERE record_id = ?",
        args: [record.id],
      });
      expect(chunksRes.rows.length).toBeGreaterThan(0);

      const embRes = await client.execute({
        sql: "SELECT * FROM memory_embeddings WHERE chunk_id = ?",
        args: [String(chunksRes.rows[0].id)],
      });
      expect(embRes.rows.length).toBe(1);
      expect(String(embRes.rows[0].provider)).toBe("mock-semantic-vector");
      const vector = JSON.parse(String(embRes.rows[0].embedding));
      expect(Array.isArray(vector)).toBe(true);
      expect(vector.length).toBe(64);
    });

    it("performs semantic search ranking relevant records highest", async () => {
      const rec1: MemoryRecord = {
        id: "rec-search-1",
        scope: "agent",
        scopeId: testAgentId,
        category: "fact",
        sourceType: "user_edit",
        content: "User prefers automated regression tests written with Vitest and TypeScript.",
        confidence: "verified",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const rec2: MemoryRecord = {
        id: "rec-search-2",
        scope: "agent",
        scopeId: testAgentId,
        category: "preference",
        sourceType: "user_edit",
        content: "User enjoys baking sourdough bread on Sunday mornings.",
        confidence: "verified",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await saveMemoryRecord(rec1);
      await indexRecordChunks(rec1);
      await saveMemoryRecord(rec2);
      await indexRecordChunks(rec2);

      const searchResults = await searchMemories("Vitest regression test suite", {
        scope: "agent",
        scopeId: testAgentId,
        limit: 5,
      });

      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults[0].recordId).toBe(rec1.id);
      expect(searchResults[0].content).toContain("automated regression tests");
      expect(searchResults[0].searchMode).toBe("vector");
    });

    it("enforces strict scope filtering in search", async () => {
      const agentRec: MemoryRecord = {
        id: "rec-agent-scope",
        scope: "agent",
        scopeId: testAgentId,
        category: "fact",
        sourceType: "user_edit",
        content: "Secret project codename is Operation Nebula.",
        confidence: "verified",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const roomRec: MemoryRecord = {
        id: "rec-room-scope",
        scope: "room",
        scopeId: testRoomId1,
        category: "fact",
        sourceType: "user_edit",
        content: "Secret room codename is Operation Supernova.",
        confidence: "verified",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await saveMemoryRecord(agentRec);
      await indexRecordChunks(agentRec);
      await saveMemoryRecord(roomRec);
      await indexRecordChunks(roomRec);

      // Search agent scope only
      const agentResults = await searchMemories("Operation codename", {
        scope: "agent",
        scopeId: testAgentId,
      });
      expect(agentResults.every((r) => r.scope === "agent")).toBe(true);
      expect(agentResults.some((r) => r.content.includes("Nebula"))).toBe(true);
      expect(agentResults.some((r) => r.content.includes("Supernova"))).toBe(false);

      // Search room scope only
      const roomResults = await searchMemories("Operation codename", {
        scope: "room",
        scopeId: testRoomId1,
      });
      expect(roomResults.every((r) => r.scope === "room")).toBe(true);
      expect(roomResults.some((r) => r.content.includes("Supernova"))).toBe(true);
      expect(roomResults.some((r) => r.content.includes("Nebula"))).toBe(false);
    });

    it("purges stale chunks when markdown is updated and re-indexed", async () => {
      writeMemory(testAgentId, "Original content line A\nOriginal content line B");
      await syncScopeMemory("agent", testAgentId);

      const client = await db();
      const initialChunks = await client.execute({
        sql: "SELECT id, content FROM memory_chunks WHERE scope_id = ?",
        args: [testAgentId],
      });
      expect(initialChunks.rows.length).toBeGreaterThan(0);

      // Overwrite with completely new content
      writeMemory(testAgentId, "Completely different content X\nCompletely different content Y");
      await syncScopeMemory("agent", testAgentId);

      const updatedChunks = await client.execute({
        sql: "SELECT id, content FROM memory_chunks WHERE scope_id = ?",
        args: [testAgentId],
      });

      // Confirm stale chunks were removed
      const allText = updatedChunks.rows.map((r) => String(r.content)).join(" ");
      expect(allText).not.toContain("Original content line A");
      expect(allText).toContain("Completely different content X");
    });
  });

  // ── 4. Automatic Memory Summarization ────────────────────────────────────

  describe("4. Automatic Memory Summarization", () => {
    it("detects when memory length exceeds the summarization threshold", () => {
      const shortMemory = "Short note about preferences.";
      expect(needsSummarization(shortMemory, 2000)).toBe(false);

      const longMemory = Array.from({ length: 40 }, (_, i) => `- Memory point number ${i + 1}: detailed information about project status and preferences.`).join("\n");
      expect(longMemory.length).toBeGreaterThan(2000);
      expect(needsSummarization(longMemory, 2000)).toBe(true);
    });

    it("partitions memory into older content and recent notes", () => {
      const lines = Array.from({ length: 15 }, (_, i) => `Line ${i + 1}`);
      const text = lines.join("\n");
      const { olderText, recentText } = partitionMemory(text);

      const olderLines = olderText.split("\n");
      const recentLines = recentText.split("\n");

      expect(recentLines.length).toBe(8);
      expect(olderLines.length).toBe(7);
      expect(recentLines[recentLines.length - 1]).toBe("Line 15");
      expect(olderLines[0]).toBe("Line 1");
    });

    it("generates and persists summary in memory_summaries table without altering markdown file", async () => {
      const longMemory = `
# Durable Preferences
- User prefers dark mode in all user interfaces
- User likes functional programming patterns
- User prefers TypeScript over JavaScript

# Decisions
- Agreed to use SQLite with WAL mode for zero-turn concurrency
- Decided on eight persistent workforce bots
- Approved Schema v4 for vector search

# Additional Notes
${Array.from({ length: 50 }, (_, i) => `- Historical log entry ${i + 1} with extensive architectural notes and background context`).join("\n")}
`;
      expect(longMemory.length).toBeGreaterThan(MEMORY_SUMMARIZE_THRESHOLD);
      writeMemory(testAgentId, longMemory);
      const summaryRecord = await getOrGenerateSummary("agent", testAgentId, longMemory);

      expect(summaryRecord).not.toBeNull();
      expect(summaryRecord?.summary).toContain("Preferences & Styles");
      expect(summaryRecord?.summary).toContain("Established Decisions");

      // Verify stored in memory_summaries
      const client = await db();
      const res = await client.execute({
        sql: "SELECT * FROM memory_summaries WHERE scope = 'agent' AND scope_id = ?",
        args: [testAgentId],
      });
      expect(res.rows.length).toBe(1);
      expect(String(res.rows[0].summary)).toContain("Established Decisions");

      // Verify original file on disk is UNMODIFIED
      const diskContent = readMemory(testAgentId);
      expect(diskContent).toBe(longMemory);
    });

    it("returns cached summary on repeat calls when content hash is unchanged", async () => {
      const longMemory = Array.from({ length: 60 }, (_, i) => `- Decision ${i}: System rule ${i} must always hold in all runtime environments`).join("\n");
      const firstSum = await getOrGenerateSummary("agent", testAgentId, longMemory);
      const secondSum = await getOrGenerateSummary("agent", testAgentId, longMemory);

      expect(firstSum?.id).toBe(secondSum?.id);
      expect(firstSum?.updatedAt).toBe(secondSum?.updatedAt);
    });

    it("builds bounded prompt memory with summary and recent notes", async () => {
      const longMemory = Array.from({ length: 60 }, (_, i) => `- Point ${i + 1}: Important architectural fact and operational detail ${i + 1}`).join("\n");
      expect(longMemory.length).toBeGreaterThan(MEMORY_SUMMARIZE_THRESHOLD);
      writeMemory(testAgentId, longMemory);
      await syncScopeMemory("agent", testAgentId);

      const bounded = await getBoundedMemoryPrompt("agent", testAgentId, longMemory);
      expect(bounded.isSummarized).toBe(true);
      expect(bounded.summary).not.toBeNull();
      expect(bounded.recentNotes).toContain("Point 60");

      // Prompt helper integrates summary and stays within limit
      const promptRes = memoryForPrompt(testAgentId);
      expect(promptRes.truncated).toBe(true);
      expect(promptRes.text).toContain("Recent Notes");
    });
  });

  // ── 5. Security, Secret Scrubbing & Isolation ─────────────────────────────

  describe("5. Security, Secret Scrubbing & Cross-Scope Isolation", () => {
    it("redacts sensitive API keys and tokens before disk write and semantic indexing", async () => {
      const sensitive = `
# Secrets
- OpenAI Key: sk-1234567890abcdef1234567890abcdef
- Anthropic: sk-ant-api03-abcdef1234567890abcdef
- GitHub: ghp_1234567890abcdef1234567890abcdef12
- AWS: AKIAIOSFODNN7EXAMPLE
- Normal note: User prefers automated testing.
`;
      writeMemory(testAgentId, sensitive);
      await syncScopeMemory("agent", testAgentId);

      const disk = readMemory(testAgentId);
      expect(disk).not.toContain("sk-1234567890");
      expect(disk).not.toContain("ghp_123456");
      expect(disk).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(disk).toContain("«redacted");

      // Ensure indexed database chunks also do not contain raw secrets
      const client = await db();
      const dbChunks = await client.execute({
        sql: "SELECT content FROM memory_chunks WHERE scope_id = ?",
        args: [testAgentId],
      });
      expect(dbChunks.rows.length).toBeGreaterThan(0);
      for (const row of dbChunks.rows) {
        expect(String(row.content)).not.toContain("sk-1234567890");
        expect(String(row.content)).not.toContain("ghp_123456");
        expect(String(row.content)).not.toContain("AKIAIOSFODNN7EXAMPLE");
      }

      const searchRes = await searchMemories("automated testing", { scope: "agent", scopeId: testAgentId });
      expect(searchRes.length).toBeGreaterThan(0);
      for (const res of searchRes) {
        expect(res.content).not.toContain("sk-1234567890");
      }
    });

    it("isolates room memories from unauthorized cross-room search", async () => {
      writeScopeMemory("room", testRoomId1, "Project Alpha financial budget is $500,000.");
      writeScopeMemory("room", testRoomId2, "Project Beta secret patent is Pending.");
      await syncScopeMemory("room", testRoomId1);
      await syncScopeMemory("room", testRoomId2);

      // Search room-1 with allowedRoomIds = [testRoomId1]
      const resultsRoom1 = await searchMemories("budget", {
        scope: "room",
        allowedRoomIds: [testRoomId1],
      });
      expect(resultsRoom1.length).toBeGreaterThan(0);
      expect(resultsRoom1.every((r) => r.scopeId === testRoomId1)).toBe(true);

      // Search room-1 looking for patent in room-2 should be blocked
      const resultsRoom2Blocked = await searchMemories("patent", {
        scope: "room",
        allowedRoomIds: [testRoomId1],
      });
      expect(resultsRoom2Blocked.length).toBe(0);
    });
  });

  // ── 6. Tool Category & Controlled Access Matrix ──────────────────────────

  describe("6. Tool Categorization & Controlled Access Integration", () => {
    it("classifies memory_search as 'read' for automatic execution under Controlled Access", () => {
      expect(toolCategory("memory_search")).toBe("read");
    });

    it("classifies memory_add, memory_edit, and room_memory_add as 'edit' requiring human approval", () => {
      expect(toolCategory("memory_add")).toBe("edit");
      expect(toolCategory("memory_edit")).toBe("edit");
      expect(toolCategory("room_memory_add")).toBe("edit");
    });

    it("formats user-friendly tool labels for memory operations in chat UI", () => {
      const searchLabel = toolLabel("memory_search", { query: "database architecture" });
      expect(searchLabel.label).toBe("Searched memory");
      expect(searchLabel.detail).toBe("database architecture");

      const roomAddLabel = toolLabel("room_memory_add", { roomId: testRoomId1, note: "Sprint goal defined" });
      expect(roomAddLabel.label).toBe("Saved to room memory");
      expect(roomAddLabel.detail).toBe("Sprint goal defined");
    });
  });
});
