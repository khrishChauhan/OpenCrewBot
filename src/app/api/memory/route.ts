import { body, handle } from "@/lib/server/http";
import { InputError } from "@/lib/server/service";
import type { MemoryCategory, MemoryScope } from "@/lib/server/memory-types";
import { listMemoryRecords, searchMemories } from "@/lib/server/memory-store";
import { syncScopeMemory } from "@/lib/server/memory-files";
import { listBots, listRooms } from "@/lib/server/db";

export async function GET(request: Request) {
  return handle(async () => {
    const url = new URL(request.url);
    const query = url.searchParams.get("query") ?? url.searchParams.get("q");
    const scope = (url.searchParams.get("scope") as MemoryScope) || undefined;
    const scopeId = url.searchParams.get("scopeId") || undefined;
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 10;

    if (query) {
      const results = await searchMemories(query, { scope, scopeId, limit });
      return { query, count: results.length, results };
    }

    if (scope && scopeId) {
      const records = await listMemoryRecords(scope, scopeId);
      return { scope, scopeId, count: records.length, records };
    }

    return { ok: true, message: "Provide ?query=... for search or ?scope=...&scopeId=... to list records." };
  });
}

interface MemoryActionBody {
  action?: "search" | "reindex";
  query?: string;
  scope?: MemoryScope | "all";
  scopeId?: string;
  category?: MemoryCategory;
  limit?: number;
}

export async function POST(request: Request) {
  return handle(async () => {
    const payload = await body<MemoryActionBody>(request);
    const action = payload.action ?? (payload.query ? "search" : "reindex");

    if (action === "search") {
      if (!payload.query || typeof payload.query !== "string") {
        throw new InputError("Field 'query' is required for search.");
      }
      const effectiveScope = payload.scope === "all" ? undefined : payload.scope;
      const results = await searchMemories(payload.query, {
        scope: effectiveScope,
        scopeId: payload.scopeId,
        limit: payload.limit ?? 5,
      });
      return { query: payload.query, count: results.length, results };
    }

    if (action === "reindex") {
      let count = 0;
      if (payload.scope && payload.scopeId && payload.scope !== "all") {
        await syncScopeMemory(payload.scope, payload.scopeId);
        count++;
      } else {
        // Reindex all known agents and rooms
        const [bots, rooms] = await Promise.all([listBots(), listRooms()]);
        for (const bot of bots) {
          await syncScopeMemory("agent", bot.id);
          count++;
        }
        for (const room of rooms) {
          await syncScopeMemory("room", room.id);
          count++;
        }
      }
      return { ok: true, reindexed: count };
    }

    throw new InputError(`Unknown memory action '${action}'. Expected 'search' or 'reindex'.`);
  });
}
