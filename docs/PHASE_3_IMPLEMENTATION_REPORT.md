# Phase 3 Implementation Report — Workforce Foundation

**Project:** OpenCrewBot 2.0  
**Status:** Completed, Hardened & Fully Verified  
**Date:** November 19, 2026  
**Test Suite:** 12/12 Test Files Passed, 118/118 Tests Passed  

---

## 1. Executive Summary

Phase 3 established the core multi-agent workforce foundation for OpenCrewBot 2.0 while strictly preserving existing Next.js, Mastra runtime, database schema, and tool execution behaviors.

Following security and architectural hardening:
1. **Eight Persistent Workforce Agents:** Seeded eight specialized agents with distinct personas, tools, model configurations, permission levels (`ask_first`, `controlled`, `full`), output preferences, and memory partitions.
2. **Four Collaboration Rooms:** Seeded persistent multi-agent rooms (Strategy, Research, Engineering, and Operations) with designated leads, explicit member rosters, instructions, shared memory, and automatic responder routing.
3. **Strict Three-Tier Permission Enforcement:** Enforced server-side permissions across all tool categories (`read`, `edit`, `execute`, `mcp`, `other`) inside `runtime.ts` and Mastra's controller, ensuring full gating for Ask First, selective gating for Controlled Access, and full execution for Full Access.
4. **Central Default Agent Deletion Protection:** Implemented ironclad default-agent protection in `service.deleteBot()` and `agent-factory.deleteAgentSafely()`, blocking accidental deletion of all eight default agents across the service, agent factory, and REST API (`DELETE /api/bots/[id]`) with HTTP 400 responses.
5. **Natural-Language Dynamic Agent Factory:** A domain-aware agent parser and factory (`src/lib/server/agent-factory.ts`) capable of parsing natural language requests into structured agent configurations, detecting ambiguities and asking for clarification, duplicating agents, toggling active status, and enforcing deletion safety constraints.
6. **Runtime & Task Engine Integration:** Seamless execution across interactive direct messages, room routing, and Phase 2 background task engine execution.

---

## 2. Eight Default Agent Profiles & Configurations

All eight default agents are seeded idempotently in [service.ts](file:///k:/code/OpenCrewBot%202.0/src/lib/server/service.ts) using definitions from [workforce-defaults.ts](file:///k:/code/OpenCrewBot%202.0/src/lib/server/workforce-defaults.ts):

| Handle | Agent Name | Role | Default Model ID | Permission Level | Tools & Skills | Output Preferences |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `@chief` | Chief | Chief of Staff & Orchestrator | `MiniMaxAI/MiniMax-M3` | `Controlled Access` | Memory, AskUser | Structured, executive, concise |
| `@scout` | Scout | Research & Intelligence | `Qwen/Qwen3.8-27B` | `Controlled Access` | WebSearch, Memory, CodeMode, Browser, AskUser | Markdown, objective, detailed |
| `@quill` | Quill | Technical Writing & Docs | `MiniMaxAI/MiniMax-M3` | `Full Access` | Memory, AskUser | Markdown, polished, standard |
| `@atlas` | Atlas | Systems & Strategy | `moonshotai/Kimi-K2.7-Code` | `Controlled Access` | Memory, CodeMode, AskUser | Structured, analytical, detailed |
| `@cipher` | Cipher | Security & Code Review | `deepseek-ai/DeepSeek-V4.1-Flash` | `Ask First` | Memory, CodeMode, AskUser | Bullet, rigorous, detailed |
| `@ledger` | Ledger | Finance & Analytics | `Qwen/Qwen3.5-397B-A17B` | `Ask First` | Memory, CodeMode, AskUser | Structured, quantitative, detailed |
| `@sentry` | Sentry | QA & Verification | `moonshotai/Kimi-K2.7-Code` | `Full Access` | Memory, CodeMode, AskUser | Markdown, skeptical, detailed |
| `@chronos` | Chronos | Operations & Scheduling | `nvidia/Nemotron-3_5-Lightning` | `Controlled Access` | Memory, AskUser | Structured, systematic, concise |

### Execution Environment Note: Mock vs. Live Providers
- **Mock Execution (Verified 100%):** In test environments and local development without a `NEBIUS_API_KEY`, `createMockModel` provides deterministic multi-agent execution, tool calls, and event streaming for all 8 agents.
- **Live Provider Execution (Nebius Token Factory):** In live mode (`isMock() === false`), the runtime connects to Nebius Token Factory (`nebius/${holder.bot.model}`). All eight default models are valid Nebius open-weights models from the static catalog.
- **Known Live Provider Limitation:** The existing OpenCrewBot runtime routes all live models through Nebius (`nebius/*`). External proprietary providers (Anthropic Claude native, Google Gemini native, OpenAI native) require the multi-model provider abstraction scheduled for **Phase 6**.

---

## 3. Four Collaboration Rooms Specifications

The four seeded collaboration rooms coordinate multi-agent turns with designated leads, specialized instructions, and shared memory contexts defined in [workforce-defaults.ts](file:///k:/code/OpenCrewBot%202.0/src/lib/server/workforce-defaults.ts):

| Room Name | Topic / Purpose | Lead Agent | Member Roster | Responder Mode |
| :--- | :--- | :--- | :--- | :--- |
| **Strategy Room** | Executive strategy, organizational roadmaps, and high-impact decision planning. | `@chief` | `@chief`, `@atlas`, `@ledger`, `@quill` | `auto` |
| **Research Room** | Market intelligence, competitive benchmarking, and empirical evidence gathering. | `@scout` | `@scout`, `@quill`, `@cipher`, `@sentry` | `auto` |
| **Engineering Room**| Systems architecture, technical specifications, secure code reviews, and quality verification. | `@atlas` | `@atlas`, `@cipher`, `@sentry`, `@scout` | `auto` |
| **Operations Room** | Operational cadences, workflow synchronization, scheduling, and health metrics. | `@chronos` | `@chronos`, `@ledger`, `@quill`, `@chief` | `auto` |

### Room Collaboration Invariants
- **Lead Fallback Routing:** In `auto` responder mode, unmentioned messages default to the designated lead agent.
- **Explicit Mentions:** When a specific member is mentioned (e.g., `@cipher`), only that member responds.
- **Broadcast Mention:** When `@everyone` or `@all` is used, all room members respond sequentially.
- **Shared Room Context:** Room instructions and memory are persisted and available for multi-agent alignment.

---

## 4. Server-Side Permission Enforcement Architecture

The system enforces three distinct permission tiers server-side in `src/lib/server/runtime.ts` via Mastra session permissions and category classification in `src/lib/server/tools.ts`:

### Tool Categories:
- **`read`**: Lookup tools (`web_search`, `read_page`, `crawl_site`, `execute_typescript`, read-only MCP/Composio actions, read-only browser tools).
- **`edit`**: State-mutating memory operations (`memory_add`, `memory_edit`).
- **`execute`**: Mutating browser driving tools (`browser_goto`, `browser_click`, `browser_type`).
- **`mcp`**: Mutating MCP and external connector tools (`mcp_*_create`, `mcp_*_update`, `COMPOSIO_*_SEND_*`).
- **`other`**: Any unrecognized tool.

### Permission Tiers:
1. **Ask First (`"ask"` / `"ask_first"`):**
   - Every tool action across `read`, `edit`, `execute`, `mcp`, and `other` requires explicit human approval.
   - No tool executes before approval. Declining an action sets `part.status = "denied"` and the action is never executed.
2. **Controlled Access (`"controlled"`):**
   - Read-only tools (`read`) execute automatically.
   - Mutating tools (`edit`, `execute`, `mcp`, `other`) require explicit human approval before execution.
3. **Full Access (`"full"`):**
   - All permitted tools across all categories execute without approval.
4. **Interactive Question Suspension (`ask_user`):**
   - Set to `policy: "allow"` across all modes so questions directly suspend execution for user input rather than requiring a redundant approval gate before asking a question.

---

## 5. Centralized Default Agent Deletion Protection

Centralized in [service.ts](file:///k:/code/OpenCrewBot%202.0/src/lib/server/service.ts) (`deleteBot`) and [agent-factory.ts](file:///k:/code/OpenCrewBot%202.0/src/lib/server/agent-factory.ts) (`deleteAgentSafely`):
- Deletion of any agent whose handle is in `DEFAULT_AGENT_HANDLES` is permanently rejected with an `InputError`.
- No public force-delete bypass parameter exists.
- REST API endpoint `DELETE /api/bots/[id]` automatically converts the `InputError` into an **HTTP 400 Bad Request** error with `{ error: "Agent '...' is a default workforce agent and cannot be deleted." }`.
- Busy agents executing active turns continue to be protected from deletion.
- Custom user agents can still be safely deleted when not busy.

---

## 6. Files Modified and Created

### Files Created:
1. [workforce-defaults.ts](file:///k:/code/OpenCrewBot%202.0/src/lib/server/workforce-defaults.ts): Full data specifications for 8 default agents, 4 collaboration rooms, and handles.
2. [agent-factory.ts](file:///k:/code/OpenCrewBot%202.0/src/lib/server/agent-factory.ts): Natural-language agent parser, validation, duplication, status management, and safe deletion.
3. [workforce-foundation.test.ts](file:///k:/code/OpenCrewBot%202.0/tests/workforce-foundation.test.ts): 16 automated tests verifying workforce foundation and all 8 agents executing in mock mode.
4. [PHASE_3_IMPLEMENTATION_REPORT.md](file:///k:/code/OpenCrewBot%202.0/docs/PHASE_3_IMPLEMENTATION_REPORT.md): This report.

### Files Modified:
1. [types.ts](file:///k:/code/OpenCrewBot%202.0/src/lib/shared/types.ts):
   - Added `"ask_first"` to `ApprovalMode`.
   - Extended `Bot` and `BotInput` with `role`, `status` (`"active" | "inactive"`), `skills`, and `outputPreferences`.
   - Extended `Room` and `RoomInput` with `instructions` and `sharedMemory`.
2. [service.ts](file:///k:/code/OpenCrewBot%202.0/src/lib/server/service.ts):
   - Added centralized default agent deletion protection in `deleteBot()`.
   - Updated `seed()` to idempotently create 8 workforce agents and 4 collaboration rooms.
   - Updated `createBot()` and `updateBot()` to persist extended agent fields.
   - Updated `createRoom()` and `updateRoom()` to persist room instructions and shared memory.
3. [runtime.ts](file:///k:/code/OpenCrewBot%202.0/src/lib/server/runtime.ts):
   - Implemented three-tier permission enforcement across `read`, `edit`, `execute`, `mcp`, and `other` categories.
4. [prompt.ts](file:///k:/code/OpenCrewBot%202.0/src/lib/server/prompt.ts):
   - Injected `bot.role` and `bot.outputPreferences` into LLM prompts.
5. [task-engine.ts](file:///k:/code/OpenCrewBot%202.0/src/lib/server/task-engine.ts):
   - Added status check in `executeTask()` failing tasks cleanly if assigned agent is `"inactive"`.
6. [approval.test.ts](file:///k:/code/OpenCrewBot%202.0/tests/approval.test.ts):
   - Expanded with 15 tests covering all permission modes, category classification, tool approval/decline, and REST API/service default agent deletion protection.

---

## 7. Verification Results

| Check | Command | Result |
| :--- | :--- | :--- |
| **Vitest Test Suite** | `pnpm test` | **12/12 test files passed, 118/118 tests passed** |
| **ESLint** | `pnpm lint` | **Clean (0 errors, 0 warnings)** |
| **TypeScript** | `pnpm exec tsc --noEmit` | **Clean (0 errors)** |
| **Production Build** | `pnpm build` | **Clean build (Exit code 0)** |
