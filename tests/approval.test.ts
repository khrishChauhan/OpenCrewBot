import { describe, it, expect, beforeEach } from "vitest";
import { respondToApproval } from "@/lib/server/runtime";
import { boot, createBot, deleteBot, sendMessage } from "@/lib/server/service";
import { deleteAgentSafely } from "@/lib/server/agent-factory";
import { toolCategory } from "@/lib/server/tools";
import { DEFAULT_AGENT_HANDLES } from "@/lib/server/workforce-defaults";
import { DELETE as deleteBotRoute } from "@/app/api/bots/[id]/route";
import * as store from "@/lib/server/db";
import type { Part, ChatMessage } from "@/lib/shared/types";

type ToolPart = Extract<Part, { kind: "tool" }>;

describe("Human-in-the-Loop: Tool Approval Mechanisms (runtime.ts)", () => {
  beforeEach(async () => {
    await boot();
  });

  it("throws descriptive error when attempting to approve expired or non-existent tool call", async () => {
    const fakeConv = "dm:non-existent-conv";
    await expect(
      respondToApproval(fakeConv, "fake-bot", "call-xyz", true)
    ).rejects.toThrow("That request is no longer waiting. The bot may have restarted.");
  });

  it("supports configuring bot with full autonomy (approval: full)", async () => {
    const autonomousBot = await createBot({
      name: "Autonomous Bot",
      handle: "autonomous",
      title: "Worker",
      description: "Full autonomy mode",
      instructions: "Execute without gating.",
      emoji: "🚀",
      color: "#059669",
      model: "mock",
      tools: { webSearch: false, memory: true, codeMode: true, browser: false, askUser: false },
      connections: [],
      approval: "full",
      pinned: false,
    });

    expect(autonomousBot.approval).toBe("full");

    const fetched = await store.getBot(autonomousBot.id);
    expect(fetched?.approval).toBe("full");
  });

  it("supports configuring bot with gated approval (approval: ask)", async () => {
    const gatedBot = await createBot({
      name: "Gated Bot",
      handle: "gated",
      title: "Worker",
      description: "Approval required mode",
      instructions: "Gate privileged tools.",
      emoji: "🛡️",
      color: "#dc2626",
      model: "mock",
      tools: { webSearch: false, memory: true, codeMode: true, browser: false, askUser: false },
      connections: [],
      approval: "ask",
      pinned: false,
    });

    expect(gatedBot.approval).toBe("ask");

    const fetched = await store.getBot(gatedBot.id);
    expect(fetched?.approval).toBe("ask");
  });

  describe("Permission Category Classification (toolCategory)", () => {
    it("correctly classifies read-only lookup tools as 'read'", () => {
      expect(toolCategory("web_search")).toBe("read");
      expect(toolCategory("read_page")).toBe("read");
      expect(toolCategory("crawl_site")).toBe("read");
      expect(toolCategory("ask_user")).toBe("read");
      expect(toolCategory("execute_typescript")).toBe("read");
      expect(toolCategory("browser_snapshot")).toBe("read");
      expect(toolCategory("browser_screenshot")).toBe("read");
      expect(toolCategory("mcp_github_get_file")).toBe("read");
      expect(toolCategory("mcp_slack_list_channels")).toBe("read");
      expect(toolCategory("COMPOSIO_SEARCH_TOOLS")).toBe("read");
    });

    it("correctly classifies memory modification tools as 'edit'", () => {
      expect(toolCategory("memory_add")).toBe("edit");
      expect(toolCategory("memory_edit")).toBe("edit");
    });

    it("correctly classifies mutating browser actions as 'execute'", () => {
      expect(toolCategory("browser_goto")).toBe("execute");
      expect(toolCategory("browser_click")).toBe("execute");
      expect(toolCategory("browser_type")).toBe("execute");
    });

    it("correctly classifies mutating MCP and external connector tools as 'mcp'", () => {
      expect(toolCategory("mcp_github_create_issue")).toBe("mcp");
      expect(toolCategory("mcp_postgres_execute_query")).toBe("mcp");
      expect(toolCategory("COMPOSIO_SLACK_SEND_MESSAGE")).toBe("mcp");
    });

    it("defaults unknown tools to 'other'", () => {
      expect(toolCategory("unrecognized_tool")).toBe("other");
    });
  });

  describe("Runtime Permission Mode Enforcement", () => {
    it("Full Access: executes mutating memory tool without requiring approval", async () => {
      const fullBot = await createBot({
        name: "Full Access Agent",
        handle: "full-exec-agent",
        title: "Auto Worker",
        description: "Executes without gating",
        instructions: "Do what is asked",
        emoji: "⚡",
        color: "#10b981",
        model: "mock",
        tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: false },
        connections: [],
        approval: "full",
        pinned: false,
      });

      const convId = `dm:${fullBot.id}`;
      await sendMessage(convId, "remember that Full access saves automatically");

      // Wait for turn to complete
      let botMsg: ChatMessage | undefined;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const messages = await store.listMessages(convId);
        botMsg = messages.find((m) => m.role === "bot");
        if (botMsg?.status === "done") break;
      }

      expect(botMsg).toBeDefined();
      expect(botMsg?.status).toBe("done");

      // Tool should have run and finished done without awaiting approval
      const toolPart = botMsg?.parts.find((p: Part) => p.kind === "tool") as ToolPart;
      expect(toolPart).toBeDefined();
      expect(toolPart.name).toBe("memory_add");
      expect(toolPart.status).toBe("done");
    });

    it("Controlled Access: gates mutating memory tool in awaiting-approval and resumes when approved", async () => {
      const controlledBot = await createBot({
        name: "Controlled Access Agent",
        handle: "controlled-exec-agent",
        title: "Controlled Worker",
        description: "Gates mutations",
        instructions: "Gate mutating tools",
        emoji: "⚖️",
        color: "#3b82f6",
        model: "mock",
        tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: false },
        connections: [],
        approval: "controlled",
        pinned: false,
      });

      const convId = `dm:${controlledBot.id}`;
      await sendMessage(convId, "remember that Controlled access gates memory write");

      // Wait brief tick for tool call to pause
      await new Promise((r) => setTimeout(r, 600));

      const messages = await store.listMessages(convId);
      const botMsg = messages.find((m) => m.role === "bot");
      expect(botMsg).toBeDefined();

      const toolPart = botMsg?.parts.find((p) => p.kind === "tool") as ToolPart;
      expect(toolPart).toBeDefined();
      expect(toolPart.name).toBe("memory_add");
      expect(toolPart.status).toBe("awaiting-approval");

      // Approve tool call
      await respondToApproval(convId, controlledBot.id, toolPart.toolCallId, true);

      // Wait brief tick for completion
      await new Promise((r) => setTimeout(r, 600));

      const updatedMessages = await store.listMessages(convId);
      const completedMsg = updatedMessages.find((m) => m.id === botMsg!.id);
      expect(completedMsg?.status).toBe("done");

      const updatedToolPart = completedMsg?.parts.find((p) => p.kind === "tool") as ToolPart;
      expect(updatedToolPart.status).toBe("done");
    });

    it("Ask First: gates mutating memory tool and rejects execution when human declines", async () => {
      const askFirstBot = await createBot({
        name: "Ask First Agent",
        handle: "askfirst-exec-agent",
        title: "Strict Worker",
        description: "Gates everything",
        instructions: "Strict mode",
        emoji: "🛑",
        color: "#ef4444",
        model: "mock",
        tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: false },
        connections: [],
        approval: "ask",
        pinned: false,
      });

      const convId = `dm:${askFirstBot.id}`;
      await sendMessage(convId, "remember that this action will be declined");

      await new Promise((r) => setTimeout(r, 600));

      const messages = await store.listMessages(convId);
      const botMsg = messages.find((m) => m.role === "bot");
      expect(botMsg).toBeDefined();

      const toolPart = botMsg?.parts.find((p) => p.kind === "tool") as ToolPart;
      expect(toolPart).toBeDefined();
      expect(toolPart.name).toBe("memory_add");
      expect(toolPart.status).toBe("awaiting-approval");

      // Decline tool call
      await respondToApproval(convId, askFirstBot.id, toolPart.toolCallId, false);

      await new Promise((r) => setTimeout(r, 600));

      const updatedMessages = await store.listMessages(convId);
      const completedMsg = updatedMessages.find((m) => m.id === botMsg!.id);
      expect(completedMsg).toBeDefined();

      const deniedToolPart = completedMsg?.parts.find((p) => p.kind === "tool") as ToolPart;
      expect(deniedToolPart.status).toBe("denied");
    });
  });

  describe("Default Workforce Deletion Protection (Service & REST API)", () => {
    it("blocks deletion of all eight default workforce agents via service.deleteBot()", async () => {
      const bots = await store.listBots();
      for (const handle of DEFAULT_AGENT_HANDLES) {
        const bot = bots.find((b) => b.handle === handle);
        expect(bot).toBeDefined();
        await expect(deleteBot(bot!.id)).rejects.toThrow(
          /default workforce agent and cannot be deleted/i,
        );
      }
    });

    it("blocks deletion of all eight default workforce agents via agent-factory.deleteAgentSafely()", async () => {
      const bots = await store.listBots();
      for (const handle of DEFAULT_AGENT_HANDLES) {
        const bot = bots.find((b) => b.handle === handle);
        expect(bot).toBeDefined();
        await expect(deleteAgentSafely(bot!.id)).rejects.toThrow(
          /default workforce agent and cannot be deleted/i,
        );
      }
    });

    it("blocks deletion of all eight default workforce agents via REST API DELETE /api/bots/[id]", async () => {
      const bots = await store.listBots();
      for (const handle of DEFAULT_AGENT_HANDLES) {
        const bot = bots.find((b) => b.handle === handle);
        expect(bot).toBeDefined();

        const req = new Request(`http://localhost:3000/api/bots/${bot!.id}`, { method: "DELETE" });
        const res = await deleteBotRoute(req, { params: Promise.resolve({ id: bot!.id }) } as never);

        expect(res.status).toBe(400);
        const json = (await res.json()) as { error: string };
        expect(json.error).toMatch(/default workforce agent and cannot be deleted/i);
      }
    });

    it("allows deleting custom agent via REST API DELETE /api/bots/[id] safely", async () => {
      const custom = await createBot({
        name: "API Deletable Agent",
        handle: "api-deletable-agent",
        title: "Deletable",
        description: "Will be deleted via API",
        instructions: "Temporary",
        emoji: "🗑️",
        color: "#6b7280",
        model: "mock",
        tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: false },
        connections: [],
        approval: "controlled",
        pinned: false,
      });

      const req = new Request(`http://localhost:3000/api/bots/${custom.id}`, { method: "DELETE" });
      const res = await deleteBotRoute(req, { params: Promise.resolve({ id: custom.id }) } as never);

      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(true);

      const inDb = await store.getBot(custom.id);
      expect(inDb).toBeNull();
    });
  });
});
