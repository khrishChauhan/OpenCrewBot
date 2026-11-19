// Central Dynamic Tool Registry for OpenCrewBot 2.0 (Phase 5)
import { randomUUID } from "node:crypto";
import { db, getSetting, setSetting } from "./db";
import { publish } from "./bus";
import type {
  Bot,
  ExecutionMode,
  RegisteredTool,
  ToolCategory,
  ToolExecutionLog,
  ToolSource,
} from "@/lib/shared/types";
import {
  getAllIntegrationActions,
  getIntegration,
  getIntegrationAction,
} from "./integrations";

const REGISTRY_VERSION_KEY = "tools.registry_version";

// In-memory execution handlers for custom/dynamic tools
const customHandlers = new Map<
  string,
  (input: unknown, context?: { botId?: string; conversationId?: string }) => Promise<unknown>
>();

export function registerToolHandler(
  id: string,
  handler: (input: unknown, context?: { botId?: string; conversationId?: string }) => Promise<unknown>,
): void {
  customHandlers.set(id, handler);
}

export function unregisterToolHandler(id: string): void {
  customHandlers.delete(id);
}

/** Registry version bumps whenever tools are added, updated, enabled, or disabled */
export async function toolRegistryVersion(): Promise<number> {
  return (await getSetting<number>(REGISTRY_VERSION_KEY)) ?? 0;
}

export async function toolRegistryChanged(): Promise<void> {
  const nextVer = (await toolRegistryVersion()) + 1;
  await setSetting(REGISTRY_VERSION_KEY, nextVer);
  publish({ type: "tools-changed" });
}

// ── In-Memory Fast Cache of Registered Tools ────────────────────────────
let cachedTools: Map<string, RegisteredTool> | null = null;

function parseToolRow(row: Record<string, unknown>): RegisteredTool {
  let inputSchema: Record<string, unknown> = {};
  let outputSchema: Record<string, unknown> | undefined;
  let config: Record<string, unknown> | undefined;

  try {
    inputSchema = typeof row.input_schema === "string" ? JSON.parse(row.input_schema) : {};
  } catch {
    inputSchema = {};
  }

  try {
    outputSchema = typeof row.output_schema === "string" ? JSON.parse(row.output_schema) : undefined;
  } catch {
    outputSchema = undefined;
  }

  try {
    config = typeof row.config === "string" ? JSON.parse(row.config) : undefined;
  } catch {
    config = undefined;
  }

  const authorizedAgentIds = Array.isArray(config?.authorizedAgentIds)
    ? (config.authorizedAgentIds as string[])
    : undefined;

  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    category: row.category as ToolCategory,
    source: row.source as ToolSource,
    integrationId: row.integration_id ? String(row.integration_id) : undefined,
    inputSchema,
    outputSchema,
    requiredPermission: row.required_permission as ToolCategory,
    enabled: Boolean(row.enabled),
    authorizedAgentIds,
    config,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function loadToolsFromDb(): Promise<Map<string, RegisteredTool>> {
  const client = await db();
  const res = await client.execute("SELECT * FROM tools ORDER BY name ASC");
  const map = new Map<string, RegisteredTool>();
  for (const row of res.rows as unknown as Array<Record<string, unknown>>) {
    const t = parseToolRow(row);
    map.set(t.id, t);
  }
  return map;
}

export async function ensureRegistryLoaded(): Promise<Map<string, RegisteredTool>> {
  if (!cachedTools) {
    cachedTools = await loadToolsFromDb();
    if (cachedTools.size === 0) {
      await seedIntegrationTools();
      cachedTools = await loadToolsFromDb();
    }
  }
  return cachedTools;
}

export function invalidateToolCache(): void {
  cachedTools = null;
}

/** Seed default integration actions into SQLite tools table if missing */
export async function seedIntegrationTools(): Promise<void> {
  const actions = getAllIntegrationActions();
  const client = await db();
  const now = new Date().toISOString();

  for (const { integrationId, action } of actions) {
    const existing = await client.execute({
      sql: "SELECT id FROM tools WHERE id = ?",
      args: [action.id],
    });
    if (existing.rows.length === 0) {
      await client.execute({
        sql: `INSERT INTO tools (
          id, name, description, category, source, integration_id,
          input_schema, output_schema, required_permission, enabled, config, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          action.id,
          action.name,
          action.description,
          action.category,
          "integration",
          integrationId,
          JSON.stringify(action.inputSchema ?? {}),
          null,
          action.category,
          1,
          JSON.stringify({}),
          now,
          now,
        ],
      });
    }
  }
}

// ── Registry Operations ─────────────────────────────────────────────────

const ID_REGEX = /^[a-z0-9_-]+$/i;
const VALID_CATEGORIES: ToolCategory[] = ["read", "edit", "execute", "mcp", "other"];
const VALID_SOURCES: ToolSource[] = ["built-in", "integration", "mcp", "custom"];

export interface RegisterToolInput {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  source?: ToolSource;
  integrationId?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredPermission?: ToolCategory;
  enabled?: boolean;
  authorizedAgentIds?: string[];
  config?: Record<string, unknown>;
  handler?: (input: unknown, context?: { botId?: string; conversationId?: string }) => Promise<unknown>;
}

export async function registerTool(input: RegisterToolInput): Promise<RegisteredTool> {
  if (!input.id || typeof input.id !== "string" || !ID_REGEX.test(input.id)) {
    throw new Error(`Invalid tool ID "${input.id}". IDs must be non-empty and alphanumeric.`);
  }
  if (!input.name || typeof input.name !== "string") {
    throw new Error("Tool name is required.");
  }
  if (!VALID_CATEGORIES.includes(input.category)) {
    throw new Error(`Invalid category "${input.category}". Must be one of: ${VALID_CATEGORIES.join(", ")}`);
  }
  const source = input.source ?? "custom";
  if (!VALID_SOURCES.includes(source)) {
    throw new Error(`Invalid source "${source}". Must be one of: ${VALID_SOURCES.join(", ")}`);
  }

  const client = await db();
  const existing = await client.execute({
    sql: "SELECT id FROM tools WHERE id = ?",
    args: [input.id],
  });

  const now = new Date().toISOString();
  const inputSchema = input.inputSchema ?? {};
  const outputSchema = input.outputSchema ?? null;
  const reqPerm = input.requiredPermission ?? input.category;
  const enabled = input.enabled !== false ? 1 : 0;
  const config = {
    ...(input.config ?? {}),
    ...(input.authorizedAgentIds ? { authorizedAgentIds: input.authorizedAgentIds } : {}),
  };

  if (existing.rows.length > 0) {
    // Update existing tool
    await client.execute({
      sql: `UPDATE tools SET
        name = ?, description = ?, category = ?, source = ?, integration_id = ?,
        input_schema = ?, output_schema = ?, required_permission = ?, enabled = ?,
        config = ?, updated_at = ?
      WHERE id = ?`,
      args: [
        input.name,
        input.description || "",
        input.category,
        source,
        input.integrationId || null,
        JSON.stringify(inputSchema),
        outputSchema ? JSON.stringify(outputSchema) : null,
        reqPerm,
        enabled,
        JSON.stringify(config),
        now,
        input.id,
      ],
    });
  } else {
    // Insert new tool
    await client.execute({
      sql: `INSERT INTO tools (
        id, name, description, category, source, integration_id,
        input_schema, output_schema, required_permission, enabled, config, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.id,
        input.name,
        input.description || "",
        input.category,
        source,
        input.integrationId || null,
        JSON.stringify(inputSchema),
        outputSchema ? JSON.stringify(outputSchema) : null,
        reqPerm,
        enabled,
        JSON.stringify(config),
        now,
        now,
      ],
    });
  }

  if (input.handler) {
    registerToolHandler(input.id, input.handler);
  }

  invalidateToolCache();
  await toolRegistryChanged();

  const tool = await getTool(input.id);
  if (!tool) throw new Error("Failed to retrieve registered tool.");
  return tool;
}

export async function unregisterTool(id: string): Promise<boolean> {
  const client = await db();
  const existing = await client.execute({
    sql: "SELECT id, source FROM tools WHERE id = ?",
    args: [id],
  });
  if (existing.rows.length === 0) return false;

  await client.execute({
    sql: "DELETE FROM tools WHERE id = ?",
    args: [id],
  });

  unregisterToolHandler(id);
  invalidateToolCache();
  await toolRegistryChanged();
  return true;
}

export async function enableTool(id: string): Promise<RegisteredTool> {
  const client = await db();
  const now = new Date().toISOString();
  const res = await client.execute({
    sql: "UPDATE tools SET enabled = 1, updated_at = ? WHERE id = ?",
    args: [now, id],
  });
  if (res.rowsAffected === 0) {
    throw new Error(`Tool "${id}" not found.`);
  }

  invalidateToolCache();
  await toolRegistryChanged();
  const tool = await getTool(id);
  if (!tool) throw new Error(`Tool "${id}" not found.`);
  return tool;
}

export async function disableTool(id: string): Promise<RegisteredTool> {
  const client = await db();
  const now = new Date().toISOString();
  const res = await client.execute({
    sql: "UPDATE tools SET enabled = 0, updated_at = ? WHERE id = ?",
    args: [now, id],
  });
  if (res.rowsAffected === 0) {
    throw new Error(`Tool "${id}" not found.`);
  }

  invalidateToolCache();
  await toolRegistryChanged();
  const tool = await getTool(id);
  if (!tool) throw new Error(`Tool "${id}" not found.`);
  return tool;
}

export async function getTool(id: string): Promise<RegisteredTool | undefined> {
  const map = await ensureRegistryLoaded();
  return map.get(id);
}

export async function listTools(filter?: {
  category?: ToolCategory;
  source?: ToolSource;
  enabled?: boolean;
  integrationId?: string;
}): Promise<RegisteredTool[]> {
  const map = await ensureRegistryLoaded();
  let tools = Array.from(map.values());

  if (filter) {
    if (filter.category) {
      tools = tools.filter((t) => t.category === filter.category);
    }
    if (filter.source) {
      tools = tools.filter((t) => t.source === filter.source);
    }
    if (typeof filter.enabled === "boolean") {
      tools = tools.filter((t) => t.enabled === filter.enabled);
    }
    if (filter.integrationId) {
      tools = tools.filter((t) => t.integrationId === filter.integrationId);
    }
  }

  return tools;
}

export async function getToolCategory(toolName: string): Promise<ToolCategory | undefined> {
  const tool = await getTool(toolName);
  return tool?.category;
}

export function getCachedToolCategory(toolName: string): ToolCategory | undefined {
  if (cachedTools) {
    const t = cachedTools.get(toolName);
    if (t) return t.category;
  }
  const act = getIntegrationAction(toolName);
  if (act) return act.action.category;
  return undefined;
}

/** Determines if a specific bot has permission to use a registered tool */
export function isBotAuthorizedForTool(bot: { id: string; handle?: string; connections?: string[] }, tool: RegisteredTool): boolean {
  // If authorizedAgentIds is set and not empty, check if bot is explicitly included
  if (tool.authorizedAgentIds && tool.authorizedAgentIds.length > 0) {
    const isIdMatch = tool.authorizedAgentIds.includes(bot.id);
    const isHandleMatch = bot.handle ? tool.authorizedAgentIds.includes(bot.handle) : false;
    if (!isIdMatch && !isHandleMatch) {
      return false;
    }
  }

  // If tool belongs to an integration and bot specifies integration connections, check match
  if (tool.integrationId && bot.connections && bot.connections.length > 0) {
    const hasIntegrationRestrictions = bot.connections.some((c) => c.startsWith("integration:"));
    if (hasIntegrationRestrictions) {
      const allowed = bot.connections.includes(`integration:${tool.integrationId}`) || bot.connections.includes(tool.integrationId);
      if (!allowed) return false;
    }
  }

  return true;
}

/** Get all registered tools authorized and ready for this bot */
export async function getToolsForBot(bot: Bot): Promise<RegisteredTool[]> {
  const map = await ensureRegistryLoaded();
  const available: RegisteredTool[] = [];

  for (const tool of map.values()) {
    if (!tool.enabled) continue;

    // Check integration status if it belongs to an integration
    if (tool.integrationId) {
      const integration = getIntegration(tool.integrationId);
      if (!integration) continue;
      const status = await integration.getStatus();
      if (status.status !== "connected") continue;
    }

    // Check authorization
    if (isBotAuthorizedForTool(bot, tool)) {
      available.push(tool);
    }
  }

  return available;
}

// ── Execution and Logging ───────────────────────────────────────────────

export async function executeTool(
  id: string,
  input: unknown,
  context?: { botId?: string; conversationId?: string; isMock?: boolean },
): Promise<unknown> {
  const start = Date.now();
  const tool = await getTool(id);

  if (!tool) {
    throw new Error(`Tool "${id}" not found.`);
  }

  if (!tool.enabled) {
    throw new Error(`Tool "${id}" is disabled.`);
  }

  // Check integration status
  const integrationHandler = tool.integrationId ? getIntegration(tool.integrationId) : undefined;
  let executionMode: ExecutionMode = "MOCK";

  if (tool.integrationId) {
    if (!integrationHandler) {
      throw new Error(`Integration "${tool.integrationId}" is not registered.`);
    }
    const state = await integrationHandler.getStatus();
    if (state.status !== "connected" || state.executionMode === "UNAVAILABLE") {
      await logExecution({
        toolId: tool.id,
        toolName: tool.name,
        integrationId: tool.integrationId,
        botId: context?.botId,
        conversationId: context?.conversationId,
        executionMode: "UNAVAILABLE",
        status: "error",
        input,
        error: `Integration "${tool.integrationId}" is disconnected or unavailable.`,
        durationMs: Date.now() - start,
      });
      throw new Error(`Integration "${tool.integrationId}" is disconnected or unavailable.`);
    }
    executionMode = state.executionMode;
  }

  // Check agent authorization
  if (context?.botId) {
    const isAuth = isBotAuthorizedForTool({ id: context.botId }, tool);
    if (!isAuth) {
      const err = `Agent "${context.botId}" is not authorized to use tool "${id}".`;
      await logExecution({
        toolId: tool.id,
        toolName: tool.name,
        integrationId: tool.integrationId,
        botId: context.botId,
        conversationId: context.conversationId,
        executionMode,
        status: "denied",
        input,
        error: err,
        durationMs: Date.now() - start,
      });
      throw new Error(err);
    }
  }

  try {
    let result: unknown;

    if (tool.integrationId) {
      const act = getIntegrationAction(id);
      if (!act) {
        throw new Error(`Action handler for "${id}" not found on integration "${tool.integrationId}".`);
      }
      result = await act.action.execute(input, {
        botId: context?.botId,
        conversationId: context?.conversationId,
        isMock: executionMode === "MOCK",
      });
    } else {
      const handler = customHandlers.get(id);
      if (handler) {
        result = await handler(input, context);
      } else if (tool.config?.mockResult) {
        result = tool.config.mockResult;
      } else {
        result = { success: true, message: `Tool ${id} executed successfully.`, input };
      }
    }

    const durationMs = Date.now() - start;
    await logExecution({
      toolId: tool.id,
      toolName: tool.name,
      integrationId: tool.integrationId,
      botId: context?.botId,
      conversationId: context?.conversationId,
      executionMode,
      status: "success",
      input,
      output: result,
      durationMs,
    });

    return result;
  } catch (error) {
    const durationMs = Date.now() - start;
    const errMsg = error instanceof Error ? error.message : String(error);
    await logExecution({
      toolId: tool.id,
      toolName: tool.name,
      integrationId: tool.integrationId,
      botId: context?.botId,
      conversationId: context?.conversationId,
      executionMode,
      status: "error",
      input,
      error: errMsg,
      durationMs,
    });
    throw error;
  }
}

export async function logExecution(
  entry: Omit<ToolExecutionLog, "id" | "createdAt">,
): Promise<ToolExecutionLog> {
  const client = await db();
  const id = randomUUID();
  const now = new Date().toISOString();

  await client.execute({
    sql: `INSERT INTO tool_execution_logs (
      id, tool_id, tool_name, integration_id, bot_id, conversation_id,
      execution_mode, status, input, output, error, duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      entry.toolId,
      entry.toolName,
      entry.integrationId || null,
      entry.botId || null,
      entry.conversationId || null,
      entry.executionMode,
      entry.status,
      entry.input ? JSON.stringify(entry.input) : null,
      entry.output ? JSON.stringify(entry.output) : null,
      entry.error || null,
      entry.durationMs ?? null,
      now,
    ],
  });

  return {
    id,
    toolId: entry.toolId,
    toolName: entry.toolName,
    integrationId: entry.integrationId,
    botId: entry.botId,
    conversationId: entry.conversationId,
    executionMode: entry.executionMode,
    status: entry.status,
    input: entry.input,
    output: entry.output,
    error: entry.error,
    durationMs: entry.durationMs,
    createdAt: now,
  };
}

export async function getExecutionLogs(options?: {
  toolId?: string;
  botId?: string;
  limit?: number;
}): Promise<ToolExecutionLog[]> {
  const client = await db();
  const limit = options?.limit ?? 50;
  let sql = "SELECT * FROM tool_execution_logs";
  const conditions: string[] = [];
  const args: Array<string | number> = [];

  if (options?.toolId) {
    conditions.push("tool_id = ?");
    args.push(options.toolId);
  }
  if (options?.botId) {
    conditions.push("bot_id = ?");
    args.push(options.botId);
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  args.push(limit);

  const res = await client.execute({ sql, args });
  return (res.rows as unknown as Array<Record<string, unknown>>).map((r) => {
    let input: unknown;
    let output: unknown;
    try {
      input = r.input ? JSON.parse(String(r.input)) : undefined;
    } catch {
      input = r.input;
    }
    try {
      output = r.output ? JSON.parse(String(r.output)) : undefined;
    } catch {
      output = r.output;
    }

    return {
      id: String(r.id),
      toolId: String(r.tool_id),
      toolName: String(r.tool_name),
      integrationId: r.integration_id ? String(r.integration_id) : undefined,
      botId: r.bot_id ? String(r.bot_id) : undefined,
      conversationId: r.conversation_id ? String(r.conversation_id) : undefined,
      executionMode: r.execution_mode as ExecutionMode,
      status: r.status as "success" | "error" | "denied",
      input,
      output,
      error: r.error ? String(r.error) : undefined,
      durationMs: typeof r.duration_ms === "number" ? r.duration_ms : undefined,
      createdAt: String(r.created_at),
    };
  });
}
