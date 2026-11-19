// Each bot's memory is one Markdown file: data/workspaces/<botId>/MEMORY.md.
// In Phase 4, memory is extended to multi-scope persistence (agent, room, project, user),
// while preserving exact file paths, markdown transparency, and prompt limits.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACES_DIR } from "./config";
import type { MemoryScope } from "./memory-types";
import { clearScope, syncMarkdownToStore } from "./memory-store";
import { getOrGenerateSummary, needsSummarization } from "./memory-summarizer";

/** How much of MEMORY.md goes into the prompt. The file itself can be longer. */
export const MEMORY_PROMPT_LIMIT = { lines: 200, bytes: 16 * 1024 };

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function workspaceDir(botId: string): string {
  const dir = join(WORKSPACES_DIR, sanitize(botId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function scopeDir(scope: MemoryScope, scopeId: string): string {
  const cleanId = sanitize(scopeId);
  let dir: string;
  if (scope === "agent") {
    dir = join(WORKSPACES_DIR, cleanId);
  } else if (scope === "room") {
    dir = join(WORKSPACES_DIR, "rooms", cleanId);
  } else if (scope === "project") {
    dir = join(WORKSPACES_DIR, "projects", cleanId);
  } else if (scope === "user") {
    dir = join(WORKSPACES_DIR, "users", cleanId);
  } else {
    dir = join(WORKSPACES_DIR, scope, cleanId);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function memoryPath(botId: string): string {
  return join(workspaceDir(botId), "MEMORY.md");
}

export function scopeMemoryPath(scope: MemoryScope, scopeId: string): string {
  if (scope === "agent") return memoryPath(scopeId);
  const fileName = scope === "user" ? "PREFERENCES.md" : "MEMORY.md";
  return join(scopeDir(scope, scopeId), fileName);
}

export function scopeSummaryPath(scope: MemoryScope, scopeId: string): string {
  return join(scopeDir(scope, scopeId), "MEMORY.summary.md");
}

export function readMemory(botId: string): string {
  return readScopeMemory("agent", botId);
}

export function readScopeMemory(scope: MemoryScope, scopeId: string): string {
  const path = scopeMemoryPath(scope, scopeId);
  return existsSync(/*turbopackIgnore: true*/ path) ? readFileSync(/*turbopackIgnore: true*/ path, "utf8") : "";
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk|tvly|ak|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi,
];

/** Bots sometimes "helpfully" remember a key they saw. They don't get to keep it. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (m) => `«redacted ${m.length} chars»`);
  }
  return out;
}

export function writeScopeMemory(
  scope: MemoryScope,
  scopeId: string,
  content: string,
  sourceAuthor = "user",
): string {
  const path = scopeMemoryPath(scope, scopeId);
  const clean = redactSecrets(content);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, clean, { mode: 0o600 });
  renameSync(tmp, path);

  // Background synchronize with semantic store & summarizer
  void syncMarkdownToStore(scope, scopeId, clean, path, sourceAuthor).catch((err) => {
    console.error(`Failed to sync markdown store for ${scope}:${scopeId}:`, err);
  });

  if (needsSummarization(clean)) {
    void getOrGenerateSummary(scope, scopeId, clean)
      .then((summaryRec) => {
        if (summaryRec?.summary) {
          try {
            writeFileSync(scopeSummaryPath(scope, scopeId), summaryRec.summary, { mode: 0o600 });
          } catch {
            // Ignore write errors for cache
          }
        }
      })
      .catch(() => {});
  }

  return clean;
}

export function writeMemory(botId: string, content: string): string {
  return writeScopeMemory("agent", botId, content, "user");
}

export async function syncScopeMemory(scope: MemoryScope, scopeId: string): Promise<void> {
  const path = scopeMemoryPath(scope, scopeId);
  const content = readScopeMemory(scope, scopeId);
  await syncMarkdownToStore(scope, scopeId, content, path);
  if (needsSummarization(content)) {
    const sum = await getOrGenerateSummary(scope, scopeId, content);
    if (sum?.summary) {
      try {
        writeFileSync(scopeSummaryPath(scope, scopeId), sum.summary, { mode: 0o600 });
      } catch {
        // Ignore cache write error
      }
    }
  }
}

export function deleteWorkspace(botId: string): void {
  deleteScopeMemory("agent", botId);
}

export function deleteScopeMemory(scope: MemoryScope, scopeId: string): void {
  const dir = scopeDir(scope, scopeId);
  rmSync(dir, { recursive: true, force: true });
  void clearScope(scope, scopeId).catch(() => {});
}

/** The slice of MEMORY.md that loads into the prompt, and whether it was cut. */
export function memoryForPrompt(botId: string): { text: string; truncated: boolean } {
  const full = readMemory(botId);
  if (!full.trim()) {
    return { text: "", truncated: false };
  }

  // If a summary companion exists and the file is large, supply summary + recent
  const sumPath = scopeSummaryPath("agent", botId);
  if (needsSummarization(full) && existsSync(/*turbopackIgnore: true*/ sumPath)) {
    try {
      const summary = readFileSync(/*turbopackIgnore: true*/ sumPath, "utf8").trim();
      const lines = full.trim().split("\n");
      const recent = lines.slice(-8).join("\n");
      const bounded = `${summary}\n\n### Recent Notes\n${recent}`;
      return {
        text: bounded,
        truncated: bounded.length < full.trimEnd().length,
      };
    } catch {
      // Fall through to standard slicing
    }
  }

  let text = full.split("\n").slice(0, MEMORY_PROMPT_LIMIT.lines).join("\n");
  if (Buffer.byteLength(text) > MEMORY_PROMPT_LIMIT.bytes) {
    text = Buffer.from(text).subarray(0, MEMORY_PROMPT_LIMIT.bytes).toString("utf8");
  }
  return { text: text.trim(), truncated: text.length < full.trimEnd().length };
}

export function appendScopeMemory(
  scope: MemoryScope,
  scopeId: string,
  note: string,
  section?: string,
  sourceAuthor = "agent",
): string {
  const today = new Date().toISOString().slice(0, 10);
  const line = `- ${note.trim().replace(/\n+/g, " ")} _(${today})_`;
  let content = readScopeMemory(scope, scopeId).trimEnd();
  if (section) {
    const heading = `## ${section.trim()}`;
    const idx = content.split("\n").findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
    if (idx >= 0) {
      const lines = content.split("\n");
      let end = idx + 1;
      while (end < lines.length && !lines[end].startsWith("## ")) end++;
      while (end > idx + 1 && lines[end - 1].trim() === "") end--;
      lines.splice(end, 0, line);
      content = lines.join("\n");
    } else {
      content = `${content}${content ? "\n\n" : ""}${heading}\n${line}`;
    }
  } else {
    const afterHeading = /(^|\n)#[^\n]*$/.test(content);
    content = `${content}${content ? (afterHeading ? "\n\n" : "\n") : ""}${line}`;
  }
  return writeScopeMemory(scope, scopeId, `${content}\n`, sourceAuthor);
}

export function appendMemory(botId: string, note: string, section?: string): string {
  return appendScopeMemory("agent", botId, note, section, "agent");
}

export function editScopeMemory(
  scope: MemoryScope,
  scopeId: string,
  find: string,
  replace: string,
  sourceAuthor = "user",
): { ok: boolean; reason?: string } {
  const content = readScopeMemory(scope, scopeId);
  const count = content.split(find).length - 1;
  const fileName = scope === "user" ? "PREFERENCES.md" : "MEMORY.md";
  if (!find || count === 0) return { ok: false, reason: `That exact text isn't in ${fileName}. Read it again and copy the text exactly.` };
  if (count > 1) return { ok: false, reason: `That text appears ${count} times. Include more surrounding words so it matches once.` };
  writeScopeMemory(scope, scopeId, content.replace(find, replace), sourceAuthor);
  return { ok: true };
}

export function editMemory(botId: string, find: string, replace: string): { ok: boolean; reason?: string } {
  return editScopeMemory("agent", botId, find, replace, "user");
}
