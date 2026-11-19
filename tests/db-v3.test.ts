import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createClient } from "@libsql/client";
import { db, migrate } from "@/lib/server/db";
import {
  createPlan,
  getPlan,
  getPlanByIdempotencyKey,
  saveTask,
  getTask,
  getTasksByPlan,
  updateTaskStatus,
  claimReadyTask,
  recoverStuckTasks,
} from "@/lib/server/task-store";
import type { Plan, Task, Bot, Room, ChatMessage } from "@/lib/shared/types";

describe("Phase 1: Database Schema v3 & Persistent Task Storage", () => {
  describe("1 & 2 & 3: Fresh Database & Schema v2 Migration & Data Preservation", () => {
    it("creates schema v3 tables and indexes on fresh database", async () => {
      const client = await db();
      expect(client).toBeDefined();

      const tables = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('bots', 'rooms', 'messages', 'settings', 'conversations', 'plans', 'tasks')"
      );
      expect(tables.rows.length).toBe(7);

      const indexes = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('plans_by_conv', 'plans_by_idempotency', 'tasks_by_plan', 'tasks_by_bot')"
      );
      expect(indexes.rows.length).toBe(4);
    });

    it("safely migrates an existing schema v2 database to v3 preserving all data", async () => {
      // 1. Create an isolated directory with raw schema v2
      const v2Dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencrewbot-v2-test-"));
      const v2DbPath = path.resolve(v2Dir, "opencrewbot.db");
      const v2Client = createClient({ url: `file:${v2DbPath}` });

      // Run exact schema v2 batch
      await v2Client.batch(
        [
          "CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
          "CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
          `CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            data TEXT NOT NULL
          )`,
          "CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, created_at)",
          "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)",
          `CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            generation INTEGER NOT NULL DEFAULT 0,
            last_read_at TEXT
          )`,
        ],
        "write"
      );

      // Seed with existing v2 data
      const v2Bot: Bot = {
        id: "v2-bot-1",
        name: "Legacy Bot",
        handle: "legacy",
        title: "V2 Legacy",
        description: "Created in schema v2",
        instructions: "Do legacy tasks.",
        emoji: "📦",
        color: "#999999",
        model: "MiniMaxAI/MiniMax-M3",
        tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: true },
        connections: [],
        approval: "ask",
        pinned: true,
        createdAt: "2026-10-01T00:00:00.000Z",
      };
      await v2Client.execute({
        sql: "INSERT INTO bots (id, data) VALUES (?, ?)",
        args: [v2Bot.id, JSON.stringify(v2Bot)],
      });

      const v2Room: Room = {
        id: "v2-room-1",
        name: "Legacy Room",
        topic: "V2 Discussion",
        emoji: "🏛️",
        memberIds: [v2Bot.id],
        leadId: v2Bot.id,
        responder: "lead",
        pinned: false,
        createdAt: "2026-10-01T00:00:00.000Z",
      };
      await v2Client.execute({
        sql: "INSERT INTO rooms (id, data) VALUES (?, ?)",
        args: [v2Room.id, JSON.stringify(v2Room)],
      });

      const v2Msg: ChatMessage = {
        id: "v2-msg-1",
        conversationId: `dm:${v2Bot.id}`,
        role: "user",
        createdAt: "2026-10-01T00:05:00.000Z",
        status: "done",
        parts: [{ kind: "text", text: "Legacy message in v2" }],
      };
      await v2Client.execute({
        sql: "INSERT INTO messages (id, conversation_id, created_at, data) VALUES (?, ?, ?, ?)",
        args: [v2Msg.id, v2Msg.conversationId, v2Msg.createdAt, JSON.stringify(v2Msg)],
      });

      // 2. Migrate the v2 database to v3 using migrate()
      await migrate(v2Client);

      // 3. Verify new v3 tables exist
      const plansTable = await v2Client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='plans'"
      );
      const tasksTable = await v2Client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"
      );
      expect(plansTable.rows.length).toBe(1);
      expect(tasksTable.rows.length).toBe(1);

      // Verify indexes exist
      const indexes = await v2Client.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('plans_by_conv', 'plans_by_idempotency', 'tasks_by_plan', 'tasks_by_bot')"
      );
      expect(indexes.rows.length).toBe(4);

      // 4. Verify existing v2 data survived migration intact
      const botRow = await v2Client.execute({
        sql: "SELECT data FROM bots WHERE id = ?",
        args: [v2Bot.id],
      });
      expect(botRow.rows.length).toBe(1);
      const fetchedBot = JSON.parse(botRow.rows[0].data as string) as Bot;
      expect(fetchedBot.name).toBe("Legacy Bot");

      const roomRow = await v2Client.execute({
        sql: "SELECT data FROM rooms WHERE id = ?",
        args: [v2Room.id],
      });
      expect(roomRow.rows.length).toBe(1);
      const fetchedRoom = JSON.parse(roomRow.rows[0].data as string) as Room;
      expect(fetchedRoom.name).toBe("Legacy Room");

      const msgRow = await v2Client.execute({
        sql: "SELECT data FROM messages WHERE id = ?",
        args: [v2Msg.id],
      });
      expect(msgRow.rows.length).toBe(1);
      const fetchedMsg = JSON.parse(msgRow.rows[0].data as string) as ChatMessage;
      expect(fetchedMsg.id).toBe("v2-msg-1");

      // 5. Test idempotency: calling migrate again on an already upgraded database succeeds
      await expect(migrate(v2Client)).resolves.not.toThrow();

      await v2Client.close();
      try {
        fs.rmSync(v2Dir, { recursive: true, force: true });
      } catch {
        // Windows SQLite file locks may delay deletion until process exit
      }
    });
  });

  describe("4 & 14: Plan Creation, Retrieval & Idempotency Key", () => {
    it("creates and retrieves a plan record", async () => {
      const plan: Plan = {
        id: "plan-1",
        conversationId: "room:war-room",
        goal: "Analyze Q3 financial models",
        status: "planning",
        taskIds: ["task-a", "task-b"],
        idempotencyKey: "idem-key-12345",
        createdAt: new Date().toISOString(),
      };

      await createPlan(plan);

      const retrieved = await getPlan("plan-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe("plan-1");
      expect(retrieved?.goal).toBe("Analyze Q3 financial models");
      expect(retrieved?.taskIds).toEqual(["task-a", "task-b"]);
      expect(retrieved?.idempotencyKey).toBe("idem-key-12345");
    });

    it("retrieves an existing plan by idempotency key", async () => {
      const plan = await getPlanByIdempotencyKey("idem-key-12345");
      expect(plan).not.toBeNull();
      expect(plan?.id).toBe("plan-1");
    });

    it("returns null for non-existent plan ID or idempotency key", async () => {
      expect(await getPlan("missing-plan-id")).toBeNull();
      expect(await getPlanByIdempotencyKey("missing-idem-key")).toBeNull();
    });
  });

  describe("5 & 6 & 7: Task Creation, Retrieval, Dependencies & Multi-Task Plans", () => {
    it("saves and retrieves multiple tasks with dependencies belonging to one plan", async () => {
      const task1: Task = {
        id: "t-1",
        planId: "plan-multi",
        stepIdentifier: "step_1_research",
        assignedBotId: "scout-1",
        title: "Market research",
        description: "Scrape competitor benchmarks",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: "2026-11-18T10:00:00.000Z",
      };

      const task2: Task = {
        id: "t-2",
        planId: "plan-multi",
        stepIdentifier: "step_2_analysis",
        assignedBotId: "ledger-1",
        title: "Financial modeling",
        description: "Build 18-month burn model",
        dependencies: ["t-1"], // Dependent on task 1
        status: "pending",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: true,
        createdAt: "2026-11-18T10:00:01.000Z",
      };

      await saveTask(task1);
      await saveTask(task2);

      const fetched1 = await getTask("t-1");
      expect(fetched1).not.toBeNull();
      expect(fetched1?.dependencies).toEqual([]);
      expect(fetched1?.status).toBe("ready");

      const fetched2 = await getTask("t-2");
      expect(fetched2).not.toBeNull();
      expect(fetched2?.dependencies).toEqual(["t-1"]);
      expect(fetched2?.status).toBe("pending");

      const planTasks = await getTasksByPlan("plan-multi");
      expect(planTasks.length).toBe(2);
      expect(planTasks[0].id).toBe("t-1");
      expect(planTasks[1].id).toBe("t-2");
    });
  });

  describe("8: Unique Constraint on (plan_id, step_identifier)", () => {
    it("rejects duplicate step_identifier within the same plan", async () => {
      const taskA: Task = {
        id: "task-unique-a",
        planId: "plan-unique-test",
        stepIdentifier: "step_alpha",
        assignedBotId: "bot1",
        title: "First Task",
        description: "Initial task",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await saveTask(taskA);

      // Attempt to insert another task with different ID but identical (planId, stepIdentifier)
      const taskB: Task = {
        id: "task-unique-b",
        planId: "plan-unique-test",
        stepIdentifier: "step_alpha", // COLLISION
        assignedBotId: "bot2",
        title: "Duplicate Step Task",
        description: "Colliding task",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await expect(saveTask(taskB)).rejects.toThrow();
    });
  });

  describe("9 & 10: Task Status Updates & Atomic Task Claiming", () => {
    it("updates task status, completedAt timestamp, and output", async () => {
      const task: Task = {
        id: "t-update",
        planId: "plan-up",
        stepIdentifier: "step_up",
        assignedBotId: "bot-up",
        title: "Update Test",
        description: "Testing status updates",
        dependencies: [],
        status: "running",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await saveTask(task);

      await updateTaskStatus("t-update", "completed", "Generated executive briefing.");

      const updated = await getTask("t-update");
      expect(updated?.status).toBe("completed");
      expect(updated?.output).toBe("Generated executive briefing.");
      expect(updated?.completedAt).toBeDefined();
    });

    it("atomically claims a ready task exactly once", async () => {
      const task: Task = {
        id: "t-atomic-claim",
        planId: "plan-atomic",
        stepIdentifier: "step_claim",
        assignedBotId: "bot-claim",
        title: "Atomic Claim",
        description: "Testing concurrent claiming",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await saveTask(task);

      // First claim should succeed
      const firstClaim = await claimReadyTask("t-atomic-claim");
      expect(firstClaim).toBe(true);

      // Task status should now be 'running'
      const inDb = await getTask("t-atomic-claim");
      expect(inDb?.status).toBe("running");
      expect(inDb?.startedAt).toBeDefined();

      // Subsequent concurrent claim must fail
      const secondClaim = await claimReadyTask("t-atomic-claim");
      expect(secondClaim).toBe(false);
    });
  });

  describe("11 & 12 & 13: Interrupted Task Recovery & State Invariants", () => {
    it("recovers interrupted running task with retries left to 'ready'", async () => {
      const runningTask: Task = {
        id: "t-recoverable",
        planId: "plan-recover",
        stepIdentifier: "step_recover",
        assignedBotId: "bot-rec",
        title: "Interrupted Task",
        description: "Interrupted mid-turn",
        dependencies: [],
        status: "running",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };
      await saveTask(runningTask);

      const result = await recoverStuckTasks();
      expect(result.recovered).toBeGreaterThanOrEqual(1);

      const recovered = await getTask("t-recoverable");
      expect(recovered?.status).toBe("ready");
      expect(recovered?.retryCount).toBe(1);
      expect(recovered?.error).toContain("Interrupted by server reboot. Retrying.");
    });

    it("fails interrupted running task that reached max retries", async () => {
      const exhaustedTask: Task = {
        id: "t-exhausted",
        planId: "plan-recover",
        stepIdentifier: "step_exhausted",
        assignedBotId: "bot-rec",
        title: "Exhausted Task",
        description: "Cannot retry anymore",
        dependencies: [],
        status: "running",
        retryCount: 2, // At max
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };
      await saveTask(exhaustedTask);

      await recoverStuckTasks();

      const failed = await getTask("t-exhausted");
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toContain("Max retries exceeded");
      expect(failed?.completedAt).toBeDefined();
    });

    it("preserves tasks in awaiting_approval without modifying them", async () => {
      const approvalTask: Task = {
        id: "t-approval-stay",
        planId: "plan-recover",
        stepIdentifier: "step_approval",
        assignedBotId: "bot-rec",
        title: "Approval Task",
        description: "Must stay awaiting approval on reboot",
        dependencies: [],
        status: "awaiting_approval",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: true,
        createdAt: new Date().toISOString(),
      };
      await saveTask(approvalTask);

      await recoverStuckTasks();

      const stillApproval = await getTask("t-approval-stay");
      expect(stillApproval?.status).toBe("awaiting_approval");
      expect(stillApproval?.error).toBeUndefined();
    });

    it("preserves completed and cancelled tasks as terminal", async () => {
      const completedTask: Task = {
        id: "t-terminal-comp",
        planId: "plan-recover",
        stepIdentifier: "step_terminal_comp",
        assignedBotId: "bot-rec",
        title: "Done Task",
        description: "Already completed",
        dependencies: [],
        status: "completed",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        output: "All good",
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      const cancelledTask: Task = {
        id: "t-terminal-canc",
        planId: "plan-recover",
        stepIdentifier: "step_terminal_canc",
        assignedBotId: "bot-rec",
        title: "Cancelled Task",
        description: "Stopped by user",
        dependencies: [],
        status: "cancelled",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await saveTask(completedTask);
      await saveTask(cancelledTask);

      await recoverStuckTasks();

      expect((await getTask("t-terminal-comp"))?.status).toBe("completed");
      expect((await getTask("t-terminal-canc"))?.status).toBe("cancelled");
    });
  });
});
