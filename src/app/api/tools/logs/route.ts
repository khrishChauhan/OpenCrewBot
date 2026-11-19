import { connection } from "next/server";
import { handle } from "@/lib/server/http";
import { getExecutionLogs } from "@/lib/server/tool-registry";

export async function GET(request: Request) {
  await connection();
  const { searchParams } = new URL(request.url);
  const toolId = searchParams.get("toolId") || undefined;
  const botId = searchParams.get("botId") || undefined;
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;

  return handle(async () => {
    const logs = await getExecutionLogs({ toolId, botId, limit });
    return { logs };
  });
}
