import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { boot, createBot } from "@/lib/server/service";
import * as store from "@/lib/server/db";
import {
  taskEngine,
  TaskEngine,
  MAX_GLOBAL_CONCURRENCY,
  MAX_PER_AGENT_CONCURRENCY,
} from "@/lib/server/task-engine";
import {
  createPlan,
  getPlan,
  saveTask,
  getTask,
  getTasksByPlan,
  claimReadyTask,
} from "@/lib/server/task-store";
import { runTurn, isBotActive } from "@/lib/server/runtime";
import type { Plan, Task, Bot } from "@/lib/shared/types";

describe("Phase 2: Autonomous Agent Dispatch & Safe Task Runtime", () => {
  let bots: Bot[] = [];

  beforeEach(async () => {
    await boot();
    taskEngine.shutdown();
    bots = await store.listBots();
    // Ensure we have at least 8 bots for concurrency testing
    while (bots.length < 8) {
      const idx = bots.length + 1;
      const b = await createBot({
        name: `Worker Bot ${idx}`,
        handle: `worker${idx}`,
        title: "Test Worker",
        description: `Worker ${idx} for testing`,
        instructions: "Do test work.",
        emoji: "🤖",
        color: "#10b981",
        model: "mock",
        tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: false },
        connections: [],
        approval: "full",
        pinned: false,
      });
      bots.push(b);
    }
  });

  afterEach(() => {
    taskEngine.shutdown();
  });

  describe("1. DAG Validation & Cycle Detection", () => {
    it("validates and accepts a clean linear DAG", () => {
      const engine = new TaskEngine();
      const tasks: Task[] = [
        {
          id: "task-1",
          planId: "plan-dag-1",
          stepIdentifier: "step-1",
          assignedBotId: bots[0].id,
          title: "Step 1",
          description: "First step",
          dependencies: [],
          status: "ready",
          retryCount: 0,
          maxRetries: 2,
          timeoutMs: 60000,
          approvalRequired: false,
          createdAt: new Date().toISOString(),
        },
        {
          id: "task-2",
          planId: "plan-dag-1",
          stepIdentifier: "step-2",
          assignedBotId: bots[1].id,
          title: "Step 2",
          description: "Second step",
          dependencies: ["task-1"],
          status: "pending",
          retryCount: 0,
          maxRetries: 2,
          timeoutMs: 60000,
          approvalRequired: false,
          createdAt: new Date().toISOString(),
        },
      ];

      expect(() => engine.validateDag(tasks)).not.toThrow();
    });

    it("rejects cyclic dependencies with a descriptive error", () => {
      const engine = new TaskEngine();
      const tasks: Task[] = [
        {
          id: "task-a",
          planId: "plan-cycle",
          stepIdentifier: "step-a",
          assignedBotId: bots[0].id,
          title: "Task A",
          description: "Depends on B",
          dependencies: ["task-b"],
          status: "pending",
          retryCount: 0,
          maxRetries: 2,
          timeoutMs: 60000,
          approvalRequired: false,
          createdAt: new Date().toISOString(),
        },
        {
          id: "task-b",
          planId: "plan-cycle",
          stepIdentifier: "step-b",
          assignedBotId: bots[1].id,
          title: "Task B",
          description: "Depends on A",
          dependencies: ["task-a"],
          status: "pending",
          retryCount: 0,
          maxRetries: 2,
          timeoutMs: 60000,
          approvalRequired: false,
          createdAt: new Date().toISOString(),
        },
      ];

      expect(() => engine.validateDag(tasks)).toThrow(/Cyclic dependency detected/i);
    });

    it("rejects self-referencing tasks", () => {
      const engine = new TaskEngine();
      const tasks: Task[] = [
        {
          id: "task-self",
          planId: "plan-self",
          stepIdentifier: "step-self",
          assignedBotId: bots[0].id,
          title: "Self Task",
          description: "Depends on itself",
          dependencies: ["task-self"],
          status: "pending",
          retryCount: 0,
          maxRetries: 2,
          timeoutMs: 60000,
          approvalRequired: false,
          createdAt: new Date().toISOString(),
        },
      ];

      expect(() => engine.validateDag(tasks)).toThrow(/Self-referencing dependency/i);
    });

    it("rejects missing prerequisite dependencies", () => {
      const engine = new TaskEngine();
      const tasks: Task[] = [
        {
          id: "task-orphan",
          planId: "plan-missing",
          stepIdentifier: "step-orphan",
          assignedBotId: bots[0].id,
          title: "Orphan Task",
          description: "Depends on non-existent task",
          dependencies: ["non-existent-task-id"],
          status: "pending",
          retryCount: 0,
          maxRetries: 2,
          timeoutMs: 60000,
          approvalRequired: false,
          createdAt: new Date().toISOString(),
        },
      ];

      expect(() => engine.validateDag(tasks)).toThrow(/depends on non-existent task/i);
    });

    it("rejects duplicate step_identifier within the same plan", () => {
      const engine = new TaskEngine();
      const tasks: Task[] = [
        {
          id: "task-s1",
          planId: "plan-dup-step",
          stepIdentifier: "duplicate-step",
          assignedBotId: bots[0].id,
          title: "Task 1",
          description: "Step 1",
          dependencies: [],
          status: "ready",
          retryCount: 0,
          maxRetries: 2,
          timeoutMs: 60000,
          approvalRequired: false,
          createdAt: new Date().toISOString(),
        },
        {
          id: "task-s2",
          planId: "plan-dup-step",
          stepIdentifier: "duplicate-step",
          assignedBotId: bots[1].id,
          title: "Task 2",
          description: "Step 2",
          dependencies: [],
          status: "ready",
          retryCount: 0,
          maxRetries: 2,
          timeoutMs: 60000,
          approvalRequired: false,
          createdAt: new Date().toISOString(),
        },
      ];

      expect(() => engine.validateDag(tasks)).toThrow(/Duplicate step_identifier/i);
    });
  });

  describe("2. Dependency Ordering & Sequential Execution", () => {
    it("executes prerequisite task first, feeds output to dependent task, and completes plan", async () => {
      const plan: Plan = {
        id: "plan-dep-exec",
        conversationId: "dm:test-dep",
        goal: "Analyze market and synthesize report",
        status: "running",
        taskIds: ["task-dep-1", "task-dep-2"],
        createdAt: new Date().toISOString(),
      };

      const task1: Task = {
        id: "task-dep-1",
        planId: plan.id,
        stepIdentifier: "step_research",
        assignedBotId: bots[0].id,
        title: "Research Phase",
        description: "Analyze market trends",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      const task2: Task = {
        id: "task-dep-2",
        planId: plan.id,
        stepIdentifier: "step_synthesis",
        assignedBotId: bots[1].id,
        title: "Synthesis Phase",
        description: "Synthesize executive report",
        dependencies: ["task-dep-1"],
        status: "pending",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await taskEngine.submitPlan(plan, [task1, task2]);

      // Wait for task 1 and task 2 to finish executing through mock runtime
      let attempts = 0;
      while (attempts < 40) {
        await new Promise((r) => setTimeout(r, 200));
        const t1 = await getTask("task-dep-1");
        const t2 = await getTask("task-dep-2");
        if (t1?.status === "completed" && t2?.status === "completed") break;
        attempts++;
      }

      const completed1 = await getTask("task-dep-1");
      const completed2 = await getTask("task-dep-2");
      expect(completed1?.status).toBe("completed");
      expect(completed1?.output).toBeDefined();
      expect(completed1?.completedAt).toBeDefined();

      expect(completed2?.status).toBe("completed");
      expect(completed2?.output).toBeDefined();
      expect(completed2?.completedAt).toBeDefined();

      const finalPlan = await getPlan(plan.id);
      expect(finalPlan?.status).toBe("completed");
      expect(finalPlan?.completedAt).toBeDefined();
    });
  });

  describe("3. Concurrency Scheduler & Invariants", () => {
    it("respects MAX_PER_AGENT_CONCURRENCY = 1 (serializes tasks assigned to the same agent)", async () => {
      const plan: Plan = {
        id: "plan-agent-serial",
        conversationId: "dm:test-serial",
        goal: "Run two tasks on the same agent",
        status: "running",
        taskIds: ["task-ser-1", "task-ser-2"],
        createdAt: new Date().toISOString(),
      };

      const sameBot = bots[0];

      const task1: Task = {
        id: "task-ser-1",
        planId: plan.id,
        stepIdentifier: "ser_step_1",
        assignedBotId: sameBot.id,
        title: "Same Bot Task 1",
        description: "First task on same bot",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      const task2: Task = {
        id: "task-ser-2",
        planId: plan.id,
        stepIdentifier: "ser_step_2",
        assignedBotId: sameBot.id,
        title: "Same Bot Task 2",
        description: "Second task on same bot (independent)",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await taskEngine.submitPlan(plan, [task1, task2]);

      // Check stats: active on this bot must be at most 1
      const stats = taskEngine.getStats();
      expect(stats.activeByAgent[sameBot.id] ?? 0).toBeLessThanOrEqual(MAX_PER_AGENT_CONCURRENCY);

      // Wait for both to complete sequentially
      let attempts = 0;
      while (attempts < 40) {
        await new Promise((r) => setTimeout(r, 200));
        const t1 = await getTask("task-ser-1");
        const t2 = await getTask("task-ser-2");
        if (t1?.status === "completed" && t2?.status === "completed") break;
        attempts++;
      }

      const t1 = await getTask("task-ser-1");
      const t2 = await getTask("task-ser-2");
      expect(t1?.status).toBe("completed");
      expect(t2?.status).toBe("completed");
    });

    it("runs different agents concurrently in parallel", async () => {
      const plan: Plan = {
        id: "plan-diff-agents",
        conversationId: "dm:test-parallel",
        goal: "Run tasks concurrently across different agents",
        status: "running",
        taskIds: ["task-par-1", "task-par-2"],
        createdAt: new Date().toISOString(),
      };

      const botA = bots[1];
      const botB = bots[2];

      const taskA: Task = {
        id: "task-par-1",
        planId: plan.id,
        stepIdentifier: "par_step_1",
        assignedBotId: botA.id,
        title: "Bot A Task",
        description: "Runs on bot A",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      const taskB: Task = {
        id: "task-par-2",
        planId: plan.id,
        stepIdentifier: "par_step_2",
        assignedBotId: botB.id,
        title: "Bot B Task",
        description: "Runs on bot B",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await taskEngine.submitPlan(plan, [taskA, taskB]);

      // Both should complete
      let attempts = 0;
      while (attempts < 40) {
        await new Promise((r) => setTimeout(r, 200));
        const a = await getTask("task-par-1");
        const b = await getTask("task-par-2");
        if (a?.status === "completed" && b?.status === "completed") break;
        attempts++;
      }

      expect((await getTask("task-par-1"))?.status).toBe("completed");
      expect((await getTask("task-par-2"))?.status).toBe("completed");
    });

    it("enforces MAX_GLOBAL_CONCURRENCY = 6", async () => {
      const plan: Plan = {
        id: "plan-concurrency-cap",
        conversationId: "dm:test-cap",
        goal: "Test global concurrency ceiling",
        status: "running",
        taskIds: [],
        createdAt: new Date().toISOString(),
      };

      // Submit 8 tasks across 8 different bots
      const tasks: Task[] = [];
      for (let i = 0; i < 8; i++) {
        const id = `task-cap-${i}`;
        plan.taskIds.push(id);
        tasks.push({
          id,
          planId: plan.id,
          stepIdentifier: `step_cap_${i}`,
          assignedBotId: bots[i].id,
          title: `Cap Task ${i}`,
          description: `Testing concurrency cap ${i}`,
          dependencies: [],
          status: "ready",
          retryCount: 0,
          maxRetries: 2,
          timeoutMs: 60000,
          approvalRequired: false,
          createdAt: new Date().toISOString(),
        });
      }

      await taskEngine.submitPlan(plan, tasks);

      const stats = taskEngine.getStats();
      expect(stats.activeGlobal).toBeLessThanOrEqual(MAX_GLOBAL_CONCURRENCY);

      // Eventually all 8 finish
      let attempts = 0;
      while (attempts < 50) {
        await new Promise((r) => setTimeout(r, 200));
        const planTasks = await getTasksByPlan(plan.id);
        if (planTasks.every((t) => t.status === "completed")) break;
        attempts++;
      }

      const allTasks = await getTasksByPlan(plan.id);
      expect(allTasks.filter((t) => t.status === "completed").length).toBe(8);
    });

    it("atomically claims a task and prevents duplicate claiming", async () => {
      const task: Task = {
        id: "task-atomic-engine",
        planId: "plan-atomic-e",
        stepIdentifier: "atomic_claim_step",
        assignedBotId: bots[0].id,
        title: "Atomic Test",
        description: "Checking race conditions",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await saveTask(task);

      const firstClaim = await claimReadyTask(task.id);
      expect(firstClaim).toBe(true);

      const secondClaim = await claimReadyTask(task.id);
      expect(secondClaim).toBe(false);
    });
  });

  describe("4. Interactive Conversation Protection", () => {
    it("prevents background task from executing while agent is busy with interactive turn", async () => {
      const bot = bots[3];
      const interactiveConv = `dm:${bot.id}`;

      // 1. Start an interactive turn using runTurn
      const interactiveTurn = runTurn({
        bot,
        conversationId: interactiveConv,
        content: "Interactive user message",
      });

      // Verify bot is detected as active in runtime
      expect(isBotActive(bot.id)).toBe(true);

      // 2. Submit a background task for the same bot
      const plan: Plan = {
        id: "plan-protect-interactive",
        conversationId: "dm:test-protect",
        goal: "Protection test",
        status: "running",
        taskIds: ["task-protect-1"],
        createdAt: new Date().toISOString(),
      };

      const task: Task = {
        id: "task-protect-1",
        planId: plan.id,
        stepIdentifier: "protect_step",
        assignedBotId: bot.id,
        title: "Protect Step",
        description: "Should not overlap with interactive turn",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await taskEngine.submitPlan(plan, [task]);

      // Background task must be queued, not executing while interactive turn is in flight
      const stats = taskEngine.getStats();
      expect(stats.activeByAgent[bot.id] ?? 0).toBe(0);

      // Let interactive turn resolve
      await interactiveTurn;

      // Now trigger scheduler tick and wait for background task to complete cleanly
      await taskEngine.schedulerTick();

      let attempts = 0;
      while (attempts < 30) {
        await new Promise((r) => setTimeout(r, 200));
        const t = await getTask(task.id);
        if (t?.status === "completed") break;
        attempts++;
      }

      const completedTask = await getTask(task.id);
      expect(completedTask?.status).toBe("completed");
    });
  });

  describe("5. Failure Handling, Retries & Timeouts", () => {
    it("retries a failing task up to maxRetries before transitioning to failed", async () => {
      const plan: Plan = {
        id: "plan-fail-retry",
        conversationId: "dm:test-fail",
        goal: "Test retries",
        status: "running",
        taskIds: ["task-retry-1"],
        createdAt: new Date().toISOString(),
      };

      // Assign to a non-existent bot to trigger execution failure
      const task: Task = {
        id: "task-retry-1",
        planId: plan.id,
        stepIdentifier: "fail_step",
        assignedBotId: "non-existent-bot-id",
        title: "Failing Task",
        description: "Will fail because bot doesn't exist",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 1, // Only 1 retry for fast testing
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await taskEngine.submitPlan(plan, [task]);

      let attempts = 0;
      while (attempts < 40) {
        await new Promise((r) => setTimeout(r, 300));
        const t = await getTask(task.id);
        if (t?.status === "failed") break;
        attempts++;
      }

      const failedTask = await getTask(task.id);
      expect(failedTask?.status).toBe("failed");
      expect(failedTask?.error).toContain("Max retries");
      expect(failedTask?.completedAt).toBeDefined();

      const failedPlan = await getPlan(plan.id);
      expect(failedPlan?.status).toBe("failed");
    });

    it("cascades failure to dependent tasks when a prerequisite fails", async () => {
      const plan: Plan = {
        id: "plan-cascade-fail",
        conversationId: "dm:test-cascade",
        goal: "Test failure cascading",
        status: "running",
        taskIds: ["task-cas-1", "task-cas-2"],
        createdAt: new Date().toISOString(),
      };

      const task1: Task = {
        id: "task-cas-1",
        planId: plan.id,
        stepIdentifier: "cas_step_1",
        assignedBotId: "non-existent-bot",
        title: "Root Failure",
        description: "Will fail",
        dependencies: [],
        status: "ready",
        retryCount: 1,
        maxRetries: 1, // Will fail immediately
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      const task2: Task = {
        id: "task-cas-2",
        planId: plan.id,
        stepIdentifier: "cas_step_2",
        assignedBotId: bots[0].id,
        title: "Dependent Task",
        description: "Should fail because prerequisite failed",
        dependencies: ["task-cas-1"],
        status: "pending",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await taskEngine.submitPlan(plan, [task1, task2]);

      let attempts = 0;
      while (attempts < 30) {
        await new Promise((r) => setTimeout(r, 200));
        const t2 = await getTask("task-cas-2");
        if (t2?.status === "failed") break;
        attempts++;
      }

      const t2 = await getTask("task-cas-2");
      expect(t2?.status).toBe("failed");
      expect(t2?.error).toContain("Prerequisite task");
    });
  });

  describe("6. Cancellation Propagation", () => {
    it("cancels parent plan, aborts running child tasks, and cancels pending tasks", async () => {
      const plan: Plan = {
        id: "plan-cancel-test",
        conversationId: "dm:test-cancel",
        goal: "Cancel all child tasks",
        status: "running",
        taskIds: ["task-canc-1", "task-canc-2"],
        createdAt: new Date().toISOString(),
      };

      const task1: Task = {
        id: "task-canc-1",
        planId: plan.id,
        stepIdentifier: "canc_step_1",
        assignedBotId: bots[0].id,
        title: "Running Task",
        description: "First task",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      const task2: Task = {
        id: "task-canc-2",
        planId: plan.id,
        stepIdentifier: "canc_step_2",
        assignedBotId: bots[1].id,
        title: "Pending Task",
        description: "Dependent task",
        dependencies: ["task-canc-1"],
        status: "pending",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await taskEngine.submitPlan(plan, [task1, task2]);

      // Cancel the plan
      await taskEngine.cancelPlan(plan.id);

      const cancelledPlan = await getPlan(plan.id);
      expect(cancelledPlan?.status).toBe("cancelled");

      const t1 = await getTask("task-canc-1");
      const t2 = await getTask("task-canc-2");
      expect(t1?.status).toBe("cancelled");
      expect(t2?.status).toBe("cancelled");
    });

    it("cancels individual task and cascades cancellation to dependent tasks", async () => {
      const plan: Plan = {
        id: "plan-task-cancel",
        conversationId: "dm:test-tcancel",
        goal: "Cancel single task",
        status: "running",
        taskIds: ["task-sing-1", "task-sing-2"],
        createdAt: new Date().toISOString(),
      };

      const task1: Task = {
        id: "task-sing-1",
        planId: plan.id,
        stepIdentifier: "sing_step_1",
        assignedBotId: bots[2].id,
        title: "Single Task 1",
        description: "Will be cancelled",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      const task2: Task = {
        id: "task-sing-2",
        planId: plan.id,
        stepIdentifier: "sing_step_2",
        assignedBotId: bots[3].id,
        title: "Single Task 2",
        description: "Dependent on single task 1",
        dependencies: ["task-sing-1"],
        status: "pending",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      await taskEngine.submitPlan(plan, [task1, task2]);

      // Cancel task 1 directly
      await taskEngine.cancelTask("task-sing-1");

      const t1 = await getTask("task-sing-1");
      const t2 = await getTask("task-sing-2");
      expect(t1?.status).toBe("cancelled");
      expect(t2?.status).toBe("cancelled");
    });
  });

  describe("7. Human Approval & Question Handling", () => {
    it("pauses task with approvalRequired: true in awaiting_approval and resumes when approved", async () => {
      const plan: Plan = {
        id: "plan-approval-gate",
        conversationId: "dm:test-appr",
        goal: "Approval test",
        status: "running",
        taskIds: ["task-appr-gate"],
        createdAt: new Date().toISOString(),
      };

      const task: Task = {
        id: "task-appr-gate",
        planId: plan.id,
        stepIdentifier: "appr_step",
        assignedBotId: bots[4].id,
        title: "Gated Task",
        description: "Requires approval before execution",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: true,
        createdAt: new Date().toISOString(),
      };

      await taskEngine.submitPlan(plan, [task]);

      // Wait a brief tick for the engine to claim and park it in awaiting_approval
      await new Promise((r) => setTimeout(r, 200));

      const parked = await getTask("task-appr-gate");
      expect(parked?.status).toBe("awaiting_approval");

      // Approve the task
      await taskEngine.approveTask("task-appr-gate");

      // Wait for it to complete
      let attempts = 0;
      while (attempts < 30) {
        await new Promise((r) => setTimeout(r, 200));
        const t = await getTask("task-appr-gate");
        if (t?.status === "completed") break;
        attempts++;
      }

      const completed = await getTask("task-appr-gate");
      expect(completed?.status).toBe("completed");
    });

    it("cancels task and cascades cancellation when rejected", async () => {
      const plan: Plan = {
        id: "plan-reject-gate",
        conversationId: "dm:test-reject",
        goal: "Rejection test",
        status: "running",
        taskIds: ["task-rej-gate"],
        createdAt: new Date().toISOString(),
      };

      const task: Task = {
        id: "task-rej-gate",
        planId: plan.id,
        stepIdentifier: "rej_step",
        assignedBotId: bots[5].id,
        title: "Rejected Task",
        description: "Will be rejected",
        dependencies: [],
        status: "ready",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: true,
        createdAt: new Date().toISOString(),
      };

      await taskEngine.submitPlan(plan, [task]);
      await new Promise((r) => setTimeout(r, 200));

      // Reject the task
      await taskEngine.rejectTask("task-rej-gate");

      const rejected = await getTask("task-rej-gate");
      expect(rejected?.status).toBe("cancelled");
      expect(rejected?.error).toContain("rejected");
    });
  });

  describe("8. Startup Crash Recovery", () => {
    it("recovers interrupted tasks, re-enqueues ready tasks, and preserves approval & terminal tasks", async () => {
      // 1. Create interrupted running task
      const stuckTask: Task = {
        id: "task-stuck-reboot",
        planId: "plan-reboot-rec",
        stepIdentifier: "stuck_step",
        assignedBotId: bots[0].id,
        title: "Stuck Task",
        description: "Interrupted mid-flight",
        dependencies: [],
        status: "running",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      // 2. Create task awaiting approval
      const approvalTask: Task = {
        id: "task-appr-reboot",
        planId: "plan-reboot-rec",
        stepIdentifier: "appr_step_reboot",
        assignedBotId: bots[1].id,
        title: "Approval Task",
        description: "Must remain awaiting approval",
        dependencies: [],
        status: "awaiting_approval",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        approvalRequired: true,
        createdAt: new Date().toISOString(),
      };

      // 3. Create completed terminal task
      const doneTask: Task = {
        id: "task-done-reboot",
        planId: "plan-reboot-rec",
        stepIdentifier: "done_step_reboot",
        assignedBotId: bots[2].id,
        title: "Done Task",
        description: "Already completed",
        dependencies: [],
        status: "completed",
        retryCount: 0,
        maxRetries: 2,
        timeoutMs: 60000,
        output: "Finished output",
        approvalRequired: false,
        createdAt: new Date().toISOString(),
      };

      const plan: Plan = {
        id: "plan-reboot-rec",
        conversationId: "dm:test-rec",
        goal: "Recovery plan",
        status: "running",
        taskIds: [stuckTask.id, approvalTask.id, doneTask.id],
        createdAt: new Date().toISOString(),
      };

      await createPlan(plan);
      await saveTask(stuckTask);
      await saveTask(approvalTask);
      await saveTask(doneTask);

      // Run recovery
      const res = await taskEngine.init();

      expect(res.recovered).toBeGreaterThanOrEqual(1);

      // Verify stuck task transitioned to ready with incremented retry count
      const recoveredStuck = await getTask(stuckTask.id);
      expect(["ready", "running", "completed"]).toContain(recoveredStuck?.status);
      expect(recoveredStuck?.retryCount).toBeGreaterThanOrEqual(1);

      // Verify awaiting_approval was preserved untouched
      const preservedApproval = await getTask(approvalTask.id);
      expect(preservedApproval?.status).toBe("awaiting_approval");

      // Verify completed terminal task was preserved untouched
      const preservedDone = await getTask(doneTask.id);
      expect(preservedDone?.status).toBe("completed");
    });
  });
});
