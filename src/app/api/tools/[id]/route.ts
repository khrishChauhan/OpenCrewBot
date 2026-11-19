import { connection } from "next/server";
import { handle } from "@/lib/server/http";
import {
  disableTool,
  enableTool,
  getTool,
  unregisterTool,
} from "@/lib/server/tool-registry";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  return handle(async () => {
    const tool = await getTool(id);
    if (!tool) {
      throw new Error(`Tool "${id}" not found.`);
    }
    return { tool };
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(async () => {
    const body = (await request.json()) as { action?: "enable" | "disable"; enabled?: boolean };
    const shouldEnable = body.action === "enable" || body.enabled === true;
    const tool = shouldEnable ? await enableTool(id) : await disableTool(id);
    return { tool };
  });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(async () => {
    const success = await unregisterTool(id);
    return { success };
  });
}
