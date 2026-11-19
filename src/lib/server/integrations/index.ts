import { GitHubIntegration } from "./github";
import { GmailIntegration } from "./gmail";
import { SlackIntegration } from "./slack";
import type { IntegrationAction, IntegrationHandler } from "./types";
import type { ExecutionMode, IntegrationState } from "@/lib/shared/types";
import { publish } from "../bus";

// Singleton instances
const github = new GitHubIntegration();
const gmail = new GmailIntegration();
const slack = new SlackIntegration();

const integrationsMap = new Map<string, IntegrationHandler>([
  [github.id, github],
  [gmail.id, gmail],
  [slack.id, slack],
]);

export function getIntegration(id: string): IntegrationHandler | undefined {
  return integrationsMap.get(id);
}

export function getAllIntegrations(): IntegrationHandler[] {
  return Array.from(integrationsMap.values());
}

export async function listIntegrations(): Promise<IntegrationState[]> {
  const list: IntegrationState[] = [];
  for (const handler of integrationsMap.values()) {
    list.push(await handler.getStatus());
  }
  return list;
}

export async function connectIntegration(id: string, credentials?: Record<string, string>): Promise<IntegrationState> {
  const handler = integrationsMap.get(id);
  if (!handler) {
    throw new Error(`Integration "${id}" not found.`);
  }
  const state = await handler.connect(credentials);
  publish({ type: "integrations-changed" });
  return state;
}

export async function disconnectIntegration(id: string): Promise<IntegrationState> {
  const handler = integrationsMap.get(id);
  if (!handler) {
    throw new Error(`Integration "${id}" not found.`);
  }
  const state = await handler.disconnect();
  publish({ type: "integrations-changed" });
  return state;
}

export async function testIntegration(id: string): Promise<{ ok: boolean; executionMode: ExecutionMode; message: string; actionsCount: number }> {
  const handler = integrationsMap.get(id);
  if (!handler) {
    throw new Error(`Integration "${id}" not found.`);
  }
  return handler.test();
}

export function getAllIntegrationActions(): Array<{ integrationId: string; action: IntegrationAction }> {
  const actions: Array<{ integrationId: string; action: IntegrationAction }> = [];
  for (const handler of integrationsMap.values()) {
    for (const action of handler.getActions()) {
      actions.push({ integrationId: handler.id, action });
    }
  }
  return actions;
}

export function getIntegrationAction(actionId: string): { integration: IntegrationHandler; action: IntegrationAction } | undefined {
  for (const handler of integrationsMap.values()) {
    const act = handler.getActions().find((a) => a.id === actionId);
    if (act) {
      return { integration: handler, action: act };
    }
  }
  return undefined;
}
