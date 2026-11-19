import { connection } from "next/server";
import { handle } from "@/lib/server/http";
import {
  connectIntegration,
  disconnectIntegration,
  getIntegration,
} from "@/lib/server/integrations";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  return handle(async () => {
    const handler = getIntegration(id);
    if (!handler) {
      throw new Error(`Integration "${id}" not found.`);
    }
    const status = await handler.getStatus();
    const actions = handler.getActions().map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      category: a.category,
      inputSchema: a.inputSchema,
    }));
    return { integration: status, actions };
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(async () => {
    let body: { credentials?: Record<string, string>; action?: "connect" | "disconnect" } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }

    if (body.action === "disconnect") {
      const state = await disconnectIntegration(id);
      return { integration: state };
    }

    const state = await connectIntegration(id, body.credentials);
    return { integration: state };
  });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(async () => {
    const state = await disconnectIntegration(id);
    return { integration: state };
  });
}
