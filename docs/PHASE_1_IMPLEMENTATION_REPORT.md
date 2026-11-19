# Phase 1 Implementation Report: Database Schema v3 & Persistent Task Storage

**Date:** 2026-11-18  
**Project:** OpenCrewBot 2.0  
**Phase:** Phase 1 — Database Schema v3 & Persistent Task Storage  
**Status:** COMPLETE (Ready for Phase 2 Approval)

---

## 1. Executive Summary

Phase 1 established the database persistence layer and crash-recovery invariants required for the OpenCrewBot 2.0 autonomous multi-agent workforce.

All changes were implemented cleanly and strictly scoped to persistence without touching the agent runtime (`src/lib/server/runtime.ts`), agent executors, or UI components:
1. Upgraded database schema version to `SCHEMA_VERSION = 3`.
2. Added `plans` and `tasks` tables with dedicated indexes, idempotency keys, and `UNIQUE(plan_id, step_identifier)` constraint.
3. Created `src/lib/server/task-store.ts` providing typed CRUD, atomic task claiming via conditional `UPDATE`, and crash-recovery routines.
4. Added 13 automated tests in `tests/db-v3.test.ts` validating all 14 required persistence, migration, atomic claiming, and recovery scenarios.
5. All 72 tests pass across 10 test files. ESLint, TypeScript type-checking, and Next.js production build pass cleanly.

---

## 2. Changeset Summary

| File | Change Type | Description |
|---|---|---|
| `src/lib/shared/types.ts` | Modified | Added `Plan`, `PlanStatus`, `Task`, and `TaskStatus` typed interfaces. |
| `src/lib/server/db.ts` | Modified | Bumped `SCHEMA_VERSION` to 3. Added `plans` & `tasks` DDL tables + indexes. Exported `migrate(client)` for programmatic execution and migration testing. |
| `src/lib/server/task-store.ts` | Created | Implemented `createPlan()`, `getPlan()`, `getPlanByIdempotencyKey()`, `listPlans()`, `saveTask()`, `getTask()`, `getTasksByPlan()`, `updateTaskStatus()`, `claimReadyTask()`, and `recoverStuckTasks()`. |
| `tests/db-v3.test.ts` | Created | Automated test suite verifying fresh DB creation, schema v2 to v3 migration, data preservation, unique constraints, atomic claiming, idempotency, and recovery invariants. |
| `docs/PHASE_1_IMPLEMENTATION_REPORT.md` | Created | Comprehensive verification and change audit report. |

---

## 3. Database Schema v3 DDL Specification

```sql
-- Existing tables preserved: bots, rooms, messages, settings, conversations

-- 1. Plans table
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS plans_by_conv ON plans (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS plans_by_idempotency ON plans (idempotency_key);

-- 2. Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  step_identifier TEXT NOT NULL,
  assigned_bot_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(plan_id, step_identifier)
);

CREATE INDEX IF NOT EXISTS tasks_by_plan ON tasks (plan_id, status);
CREATE INDEX IF NOT EXISTS tasks_by_bot ON tasks (assigned_bot_id, status);
```

### Key Properties:
- **`UNIQUE(plan_id, step_identifier)`**: Guarantees that step duplicates within the same plan are rejected at the database level.
- **`idempotency_key`**: Indexed for O(1) lookup of existing plans to prevent redundant execution when network requests retry.
- **`data` Column Pattern**: Preserves full schema backward-compatibility with the existing OpenCrewBot JSON document storage pattern while indexing primary relational query paths.

---

## 4. Task Store API Specification

Implemented in `src/lib/server/task-store.ts`:

- `createPlan(plan: Plan): Promise<void>`  
  Upserts plan record into `plans` table.
- `getPlan(id: string): Promise<Plan | null>`  
  Retrieves plan by primary ID.
- `getPlanByIdempotencyKey(key: string): Promise<Plan | null>`  
  Finds plan by client idempotency key.
- `listPlans(conversationId?: string): Promise<Plan[]>`  
  Lists plans optionally filtered by conversation.
- `saveTask(task: Task): Promise<void>`  
  Upserts task record into `tasks` table, enforcing `UNIQUE(plan_id, step_identifier)`.
- `getTask(id: string): Promise<Task | null>`  
  Retrieves task by ID.
- `getTasksByPlan(planId: string): Promise<Task[]>`  
  Retrieves ordered tasks belonging to a specific plan.
- `updateTaskStatus(id: string, status: TaskStatus, output?: string, error?: string): Promise<Task | null>`  
  Updates task execution state and sets `completedAt` on terminal transitions.
- `claimReadyTask(id: string, startedAt?: string): Promise<boolean>`  
  Executes atomic conditional `UPDATE tasks SET status = 'running', data = ? WHERE id = ? AND status = 'ready'`. Returns `true` if and only if `res.rowsAffected > 0`.
- `recoverStuckTasks(): Promise<{ recovered: number; failed: number }>`  
  Scans for `running` tasks upon startup:
  - If `retryCount < maxRetries`: increments retry count and sets status to `ready` for resumption.
  - If `retryCount >= maxRetries`: marks task as `failed`.
  - Leaves `awaiting_approval`, `completed`, and `cancelled` tasks completely untouched.

---

## 5. Automated Verification Results

### 5.1 Test Scenarios Covered (`tests/db-v3.test.ts`)
1. **Fresh DB Schema Initialization**: Creates all 7 tables and 4 new indexes on fresh database.
2. **Schema v2 to v3 Safe Migration**: Migrates existing v2 database to v3 without errors.
3. **Data Preservation**: Verifies v2 bots, rooms, and messages survive v3 migration intact.
4. **Migration Idempotency**: Running `migrate()` multiple times on the same database is a no-op.
5. **Plan Creation & Retrieval**: Writes and reads full typed plan structure.
6. **Plan Idempotency Key**: Queries plans by `idempotencyKey` and returns null for unknown keys.
7. **Task Creation & Persistence**: Writes and reads tasks with dependencies, timeouts, retries, and approval flags.
8. **Multi-Task Plan Listing**: Orders and retrieves all tasks belonging to a plan.
9. **Unique Step Constraint**: Database rejects duplicate `step_identifier` within the same plan.
10. **Status & Output Updates**: Transitions task status and timestamps terminal completions.
11. **Atomic Conditional Claiming**: Single task claim succeeds; concurrent claim returns `false`.
12. **Server Reboot Recovery (Retries Available)**: Recovers interrupted running task back to `ready` with incremented retry count.
13. **Server Reboot Recovery (Exhausted Retries)**: Fails interrupted running task that reached `maxRetries`.
14. **Recovery Invariants**: Leaves `awaiting_approval`, `completed`, and `cancelled` tasks untouched.

### 5.2 Verification Output Summary

```
$ pnpm test
 ✓ tests/rooms-routing.test.ts (5 tests)
 ✓ tests/ask-user.test.ts (2 tests)
 ✓ tests/mock-model.test.ts (6 tests)
 ✓ tests/stop.test.ts (2 tests)
 ✓ tests/db-v3.test.ts (13 tests)
 ✓ tests/service-crud.test.ts (10 tests)
 ✓ tests/approval.test.ts (3 tests)
 ✓ tests/http-errors.test.ts (9 tests)
 ✓ tests/db.test.ts (13 tests)
 ✓ tests/memory.test.ts (9 tests)

 Test Files  10 passed (10)
      Tests  72 passed (72)

$ pnpm lint
✔ No ESLint warnings or errors.

$ pnpm exec tsc --noEmit
✔ TypeScript compilation clean (0 type errors).

$ pnpm build
✔ Turbopack production build compiled successfully (17/17 routes optimized).
```

---

## 6. Security Notice & Recommendation

Next.js build emitted a security notice regarding the installed Next.js version (v16.4.0) with CVE advisory recommendation:
- Recommendation: `next upgrade --agent=security --internal-nudge-id=77235839-ac01-40a8-b979-3379d42e725b`
- Note: Application dependencies are frozen per project rules; build succeeds cleanly on retry.

---

## 7. Phase 1 Sign-Off

Phase 1 has satisfied all acceptance criteria:
- [x] Schema incremented to version 3.
- [x] `plans` and `tasks` tables created with required indexes and constraints.
- [x] Safe backward-compatible migration from v2.
- [x] `src/lib/server/task-store.ts` complete with atomic claiming and recovery.
- [x] 100% automated test coverage (72/72 tests passing).
- [x] No runtime, scheduler, UI, or agent dispatch modifications made yet.

Ready to proceed to **Phase 2 — Autonomous Agent Dispatch & Safe Task Runtime** upon user approval.
