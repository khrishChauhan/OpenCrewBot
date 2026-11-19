import { describe, expect, it, beforeEach } from "vitest";
import {
  registerTool,
  unregisterTool,
  enableTool,
  disableTool,
  listTools,
  getTool,
  executeTool,
  getToolsForBot,
  toolRegistryVersion,
  getExecutionLogs,
  seedIntegrationTools,
  invalidateToolCache,
} from "@/lib/server/tool-registry";
import {
  connectIntegration,
  disconnectIntegration,
  getIntegration,
  listIntegrations,
  testIntegration,
} from "@/lib/server/integrations";
import { toolCategory } from "@/lib/server/tools";
import type { Bot } from "@/lib/shared/types";

describe("Phase 5: Verified Integrations & Dynamic Tool Registry", () => {
  beforeEach(async () => {
    invalidateToolCache();
    await seedIntegrationTools();
  });

  describe("A. Dynamic Tool Registry Lifecycle & CRUD", () => {
    it("registers a valid custom tool with schemas and category", async () => {
      const tool = await registerTool({
        id: "custom_calculator",
        name: "Custom Calculator",
        description: "Adds two numbers together safely.",
        category: "read",
        source: "custom",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        handler: async (input: unknown) => {
          const { a, b } = input as { a: number; b: number };
          return { sum: a + b };
        },
      });

      expect(tool.id).toBe("custom_calculator");
      expect(tool.name).toBe("Custom Calculator");
      expect(tool.category).toBe("read");
      expect(tool.enabled).toBe(true);

      const retrieved = await getTool("custom_calculator");
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe("custom_calculator");

      // Clean up
      await unregisterTool("custom_calculator");
    });

    it("rejects invalid tool configurations", async () => {
      // Empty name
      await expect(
        registerTool({
          id: "invalid_tool_1",
          name: "",
          description: "Missing name",
          category: "read",
        }),
      ).rejects.toThrow(/Tool name is required/);

      // Invalid ID
      await expect(
        registerTool({
          id: "invalid id with spaces!",
          name: "Bad ID Tool",
          description: "Has spaces",
          category: "read",
        }),
      ).rejects.toThrow(/Invalid tool ID/);

      // Invalid category
      await expect(
        registerTool({
          id: "invalid_cat",
          name: "Bad Category",
          description: "Invalid category",
          // @ts-expect-error testing invalid category
          category: "unsupported_cat",
        }),
      ).rejects.toThrow(/Invalid category/);
    });

    it("filters tools by category, source, and enabled status", async () => {
      const allTools = await listTools();
      expect(allTools.length).toBeGreaterThan(0);

      const readTools = await listTools({ category: "read" });
      expect(readTools.every((t) => t.category === "read")).toBe(true);

      const editTools = await listTools({ category: "edit" });
      expect(editTools.every((t) => t.category === "edit")).toBe(true);

      const integrationTools = await listTools({ source: "integration" });
      expect(integrationTools.every((t) => t.source === "integration")).toBe(true);
    });

    it("enables and disables a tool dynamically", async () => {
      await registerTool({
        id: "toggle_test_tool",
        name: "Toggle Test Tool",
        description: "Testing enable and disable",
        category: "read",
        source: "custom",
      });

      const initial = await getTool("toggle_test_tool");
      expect(initial?.enabled).toBe(true);

      const disabled = await disableTool("toggle_test_tool");
      expect(disabled.enabled).toBe(false);

      const retrievedDisabled = await getTool("toggle_test_tool");
      expect(retrievedDisabled?.enabled).toBe(false);

      const reEnabled = await enableTool("toggle_test_tool");
      expect(reEnabled.enabled).toBe(true);

      await unregisterTool("toggle_test_tool");
    });

    it("unregisters a tool and confirms removal", async () => {
      await registerTool({
        id: "remove_me_tool",
        name: "Temporary Tool",
        description: "Will be removed",
        category: "read",
      });

      const removed = await unregisterTool("remove_me_tool");
      expect(removed).toBe(true);

      const check = await getTool("remove_me_tool");
      expect(check).toBeUndefined();

      const secondRemove = await unregisterTool("remove_me_tool");
      expect(secondRemove).toBe(false);
    });
  });

  describe("B. Verified Integrations (GitHub, Gmail, Slack)", () => {
    it("lists all three verified integrations with valid states", async () => {
      const integrations = await listIntegrations();
      expect(integrations.length).toBe(3);

      const ids = integrations.map((i) => i.id);
      expect(ids).toContain("github");
      expect(ids).toContain("gmail");
      expect(ids).toContain("slack");

      for (const intg of integrations) {
        expect(["LIVE", "MOCK", "UNAVAILABLE"]).toContain(intg.executionMode);
        expect(intg.actionsCount).toBeGreaterThan(0);
      }
    });

    it("executes GitHub integration actions in mock mode", async () => {
      const github = getIntegration("github");
      expect(github).toBeDefined();

      // Test connection
      const testRes = await testIntegration("github");
      expect(testRes.ok).toBe(true);
      expect(testRes.executionMode).toBe("MOCK");

      // 1. Inspect repo
      const repoInfo = (await executeTool("github_inspect_repo", {
        owner: "opencrewbot",
        repo: "opencrewbot",
      })) as { executionMode: string; fullName: string; stars: number; defaultBranch: string };
      expect(repoInfo.executionMode).toBe("MOCK");
      expect(repoInfo.fullName).toBe("opencrewbot/opencrewbot");
      expect(typeof repoInfo.stars).toBe("number");

      // 2. Read file
      const fileInfo = (await executeTool("github_read_file", {
        owner: "opencrewbot",
        repo: "opencrewbot",
        path: "README.md",
      })) as { executionMode: string; path: string; content: string };
      expect(fileInfo.executionMode).toBe("MOCK");
      expect(fileInfo.path).toBe("README.md");
      expect(fileInfo.content.toLowerCase()).toContain("opencrewbot");

      // 3. List issues
      const issues = (await executeTool("github_list_issues", {
        owner: "opencrewbot",
        repo: "opencrewbot",
        state: "open",
      })) as { executionMode: string; count: number; issues: Array<{ number: number; title: string }> };
      expect(issues.executionMode).toBe("MOCK");
      expect(issues.issues.length).toBeGreaterThan(0);

      // 4. Create issue
      const newIssue = (await executeTool("github_create_issue", {
        owner: "opencrewbot",
        repo: "opencrewbot",
        title: "Test Bug Report",
        body: "Detailed reproduction steps.",
      })) as { executionMode: string; created: boolean; issueNumber: number };
      expect(newIssue.executionMode).toBe("MOCK");
      expect(newIssue.created).toBe(true);
      expect(typeof newIssue.issueNumber).toBe("number");
    });

    it("executes Gmail integration actions in mock mode", async () => {
      const testRes = await testIntegration("gmail");
      expect(testRes.ok).toBe(true);
      expect(testRes.executionMode).toBe("MOCK");

      // 1. Search emails
      const searchRes = (await executeTool("gmail_search_emails", {
        query: "urgent project update",
      })) as { executionMode: string; count: number; messages: Array<{ id: string; subject: string }> };
      expect(searchRes.executionMode).toBe("MOCK");
      expect(searchRes.messages.length).toBeGreaterThan(0);

      // 2. Read email
      const readRes = (await executeTool("gmail_read_email", {
        messageId: "msg-101",
      })) as { executionMode: string; id: string; subject: string; body: string };
      expect(readRes.executionMode).toBe("MOCK");
      expect(readRes.id).toBe("msg-101");
      expect(readRes.body.length).toBeGreaterThan(0);

      // 3. Create draft
      const draftRes = (await executeTool("gmail_create_draft", {
        to: "team@example.com",
        subject: "Q3 Strategy Memo",
        body: "Attached is the Q3 strategy draft.",
      })) as { executionMode: string; draftId: string; draftCreated: boolean };
      expect(draftRes.executionMode).toBe("MOCK");
      expect(draftRes.draftCreated).toBe(true);
      expect(draftRes.draftId).toBeDefined();

      // 4. Send email
      const sendRes = (await executeTool("gmail_send_email", {
        to: "exec@example.com",
        subject: "Production Alert Resolved",
        body: "All systems nominal.",
      })) as { executionMode: string; sent: boolean; messageId: string };
      expect(sendRes.executionMode).toBe("MOCK");
      expect(sendRes.sent).toBe(true);
      expect(sendRes.messageId).toBeDefined();
    });

    it("executes Slack integration actions in mock mode", async () => {
      const testRes = await testIntegration("slack");
      expect(testRes.ok).toBe(true);
      expect(testRes.executionMode).toBe("MOCK");

      // 1. Search messages
      const searchRes = (await executeTool("slack_search_messages", {
        query: "release status",
      })) as { executionMode: string; count: number; messages: Array<{ channel: string; text: string }> };
      expect(searchRes.executionMode).toBe("MOCK");
      expect(searchRes.messages.length).toBeGreaterThan(0);

      // 2. Read channel
      const channelRes = (await executeTool("slack_read_channel", {
        channel: "engineering",
      })) as { executionMode: string; channel: string; messages: Array<{ text: string }> };
      expect(channelRes.executionMode).toBe("MOCK");
      expect(channelRes.channel).toBe("engineering");
      expect(channelRes.messages.length).toBeGreaterThan(0);

      // 3. Post message
      const postRes = (await executeTool("slack_post_message", {
        channel: "announcements",
        text: "Sprint 24 completed ahead of schedule! 🎉",
      })) as { executionMode: string; posted: boolean; channel: string; ts: string };
      expect(postRes.executionMode).toBe("MOCK");
      expect(postRes.posted).toBe(true);
      expect(postRes.channel).toBe("announcements");
    });
  });

  describe("C. Execution Logging & History", () => {
    it("logs tool executions to SQLite with duration, mode, and status", async () => {
      const testInput = { owner: "opencrewbot", repo: "test-repo" };
      await executeTool("github_inspect_repo", testInput, { botId: "bot-chief" });

      const logs = await getExecutionLogs({ toolId: "github_inspect_repo", limit: 5 });
      expect(logs.length).toBeGreaterThan(0);

      const latest = logs[0];
      expect(latest.toolId).toBe("github_inspect_repo");
      expect(latest.botId).toBe("bot-chief");
      expect(latest.status).toBe("success");
      expect(latest.executionMode).toBe("MOCK");
      expect(typeof latest.durationMs).toBe("number");
      expect(latest.createdAt).toBeDefined();
    });

    it("logs execution failures accurately with error details", async () => {
      await registerTool({
        id: "failing_tool",
        name: "Failing Tool",
        description: "Always throws an error",
        category: "execute",
        handler: async () => {
          throw new Error("Simulated system failure.");
        },
      });

      await expect(executeTool("failing_tool", {}, { botId: "bot-cipher" })).rejects.toThrow(
        "Simulated system failure.",
      );

      const logs = await getExecutionLogs({ toolId: "failing_tool", limit: 1 });
      expect(logs.length).toBe(1);
      expect(logs[0].status).toBe("error");
      expect(logs[0].error).toContain("Simulated system failure.");

      await unregisterTool("failing_tool");
    });
  });

  describe("D. Agent Access, Authorization & Scoping", () => {
    it("respects authorizedAgentIds restriction", async () => {
      await registerTool({
        id: "finance_secret_tool",
        name: "Finance Tool",
        description: "Only ledger can access this",
        category: "read",
        authorizedAgentIds: ["bot-ledger", "ledger"],
      });

      const allowedBot = { id: "bot-ledger", handle: "ledger", connections: [] } as unknown as Bot;
      const deniedBot = { id: "bot-scout", handle: "scout", connections: [] } as unknown as Bot;

      const allowedTools = await getToolsForBot(allowedBot);
      expect(allowedTools.some((t) => t.id === "finance_secret_tool")).toBe(true);

      const deniedTools = await getToolsForBot(deniedBot);
      expect(deniedTools.some((t) => t.id === "finance_secret_tool")).toBe(false);

      // Direct execution also enforces authorization
      await expect(
        executeTool("finance_secret_tool", {}, { botId: "bot-scout" }),
      ).rejects.toThrow(/not authorized to use tool/);

      await unregisterTool("finance_secret_tool");
    });

    it("excludes disabled tools from bot available toolset", async () => {
      await registerTool({
        id: "disabled_check_tool",
        name: "Check Tool",
        description: "Testing disabled exclusion",
        category: "read",
      });

      const bot = { id: "bot-chief", handle: "chief", connections: [] } as unknown as Bot;
      let tools = await getToolsForBot(bot);
      expect(tools.some((t) => t.id === "disabled_check_tool")).toBe(true);

      await disableTool("disabled_check_tool");
      tools = await getToolsForBot(bot);
      expect(tools.some((t) => t.id === "disabled_check_tool")).toBe(false);

      await unregisterTool("disabled_check_tool");
    });

    it("bumps registry version on tool registration, update, and deletion", async () => {
      const v0 = await toolRegistryVersion();

      await registerTool({
        id: "version_test_tool",
        name: "Version Tool",
        description: "Tests version bumping",
        category: "read",
      });
      const v1 = await toolRegistryVersion();
      expect(v1).toBeGreaterThan(v0);

      await disableTool("version_test_tool");
      const v2 = await toolRegistryVersion();
      expect(v2).toBeGreaterThan(v1);

      await unregisterTool("version_test_tool");
      const v3 = await toolRegistryVersion();
      expect(v3).toBeGreaterThan(v2);
    });
  });

  describe("E. Security & Human-in-the-Loop Permissions", () => {
    it("maps tool categories accurately according to safety levels", () => {
      // Read-only tools
      expect(toolCategory("github_inspect_repo")).toBe("read");
      expect(toolCategory("github_read_file")).toBe("read");
      expect(toolCategory("github_list_issues")).toBe("read");
      expect(toolCategory("gmail_search_emails")).toBe("read");
      expect(toolCategory("gmail_read_email")).toBe("read");
      expect(toolCategory("slack_search_messages")).toBe("read");
      expect(toolCategory("slack_read_channel")).toBe("read");

      // Mutating tools
      expect(toolCategory("github_create_issue")).toBe("edit");
      expect(toolCategory("gmail_create_draft")).toBe("edit");
      expect(toolCategory("gmail_send_email")).toBe("execute");
      expect(toolCategory("slack_post_message")).toBe("execute");
    });
  });

  describe("F. The Seven Required Demonstration Scenarios (Demos 1-7)", () => {
    // Demo 1: GitHub Repo Inspection
    it("Demo 1: GitHub repo inspection (read repo, files, and issues)", async () => {
      const repo = (await executeTool("github_inspect_repo", {
        owner: "deepmind",
        repo: "antigravity",
      })) as { fullName: string; stars: number; executionMode: string };
      expect(repo.executionMode).toBe("MOCK");
      expect(repo.fullName).toContain("antigravity");

      const file = (await executeTool("github_read_file", {
        owner: "deepmind",
        repo: "antigravity",
        path: "README.md",
      })) as { content: string };
      expect(file.content.length).toBeGreaterThan(0);

      const issues = (await executeTool("github_list_issues", {
        owner: "deepmind",
        repo: "antigravity",
      })) as { issues: unknown[] };
      expect(issues.issues.length).toBeGreaterThan(0);
    });

    // Demo 2: Gmail Search & Draft Without Sending
    it("Demo 2: Gmail search and draft without sending", async () => {
      const search = (await executeTool("gmail_search_emails", {
        query: "investor pitch deck",
      })) as { messages: Array<{ id: string }> };
      expect(search.messages.length).toBeGreaterThan(0);

      const draft = (await executeTool("gmail_create_draft", {
        to: "partner@sequoia.com",
        subject: "Updated Investor Deck",
        body: "Please find the revised deck draft attached.",
      })) as { draftId: string; draftCreated: boolean; executionMode: string };
      expect(draft.draftCreated).toBe(true);
      expect(draft.draftId).toBeDefined();

      // Verify that drafting does NOT execute sending
      const logs = await getExecutionLogs({ toolId: "gmail_send_email", limit: 5 });
      const recentSend = logs.find((l) => (l.input as { subject?: string })?.subject === "Updated Investor Deck");
      expect(recentSend).toBeUndefined();
    });

    // Demo 3: Slack Announcement Preview & Policy Check
    it("Demo 3: Slack announcement policy check (mutating action classified as execute)", async () => {
      // Must be classified as execute
      expect(toolCategory("slack_post_message")).toBe("execute");

      // Execution in mock mode works with explicit audit
      const post = (await executeTool("slack_post_message", {
        channel: "general",
        text: "All-hands briefing at 10:00 AM UTC.",
      })) as { posted: boolean; channel: string };
      expect(post.posted).toBe(true);
      expect(post.channel).toBe("general");

      const logs = await getExecutionLogs({ toolId: "slack_post_message", limit: 1 });
      expect(logs[0].status).toBe("success");
      expect(logs[0].executionMode).toBe("MOCK");
    });

    // Demo 4: Dynamic Tool Registration Without Code Changes
    it("Demo 4: Dynamic tool registration without code changes", async () => {
      const customToolId = "currency_converter";
      await registerTool({
        id: customToolId,
        name: "Currency Converter",
        description: "Converts USD to EUR at fixed rate.",
        category: "read",
        source: "custom",
        handler: async (input: unknown) => {
          const { amount } = input as { amount: number };
          return { converted: amount * 0.92, currency: "EUR" };
        },
      });

      const result = (await executeTool(customToolId, { amount: 100 })) as { converted: number; currency: string };
      expect(result.converted).toBe(92);
      expect(result.currency).toBe("EUR");

      // Verify it is listed in registry
      const tool = await getTool(customToolId);
      expect(tool).toBeDefined();
      expect(tool?.name).toBe("Currency Converter");

      await unregisterTool(customToolId);
    });

    // Demo 5: Tool Removal & Subsequent Execution Failure
    it("Demo 5: Tool removal & subsequent execution failure", async () => {
      const ephemeralToolId = "ephemeral_tool";
      await registerTool({
        id: ephemeralToolId,
        name: "Ephemeral Tool",
        description: "Exists briefly then removed",
        category: "read",
      });

      // Works before removal
      await expect(executeTool(ephemeralToolId, {})).resolves.toBeDefined();

      // Unregister tool
      await unregisterTool(ephemeralToolId);

      // Fails immediately after removal
      await expect(executeTool(ephemeralToolId, {})).rejects.toThrow(`Tool "${ephemeralToolId}" not found.`);
    });

    // Demo 6: Disconnection Security & Immediate Revocation
    it("Demo 6: Disconnection security & cached tool execution failure", async () => {
      // Initially connected
      const intg = getIntegration("slack");
      expect(intg).toBeDefined();

      // Disconnect Slack
      await disconnectIntegration("slack");
      const status = await intg!.getStatus();
      expect(status.status).toBe("disconnected");

      // Executing any slack tool must fail immediately
      await expect(
        executeTool("slack_post_message", { channel: "general", text: "Hello" }),
      ).rejects.toThrow(/Integration "slack" is disconnected or unavailable/);

      // Reconnect Slack to restore state
      await connectIntegration("slack");
      const restored = await intg!.getStatus();
      expect(restored.status).toBe("connected");
    });

    // Demo 7: Mock vs Live Distinction
    it("Demo 7: Explicit Mock vs Live distinction & no silent fallback", async () => {
      const github = getIntegration("github");
      const mode = await github!.getExecutionMode();
      expect(mode).toBe("MOCK");

      const res = (await executeTool("github_inspect_repo", {
        owner: "test",
        repo: "test",
      })) as { executionMode: string };

      // Result must explicitly state MOCK mode
      expect(res.executionMode).toBe("MOCK");

      // Verify status check accurately reports mode
      const status = await github!.getStatus();
      expect(status.executionMode).toBe("MOCK");
    });
  });
});
