import { describe, it, expect, beforeEach } from "vitest";
import { boot, createBot, seed } from "@/lib/server/service";
import * as store from "@/lib/server/db";
import {
  parseAgentRequest,
  createAgentFromNaturalLanguage,
  duplicateAgent,
  deactivateAgent,
  activateAgent,
  deleteAgentSafely,
} from "@/lib/server/agent-factory";
import { DEFAULT_AGENT_HANDLES } from "@/lib/server/workforce-defaults";
import { runTurn } from "@/lib/server/runtime";
import { taskEngine } from "@/lib/server/task-engine";
import { getTask } from "@/lib/server/task-store";
import type { Plan, Task, BotInput } from "@/lib/shared/types";

describe("Phase 3: Workforce Foundation (8 Agents, 4 Rooms & Dynamic Agent Factory)", () => {
  beforeEach(async () => {
    await boot();
  });

  describe("A. Default 8 Agents Seeding & Idempotency", () => {
    it("seeds exactly the eight default agents with distinct responsibilities", async () => {
      const bots = await store.listBots();
      const handles = bots.map((b) => b.handle);

      for (const expectedHandle of DEFAULT_AGENT_HANDLES) {
        expect(handles).toContain(expectedHandle);
      }

      // Check specific distinct agents
      const chief = bots.find((b) => b.handle === "chief");
      expect(chief).toBeDefined();
      expect(chief?.name).toBe("Chief");
      expect(chief?.title).toContain("Chief of Staff");
      expect(chief?.role).toContain("Task Orchestrator");
      expect(chief?.model).toBe("MiniMaxAI/MiniMax-M3");
      expect(chief?.approval).toBe("controlled");
      expect(chief?.status).toBe("active");
      expect(chief?.skills).toContain("orchestration");

      const scout = bots.find((b) => b.handle === "scout");
      expect(scout?.tools.webSearch).toBe(true);
      expect(scout?.skills).toContain("web_research");

      const quill = bots.find((b) => b.handle === "quill");
      expect(quill?.approval).toBe("full");
      expect(quill?.skills).toContain("technical_writing");

      const atlas = bots.find((b) => b.handle === "atlas");
      expect(atlas?.role).toContain("Systems Architect");

      const cipher = bots.find((b) => b.handle === "cipher");
      expect(cipher?.tools.codeMode).toBe(true);
      expect(cipher?.approval).toBe("ask");
      expect(cipher?.skills).toContain("security_audit");

      const ledger = bots.find((b) => b.handle === "ledger");
      expect(ledger?.role).toContain("Financial Analyst");
      expect(ledger?.approval).toBe("ask");

      const sentry = bots.find((b) => b.handle === "sentry");
      expect(sentry?.role).toContain("QA");
      expect(sentry?.approval).toBe("full");

      const chronos = bots.find((b) => b.handle === "chronos");
      expect(chronos?.role).toContain("Operations");
    });

    it("is completely idempotent when seed() is called multiple times", async () => {
      const beforeCount = (await store.listBots()).length;

      // Run seed again
      await seed();
      await seed();

      const afterCount = (await store.listBots()).length;
      expect(afterCount).toBe(beforeCount);
    });
  });

  describe("B. Four Collaboration Rooms Seeding", () => {
    it("seeds the four default collaboration rooms with correct leads and memberships", async () => {
      const rooms = await store.listRooms();
      const roomNames = rooms.map((r) => r.name);

      expect(roomNames).toContain("Strategy Room");
      expect(roomNames).toContain("Research Room");
      expect(roomNames).toContain("Engineering Room");
      expect(roomNames).toContain("Operations Room");

      const bots = await store.listBots();
      const botMap = new Map(bots.map((b) => [b.handle, b.id]));

      // Strategy Room
      const strategyRoom = rooms.find((r) => r.name === "Strategy Room");
      expect(strategyRoom).toBeDefined();
      expect(strategyRoom?.leadId).toBe(botMap.get("chief"));
      expect(strategyRoom?.memberIds).toContain(botMap.get("chief"));
      expect(strategyRoom?.memberIds).toContain(botMap.get("atlas"));
      expect(strategyRoom?.responder).toBe("auto");

      // Research Room
      const researchRoom = rooms.find((r) => r.name === "Research Room");
      expect(researchRoom?.leadId).toBe(botMap.get("scout"));
      expect(researchRoom?.memberIds).toContain(botMap.get("scout"));

      // Engineering Room
      const engineeringRoom = rooms.find((r) => r.name === "Engineering Room");
      expect(engineeringRoom?.leadId).toBe(botMap.get("atlas"));
      expect(engineeringRoom?.memberIds).toContain(botMap.get("cipher"));
      expect(engineeringRoom?.memberIds).toContain(botMap.get("sentry"));

      // Operations Room
      const operationsRoom = rooms.find((r) => r.name === "Operations Room");
      expect(operationsRoom?.leadId).toBe(botMap.get("chronos"));
      expect(operationsRoom?.memberIds).toContain(botMap.get("chronos"));
      expect(operationsRoom?.memberIds).toContain(botMap.get("ledger"));
    });
  });

  describe("C. Dynamic Agent Factory & Natural Language Parsing", () => {
    it("parses the canonical B2B SaaS social media strategist example", () => {
      const prompt =
        "Create a social media strategist who specializes in B2B SaaS campaigns, uses research and writing skills, and requires approval before external actions.";
      const res = parseAgentRequest(prompt);

      expect(res.success).toBe(true);
      if (!res.success) return;

      expect(res.spec.name).toContain("Social Media Strategist");
      expect(res.spec.role).toContain("B2B SaaS Campaigns");
      expect(res.spec.tools.webSearch).toBe(true);
      expect(res.spec.approval).toBe("ask");
      expect(res.spec.skills).toContain("writing");
      expect(res.spec.skills).toContain("web_research");
      expect(res.spec.instructions).toContain("B2B SaaS Campaigns");
    });

    it("parses arbitrary professions and capabilities", () => {
      const prompt =
        "Build a financial analyst who specializes in startup financial modelling, uses python scripts for unit economics, with full access";
      const res = parseAgentRequest(prompt);

      expect(res.success).toBe(true);
      if (!res.success) return;

      expect(res.spec.name).toContain("Financial Analyst");
      expect(res.spec.tools.codeMode).toBe(true);
      expect(res.spec.approval).toBe("full");
      expect(res.spec.skills).toContain("financial_analysis");
    });

    it("detects missing information and requests clarification for vague requests", () => {
      const vague1 = parseAgentRequest("create a bot");
      expect(vague1.success).toBe(false);
      if (vague1.success) return;
      expect(vague1.clarificationNeeded).toBe(true);
      expect(vague1.question).toBeDefined();

      const vague2 = parseAgentRequest("");
      expect(vague2.success).toBe(false);
    });

    it("creates, persists, and registers agent from natural language", async () => {
      const prompt =
        "Create a cybersecurity auditor named Sentinel who specializes in smart contract vulnerability analysis and requires approval before actions";
      const res = await createAgentFromNaturalLanguage(prompt);

      expect(res.success).toBe(true);
      if (!res.success) return;

      expect(res.bot.id).toBeDefined();
      expect(res.bot.name).toContain("Sentinel");
      expect(res.bot.approval).toBe("ask");
      expect(res.bot.role).toContain("Smart Contract Vulnerability Analysis");

      // Verify immediate persistence in database
      const fetched = await store.getBot(res.bot.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe(res.bot.name);
    });

    it("rejects invalid agent configurations", async () => {
      const invalidName: BotInput = {
        name: "", // Invalid empty name
        title: "Test",
        description: "Test description",
        instructions: "Test instructions",
        emoji: "🧪",
        color: "#000000",
        model: "mock",
        tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: false },
        connections: [],
        approval: "controlled",
        pinned: false,
      };

      await expect(createBot(invalidName)).rejects.toThrow(/A bot needs a name/i);

      const oversizedName: BotInput = {
        ...invalidName,
        name: "A".repeat(50), // Over 40 characters
      };
      await expect(createBot(oversizedName)).rejects.toThrow(/under 40 characters/i);
    });

    it("resolves duplicate handles automatically with numerical suffix", async () => {
      const botA = await createBot({
        name: "Test Handle Bot",
        handle: "test-handle",
        title: "Bot A",
        description: "First",
        instructions: "Do stuff",
        emoji: "🤖",
        color: "#111111",
        model: "mock",
        tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: false },
        connections: [],
        approval: "controlled",
        pinned: false,
      });

      expect(botA.handle).toBe("test-handle");

      const botB = await createBot({
        name: "Test Handle Bot Duplicate",
        handle: "test-handle", // Duplicate requested
        title: "Bot B",
        description: "Second",
        instructions: "Do stuff",
        emoji: "🤖",
        color: "#222222",
        model: "mock",
        tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: false },
        connections: [],
        approval: "controlled",
        pinned: false,
      });

      expect(botB.handle).toBe("test-handle2");
    });
  });

  describe("D. Agent Management: Edit, Duplicate, Deactivate & Delete Safeguards", () => {
    it("duplicates an existing agent cleanly", async () => {
      const bots = await store.listBots();
      const chief = bots.find((b) => b.handle === "chief")!;

      const copy = await duplicateAgent(chief.id, "Chief Clone");
      expect(copy.id).not.toBe(chief.id);
      expect(copy.name).toBe("Chief Clone");
      expect(copy.role).toBe(chief.role);
      expect(copy.instructions).toBe(chief.instructions);
      expect(copy.skills).toEqual(chief.skills);
    });

    it("deactivates and reactivates an agent", async () => {
      const custom = await createBot({
        name: "Toggle Bot",
        handle: "toggle-bot",
        title: "Toggle",
        description: "Toggle test",
        instructions: "Toggle instructions",
        emoji: "🎛️",
        color: "#333333",
        model: "mock",
        tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: false },
        connections: [],
        approval: "controlled",
        pinned: false,
      });

      expect(custom.status).toBe("active");

      const deactivated = await deactivateAgent(custom.id);
      expect(deactivated.status).toBe("inactive");
      expect(deactivated.pinned).toBe(false);

      const activated = await activateAgent(custom.id);
      expect(activated.status).toBe("active");
    });

    it("protects default workforce agents from accidental deletion", async () => {
      const bots = await store.listBots();
      const chief = bots.find((b) => b.handle === "chief")!;

      // Deleting default agent without force must be rejected
      await expect(deleteAgentSafely(chief.id)).rejects.toThrow(
        /default workforce agent and cannot be deleted/i,
      );
    });

    it("allows deleting custom agent safely and cleans up rooms", async () => {
      const custom = await createBot({
        name: "Temporary Agent",
        handle: "temp-agent",
        title: "Temp",
        description: "Temp description",
        instructions: "Temp instructions",
        emoji: "🗑️",
        color: "#444444",
        model: "mock",
        tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: false },
        connections: [],
        approval: "controlled",
        pinned: false,
      });

      // Add to a room
      const rooms = await store.listRooms();
      const room = rooms[0];
      await store.saveRoom({ ...room, memberIds: [...room.memberIds, custom.id] });

      // Delete safely
      await deleteAgentSafely(custom.id);

      const fetched = await store.getBot(custom.id);
      expect(fetched).toBeNull();

      // Verify removed from room
      const updatedRoom = await store.getRoom(room.id);
      expect(updatedRoom?.memberIds).not.toContain(custom.id);
    });
  });

  describe("E. Runtime & Task Engine Integration", () => {
    it("executes turns with all eight default workforce agents via existing runtime in mock mode", async () => {
      const bots = await store.listBots();
      for (const handle of DEFAULT_AGENT_HANDLES) {
        const agent = bots.find((b) => b.handle === handle);
        expect(agent).toBeDefined();

        const convId = `dm:${agent!.id}`;
        const reply = await runTurn({
          bot: agent!,
          conversationId: convId,
          content: `Test inquiry for ${agent!.name}`,
        });

        expect(reply).not.toBeNull();
        expect(reply?.status).toBe("done");
        expect(reply?.botId).toBe(agent!.id);
      }
    });

    it("assigns Phase 2 tasks to new workforce agents and executes successfully", async () => {
      const bots = await store.listBots();
      const ledger = bots.find((b) => b.handle === "ledger")!;

      const plan: Plan = {
        id: "plan-workforce-ledger",
        conversationId: "dm:test-ledger",
        goal: "Forecast 18-month burn rate",
        status: "running",
        taskIds: ["task-wf-ledger-1"],
        createdAt: new Date().toISOString(),
      };

      const task: Task = {
        id: "task-wf-ledger-1",
        planId: plan.id,
        stepIdentifier: "burn_model_step",
        assignedBotId: ledger.id,
        title: "Burn Rate Model",
        description: "Calculate runway under $40k/mo net burn scenario",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await taskEngine.submitPlan(plan, [task]);

      let attempts = 0;
      while (attempts < 30) {
        await new Promise((r) => setTimeout(r, 200));
        const t = await getTask(task.id);
        if (t?.status === "completed") break;
        attempts++;
      }

      const completed = await getTask(task.id);
      expect(completed?.status).toBe("completed");
      expect(completed?.output).toBeDefined();
    });

    it("fails task execution when assigned agent is deactivated/inactive", async () => {
      const inactiveBot = await createBot({
        name: "Dormant Bot",
        handle: "dormant-bot",
        title: "Dormant",
        description: "Dormant",
        instructions: "Do nothing",
        emoji: "💤",
        color: "#555555",
        model: "mock",
        tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: false },
        connections: [],
        approval: "controlled",
        pinned: false,
        status: "inactive",
      });

      const plan: Plan = {
        id: "plan-inactive-test",
        conversationId: "dm:test-inactive",
        goal: "Test inactive bot task assignment",
        status: "running",
        taskIds: ["task-inactive-1"],
        createdAt: new Date().toISOString(),
      };

      const task: Task = {
        id: "task-inactive-1",
        planId: plan.id,
        stepIdentifier: "inactive_step",
        assignedBotId: inactiveBot.id,
        title: "Inactive Task",
        description: "Should fail because agent is inactive",
        dependencies: [],
        status: "ready",
        retryCount: 2,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await taskEngine.submitPlan(plan, [task]);

      let attempts = 0;
      while (attempts < 30) {
        await new Promise((r) => setTimeout(r, 200));
        const t = await getTask(task.id);
        if (t?.status === "failed") break;
        attempts++;
      }

      const failedTask = await getTask(task.id);
      expect(failedTask?.status).toBe("failed");
      expect(failedTask?.error).toContain("is inactive");
    });
  });
});
