# OpenCrewBot — Automated Testing Strategy

**Document:** Automated Testing Foundation & Verification Strategy  
**Target File:** `docs/TESTING_STRATEGY.md`  
**Date:** 2026-11-18  
**Scope:** Architecture, isolation design, test suite inventory, and execution guidelines for automated testing.  
**Author:** Antigravity AI Engineering Assistant  

---

## 1. Objectives & Testing Principles

Prior to Task 3, OpenCrewBot had **zero automated tests**. Establishing a robust testing framework before introducing OpenCrewBot 2.0 features ensures:
1. **Regression Prevention:** The core agent runtime (`runtime.ts`), memory management (`memory-files.ts`), room collaboration (`rooms.ts`), and service operations (`service.ts`) cannot be broken silently during extension work.
2. **Environment & Data Isolation:** Automated test runs must execute against isolated, temporary SQLite databases and ephemeral bot workspace directories. Real user data in `data/opencrewbot.db`, `data/mastra.db`, and `data/workspaces` must never be touched.
3. **Deterministic & Fast Execution:** Tests must run without requiring live model API keys (Nebius, OpenAI, Anthropic) by taking full advantage of the mock runtime harness (`mock-model.ts`).
4. **Zero Disruptive Changes:** The testing foundation introduces Vitest as a development dependency and test files in `tests/`, without modifying application production code or altering the MIT license.

---

## 2. Test Framework Selection: Vitest

### Evaluation & Rationale
| Framework Candidate | Compatibility with Next.js 16 + React 19 + Node 22 + ESM | Pros | Cons | Decision |
|---|---|---|---|---|
| **Vitest** (Selected) | Native ESM & TypeScript support; matches Next.js / Turbopack architecture | Blazing fast execution (~400ms for db tests), out-of-the-box TypeScript, shared Vite configuration, seamless Node 22 compatibility | Requires path alias mapping | **ADOPTED** |
| **Jest** | Requires `ts-jest` or `@swc/jest` with complex ESM shims | Mature ecosystem | Complex ESM config with Next.js 16 and Node 22; slower execution | Rejected |
| **Playwright** | Full browser automation | Excellent for UI E2E | Heavyweight for unit and backend service tests; will be used later for Phase 7/8 E2E | Deferred to UI Phase |

### Configuration (`vitest.config.mjs`)
- **Environment:** `node`
- **File Matching:** `tests/**/*.test.ts`
- **Setup File:** `tests/setup.ts`
- **File Parallelism:** `false` (serialized suite execution to prevent SQLite file-locking contention across concurrent threads)
- **Path Aliasing:** Maps `@/*` directly to `./src/*`

---

## 3. Test Isolation Design

### Ephemeral Storage Architecture
In `tests/setup.ts`:
1. Creates a unique temporary directory via `fs.mkdtempSync(path.join(os.tmpdir(), "opencrewbot-test-"))`.
2. Injects `process.env.OPENCREWBOT_DATA_DIR = testDataDir`.
3. Injects `process.env.NODE_ENV = "test"`.
4. Deletes any external service API keys (`NEBIUS_API_KEY`, `TAVILY_API_KEY`, `BROWSERBASE_API_KEY`, `COMPOSIO_API_KEY`, `TYPESAFE_API_KEY`) to ensure default mock-mode operation.

Because `src/lib/server/config.ts` resolves `DATA_DIR` from `process.env.OPENCREWBOT_DATA_DIR`, all test databases (`opencrewbot.db`, `mastra.db`) and workspaces (`data/workspaces/{botId}/`) are created within this temporary directory and remain completely isolated from the user's primary application workspace.

---

## 4. Test Suite Inventory & Coverage Areas

| Test Suite | Target Module | Core Responsibilities Tested | Mocks Used |
|---|---|---|---|
| `tests/db.test.ts` | `src/lib/server/db.ts` | Schema tables initialization, settings key-value store, bot CRUD, room CRUD, message persistence, last-message preview lookup, unread count tracking, conversation generation bumping, and message clearing. | Isolated SQLite DB |
| `tests/service-crud.test.ts` | `src/lib/server/service.ts` | Bot validation rules (name length, empty name checks), bot creation, field updates, bot deletion (with cascade removal from rooms), room validation, lead fallback assignment, and member filtering. | Isolated SQLite DB |
| `tests/memory.test.ts` | `src/lib/server/memory-files.ts` | Workspace initialization, dated bullet appending, exact substring editing, secret redaction filter (`sk-`, `ghp_` tokens), and prompt context window limit truncation (200 lines / 16KB). | Ephemeral workspace dir |
| `tests/mock-model.test.ts` | `src/lib/server/mock-model.ts` | Scripted model keyword behaviors (`remember that`, `ask me`, `open http`, `search for`), standard greeting streaming, and tool result formatting. | Pure mock model harness |
| `tests/rooms-routing.test.ts` | `src/lib/server/rooms.ts` | Message text extraction, conversation ID formatting, lead bot fallback in unmentioned auto rooms, explicit single `@mention` routing, and broadcast `@everyone` routing. | Isolated SQLite DB + Mock Model |
| `tests/ask-user.test.ts` | `src/lib/server/runtime.ts` | Human-in-the-loop suspension on `ask_user` tool call, question card payload structure, turn resumption via `answerQuestion()`, and expired question rejection. | Isolated SQLite DB + Mock Model |
| `tests/approval.test.ts` | `src/lib/server/runtime.ts` | Rejection of invalid approval IDs, configuring autonomous bots (`approval: "full"`), and configuring gated bots (`approval: "ask"`). | Isolated SQLite DB |
| `tests/stop.test.ts` | `src/lib/server/runtime.ts` | Stop epoch increments, in-flight and suspended turn aborts, transition of message status to `"stopped"`, and cleanup of active running bot state. | Isolated SQLite DB + Mock Model |
| `tests/http-errors.test.ts` | `src/lib/server/http.ts` | `handle()` wrapper behavior, conversion of `InputError` to HTTP 400 Bad Request, conversion of unknown errors to HTTP 500, JSON body parsing and malformed body rejection via `body()`, and `conversationParam()` URL decoding. | None (Unit tests) |

---

## 5. Execution Guidelines

### Available Commands (`package.json`)
- **Run Full Test Suite:** `pnpm test` (executes `vitest run`)
- **Run Specific Suite:** `pnpm test tests/db.test.ts`
- **Interactive Watch Mode:** `pnpm test:watch` (executes `vitest`)
- **Type Checking:** `pnpm exec tsc --noEmit`
- **Linter Check:** `pnpm lint`
- **Production Build:** `pnpm build`

---
*Testing Strategy Established and Verified.*
