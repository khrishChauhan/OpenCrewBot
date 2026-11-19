import { connection } from "next/server";
import { handle } from "@/lib/server/http";
import { listTools, registerTool } from "@/lib/server/tool-registry";
import type { ToolCategory, ToolSource } from "@/lib/shared/types";

export async function GET(request: Request) {
  await connection();
  const { searchParams } = new URL(request.url);
  const category = (searchParams.get("category") as ToolCategory) || undefined;
  const source = (searchParams.get("source") as ToolSource) || undefined;
  const integrationId = searchParams.get("integrationId") || undefined;
  const enabledParam = searchParams.get("enabled");
  const enabled = enabledParam !== null ? enabledParam === "true" || enabledParam === "1" : undefined;

  return handle(async () => {
    const tools = await listTools({ category, source, enabled, integrationId });
    return { tools };
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const body = (await request.json()) as {
      id: string;
      name: string;
      description: string;
      category: ToolCategory;
      source?: ToolSource;
      integrationId?: string;
      inputSchema?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      requiredPermission?: ToolCategory;
      enabled?: boolean;
      authorizedAgentIds?: string[];
      config?: Record<string, unknown>;
    };

    const tool = await registerTool(body);
    return { tool };
  });
}
