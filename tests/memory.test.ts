import { describe, it, expect, beforeEach } from "vitest";
import {
  readMemory,
  writeMemory,
  appendMemory,
  editMemory,
  redactSecrets,
  memoryForPrompt,
  memoryPath,
  deleteWorkspace,
  MEMORY_PROMPT_LIMIT,
} from "@/lib/server/memory-files";
import fs from "node:fs";

describe("Agent Memory & Workspaces (memory-files.ts)", () => {
  const botId = "test-mem-bot";

  beforeEach(() => {
    deleteWorkspace(botId);
  });

  it("returns empty string when MEMORY.md does not exist yet", () => {
    const content = readMemory(botId);
    expect(content).toBe("");
  });

  it("appends dated bullet points to MEMORY.md and creates file", () => {
    appendMemory(botId, "User prefers dark mode");
    const updated = readMemory(botId);

    expect(updated).toContain("- User prefers dark mode _(");
    expect(fs.existsSync(memoryPath(botId))).toBe(true);
  });

  it("edits memory via exact substring replacement", () => {
    writeMemory(botId, "Key: old-value\nNote: keep this");
    const result = editMemory(botId, "old-value", "new-value");

    expect(result.ok).toBe(true);
    expect(readMemory(botId)).toBe("Key: new-value\nNote: keep this");
  });

  it("returns failure when edit target is not found in memory", () => {
    writeMemory(botId, "Existing text");
    const result = editMemory(botId, "non-existent text", "replacement");

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("That exact text isn't in MEMORY.md");
  });

  describe("Secret Redaction", () => {
    it("redacts OpenAI and Anthropic API keys before saving", () => {
      const sensitive = "My key is sk-1234567890abcdef1234567890abcdef and sk-ant-api03-abcdef1234567890abcdef";
      const redacted = redactSecrets(sensitive);

      expect(redacted).not.toContain("sk-1234567890");
      expect(redacted).not.toContain("sk-ant-api03");
      expect(redacted).toContain("«redacted");
    });

    it("redacts GitHub personal access tokens", () => {
      const sensitive = "Token: ghp_1234567890abcdef1234567890abcdef12";
      const redacted = redactSecrets(sensitive);

      expect(redacted).not.toContain("ghp_");
      expect(redacted).toContain("«redacted");
    });

    it("automatically redacts secrets when writing to disk", () => {
      writeMemory(botId, "Secret: sk-abcdef1234567890abcdef1234567890");
      const saved = readMemory(botId);

      expect(saved).not.toContain("sk-abcdef");
      expect(saved).toContain("«redacted");
    });
  });

  describe("Prompt Ingestion & Truncation", () => {
    it("returns empty prompt memory when file is empty", () => {
      const res = memoryForPrompt(botId);
      expect(res.text).toBe("");
      expect(res.truncated).toBe(false);
    });

    it("truncates memory when it exceeds line limits", () => {
      const lines = Array.from({ length: 250 }, (_, i) => `Line ${i + 1}`);
      writeMemory(botId, lines.join("\n"));

      const res = memoryForPrompt(botId);
      expect(res.truncated).toBe(true);
      const returnedLines = res.text.split("\n");
      expect(returnedLines.length).toBeLessThanOrEqual(MEMORY_PROMPT_LIMIT.lines);
    });
  });
});
