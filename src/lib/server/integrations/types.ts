import { z } from "zod";
import type { ExecutionMode, IntegrationState, ToolCategory } from "@/lib/shared/types";

export interface IntegrationAction {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: Record<string, unknown>;
  zodSchema: z.ZodTypeAny;
  execute: (input: unknown, context: { botId?: string; conversationId?: string; isMock?: boolean }) => Promise<unknown>;
}

export interface IntegrationHandler {
  id: string;
  name: string;
  slug: string;
  category: string;
  authType: string;
  getExecutionMode: () => Promise<ExecutionMode>;
  getStatus: () => Promise<IntegrationState>;
  connect: (credentials?: Record<string, string>) => Promise<IntegrationState>;
  disconnect: () => Promise<IntegrationState>;
  test: () => Promise<{ ok: boolean; executionMode: ExecutionMode; message: string; actionsCount: number }>;
  getActions: () => IntegrationAction[];
}
