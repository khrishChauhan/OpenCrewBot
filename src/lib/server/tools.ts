// The tools a bot gets, from its settings. Names are short snake_case words
// because open models pick tools by name more reliably that way.
import type { ToolsInput } from "@mastra/core/agent";
import { createTool, createCodeMode } from "@mastra/core/tools";
import type { ToolCategory } from "@mastra/core/agent-controller";
import { createTavilyCrawlTool, createTavilyExtractTool, createTavilySearchTool } from "@mastra/tavily";
import { QuickJsCodeModeTransport } from "@mastra/quickjs";
import { z } from "zod";
import type { Bot, Source } from "@/lib/shared/types";
import { appendMemory, editMemory, appendScopeMemory } from "./memory-files";
import { searchMemories } from "./memory-store";
import { publish } from "./bus";
import { keys } from "./config";
import { mcpServerNames } from "./connectors";
import { getCachedToolCategory } from "./tool-registry";

export const CODE_MODE_TOOL = "execute_typescript";

function memoryTools(botId: string): ToolsInput {
  return {
    memory_add: createTool({
      id: "memory_add",
      description:
        "Save one durable fact to your MEMORY.md (a preference, a decision, something about the person or your ongoing work). One short line per call.",
      inputSchema: z.object({
        note: z.string().min(1).describe("The fact, as one short sentence."),
        section: z.string().optional().describe("Optional heading to file it under, e.g. 'About the person' or 'Projects'."),
      }),
      execute: async ({ note, section }) => {
        appendMemory(botId, note, section);
        publish({ type: "memory-changed", botId });
        return { saved: true };
      },
    }),
    memory_edit: createTool({
      id: "memory_edit",
      description:
        "Fix or remove a line in your MEMORY.md. `find` must match the current text exactly once; use an empty `replace` to delete it.",
      inputSchema: z.object({ find: z.string().min(1), replace: z.string() }),
      execute: async ({ find, replace }) => {
        const result = editMemory(botId, find, replace);
        if (result.ok) publish({ type: "memory-changed", botId });
        return result;
      },
    }),
    memory_search: createTool({
      id: "memory_search",
      description:
        "Search your memory and shared context semantically for relevant notes, past decisions, facts, or instructions.",
      inputSchema: z.object({
        query: z.string().min(1).describe("The search query or concept to look up."),
        scope: z.enum(["all", "agent", "room", "project", "user"]).optional().describe("Scope to search. Defaults to 'agent'."),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)."),
      }),
      execute: async ({ query, scope, limit }) => {
        const effectiveScope = scope ?? "agent";
        const results = await searchMemories(query, {
          scope: effectiveScope === "all" ? undefined : effectiveScope,
          scopeId: effectiveScope === "agent" ? botId : undefined,
          limit: limit ?? 5,
        });
        return {
          query,
          count: results.length,
          results: results.map((r) => ({
            scope: r.scope,
            scopeId: r.scopeId,
            content: r.content,
            score: Number(r.score.toFixed(3)),
            category: r.category,
            sourceRef: r.sourceRef,
          })),
        };
      },
    }),
    room_memory_add: createTool({
      id: "room_memory_add",
      description:
        "Add a shared note, decision, or finding to a group room's shared memory, visible to all room members.",
      inputSchema: z.object({
        roomId: z.string().min(1).describe("The room ID."),
        note: z.string().min(1).describe("The note or decision to share with the room."),
        section: z.string().optional().describe("Optional heading to file it under."),
      }),
      execute: async ({ roomId, note, section }) => {
        appendScopeMemory("room", roomId, note, section, botId);
        publish({ type: "room-memory-changed", roomId });
        return { saved: true, roomId };
      },
    }),
  };
}

function webTools(): ToolsInput {
  const apiKey = process.env.TAVILY_API_KEY;
  return {
    web_search: createTavilySearchTool({ apiKey }),
    read_page: createTavilyExtractTool({ apiKey }),
    crawl_site: createTavilyCrawlTool({ apiKey }),
  };
}

export interface BotToolset {
  tools: ToolsInput;
  /** Extra prompt text the tools need (Code Mode's function stubs). */
  instructions: string[];
  /** What the bot can do, in words, for its own system prompt. */
  capabilities: string[];
}

export function buildTools(bot: Bot): BotToolset {
  const tools: ToolsInput = {};
  const instructions: string[] = [];
  const capabilities: string[] = [];

  if (bot.tools.webSearch && keys.tavily()) {
    Object.assign(tools, webTools());
    capabilities.push("Search the web (web_search), read pages (read_page) and crawl sites (crawl_site). Cite the URLs you used.");
  } else if (bot.tools.webSearch) {
    capabilities.push("Web search is switched on for you, but no Tavily key is set yet, so you can't search right now. Say so if asked.");
  }
  if (bot.tools.memory) {
    Object.assign(tools, memoryTools(bot.id));
    capabilities.push("Remember facts (memory_add), fix memory (memory_edit), and search memories semantically (memory_search).");
  }
  if (bot.tools.codeMode) {
    // The program runs in a QuickJS (WebAssembly) isolate with no filesystem or
    // network; its only reach is the tools passed here, bridged back to the host.
    const reachable = { ...tools };
    const codeMode = createCodeMode({ tools: reachable, timeout: 60_000 }, new QuickJsCodeModeTransport({ memoryLimitMb: 128 }));
    tools[CODE_MODE_TOOL] = codeMode.tool;
    instructions.push(codeMode.instructions);
    capabilities.push(
      `Run TypeScript with ${CODE_MODE_TOOL} when a question needs several tool calls, filtering, or exact arithmetic; call the other tools from inside it with Promise.all.`,
    );
  }
  if (bot.tools.browser && keys.browserbase()) {
    capabilities.push(
      "Drive a real cloud browser with the browser_* tools for pages that need clicks, forms or JavaScript. Start with browser_goto, then browser_snapshot to get element refs. The person can watch you live. Prefer read_page for plain reading; it's faster.",
    );
  } else if (bot.tools.browser) {
    capabilities.push("The browser is switched on for you, but no Browserbase key is set yet, so browsing will fail. Say so if asked.");
  }
  return { tools, instructions, capabilities };
}

/** Which approval policy a tool falls under. Read and memory tools never ask;
 * acting in the browser does, unless the bot has Full access. */
/** MCP tool names that only look things up. A heuristic over the tool's own name:
 * anything that doesn't read clearly as a lookup asks first. */
const READ_ONLY_VERB = /^(get|list|search|read|fetch|find|view|show|describe|lookup|query)(_|$)/;

export function toolCategory(toolName: string): ToolCategory | null {
  // Check dynamic tool registry first
  const dynamicCategory = getCachedToolCategory(toolName);
  if (dynamicCategory) return dynamicCategory;

  if (toolName === "memory_search") return "read";
  if (["web_search", "read_page", "crawl_site", "ask_user", CODE_MODE_TOOL].includes(toolName)) return "read";
  // Composio: looking up actions is free; running them ("multi execute", the remote workbench) asks.
  if (toolName.startsWith("COMPOSIO_")) {
    return /SEARCH_TOOLS|GET_TOOL_SCHEMAS|MANAGE_CONNECTIONS/.test(toolName) ? "read" : "mcp";
  }
  if (toolName.startsWith("mcp_")) {
    const action = toolName.split("_").slice(2).join("_");
    return READ_ONLY_VERB.test(action) ? "read" : "mcp";
  }
  if (toolName.startsWith("memory_") || toolName.startsWith("room_memory_")) return "edit";
  if (toolName.startsWith("browser_")) {
    return /snapshot|screenshot|scroll|wait|tabs|close|get_|read|extract|console/.test(toolName) ? "read" : "execute";
  }
  return "other";
}

// ── how tool calls look in chat ─────────────────────────────────────────

function host(url: unknown): string {
  try {
    return new URL(String(url)).host.replace(/^www\./, "");
  } catch {
    return String(url ?? "");
  }
}

/** "SLACK_SEND_MESSAGE" → "Slack: send message" */
function composioAction(slug: string): string {
  const [app, ...rest] = String(slug).toLowerCase().split("_");
  return `${app.charAt(0).toUpperCase()}${app.slice(1)}: ${rest.join(" ")}`;
}

export function toolLabel(name: string, args: unknown): { label: string; detail?: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name.startsWith("COMPOSIO_")) {
    if (/SEARCH_TOOLS/.test(name)) {
      const queries = Array.isArray(a.queries) ? a.queries.map((q) => (q as { use_case?: string })?.use_case ?? q) : [];
      return { label: "Looked up app actions", detail: queries.map(String).join(", ") || undefined };
    }
    if (/MULTI_EXECUTE/.test(name)) {
      const runs = Array.isArray(a.tools) ? a.tools.map((t) => composioAction((t as { tool_slug?: string })?.tool_slug ?? "")) : [];
      return { label: "Used connected apps", detail: runs.join(", ") || undefined };
    }
    return { label: composioAction(name.replace(/^COMPOSIO_/, "")) };
  }
  if (name.startsWith("mcp_")) {
    const [, id, ...rest] = name.split("_");
    return { label: `${mcpServerNames.get(id) ?? "MCP"}: ${rest.join(" ")}` };
  }
  if (name.startsWith("github_")) {
    const action = name.slice("github_".length).replace(/_/g, " ");
    const detail = a.owner && a.repo ? `${a.owner}/${a.repo}${a.title ? ` #${a.title}` : ""}` : (a.path ? String(a.path) : undefined);
    return { label: `GitHub: ${action}`, detail };
  }
  if (name.startsWith("gmail_")) {
    const action = name.slice("gmail_".length).replace(/_/g, " ");
    const detail = a.to ? `To: ${a.to}${a.subject ? ` | ${a.subject}` : ""}` : (a.query ? `Query: ${a.query}` : undefined);
    return { label: `Gmail: ${action}`, detail };
  }
  if (name.startsWith("slack_")) {
    const action = name.slice("slack_".length).replace(/_/g, " ");
    const detail = a.channel ? `#${a.channel}${a.text ? ` - ${String(a.text).slice(0, 40)}` : ""}` : undefined;
    return { label: `Slack: ${action}`, detail };
  }
  switch (name) {
    case "web_search":
      return { label: "Searched the web", detail: String(a.query ?? "") };
    case "read_page": {
      const urls = Array.isArray(a.urls) ? a.urls : [a.urls ?? a.url];
      return { label: "Read", detail: urls.map(host).join(", ") };
    }
    case "crawl_site":
      return { label: "Crawled", detail: host(a.url) };
    case "memory_add":
      return { label: "Saved to memory", detail: String(a.note ?? "") };
    case "memory_edit":
      return { label: "Updated memory" };
    case "memory_search":
      return { label: "Searched memory", detail: String(a.query ?? "") };
    case "room_memory_add":
      return { label: "Saved to room memory", detail: String(a.note ?? "") };
    case CODE_MODE_TOOL:
      return { label: "Ran code" };
    case "ask_user":
      return { label: "Asked you" };
    default:
      if (name.startsWith("browser_")) {
        const action = name.slice("browser_".length).replace(/_/g, " ");
        return { label: `Browser: ${action}`, detail: a.url ? host(a.url) : undefined };
      }
      return { label: name.replace(/_/g, " ") };
  }
}

export function toolSources(result: unknown): Source[] | undefined {
  const r = result as { results?: Array<{ title?: string; url?: string }> } | null;
  if (!r || !Array.isArray(r.results)) return undefined;
  const sources = r.results
    .filter((x) => typeof x?.url === "string")
    .map((x) => ({ title: x.title || host(x.url), url: x.url as string }));
  return sources.length ? sources.slice(0, 8) : undefined;
}

export function toolPreview(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result.slice(0, 400);
  const r = result as Record<string, unknown>;
  if (typeof r.answer === "string" && r.answer) return r.answer.slice(0, 400);
  if (typeof r.error === "string") return r.error.slice(0, 400);
  if (typeof r.reason === "string") return r.reason.slice(0, 400);
  try {
    return JSON.stringify(result).slice(0, 400);
  } catch {
    return undefined;
  }
}
