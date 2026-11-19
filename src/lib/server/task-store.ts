import { db } from "./db";
import type { Plan, Task, TaskStatus } from "@/lib/shared/types";

// ── plans storage ───────────────────────────────────────────────────────

export async function createPlan(plan: Plan): Promise<void> {
  const client = await db();
  await client.execute({
    sql: `INSERT INTO plans (id, conversation_id, status, idempotency_key, created_at, data)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            idempotency_key = excluded.idempotency_key,
            data = excluded.data`,
    args: [
      plan.id,
      plan.conversationId,
      plan.status,
      plan.idempotencyKey ?? null,
      plan.createdAt,
      JSON.stringify(plan),
    ],
  });
}

export async function getPlan(id: string): Promise<Plan | null> {
  const client = await db();
  const rows = await client.execute({
    sql: "SELECT data FROM plans WHERE id = ?",
    args: [id],
  });
  return rows.rows[0] ? (JSON.parse(String(rows.rows[0].data)) as Plan) : null;
}

export async function getPlanByIdempotencyKey(key: string): Promise<Plan | null> {
  const client = await db();
  const rows = await client.execute({
    sql: "SELECT data FROM plans WHERE idempotency_key = ?",
    args: [key],
  });
  return rows.rows[0] ? (JSON.parse(String(rows.rows[0].data)) as Plan) : null;
}

export async function listPlans(conversationId?: string): Promise<Plan[]> {
  const client = await db();
  const sql = conversationId
    ? "SELECT data FROM plans WHERE conversation_id = ? ORDER BY created_at DESC"
    : "SELECT data FROM plans ORDER BY created_at DESC";
  const args = conversationId ? [conversationId] : [];
  const rows = await client.execute({ sql, args });
  return rows.rows.map((r) => JSON.parse(String(r.data)) as Plan);
}

// ── tasks storage ───────────────────────────────────────────────────────

export async function saveTask(task: Task): Promise<void> {
  const client = await db();
  await client.execute({
    sql: `INSERT INTO tasks (id, plan_id, step_identifier, assigned_bot_id, status, created_at, data)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            data = excluded.data`,
    args: [
      task.id,
      task.planId,
      task.stepIdentifier,
      task.assignedBotId,
      task.status,
      task.createdAt,
      JSON.stringify(task),
    ],
  });
}

export async function getTask(id: string): Promise<Task | null> {
  const client = await db();
  const rows = await client.execute({
    sql: "SELECT data FROM tasks WHERE id = ?",
    args: [id],
  });
  return rows.rows[0] ? (JSON.parse(String(rows.rows[0].data)) as Task) : null;
}

export async function getTasksByPlan(planId: string): Promise<Task[]> {
  const client = await db();
  const rows = await client.execute({
    sql: "SELECT data FROM tasks WHERE plan_id = ? ORDER BY created_at ASC",
    args: [planId],
  });
  return rows.rows.map((r) => JSON.parse(String(r.data)) as Task);
}

export async function updateTaskStatus(
  id: string,
  status: TaskStatus,
  output?: string,
  error?: string,
): Promise<Task | null> {
  const task = await getTask(id);
  if (!task) return null;

  task.status = status;
  if (output !== undefined) task.output = output;
  if (error !== undefined) task.error = error;
  if (["completed", "failed", "cancelled", "timed_out"].includes(status)) {
    task.completedAt = task.completedAt ?? new Date().toISOString();
  }

  await saveTask(task);
  return task;
}

/**
 * Atomically claim a ready task by transitioning it from 'ready' to 'running'.
 * Returns true if the claim succeeded, false if another thread or process claimed it first.
 */
export async function claimReadyTask(id: string, startedAt = new Date().toISOString()): Promise<boolean> {
  const client = await db();
  const task = await getTask(id);
  if (!task || task.status !== "ready") return false;

  const updatedTask: Task = {
    ...task,
    status: "running",
    startedAt,
  };

  const res = await client.execute({
    sql: "UPDATE tasks SET status = 'running', data = ? WHERE id = ? AND status = 'ready'",
    args: [JSON.stringify(updatedTask), id],
  });

  return res.rowsAffected > 0;
}

/**
 * Recovers stuck 'running' tasks on server startup.
 * Tasks with remaining retries transition to 'ready' with an incremented retryCount.
 * Tasks that reached maxRetries transition to 'failed'.
 * Tasks awaiting approval, completed, or cancelled are never modified.
 */
export async function recoverStuckTasks(): Promise<{ recovered: number; failed: number }> {
  const client = await db();
  const rows = await client.execute({
    sql: "SELECT data FROM tasks WHERE status = 'running'",
    args: [],
  });

  let recovered = 0;
  let failed = 0;

  for (const r of rows.rows) {
    const task = JSON.parse(String(r.data)) as Task;
    if (task.retryCount < task.maxRetries) {
      task.retryCount++;
      task.status = "ready";
      task.error = "Interrupted by server reboot. Retrying.";
      await saveTask(task);
      recovered++;
    } else {
      task.status = "failed";
      task.error = "Interrupted by server reboot. Max retries exceeded.";
      task.completedAt = new Date().toISOString();
      await saveTask(task);
      failed++;
    }
  }

  return { recovered, failed };
}
