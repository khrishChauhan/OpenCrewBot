import { connection } from "next/server";
import type { ConnectionsState } from "@/lib/shared/types";
import { handle } from "@/lib/server/http";
import { keys } from "@/lib/server/config";
import { listApps } from "@/lib/server/composio";
import { listServers } from "@/lib/server/mcp-servers";
import { mcpServerNames } from "@/lib/server/connectors";
import { listIntegrations } from "@/lib/server/integrations";

export async function GET() {
  await connection();
  return handle(async (): Promise<ConnectionsState> => {
    const mcpServers = await listServers();
    for (const s of mcpServers) mcpServerNames.set(s.id, s.name);
    const integrations = await listIntegrations();
    if (!keys.composio()) return { composio: { enabled: false, apps: [] }, mcpServers, integrations };
    try {
      return { composio: { enabled: true, apps: await listApps() }, mcpServers, integrations };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't reach Composio.";
      return { composio: { enabled: true, apps: [], error: message }, mcpServers, integrations };
    }
  });
}
