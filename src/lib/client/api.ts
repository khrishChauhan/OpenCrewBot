import type {
  AppStatus,
  Bot,
  BotInput,
  ChatMessage,
  ComposioApp,
  ConnectionsState,
  ConversationId,
  ConversationSummary,
  McpServer,
  ModelOption,
  Room,
  RoomInput,
  IntegrationState,
  RegisteredTool,
  ToolExecutionLog,
} from "@/lib/shared/types";

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const conv = (id: ConversationId) => `/api/conversations/${encodeURIComponent(id)}`;

export interface Bootstrap {
  status: AppStatus;
  bots: Bot[];
  rooms: Room[];
  conversations: ConversationSummary[];
  models: ModelOption[];
  /** botId → Browserbase live view URL for bots with an open browser. */
  liveViews: Record<string, string>;
}

export const api = {
  bootstrap: () => call<Bootstrap>("/api/bootstrap"),
  models: (refresh = false) => call<{ models: ModelOption[] }>(`/api/models${refresh ? "?refresh=1" : ""}`),
  createBot: (input: BotInput) => call<{ bot: Bot }>("/api/bots", { method: "POST", json: input }),
  updateBot: (id: string, patch: Partial<BotInput>) => call<{ bot: Bot }>(`/api/bots/${id}`, { method: "PATCH", json: patch }),
  deleteBot: (id: string) => call(`/api/bots/${id}`, { method: "DELETE" }),
  getMemory: (id: string) => call<{ content: string; path: string; limit: { lines: number; bytes: number } }>(`/api/bots/${id}/memory`),
  saveMemory: (id: string, content: string) => call<{ content: string }>(`/api/bots/${id}/memory`, { method: "PUT", json: { content } }),
  getRoomMemory: (id: string) => call<{ content: string; path: string; limit: { lines: number; bytes: number } }>(`/api/rooms/${id}/memory`),
  saveRoomMemory: (id: string, content: string) => call<{ content: string }>(`/api/rooms/${id}/memory`, { method: "PUT", json: { content } }),
  searchMemory: (query: string, scope?: string, scopeId?: string, limit?: number) =>
    call<{ query: string; count: number; results: unknown[] }>("/api/memory", {
      method: "POST",
      json: { action: "search", query, scope, scopeId, limit },
    }),
  reindexMemory: (scope?: string, scopeId?: string) =>
    call<{ ok: boolean; reindexed: number }>("/api/memory", {
      method: "POST",
      json: { action: "reindex", scope, scopeId },
    }),
  createRoom: (input: RoomInput) => call<{ room: Room }>("/api/rooms", { method: "POST", json: input }),
  updateRoom: (id: string, patch: Partial<RoomInput>) => call<{ room: Room }>(`/api/rooms/${id}`, { method: "PATCH", json: patch }),
  deleteRoom: (id: string) => call(`/api/rooms/${id}`, { method: "DELETE" }),
  messages: (id: ConversationId) => call<{ messages: ChatMessage[]; running: string[] }>(`${conv(id)}/messages`),
  send: (id: ConversationId, text: string) => call<{ message: ChatMessage }>(`${conv(id)}/messages`, { method: "POST", json: { text } }),
  approve: (id: ConversationId, botId: string, toolCallId: string, approve: boolean) =>
    call(`${conv(id)}/approval`, { method: "POST", json: { botId, toolCallId, approve } }),
  answer: (id: ConversationId, botId: string, toolCallId: string, answer: string) =>
    call(`${conv(id)}/answer`, { method: "POST", json: { botId, toolCallId, answer } }),
  stop: (id: ConversationId) => call(`${conv(id)}/stop`, { method: "POST" }),
  clear: (id: ConversationId) => call(`${conv(id)}/clear`, { method: "POST" }),
  read: (id: ConversationId) => call(`${conv(id)}/read`, { method: "POST" }),
  connections: () => call<ConnectionsState>("/api/connections"),
  searchApps: (q: string) => call<{ apps: ComposioApp[] }>(`/api/connections/composio/search?q=${encodeURIComponent(q)}`),
  connectApp: (slug: string) => call<{ redirectUrl: string }>("/api/connections/composio/connect", { method: "POST", json: { slug } }),
  disconnectApp: (slug: string) => call("/api/connections/composio/disconnect", { method: "POST", json: { slug } }),
  connectionsChanged: () => call("/api/connections/changed", { method: "POST" }),
  addMcpServer: (input: { name: string; url: string; token?: string; headers?: Record<string, string> }) =>
    call<{ server: McpServer }>("/api/connections/mcp", { method: "POST", json: input }),
  removeMcpServer: (id: string) => call(`/api/connections/mcp/${id}`, { method: "DELETE" }),
  testMcpServer: (id: string) => call<{ tools: number }>(`/api/connections/mcp/${id}/test`, { method: "POST" }),
  // Integrations & dynamic tool registry
  listIntegrations: () => call<{ integrations: IntegrationState[] }>("/api/integrations"),
  getIntegration: (id: string) => call<{ integration: IntegrationState; actions: unknown[] }>(`/api/integrations/${id}`),
  connectIntegration: (id: string, credentials?: Record<string, string>) =>
    call<{ integration: IntegrationState }>(`/api/integrations/${id}`, { method: "POST", json: { credentials } }),
  disconnectIntegration: (id: string) => call<{ integration: IntegrationState }>(`/api/integrations/${id}`, { method: "DELETE" }),
  testIntegration: (id: string) =>
    call<{ ok: boolean; executionMode: string; message: string; actionsCount: number }>(`/api/integrations/${id}/test`, { method: "POST" }),
  listTools: (params?: { category?: string; source?: string; enabled?: boolean; integrationId?: string }) => {
    const q = new URLSearchParams();
    if (params?.category) q.set("category", params.category);
    if (params?.source) q.set("source", params.source);
    if (params?.integrationId) q.set("integrationId", params.integrationId);
    if (params?.enabled !== undefined) q.set("enabled", String(params.enabled));
    const qs = q.toString();
    return call<{ tools: RegisteredTool[] }>(`/api/tools${qs ? `?${qs}` : ""}`);
  },
  getTool: (id: string) => call<{ tool: RegisteredTool }>(`/api/tools/${id}`),
  registerTool: (tool: Record<string, unknown>) => call<{ tool: RegisteredTool }>("/api/tools", { method: "POST", json: tool }),
  enableTool: (id: string) => call<{ tool: RegisteredTool }>(`/api/tools/${id}`, { method: "PATCH", json: { action: "enable" } }),
  disableTool: (id: string) => call<{ tool: RegisteredTool }>(`/api/tools/${id}`, { method: "PATCH", json: { action: "disable" } }),
  removeTool: (id: string) => call<{ success: boolean }>(`/api/tools/${id}`, { method: "DELETE" }),
  getToolExecutionLogs: (params?: { toolId?: string; botId?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.toolId) q.set("toolId", params.toolId);
    if (params?.botId) q.set("botId", params.botId);
    if (params?.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return call<{ logs: ToolExecutionLog[] }>(`/api/tools/logs${qs ? `?${qs}` : ""}`);
  },
};
