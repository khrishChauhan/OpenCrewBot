import { body, handle } from "@/lib/server/http";
import { getRoom } from "@/lib/server/db";
import { publish } from "@/lib/server/bus";
import { MEMORY_PROMPT_LIMIT, readScopeMemory, scopeMemoryPath, writeScopeMemory } from "@/lib/server/memory-files";
import { InputError } from "@/lib/server/service";

async function requireRoom(id: string) {
  if (!(await getRoom(id))) throw new InputError("That room doesn't exist.");
}

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(async () => {
    await requireRoom(id);
    return {
      content: readScopeMemory("room", id),
      path: scopeMemoryPath("room", id),
      limit: MEMORY_PROMPT_LIMIT,
    };
  });
}

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(async () => {
    await requireRoom(id);
    const { content } = await body<{ content: string }>(request);
    if (typeof content !== "string") throw new InputError("Expected { content }.");
    const saved = writeScopeMemory("room", id, content);
    publish({ type: "room-memory-changed", roomId: id });
    return { content: saved };
  });
}
