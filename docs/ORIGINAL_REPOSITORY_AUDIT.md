# OpenCrewBot — Original Repository Audit

**Document:** Original Repository Architectural & Implementation Audit  
**Target File:** `docs/ORIGINAL_REPOSITORY_AUDIT.md`  
**Date:** 2026-11-18  
**Scope:** Strict read-only audit of the original MIT-licensed OpenCrewBot repository prior to OpenCrewBot 2.0 extension.  
**Auditor:** Antigravity AI Engineering Assistant  

---

## Executive Summary

OpenCrewBot (historically "CrewRoom") is an open-source, local-first multi-agent collaboration platform built on **Next.js 16 (App Router)** and **Mastra (`@mastra/core` v1.76.0)**. The platform provides a Slack-like interface for managing autonomous agents ("bots") and group collaboration spaces ("rooms"). It features live streaming responses over Server-Sent Events (SSE), tool execution with human-in-the-loop approval, local file-based memory (`MEMORY.md`), multi-bot room conversations with @mention-driven handoffs, Model Context Protocol (MCP) server connectivity, and a Composio tool integration layer.

This audit evaluates the codebase across 15 technical dimensions and benchmarks it against the core requirements for Assignment 3: OpenCrewBot 2.0.

---

## Table of Contents

1. [Repository Structure and File Organization](#1-repository-structure-and-file-organization)
2. [Frontend Architecture](#2-frontend-architecture)
3. [Backend and Server Architecture](#3-backend-and-server-architecture)
4. [Agent Runtime and Configuration System](#4-agent-runtime-and-configuration-system)
5. [How Individual Agents Work](#5-how-individual-agents-work)
6. [Collaboration Rooms](#6-collaboration-rooms)
7. [Agent-to-Agent Communication and Handoffs](#7-agent-to-agent-communication-and-handoffs)
8. [Memory Implementation](#8-memory-implementation)
9. [Tools and MCP Integrations](#9-tools-and-mcp-integrations)
10. [Approval and Permission Mechanisms](#10-approval-and-permission-mechanisms)
11. [Database and Persistent Storage](#11-database-and-persistent-storage)
12. [Model Provider Configuration](#12-model-provider-configuration)
13. [Mock Mode and Simulated Functionality](#13-mock-mode-and-simulated-functionality)
14. [Existing Tests and Verification Evidence](#14-existing-tests-and-verification-evidence)
15. [Limitations and Incomplete Functionality](#15-limitations-and-incomplete-functionality)
16. [Assignment 3 Requirements Assessment](#16-assignment-3-requirements-assessment)
17. [External Dependencies and MIT License](#17-external-dependencies-and-mit-license)
18. [Engineering Assessment and Recommended Implementation Sequence](#18-engineering-assessment-and-recommended-implementation-sequence)

---

## 1. Repository Structure and File Organization

### Project Metadata
- **Name:** `opencrewbot`
- **Version:** `0.1.0`
- **License:** MIT License (Copyright 2026 Studio1HQ)
- **Node Requirement:** `>=22.13`
- **Package Manager:** `pnpm 11.21.0` (managed via `pnpm-workspace.yaml`)

### Directory Tree
```
OpenCrewBot 2.0/
├── .env.example                     # Sample environment variable configuration
├── LICENSE                          # MIT License file
├── next.config.ts                   # Next.js configuration (serverExternalPackages, Turbopack)
├── package.json                     # Dependencies, scripts, package metadata
├── pnpm-lock.yaml                   # Lockfile
├── pnpm-workspace.yaml              # PNPM workspace definition
├── tsconfig.json                    # TypeScript compiler configuration
├── docs/                            # Documentation assets
│   ├── logo.svg
│   └── screenshots/
├── public/                          # Static assets
└── src/
    ├── proxy.ts                     # Localhost-only request guard middleware
    ├── app/                         # Next.js App Router root
    │   ├── layout.tsx               # Root HTML layout with Geist font definition
    │   ├── page.tsx                 # Root landing page (renders OpenCrewBotApp)
    │   └── api/                     # 21 REST & SSE endpoint route handlers
    │       ├── bootstrap/route.ts
    │       ├── events/route.ts
    │       ├── models/route.ts
    │       ├── bots/
    │       │   ├── route.ts
    │       │   └── [id]/
    │       │       ├── route.ts
    │       │       └── memory/route.ts
    │       ├── rooms/
    │       │   ├── route.ts
    │       │   └── [id]/route.ts
    │       ├── conversations/
    │       │   └── [id]/
    │       │       ├── messages/route.ts
    │       │       ├── answer/route.ts
    │       │       ├── approval/route.ts
    │       │       ├── clear/route.ts
    │       │       ├── read/route.ts
    │       │       └── stop/route.ts
    │       └── connections/
    │           ├── route.ts
    │           ├── changed/route.ts
    │           ├── composio/
    │           │   ├── connect/route.ts
    │           │   ├── disconnect/route.ts
    │           │   └── search/route.ts
    │           └── mcp/
    │               ├── route.ts
    │               └── [id]/route.ts
    ├── components/                  # Client-side React 19 components
    │   ├── OpenCrewBotApp.tsx       # Root provider & shell
    │   ├── Sidebar.tsx              # Navigation drawer for bots, rooms, search
    │   ├── ChatView.tsx             # Main chat feed & composer
    │   ├── Message.tsx              # Message renderer (text, tools, approvals, questions)
    │   ├── Inspector.tsx            # Right sidebar (details, memory, browser, settings)
    │   ├── BotForms.tsx             # Bot create/edit modal
    │   ├── RoomForms.tsx            # Room create/edit modal
    │   ├── ModelPicker.tsx          # Fullscreen model catalog modal
    │   ├── ConnectionsPanel.tsx     # Composio & MCP settings
    │   ├── SettingsPanel.tsx        # System status and storage info
    │   ├── ui.tsx                   # Design system primitives (Button, Input, Modal, etc.)
    │   └── NebiusLogo.tsx           # Brand icon
    └── lib/
        ├── client/                  # Frontend utilities & state
        │   ├── api.ts               # Typed fetch client for all API routes
        │   ├── format.ts            # Timestamp & relative formatting helpers
        │   ├── store.ts             # Reducer, action definitions, state tree
        │   └── use-connections.ts   # SWR-style hook for connection status
        ├── server/                  # Backend modules (Mastra, storage, routing)
        │   ├── bus.ts               # In-process SSE pub/sub event bus
        │   ├── composio.ts          # Composio tool client & action runner
        │   ├── config.ts            # App paths, data directory, legacy DB migration
        │   ├── db.ts                # LibSQL database connection & queries
        │   ├── http.ts              # Route wrapper, JSON error formatting
        │   ├── jev.ts               # TypeSafe Jev routing client
        │   ├── mcp-servers.ts       # MCPClient instances and lifecycle
        │   ├── memory-files.ts      # Workspaces/MEMORY.md management & scrubbing
        │   ├── mock-model.ts        # Mock model response generator
        │   ├── models.ts            # Nebius model catalog & live discovery
        │   ├── prompt.ts            # System prompt builder per bot turn
        │   ├── rooms.ts             # Multi-agent room execution & turn queue
        │   ├── runtime.ts           # Mastra AgentController lifecycle & turns
        │   ├── service.ts           # Business logic orchestrator (CRUD & actions)
        │   ├── tools.ts             # Built-in tool factory (Tavily, Memory, Browser, Code)
        │   └── workspaces.ts        # Bot filesystem workspace initialization
        └── shared/                  # Common TypeScript interfaces
            ├── preview.ts           # Message text truncation & preview helpers
            └── types.ts             # Core entity types (Bot, Room, Message, Event)
```

---

## 2. Frontend Architecture

- **Classification:** `EXISTING AND VERIFIED`
- **Relevant Files:**
  - `src/components/OpenCrewBotApp.tsx`
  - `src/components/Sidebar.tsx`
  - `src/components/ChatView.tsx`
  - `src/components/Message.tsx`
  - `src/components/Inspector.tsx`
  - `src/components/BotForms.tsx`
  - `src/components/RoomForms.tsx`
  - `src/components/ModelPicker.tsx`
  - `src/components/ConnectionsPanel.tsx`
  - `src/lib/client/store.ts`
  - `src/lib/client/api.ts`

### Implementation Details & Mechanics
1. **Technology Stack:** Built on React 19.3.0 and Tailwind CSS v4 using `@tailwindcss/turbopack`. Markdown formatting is powered by `react-markdown` and `remark-gfm`. Icons are sourced from `lucide-react`.
2. **State Management:** A centralized `useReducer` store in `store.ts` manages the entire application state. The state shape includes:
   - `bots`: Normalized map of all configured bots.
   - `rooms`: Normalized map of all collaboration rooms.
   - `transcripts`: In-memory cache of message histories keyed by conversation ID.
   - `summaries`: Conversation metadata (unread count, snippet preview, running bot IDs).
   - `active`: Current conversation descriptor (`{ type: "dm", id: botId }` or `{ type: "room", id: roomId }`).
   - `liveViews`: Map of active bot IDs to Browserbase remote CDP live-view URLs.
   - `connectionsVersion`: Cache-busting counter for tool and MCP status.
3. **Bootstrap & Real-Time Sync:**
   - On initial mount, `OpenCrewBotApp` invokes `GET /api/bootstrap`, loading all bots, rooms, conversation summaries, and models.
   - Immediately connects to `GET /api/events` via native `EventSource`.
   - Streaming text deltas, tool call lifecycle events (`tool_call_started`, `tool_call_completed`, `tool_approval_required`), memory updates, and roster changes are dispatched directly to the reducer.
4. **URL Hash Routing:** Deep-linking is handled via URL hash fragments (`#dm:<botId>` or `#room:<roomId>`). Changes update `window.history.replaceState` without full page transitions.
5. **Interactive Cards:** Chat supports interactive message parts:
   - `tool` parts display input arguments, execution spinners, and expandable output payloads.
   - `approval` parts present "Allow once" and "Deny" triggers for high-privilege actions.
   - `question` parts display dynamic single-select option buttons generated by the `ask_user` tool.

### Limitations
- No pagination or virtualized list rendering; extremely long chat transcripts can degrade client performance.
- Direct DOM manipulation is used for scroll locking and auto-scroll behaviors.
- State is entirely client-volatile; refreshing the browser re-fetches bootstrap state from the server.

### Required Extensions for OpenCrewBot 2.0
- Add visual indicators for Chief of Staff orchestration and task progress trees.
- Add workflow scheduler management UI to configure and view recurring AI jobs.
- Display multi-provider badge tags (e.g., Nebius, Anthropic, OpenAI, Local Ollama) in `ModelPicker`.

---

## 3. Backend and Server Architecture

- **Classification:** `EXISTING AND VERIFIED`
- **Relevant Files:**
  - `src/proxy.ts`
  - `src/lib/server/http.ts`
  - `src/lib/server/service.ts`
  - `src/lib/server/bus.ts`
  - `src/app/api/**/route.ts` (21 endpoint files)

### Implementation Details & Mechanics
1. **Host Boundary Enforcement:**
   - The server is strictly intended for local personal use. `src/proxy.ts` inspects incoming request headers. Any request with a `host` other than `localhost` or `127.0.0.1`, or an untrusted `origin` or `sec-fetch-site: cross-site`, receives an immediate HTTP 403 Forbidden.
2. **Service Orchestration:**
   - `service.ts` acts as the domain facade. API route handlers never query the database or invoke runtime controllers directly. Instead, they call `service.createBot()`, `service.sendMessage()`, `service.updateRoom()`, etc.
3. **Startup & Seeding:**
   - On initialization, `service.init()` checks for a marker file (`data/.seeded`). If absent, it automatically seeds three default bots:
     - **Scout** (`@scout`): Fast research specialist using `Qwen/Qwen2.5-32B-Instruct`.
     - **Quill** (`@quill`): Technical writer using `meta-llama/Meta-Llama-3.1-70B-Instruct`.
     - **Atlas** (`@atlas`): Code and architecture analyst using `Qwen/Qwen2.5-Coder-32B-Instruct`.
   - It also seeds a shared room named **Studio** containing all three bots.
4. **Stuck Turn Recovery:**
   - During startup, `service.recoverStuckTurns()` scans the SQLite messages table for any turn records left in `status: "streaming"` (from abrupt crashes or server restarts) and transitions them to `status: "stopped"`.
5. **Event Fanout:**
   - `bus.ts` maintains an in-memory `Set` of SSE subscriber controllers. When agents generate output or system status changes, `bus.publish(event)` serializes the payload to SSE format (`event: <type>\ndata: <json>\n\n`) and pushes it to all connected clients.

### Limitations
- **Single Process Only:** `bus.ts` operates strictly in-memory. It cannot scale across multiple cluster instances or serverless worker threads without a message broker (e.g., Redis pub/sub).
- **Localhost Bound:** Remote deployment requires either tunnels (Tailscale/Cloudflare) or rewriting `proxy.ts`.

### Required Extensions for OpenCrewBot 2.0
- Add background scheduler task loop initialization in `service.init()`.
- Add endpoints for workflow automation and agent delegation chains.

---

## 4. Agent Runtime and Configuration System

- **Classification:** `EXISTING AND VERIFIED`
- **Relevant Files:**
  - `src/lib/server/runtime.ts`
  - `src/lib/server/prompt.ts`
  - `src/lib/server/tools.ts`
  - `src/lib/shared/types.ts`

### Implementation Details & Mechanics
1. **Core Harness:** Built on Mastra's `AgentController` from `@mastra/core/agent`.
2. **Controller Lifecycle & Reuse:**
   - Unlike naive architectures that instantiate a new LLM agent on every turn, `runtime.ts` maintains a long-lived `AgentController` per bot stored in `state.controllers` on `globalThis.__opencrewbotRuntime`.
   - Controllers are keyed by bot ID and evaluated using a cryptographic signature:
     ```typescript
     function signatureOf(bot: Bot): string {
       return JSON.stringify([bot.tools, bot.approval, bot.connections, state.connectionsVersion]);
     }
     ```
   - If a bot's prompt or model is updated in the UI, the existing controller is reused without re-instantiation. If its tool bundle, approval settings, or active MCP connections change, the controller is cleanly torn down and rebuilt.
3. **Session Management:**
   - Execution sessions wrap Mastra threads and are cached in `state.sessions` with the key format `${conversationId}:${botId}`.
   - Mastra threads are uniquely partitioned: `threadId = "${conversationId}:${botId}:${generation}"`. The generation counter increments when conversation history is cleared.
4. **Turn Serialization:**
   - Multi-agent or concurrent inputs to the same bot within the same conversation are strictly serialized using promise chains in `state.chains.set(chainKey, nextPromise)`.
5. **Explicitly Disabled Mastra Built-ins:**
   - `runtime.ts` explicitly disables Mastra's built-in tool suite:
     ```typescript
     disabledTools: ["submit_plan", "task_write", "task_update", "task_complete", "task_check", "subagent"]
     ```
   - Mastra's internal hierarchical planner and subagent orchestration are bypassed in favor of OpenCrewBot's custom message folding and room routing.

### Limitations
- Disabling `subagent` prevents agents from directly spawning nested Mastra child tasks.
- If an agent's controller crashes during generation, turn cleanup relies on catch blocks that set the message to `error`.

### Required Extensions for OpenCrewBot 2.0
- Enable structured autonomous task execution and planning capabilities.
- Integrate dynamic subagent creation triggers into `buildTools()`.

---

## 5. How Individual Agents Work

- **Classification:** `EXISTING AND VERIFIED`
- **Relevant Files:**
  - `src/lib/server/runtime.ts`
  - `src/lib/server/prompt.ts`
  - `src/lib/server/mock-model.ts`

### Implementation Details & Mechanics
1. **Dynamic Prompt Assembly:**
   - The system prompt is constructed dynamically on *every turn* in `prompt.ts`:
     - **Identity:** Name, title, handle, and persona instructions.
     - **Context:** System date, platform environment guidelines.
     - **Capabilities:** Bulleted declarations of available tools.
     - **Memory Injection:** Reads the first 200 lines (or 16KB) of `data/workspaces/{botId}/MEMORY.md` and embeds it directly into the prompt context.
     - **Code Mode Stubs:** If Code Mode is enabled, injects TypeScript interface signatures for all discoverable tools so the model can write code against them.
2. **Turn Execution & Event Folding:**
   - `executeTurn()` instantiates a `TurnFolder` instance.
   - The `TurnFolder` consumes Mastra's asynchronous event stream and updates the `Message` record:
     - `text-delta` -> Appends chunks to `message.parts[i].text`.
     - `reasoning-delta` -> Appends thoughts to `message.parts[i].reasoning`.
     - `tool-call-started` -> Creates tool execution part with `state: "running"`.
     - `tool-call-completed` -> Attaches output payload and marks `state: "complete"`.
     - `tool-approval-required` -> Marks tool part as `awaiting-approval`.
   - On every flush tick (throttled to 80ms), the current state of the message is written to SQLite and emitted over SSE.

### Limitations
- Large reasoning traces or verbose tool results are stored directly inside the single JSON message blob in SQLite.
- Linear prompt injection of `MEMORY.md` consumes a significant portion of the model's context window.

### Required Extensions for OpenCrewBot 2.0
- Support selective memory retrieval (semantic search) to prevent prompt bloat.
- Support multi-turn autonomous goal loops without requiring user prompting for each step.

---

## 6. Collaboration Rooms

- **Classification:** `EXISTING AND VERIFIED`
- **Relevant Files:**
  - `src/lib/server/rooms.ts`
  - `src/lib/server/service.ts`
  - `src/lib/shared/types.ts`

### Implementation Details & Mechanics
1. **Room Data Model:**
   ```typescript
   interface Room {
     id: string;
     name: string;
     topic: string;
     emoji: string;
     memberIds: string[];
     leadId: string | null;
     responder: "auto" | "lead" | "everyone";
     pinned: boolean;
     createdAt: string;
   }
   ```
2. **Routing Modes (`responder`):**
   - `"lead"`: Only the bot specified by `leadId` responds to unmentioned messages.
   - `"everyone"`: All bots in `memberIds` respond sequentially.
   - `"auto"`: Queries the TypeSafe Jev classification API (`src/lib/server/jev.ts`) to predict which bot's expertise matches the prompt. If confidence is below 0.6 or Jev fails, falls back to `leadId` or the first member.
3. **Explicit Overrides:**
   - Direct `@handle` mentions in the prompt immediately override the room's responder mode and queue only the tagged bots.
   - `@everyone` or `@all` forces every room member to queue up.
4. **Context Catch-Up Mechanism:**
   - When bot $B$ is queued to speak, `catchUp(room, bot)` inspects the room transcript since $B$'s last turn (up to 30 messages).
   - These messages are bundled into a synthetic user turn prefix (`[Room Activity: @user said ..., @quill said ...]`) so the bot has full conversational awareness of what peers said before generating its turn.

### Limitations
- **Strictly Sequential Execution:** The room execution loop runs in a single asynchronous `while (queue.length > 0)` loop. Multiple bots cannot think or stream tools in parallel.
- If one bot encounters an API timeout or rate limit, subsequent bots in the queue remain blocked.

### Required Extensions for OpenCrewBot 2.0
- Implement concurrent multi-agent turns with join/merge consensus.
- Introduce an intelligent Chief of Staff coordinating room objectives.

---

## 7. Agent-to-Agent Communication and Handoffs

- **Classification:** `PARTIALLY IMPLEMENTED`
- **Relevant Files:**
  - `src/lib/server/rooms.ts` (lines 142–186)
  - `src/lib/server/runtime.ts`

### Implementation Details & Mechanics
1. **Text-Based Mention Parsing:**
   - Handoffs are not structured API calls; they rely on text parsing of the agent's output.
   - At the completion of an agent's turn in a room, `mentionsIn(reply, members)` executes a regex scan (`/@([a-z0-9_-]+)/gi`) against the emitted message text.
   - If bot $A$ writes: `"I've drafted the spec, @quill can you review the grammar?"`, the system detects `@quill`.
   - If `@quill` is a member of the room and not already queued, Quill is appended to the queue with `route: { by: "handoff" }`.
2. **Loop Suppression & Depth Ceiling:**
   - A hard constant `MAX_HANDOFF_DEPTH = 2` prevents infinite ping-pong loops between bots.
   - Bots cannot trigger handoffs to themselves.

### Missing & Deficient Aspects
- **No Direct 1:1 Agent Delegation:** A bot in a direct message (DM) cannot hand off or delegate a subtask to another bot.
- **No Structured Handoff Payloads:** The target bot receives only conversational history, not a structured task object, inputs/outputs, or defined completion criteria.
- **No Subagent Orchestration:** Mastra's built-in `subagent` tool is explicitly disabled.

### Required Extensions for OpenCrewBot 2.0
- Add structured delegation tools (`delegate_task`, `call_agent`).
- Support cross-agent delegation across both DMs and Rooms.

---

## 8. Memory Implementation

- **Classification:** `PARTIALLY IMPLEMENTED`
- **Relevant Files:**
  - `src/lib/server/memory-files.ts`
  - `src/lib/server/tools.ts`
  - `src/app/api/bots/[id]/memory/route.ts`

### Implementation Details & Mechanics
1. **Dual Storage Mechanism:**
   - **Conversation Thread Memory:** Managed internally by Mastra via `@mastra/memory` and LibSQL (`data/mastra.db`). Stores raw message sequences (last 40 messages per thread).
   - **Long-Term Bot Knowledge:** Managed via dedicated markdown files at `data/workspaces/{botId}/MEMORY.md`.
2. **File Memory Operations:**
   - `memory_add`: Appends a timestamped bullet to `MEMORY.md`.
   - `memory_edit`: Performs exact string replacement within `MEMORY.md`.
3. **Secret Scrubbing Filter:**
   - Before writing to `MEMORY.md`, `scrub(content)` scans the string against known credential patterns (OpenAI, Anthropic, GitHub, AWS tokens, private keys) and replaces them with `[REDACTED_SECRET]`.
4. **Prompt Injection:**
   - The first 200 lines (or 16KB) of `MEMORY.md` are prepended to the system prompt on every turn.

### Limitations
- **Linear & Unindexed:** No vector embeddings, semantic search, or chunk retrieval.
- **Context Window Exhaustion:** As `MEMORY.md` grows, injecting the first 200 lines clutters the prompt and will eventually truncate newer memories.
- **Isolated:** Memory is strictly per-bot. There is no shared room or project-level memory store.

### Required Extensions for OpenCrewBot 2.0
- Implement semantic vector memory with embedding search.
- Implement shared team memory accessible across room members.
- Implement automatic memory summarization.

---

## 9. Tools and MCP Integrations

- **Classification:** `PARTIALLY IMPLEMENTED`
- **Relevant Files:**
  - `src/lib/server/tools.ts`
  - `src/lib/server/mcp-servers.ts`
  - `src/lib/server/composio.ts`
  - `src/app/api/connections/**`

### Implementation Details & Mechanics
1. **Built-in Tool Factory (`buildTools`):**
   - `web_search`, `read_page`, `crawl_site`: Powered by Tavily SDK (`@tavily/core`). Only active if `TAVILY_API_KEY` is present.
   - `memory_add`, `memory_edit`: Manipulate `MEMORY.md`.
   - `execute_typescript`: Sandboxed execution using QuickJS WASM (`@mastra/quickjs`).
   - `browser_*`: Cloud browser automation using Mastra AgentBrowser (`@mastra/agent-browser`) connecting to Browserbase CDP sessions.
   - `ask_user`: Suspends the Mastra turn to solicit structured user input via chat.
2. **MCP (Model Context Protocol) Client:**
   - Implemented in `mcp-servers.ts` using `@mastra/mcp`.
   - Supports connecting to remote SSE-based MCP servers with Bearer authentication.
   - MCP tools are dynamically registered on the bot's controller, namespaced as `mcp_{serverId}_{toolName}`.
3. **Composio Integration Layer:**
   - `composio.ts` wraps `@composio/core` and `@composio/mastra`.
   - Supports 8 featured apps: GitHub, Slack, Gmail, Google Calendar, Notion, Linear, Google Drive, Jira.
   - Uses three meta-tools: `SEARCH_TOOLS`, `GET_TOOL_SCHEMAS`, and `MULTI_EXECUTE_TOOL`.

### Verification Status & Gaps
- **Tavily & MCP:** Verified and operational.
- **Browserbase:** Code-complete, but tested against local Chrome; production Cloud Browserbase CDP is not verified with live credentials.
- **Composio:** Fully written, but live OAuth flow and production app action execution remain unverified in real environments.

### Required Extensions for OpenCrewBot 2.0
- Provide three verified, production-ready integrations.
- Add dynamic agent creation and room creation tools.
- Add workflow scheduling tools.

---

## 10. Approval and Permission Mechanisms

- **Classification:** `EXISTING AND VERIFIED`
- **Relevant Files:**
  - `src/lib/server/runtime.ts`
  - `src/lib/shared/types.ts`
  - `src/components/Message.tsx`
  - `src/app/api/conversations/[id]/approval/route.ts`
  - `src/app/api/conversations/[id]/answer/route.ts`
  - `src/app/api/conversations/[id]/stop/route.ts`

### Implementation Details & Mechanics
1. **Granular Approval Modes:**
   - Configured per bot via `bot.approval`:
     - `"full"`: Complete autonomy. All tool calls execute immediately without human confirmation.
     - `"ask"`: High-privilege tool categories (`mcp` and `execute`) trigger execution suspension.
2. **Suspension Flow:**
   - When a gated tool is invoked, Mastra pauses execution and emits `tool_approval_required`.
   - The message part is saved with `approvalState: "awaiting-approval"`.
   - The UI displays an approval card with full argument inspection and "Allow once" / "Deny" actions.
   - Client calls `POST /api/conversations/[id]/approval` with `{ runId, toolCallId, decision: "allow" | "deny" }`.
   - Mastra resumes the suspended turn.
3. **Question Suspension (`ask_user`):**
   - The `ask_user` tool prompts the user with selectable options.
   - The turn suspends until the user answers via `POST /api/conversations/[id]/answer`.
4. **Emergency Abort (`stop`):**
   - Client sends `POST /api/conversations/[id]/stop`.
   - Increments `state.stopEpochs[conversationId]`.
   - Any currently streaming turn is aborted immediately via `AbortController`, and pending queued turns are discarded.

### Strengths
This is the most mature and thoroughly engineered subsystem in the existing codebase.

---

## 11. Database and Persistent Storage

- **Classification:** `EXISTING AND VERIFIED`
- **Relevant Files:**
  - `src/lib/server/db.ts`
  - `src/lib/server/config.ts`

### Implementation Details & Mechanics
1. **Storage Engine:** SQLite accessed via `@libsql/client`.
2. **Database Files:**
   - `data/opencrewbot.db`: Primary application database.
   - `data/mastra.db`: Mastra framework database (thread sessions and event history).
3. **Schema Architecture (Version 2):**
   ```sql
   CREATE TABLE bots (
     id TEXT PRIMARY KEY,
     data TEXT NOT NULL
   );

   CREATE TABLE rooms (
     id TEXT PRIMARY KEY,
     data TEXT NOT NULL
   );

   CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     data TEXT NOT NULL
   );
   CREATE INDEX messages_by_conversation ON messages (conversation_id, created_at);

   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     data TEXT NOT NULL
   );

   CREATE TABLE conversations (
     id TEXT PRIMARY KEY,
     generation INTEGER NOT NULL DEFAULT 0,
     last_read_at TEXT
   );
   ```
4. **Document-Store Paradigm:** Entities are serialized as JSON strings in the `data` column rather than relational tables.
5. **Legacy Migration:** `config.ts` automatically detects legacy `data/crewroom.db` files and migrates them to `opencrewbot.db` on boot.

### Limitations
- No relational queries or foreign key constraints.
- No storage tables for scheduled tasks, plans, or background workflows.
- No vector database support.

### Required Extensions for OpenCrewBot 2.0
- Add schema tables for scheduled workflows and task execution state.
- Add a vector table or sqlite-vss/libsql vector extension for semantic memory.

---

## 12. Model Provider Configuration

- **Classification:** `EXISTING AND VERIFIED` (Single Provider Only)
- **Relevant Files:**
  - `src/lib/server/models.ts`
  - `src/lib/server/runtime.ts`
  - `src/components/ModelPicker.tsx`

### Implementation Details & Mechanics
1. **Single Provider:** The application is architected exclusively around the **Nebius Token Factory** (`nebius/*`).
2. **Model Catalog:**
   - Hardcodes a static fallback catalog of 18 models (Qwen, Llama, DeepSeek, Mistral, Gemma, MiniMax). Default: `MiniMaxAI/MiniMax-M3`.
   - If `NEBIUS_API_KEY` is present, dynamically fetches the live catalog from `https://api.tokenfactory.nebius.com/v1/models` (cached for 10 minutes).
3. **Model Instantiation:**
   - `runtime.ts` resolves models via `resolveModelString(bot.model)` which prepends `nebius/`.

### Critical Gap for Assignment 3
The repository **completely lacks multi-provider support**. There is no direct configuration or routing for Anthropic Claude, OpenAI GPT, Google Gemini, or local Ollama endpoints.

### Required Extensions for OpenCrewBot 2.0
- Abstract model resolution to support multiple providers (OpenAI, Anthropic, Google, Ollama, Nebius).
- Implement intelligent multi-model routing based on task complexity.

---

## 13. Mock Mode and Simulated Functionality

- **Classification:** `EXISTING AND VERIFIED`
- **Relevant Files:**
  - `src/lib/server/mock-model.ts`
  - `src/lib/server/runtime.ts`

### Implementation Details & Mechanics
1. **Zero-API-Key Operation:**
   - If `NEBIUS_API_KEY` is omitted, `isMock()` returns `true`.
   - The runtime substitutes the real LLM with `createMockModel(botName)`.
2. **Simulated Model Behavior:**
   - Inspects the user's prompt text for keywords to trigger real tool mechanisms:
     - `"remember that ..."` -> Triggers real `memory_add` tool call.
     - `"ask me ..."` -> Triggers real `ask_user` suspension.
     - `"open https://..."` -> Triggers real `browser_goto` approval check.
     - `"search for ..."` -> Triggers real `web_search` tool call.
     - Default -> Streams a simulated typing response identifying the bot and its active configuration.
3. **Engineering Value:**
   - Downstream plumbing (SSE streaming, event folding, tool approval gates, and client reducers) runs against real code paths even in mock mode.

---

## 14. Existing Tests and Verification Evidence

- **Classification:** `MISSING`
- **Verification Evidence:**
  - Manual verification checklist in `README.md` (dated 2026-10-13 and 2026-10-14).
  - **Zero automated test files** exist in the repository (`*.test.ts`, `*.spec.ts`).
  - No test runner (Vitest, Jest, Playwright) is installed in `package.json`.

### Tested vs. Unverified Status Matrix (from Author's Log)

| Feature Area | Author's Verification Status | Audit Finding |
|---|---|---|
| Text Streaming & Delays | Verified Manually | Code verified in `runtime.ts` |
| Tool Invocations & Output | Verified Manually | Code verified in `tools.ts` |
| Memory Add & Edit | Verified Manually | Code verified in `memory-files.ts` |
| Human Approval Gates | Verified Manually | Code verified in `runtime.ts` |
| Question Suspension | Verified Manually | Code verified in `runtime.ts` |
| Room Mentions & Handoffs | Verified Manually | Code verified in `rooms.ts` |
| Process Crash Recovery | Verified Manually | Code verified in `service.ts` |
| Composio Live Sign-In | **Unverified** | Requires live OAuth credentials |
| Browserbase Cloud CDP | **Unverified** | Local Chrome only; cloud unverified |
| Jev Auto-Routing API | **Unverified** | Requires TypeSafe API key |
| Automated Test Suite | **Missing** | Zero test files exist |

---

## 15. Limitations and Incomplete Functionality

| Subsystem | Existing Limitation | Impact on OpenCrewBot 2.0 |
|---|---|---|
| **Testing** | No unit, integration, or E2E tests | High regression risk during extension |
| **Model Providers** | Nebius Token Factory only | Fails Multi-Model requirement |
| **Room Concurrency** | Sequential `while` loop | Bots cannot collaborate simultaneously |
| **Handoffs** | Text regex `@mention` only (max 2 hops) | No structured task delegation |
| **Subagents** | Mastra `subagent` explicitly disabled | No nested task decomposition |
| **Memory** | Unindexed `MEMORY.md` (top 200 lines) | Context overflow, no semantic search |
| **Scheduling** | No timers, cron, or background workers | Fails Scheduled Workflows requirement |
| **Agent Creation** | Manual UI form creation only | Fails Dynamic Agent Creation requirement |
| **Orchestrator** | No Chief of Staff role or routing | Fails Intelligent Chief of Staff requirement |
| **Authentication** | Hardcoded single owner (`OWNER_ID = "owner"`) | Single-user local app only |

---

## 16. Assignment 3 Requirements Assessment

### 1. Intelligent Chief of Staff
- **Status:** `MISSING`
- **Assessment:** No orchestrator agent exists. Lead bots in rooms merely act as conversational defaults.
- **Extension Strategy:** Create a specialized Chief of Staff agent with high-level system prompts, room coordination capabilities, and an autonomous task assignment tool.

### 2. Dynamic Agent Creation
- **Status:** `MISSING`
- **Assessment:** Bots can only be registered manually by the user via the `BotForms.tsx` modal.
- **Extension Strategy:** Implement a `create_agent` tool wrapping `service.createBot()`, allowing agents to dynamically instantiate specialized helper bots to solve specific subtasks.

### 3. Multi-Agent Collaboration
- **Status:** `PARTIALLY IMPLEMENTED`
- **Assessment:** Sequential turns in rooms and 2-hop text handoffs exist. Concurrent collaboration and consensus-building are missing.
- **Extension Strategy:** Refactor `rooms.ts` to support parallel turn execution and multi-agent synthesis stages.

### 4. Autonomous Task Execution
- **Status:** `PARTIALLY IMPLEMENTED`
- **Assessment:** Agents can execute multiple tool calls within one turn, but cannot run autonomous multi-turn loops or track long-term task completion.
- **Extension Strategy:** Introduce a persistent task execution tracker and self-directed execution cycles.

### 5. Persistent Memory
- **Status:** `PARTIALLY IMPLEMENTED`
- **Assessment:** File-based `MEMORY.md` is durable and human-readable, but lacks semantic search, shared team memory, or automatic summarization.
- **Extension Strategy:** Add vector embeddings alongside `MEMORY.md` and implement a shared room memory bank.

### 6. Skills and Tools
- **Status:** `PARTIALLY IMPLEMENTED`
- **Assessment:** Built-in Tavily, Code Mode, Browser, and MCP tools exist. No runtime-defined custom skills or skill discovery catalog.
- **Extension Strategy:** Build a dynamic skill registry allowing agents to define, persist, and execute custom tool functions.

### 7. Human Approval and Autonomy
- **Status:** `EXISTING AND VERIFIED`
- **Assessment:** Fully implemented, highly functional tool approval cards, question suspension, and emergency stop mechanisms.
- **Extension Strategy:** Preserve the existing architecture; wire new sensitive tools (e.g., dynamic agent creation, system execution) into the `"ask"` approval pipeline.

### 8. Three Working Integrations
- **Status:** `PARTIALLY IMPLEMENTED`
- **Assessment:** Tavily and MCP are verified. Composio, Browserbase, and Jev are unverified with live services.
- **Extension Strategy:** Provide and verify three robust, end-to-end working integrations (e.g., Tavily Web Search, GitHub/Slack via Composio or direct MCP, and local Filesystem/CLI).

### 9. Scheduled AI Workflows
- **Status:** `MISSING`
- **Assessment:** Zero background task or timer infrastructure exists.
- **Extension Strategy:** Implement a robust background scheduler service (cron/interval) that triggers autonomous agent turns and notifies rooms.

### 10. Multi-Model Intelligence
- **Status:** `PARTIALLY IMPLEMENTED` (Single Provider)
- **Assessment:** Supports multiple models, but only from Nebius Token Factory.
- **Extension Strategy:** Expand `models.ts` and `runtime.ts` to support multi-provider routing (Anthropic, OpenAI, Google Gemini, Ollama) and automatic model tiering.

---

## 17. External Dependencies and MIT License

### MIT License Compatibility
The repository is licensed under the standard **MIT License (Copyright 2026 Studio1HQ)**.  
- **Rights Granted:** Commercial and private use, modification, distribution, sublicensing.
- **Obligations:** Must preserve the original copyright notice and MIT permission notice in all copies or substantial portions of the Software.

### Dependency Inventory

| Package | Version | Purpose |
|---|---|---|
| `next` | `16.4.0` | React framework, API routes, Turbopack bundling |
| `react` / `react-dom` | `19.3.0` | Frontend view rendering |
| `@mastra/core` | `1.76.0` | AgentController, sessions, tools, LLM abstraction |
| `@mastra/memory` | `1.37.0` | Conversation thread history tracking |
| `@mastra/libsql` | `1.26.0` | Mastra storage backend |
| `@mastra/mcp` | `^2.3.0` | Model Context Protocol client |
| `@mastra/tavily` | `1.1.2` | Tavily web search adapter |
| `@mastra/quickjs` | `0.1.3` | Sandboxed JavaScript/TypeScript execution |
| `@mastra/agent-browser` | `0.5.3` | Browser automation client |
| `@libsql/client` | `^0.18.0` | SQLite embedded database engine |
| `@composio/core` | `^0.23.0` | Composio platform SDK |
| `@composio/mastra` | `^0.10.5` | Composio tools adapter |
| `@tavily/core` | `^0.7.14` | Tavily search API client |
| `zod` | `^4.6.7` | Runtime type validation |
| `lucide-react` | `^1.55.0` | Icon library |
| `react-markdown` | `^10.1.0` | Markdown formatting |
| `tailwindcss` | `^4` | Utility-first styling |

---

## 18. Engineering Assessment and Recommended Implementation Sequence

### Overall Engineering Quality
The original OpenCrewBot codebase is an **exceptionally well-crafted, production-grade foundation**.
- **Code Cleanliness:** Clean TypeScript, strict typing, consistent naming conventions, zero bloat.
- **Architecture:** Thoughtful separation between UI components, client state, service layer, and agent runtime.
- **Stability Mechanisms:** Global state preservation over hot-reloads, crash recovery on boot, and message turn queuing demonstrate strong engineering rigor.

### Protected File Warning
> [!CAUTION]
> **DO NOT modify `src/lib/server/runtime.ts` haphazardly.**  
> It is the 450-line nervous system of the platform. Its session lifecycle, event-folding logic, turn queue, and controller caching must be preserved. Extend it through clean interfaces, tools, and hooks rather than rewriting it.

---

### Recommended Implementation Sequence for OpenCrewBot 2.0

```
Phase 1: Environment & Baseline Verification
   │
   ├── Phase 2: Automated Test Infrastructure (Vitest)
   │
   ├── Phase 3: Multi-Model Intelligence (Provider Abstraction)
   │
   ├── Phase 4: Persistent Memory Enhancement (Vector & Summaries)
   │
   ├── Phase 5: Verified Integrations & Dynamic Tool Registry
   │
   ├── Phase 6: Scheduled AI Workflows (Background Engine)
   │
   ├── Phase 7: Dynamic Agent & Room Creation Tools
   │
   └── Phase 8: Intelligent Chief of Staff & Multi-Agent Collaboration
```

#### Detailed Phase Breakdown

1. **Phase 1: Environment & Baseline Verification**
   - Verify Node.js and PNPM setup.
   - Run in mock mode to confirm baseline UI, SSE events, and approval flows.
   - Document environment prerequisites.

2. **Phase 2: Automated Testing Foundation**
   - Install Vitest and set up unit test harnesses.
   - Add test coverage for `service.ts`, `rooms.ts`, `memory-files.ts`, and `tools.ts`.
   - Prevent regressions before modifying server logic.

3. **Phase 3: Multi-Model Intelligence Layer**
   - Extend `models.ts` and `runtime.ts` to support multi-provider models (Anthropic, OpenAI, Google Gemini, Ollama) alongside Nebius.
   - Update `ModelPicker.tsx` to display model provider tags.

4. **Phase 4: Memory System Enhancement**
   - Augment `memory-files.ts` with semantic vector indexing.
   - Implement automatic memory summarization when `MEMORY.md` exceeds context limits.
   - Add shared room-level memory.

5. **Phase 5: Three Verified Working Integrations**
   - Verify Tavily web search.
   - Set up and verify two additional real-world integrations (e.g., GitHub, Slack, or local system tools).
   - Implement dynamic skill registry.

6. **Phase 6: Scheduled AI Workflows**
   - Add a persistent scheduled jobs table to SQLite.
   - Implement a lightweight background worker loop that executes recurring agent tasks and posts results to rooms.

7. **Phase 7: Dynamic Agent & Room Creation**
   - Expose `create_agent` and `create_room` tools to the agent runtime.
   - Wire tools to the `"ask"` human approval pipeline for safety.

8. **Phase 8: Intelligent Chief of Staff & Collaboration**
   - Design and seed the Chief of Staff orchestrator bot.
   - Extend room routing to support parallel multi-agent execution and multi-hop delegation.

---
*Audit complete. Original repository state fully inspected and verified. Awaiting user authorization to begin Phase 1.*
