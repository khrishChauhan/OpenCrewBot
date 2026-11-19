// OpenCrewBot 2.0 Autonomous Task Engine
// Implements global concurrency scheduling (max 6), per-agent serialization (max 1),
// interactive conversation protection, DAG dependency management, timeout handling,
// exponential retry backoff, reliable cancellation propagation, and startup recovery.

import type { Plan, Task, TaskStatus } from "@/lib/shared/types";
import { getBot } from "./db";
import {
  createPlan,
  getPlan,
  getTask,
  getTasksByPlan,
  listPlans,
  saveTask,
  updateTaskStatus,
  claimReadyTask,
  recoverStuckTasks,
} from "./task-store";
import {
  runTurn,
  stopConversation,
  respondToApproval,
  answerQuestion,
  isBotActive,
} from "./runtime";

export const MAX_GLOBAL_CONCURRENCY = 6;
export const MAX_PER_AGENT_CONCURRENCY = 1;
export const DEFAULT_TASK_TIMEOUT_MS = 60000;
export const DEFAULT_MAX_RETRIES = 2;

export interface TaskEngineStats {
  activeGlobal: number;
  activeByAgent: Record<string, number>;
  queuedGlobal: number;
  queuedByAgent: Record<string, number>;
  activePlanIds: string[];
}

interface ActiveExecution {
  taskId: string;
  planId: string;
  botId: string;
  conversationId: string;
  startedAt: number;
  timeoutTimer?: NodeJS.Timeout;
}

export class TaskEngine {
  private activeExecutions = new Map<string, ActiveExecution>(); // taskId -> ActiveExecution
  private activeByBot = new Map<string, string>(); // botId -> taskId
  private agentQueues = new Map<string, Task[]>(); // botId -> FIFO queue of Tasks
  private planOrder: string[] = []; // for fair round-robin scheduling across plans
  private running = false;
  private tickInProgress = false;

  constructor() {
    this.running = true;
  }

  // ── DAG & Dependency Management ──────────────────────────────────────────

  /**
   * Validates that tasks in a plan form a valid Directed Acyclic Graph (DAG).
   * Rejects cycles, unknown dependencies, and self-referencing tasks.
   */
  validateDag(tasks: Task[]): void {
    const taskIds = new Set(tasks.map((t) => t.id));

    // Check unique step identifiers within the plan
    const stepIds = new Set<string>();
    for (const task of tasks) {
      if (stepIds.has(task.stepIdentifier)) {
        throw new Error(`Duplicate step_identifier within plan: ${task.stepIdentifier}`);
      }
      stepIds.add(task.stepIdentifier);
    }

    // Check all dependencies exist within the plan
    for (const task of tasks) {
      for (const depId of task.dependencies) {
        if (depId === task.id) {
          throw new Error(`Self-referencing dependency detected on task ${task.id}`);
        }
        if (!taskIds.has(depId)) {
          throw new Error(`Task ${task.id} depends on non-existent task ${depId}`);
        }
      }
    }

    // Depth-First Search cycle detection
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const taskMap = new Map(tasks.map((t) => [t.id, t]));

    const checkCycle = (currId: string, path: string[]) => {
      if (visiting.has(currId)) {
        throw new Error(`Cyclic dependency detected: ${[...path, currId].join(" -> ")}`);
      }
      if (visited.has(currId)) return;

      visiting.add(currId);
      const task = taskMap.get(currId);
      if (task) {
        for (const depId of task.dependencies) {
          checkCycle(depId, [...path, currId]);
        }
      }
      visiting.delete(currId);
      visited.add(currId);
    };

    for (const task of tasks) {
      if (!visited.has(task.id)) {
        checkCycle(task.id, []);
      }
    }
  }

  // ── Plan & Task Submission ───────────────────────────────────────────────

  /**
   * Submits a new multi-agent plan and its constituent tasks.
   * Validates the DAG, persists records to DB, and enqueues root ready tasks.
   */
  async submitPlan(plan: Plan, tasks: Task[]): Promise<Plan> {
    this.running = true;
    this.validateDag(tasks);

    // Save plan
    await createPlan(plan);

    // Initialize tasks and save to DB
    for (const task of tasks) {
      const isReady = task.dependencies.length === 0;
      task.status = isReady ? "ready" : "pending";
      task.retryCount = task.retryCount ?? 0;
      task.maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES;
      task.timeoutMs = task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
      await saveTask(task);
    }

    if (!this.planOrder.includes(plan.id)) {
      this.planOrder.push(plan.id);
    }

    // Enqueue ready tasks into agent FIFO queues
    for (const task of tasks) {
      if (task.status === "ready") {
        this.enqueueTask(task);
      }
    }

    // Trigger scheduler
    void this.schedulerTick();

    return plan;
  }

  private enqueueTask(task: Task) {
    const queue = this.agentQueues.get(task.assignedBotId) ?? [];
    if (!queue.some((t) => t.id === task.id)) {
      queue.push(task);
      this.agentQueues.set(task.assignedBotId, queue);
    }
  }

  // ── Global Concurrency Scheduler ─────────────────────────────────────────

  /**
   * Scheduler tick:
   * 1. Honors max 6 global concurrent turns.
   * 2. Honors max 1 active turn per agent.
   * 3. Protects interactive conversations: skips agents currently busy in runtime.
   * 4. Enforces fair round-robin scheduling across multiple plans.
   * 5. Atomically claims tasks via task-store conditional SQL update.
   */
  async schedulerTick(): Promise<void> {
    if (!this.running || this.tickInProgress) return;
    this.tickInProgress = true;

    try {
      let dispatchedAny = true;

      while (dispatchedAny && this.activeExecutions.size < MAX_GLOBAL_CONCURRENCY) {
        dispatchedAny = false;

        // Collect distinct plans that have tasks in agent queues
        const activePlans = this.planOrder.filter((planId) => {
          for (const queue of this.agentQueues.values()) {
            if (queue.some((t) => t.planId === planId)) return true;
          }
          return false;
        });

        if (activePlans.length === 0) break;

        // Fair round-robin across active plans
        for (const planId of activePlans) {
          if (this.activeExecutions.size >= MAX_GLOBAL_CONCURRENCY) break;

          // Find candidate task in this plan where assigned agent is free
          let candidateTask: Task | undefined;
          let candidateBotId: string | undefined;

          for (const [botId, queue] of this.agentQueues.entries()) {
            // Agent must be completely idle in background AND not active in interactive runtime
            if (this.activeByBot.has(botId) || isBotActive(botId)) {
              continue;
            }

            const taskIndex = queue.findIndex((t) => t.planId === planId);
            if (taskIndex !== -1) {
              candidateTask = queue[taskIndex];
              candidateBotId = botId;
              break;
            }
          }

          if (candidateTask && candidateBotId) {
            // Attempt atomic claim from DB
            const claimed = await claimReadyTask(candidateTask.id);

            // Remove from queue regardless (if claim failed, it's not ready)
            const queue = this.agentQueues.get(candidateBotId) ?? [];
            const idx = queue.findIndex((t) => t.id === candidateTask!.id);
            if (idx !== -1) queue.splice(idx, 1);
            if (queue.length === 0) this.agentQueues.delete(candidateBotId);

            if (claimed) {
              // Track active execution
              const conversationId = `task:${candidateTask.id}`;
              const execution: ActiveExecution = {
                taskId: candidateTask.id,
                planId: candidateTask.planId,
                botId: candidateBotId,
                conversationId,
                startedAt: Date.now(),
              };

              this.activeExecutions.set(candidateTask.id, execution);
              this.activeByBot.set(candidateBotId, candidateTask.id);
              dispatchedAny = true;

              // Rotate planOrder for fairness
              const pIdx = this.planOrder.indexOf(planId);
              if (pIdx !== -1) {
                this.planOrder.splice(pIdx, 1);
                this.planOrder.push(planId);
              }

              // Dispatch execution asynchronously
              void this.executeTask(candidateTask, execution);
              break; // evaluate next round-robin turn
            }
          }
        }
      }
    } finally {
      this.tickInProgress = false;
    }
  }

  // ── Task Dispatcher & Execution ──────────────────────────────────────────

  private async executeTask(task: Task, execution: ActiveExecution): Promise<void> {
    try {
      const bot = await getBot(task.assignedBotId);
      if (!bot) {
        await updateTaskStatus(
          task.id,
          "failed",
          undefined,
          `Assigned bot '${task.assignedBotId}' not found.`,
        );
        await this.handleTaskFailure(task, "Assigned bot not found.");
        return;
      }

      if (bot.status === "inactive") {
        const errorMsg = `Assigned agent '${bot.name}' is inactive.`;
        await updateTaskStatus(task.id, "failed", undefined, errorMsg);
        await this.handleTaskFailure(task, errorMsg);
        return;
      }

      // Pre-execution approval gating if flagged on task
      if (task.approvalRequired) {
        await updateTaskStatus(task.id, "awaiting_approval");
        this.cleanupExecution(task.id, task.assignedBotId);
        void this.schedulerTick();
        return;
      }

      // Fetch parent plan for context
      const plan = await getPlan(task.planId);

      // Gather prerequisite task outputs
      let prerequisiteContext = "";
      if (task.dependencies.length > 0) {
        const prereqTasks = await Promise.all(task.dependencies.map((dId) => getTask(dId)));
        const sections = prereqTasks
          .filter((p): p is Task => Boolean(p))
          .map((p) => `--- Output from prerequisite [${p.title}] ---\n${p.output || "(no text output)"}`);
        if (sections.length > 0) {
          prerequisiteContext = `\n\nPrerequisite Context:\n${sections.join("\n\n")}`;
        }
      }

      const prompt = [
        `[Autonomous Workforce Task: "${task.title}"]`,
        `Plan Goal: ${plan?.goal || "(independent task)"}`,
        `Step: ${task.stepIdentifier}`,
        `Instructions: ${task.description}`,
        prerequisiteContext,
        "\nProvide your complete analysis or solution for this step.",
      ].join("\n");

      // Setup timeout timer
      const timeoutMs = task.timeoutMs || DEFAULT_TASK_TIMEOUT_MS;
      execution.timeoutTimer = setTimeout(async () => {
        await this.handleTaskTimeout(task.id);
      }, timeoutMs);

      // Dispatch turn through runtime
      const reply = await runTurn({
        bot,
        conversationId: execution.conversationId,
        content: prompt,
      });

      // Clear timeout
      if (execution.timeoutTimer) {
        clearTimeout(execution.timeoutTimer);
        execution.timeoutTimer = undefined;
      }

      // Check current task status in case it was cancelled while running
      const currentTask = await getTask(task.id);
      if (!currentTask || currentTask.status === "cancelled") {
        this.cleanupExecution(task.id, task.assignedBotId);
        void this.schedulerTick();
        return;
      }

      if (!reply) {
        // Stopped by stopConversation before it began
        await updateTaskStatus(task.id, "cancelled", undefined, "Task execution stopped.");
        this.cleanupExecution(task.id, task.assignedBotId);
        void this.schedulerTick();
        return;
      }

      // Check if turn was suspended for human approval or question
      const isSuspended = reply.parts.some(
        (p) =>
          (p.kind === "question" && p.answer === undefined) ||
          (p.kind === "tool" && p.status === "awaiting-approval"),
      );

      if (isSuspended) {
        await updateTaskStatus(task.id, "awaiting_approval");
        this.cleanupExecution(task.id, task.assignedBotId);
        void this.schedulerTick();
        return;
      }

      if (reply.status === "stopped") {
        await updateTaskStatus(task.id, "cancelled", undefined, "Task turn was stopped.");
        this.cleanupExecution(task.id, task.assignedBotId);
        void this.schedulerTick();
        return;
      }

      if (reply.status === "error") {
        const errorMsg = reply.error || "Model returned an error during execution.";
        await this.handleTaskFailure(task, errorMsg);
        return;
      }

      // Success: Extract output text
      const outputText = reply.parts
        .filter((p) => p.kind === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n")
        .trim();

      await updateTaskStatus(
        task.id,
        "completed",
        outputText || "Step completed successfully with no textual output.",
      );

      this.cleanupExecution(task.id, task.assignedBotId);

      // Resolve dependent tasks in this plan
      await this.resolveDependents(task.planId);

      // Trigger scheduler
      void this.schedulerTick();
    } catch (err) {
      if (execution.timeoutTimer) {
        clearTimeout(execution.timeoutTimer);
        execution.timeoutTimer = undefined;
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.handleTaskFailure(task, errorMsg);
    }
  }

  // ── Dependency Resolution & Cascading ────────────────────────────────────

  private async resolveDependents(planId: string): Promise<void> {
    const allPlanTasks = await getTasksByPlan(planId);
    const completedIds = new Set(
      allPlanTasks.filter((t) => t.status === "completed").map((t) => t.id),
    );

    let newlyReady = false;

    for (const task of allPlanTasks) {
      if (task.status === "pending") {
        const allPrereqsMet = task.dependencies.every((depId) => completedIds.has(depId));
        if (allPrereqsMet) {
          task.status = "ready";
          await saveTask(task);
          this.enqueueTask(task);
          newlyReady = true;
        }
      }
    }

    // Check if entire plan completed
    const allCompleted = allPlanTasks.every((t) => t.status === "completed");
    if (allCompleted) {
      const plan = await getPlan(planId);
      if (plan && plan.status !== "completed") {
        plan.status = "completed";
        plan.completedAt = new Date().toISOString();
        await createPlan(plan);
      }
    }

    if (newlyReady) {
      void this.schedulerTick();
    }
  }

  // ── Timeout & Failure Handling ───────────────────────────────────────────

  private async handleTaskTimeout(taskId: string): Promise<void> {
    const execution = this.activeExecutions.get(taskId);
    if (!execution) return;

    // Abort running turn in Mastra
    await stopConversation(execution.conversationId);

    const task = await getTask(taskId);
    if (!task || task.status === "cancelled" || task.status === "completed") {
      this.cleanupExecution(taskId, execution.botId);
      return;
    }

    const timeoutMsg = `Task timed out after ${task.timeoutMs}ms.`;
    await this.handleTaskFailure(task, timeoutMsg, true);
  }

  private async handleTaskFailure(
    task: Task,
    errorMessage: string,
    isTimeout = false,
  ): Promise<void> {
    this.cleanupExecution(task.id, task.assignedBotId);

    if (task.retryCount < task.maxRetries) {
      task.retryCount++;
      const backoffMs = Math.min(1000 * Math.pow(2, task.retryCount - 1), 30000);
      task.error = `${errorMessage} Retrying in ${backoffMs}ms (Attempt ${task.retryCount}/${task.maxRetries}).`;
      task.status = "ready";
      await saveTask(task);

      // Re-enqueue after exponential backoff
      setTimeout(() => {
        this.enqueueTask(task);
        void this.schedulerTick();
      }, backoffMs);
    } else {
      // Terminal failure
      const finalStatus: TaskStatus = isTimeout ? "timed_out" : "failed";
      task.status = finalStatus;
      task.error = `Max retries (${task.maxRetries}) exceeded: ${errorMessage}`;
      task.completedAt = new Date().toISOString();
      await saveTask(task);

      // Cascade failure to dependent tasks
      await this.cascadePrerequisiteFailure(task.planId, task.id, task.title);

      // Mark plan failed
      const plan = await getPlan(task.planId);
      if (plan && plan.status !== "failed" && plan.status !== "cancelled") {
        plan.status = "failed";
        plan.completedAt = new Date().toISOString();
        await createPlan(plan);
      }
    }

    void this.schedulerTick();
  }

  private async cascadePrerequisiteFailure(
    planId: string,
    failedTaskId: string,
    failedTaskTitle: string,
  ): Promise<void> {
    const planTasks = await getTasksByPlan(planId);
    for (const t of planTasks) {
      if ((t.status === "pending" || t.status === "ready") && t.dependencies.includes(failedTaskId)) {
        t.status = "failed";
        t.error = `Prerequisite task '${failedTaskTitle}' (${failedTaskId}) failed.`;
        t.completedAt = new Date().toISOString();
        await saveTask(t);

        // Remove from in-memory queue if queued
        const queue = this.agentQueues.get(t.assignedBotId);
        if (queue) {
          const idx = queue.findIndex((item) => item.id === t.id);
          if (idx !== -1) queue.splice(idx, 1);
        }

        // Recursively cascade to tasks depending on this task
        await this.cascadePrerequisiteFailure(planId, t.id, t.title);
      }
    }
  }

  // ── Cancellation Propagation ─────────────────────────────────────────────

  /**
   * Cancels a parent plan, aborts running child tasks, removes queued tasks,
   * and marks pending/awaiting_approval tasks as cancelled.
   */
  async cancelPlan(planId: string): Promise<Plan | null> {
    const plan = await getPlan(planId);
    if (!plan) return null;

    plan.status = "cancelled";
    plan.completedAt = new Date().toISOString();
    await createPlan(plan);

    const planTasks = await getTasksByPlan(planId);

    for (const task of planTasks) {
      if (["completed", "failed", "cancelled"].includes(task.status)) {
        continue;
      }

      // If actively running in Mastra, abort it
      const execution = this.activeExecutions.get(task.id);
      if (execution) {
        if (execution.timeoutTimer) clearTimeout(execution.timeoutTimer);
        await stopConversation(execution.conversationId);
        this.cleanupExecution(task.id, execution.botId);
      }

      // Remove from agent queues
      const queue = this.agentQueues.get(task.assignedBotId);
      if (queue) {
        const idx = queue.findIndex((t) => t.id === task.id);
        if (idx !== -1) queue.splice(idx, 1);
      }

      task.status = "cancelled";
      task.error = "Parent plan cancelled.";
      task.completedAt = new Date().toISOString();
      await saveTask(task);
    }

    // Clean planOrder
    const pIdx = this.planOrder.indexOf(planId);
    if (pIdx !== -1) this.planOrder.splice(pIdx, 1);

    void this.schedulerTick();
    return plan;
  }

  /**
   * Cancels a single task and cascades cancellation to dependent tasks.
   */
  async cancelTask(taskId: string, reason = "Task cancelled by user."): Promise<Task | null> {
    const task = await getTask(taskId);
    if (!task) return null;

    const execution = this.activeExecutions.get(taskId);
    if (execution) {
      if (execution.timeoutTimer) clearTimeout(execution.timeoutTimer);
      await stopConversation(execution.conversationId);
      this.cleanupExecution(taskId, execution.botId);
    }

    const queue = this.agentQueues.get(task.assignedBotId);
    if (queue) {
      const idx = queue.findIndex((t) => t.id === taskId);
      if (idx !== -1) queue.splice(idx, 1);
    }

    task.status = "cancelled";
    task.error = reason;
    task.completedAt = new Date().toISOString();
    await saveTask(task);

    // Cascade cancellation to dependent tasks in the same plan
    const planTasks = await getTasksByPlan(task.planId);
    for (const t of planTasks) {
      if (t.dependencies.includes(taskId) && (t.status === "pending" || t.status === "ready")) {
        await this.cancelTask(t.id, `Prerequisite task '${task.title}' was cancelled.`);
      }
    }

    void this.schedulerTick();
    return task;
  }

  // ── Human-in-the-Loop Approval & Answers ──────────────────────────────────

  async approveTask(taskId: string, toolCallId?: string): Promise<Task | null> {
    const task = await getTask(taskId);
    if (!task || task.status !== "awaiting_approval") return null;

    if (toolCallId) {
      // In-flight Mastra tool approval
      const conversationId = `task:${taskId}`;
      await respondToApproval(conversationId, task.assignedBotId, toolCallId, true);
    } else {
      // Pre-execution approval: transition to ready and enqueue
      task.status = "ready";
      task.approvalRequired = false;
      await saveTask(task);
      this.enqueueTask(task);
      void this.schedulerTick();
    }

    return task;
  }

  async rejectTask(taskId: string, toolCallId?: string): Promise<Task | null> {
    const task = await getTask(taskId);
    if (!task || task.status !== "awaiting_approval") return null;

    if (toolCallId) {
      const conversationId = `task:${taskId}`;
      await respondToApproval(conversationId, task.assignedBotId, toolCallId, false);
    }

    await this.cancelTask(taskId, "Task rejected by user.");
    return task;
  }

  async answerTaskQuestion(taskId: string, toolCallId: string, answer: string): Promise<Task | null> {
    const task = await getTask(taskId);
    if (!task || task.status !== "awaiting_approval") return null;

    const conversationId = `task:${taskId}`;
    await answerQuestion(conversationId, task.assignedBotId, toolCallId, answer);
    return task;
  }

  // ── Startup Crash Recovery ───────────────────────────────────────────────

  /**
   * Initializes the engine upon server startup:
   * 1. Recovers interrupted running tasks via recoverStuckTasks()
   * 2. Re-enqueues ready tasks into agentQueues
   * 3. Preserves awaiting_approval tasks
   * 4. Leaves completed and cancelled tasks terminal
   */
  async init(): Promise<{ recovered: number; failed: number; enqueued: number }> {
    this.running = true;
    const recoveryResult = await recoverStuckTasks();

    const allPlans = await listPlans();
    const activePlans = allPlans.filter((p) => p.status === "planning" || p.status === "running");

    let enqueued = 0;

    for (const plan of activePlans) {
      if (!this.planOrder.includes(plan.id)) {
        this.planOrder.push(plan.id);
      }

      const tasks = await getTasksByPlan(plan.id);
      for (const task of tasks) {
        if (task.status === "ready") {
          this.enqueueTask(task);
          enqueued++;
        }
      }
    }

    void this.schedulerTick();
    return { ...recoveryResult, enqueued };
  }

  private cleanupExecution(taskId: string, botId: string) {
    this.activeExecutions.delete(taskId);
    if (this.activeByBot.get(botId) === taskId) {
      this.activeByBot.delete(botId);
    }
  }

  // ── Telemetry & Diagnostics ──────────────────────────────────────────────

  getStats(): TaskEngineStats {
    const activeByAgent: Record<string, number> = {};
    for (const botId of this.activeByBot.keys()) {
      activeByAgent[botId] = 1;
    }

    const queuedByAgent: Record<string, number> = {};
    let queuedGlobal = 0;
    for (const [botId, q] of this.agentQueues.entries()) {
      queuedByAgent[botId] = q.length;
      queuedGlobal += q.length;
    }

    return {
      activeGlobal: this.activeExecutions.size,
      activeByAgent,
      queuedGlobal,
      queuedByAgent,
      activePlanIds: [...this.planOrder],
    };
  }

  shutdown(): void {
    this.running = false;
    for (const execution of this.activeExecutions.values()) {
      if (execution.timeoutTimer) clearTimeout(execution.timeoutTimer);
    }
    this.activeExecutions.clear();
    this.activeByBot.clear();
    this.agentQueues.clear();
  }
}

// Global instance surviving Next.js hot reloads
const g = globalThis as unknown as { __opencrewbotTaskEngine?: TaskEngine };
export const taskEngine = (g.__opencrewbotTaskEngine ??= new TaskEngine());
