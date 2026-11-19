import { z } from "zod";
import { isMock } from "../config";
import { getSetting, setSetting } from "../db";
import type { ExecutionMode, IntegrationState } from "@/lib/shared/types";
import type { IntegrationAction, IntegrationHandler } from "./types";

const SETTING_KEY = "integration.slack";

interface SlackSettings {
  connected: boolean;
  botToken?: string;
  forceMock?: boolean;
}

async function getStoredSettings(): Promise<SlackSettings> {
  const s = await getSetting<SlackSettings>(SETTING_KEY);
  return s ?? { connected: true };
}

export class SlackIntegration implements IntegrationHandler {
  readonly id = "slack";
  readonly name = "Slack";
  readonly slug = "slack";
  readonly category = "communication";
  readonly authType = "bot_token";

  private getToken(settings: SlackSettings): string | undefined {
    return settings.botToken || process.env.SLACK_BOT_TOKEN;
  }

  async getExecutionMode(): Promise<ExecutionMode> {
    const settings = await getStoredSettings();
    if (!settings.connected) return "UNAVAILABLE";
    if (settings.forceMock || isMock() || process.env.NODE_ENV === "test") return "MOCK";
    const token = this.getToken(settings);
    if (!token) return "UNAVAILABLE";
    return "LIVE";
  }

  async getStatus(): Promise<IntegrationState> {
    const settings = await getStoredSettings();
    const mode = await this.getExecutionMode();
    const token = this.getToken(settings);
    const hasCredentials = Boolean(token);

    return {
      id: this.id,
      name: this.name,
      slug: this.slug,
      category: this.category,
      status: settings.connected ? "connected" : "disconnected",
      executionMode: mode,
      authType: this.authType,
      hasCredentials,
      actionsCount: this.getActions().length,
    };
  }

  async connect(credentials?: Record<string, string>): Promise<IntegrationState> {
    const token = credentials?.token?.trim();
    await setSetting(SETTING_KEY, {
      connected: true,
      botToken: token || undefined,
      forceMock: credentials?.mock === "true",
    });
    return this.getStatus();
  }

  async disconnect(): Promise<IntegrationState> {
    await setSetting(SETTING_KEY, { connected: false });
    return this.getStatus();
  }

  async test(): Promise<{ ok: boolean; executionMode: ExecutionMode; message: string; actionsCount: number }> {
    const mode = await this.getExecutionMode();
    const actionsCount = this.getActions().length;

    if (mode === "UNAVAILABLE") {
      return {
        ok: false,
        executionMode: mode,
        message: "Slack integration is disconnected or missing SLACK_BOT_TOKEN.",
        actionsCount,
      };
    }

    if (mode === "MOCK") {
      return {
        ok: true,
        executionMode: mode,
        message: "Slack simulated connection verified in mock environment.",
        actionsCount,
      };
    }

    const settings = await getStoredSettings();
    const token = this.getToken(settings);
    try {
      const res = await fetch("https://slack.com/api/auth.test", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(4000),
      });

      if (!res.ok) {
        return {
          ok: false,
          executionMode: "LIVE",
          message: `Slack auth check failed: HTTP ${res.status}`,
          actionsCount,
        };
      }

      const data = (await res.json()) as { ok: boolean; user?: string; team?: string; error?: string };
      if (!data.ok) {
        return {
          ok: false,
          executionMode: "LIVE",
          message: `Slack error: ${data.error || "invalid auth"}`,
          actionsCount,
        };
      }

      return {
        ok: true,
        executionMode: "LIVE",
        message: `Connected to Slack team '${data.team}' as @${data.user}.`,
        actionsCount,
      };
    } catch (err) {
      return {
        ok: false,
        executionMode: "LIVE",
        message: `Slack connection error: ${err instanceof Error ? err.message : String(err)}`,
        actionsCount,
      };
    }
  }

  getActions(): IntegrationAction[] {
    return [
      {
        id: "slack_search_messages",
        name: "Search Messages",
        description: "Search Slack conversation history across channels.",
        category: "read",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query string." },
            count: { type: "number", description: "Number of matching messages to return." },
          },
          required: ["query"],
        },
        zodSchema: z.object({
          query: z.string().min(1),
          count: z.number().int().min(1).max(20).optional(),
        }),
        execute: async (rawInput) => {
          const input = rawInput as { query: string; count?: number };
          const mode = await this.getExecutionMode();

          if (mode === "UNAVAILABLE") {
            throw new Error("Slack integration is not connected or credentials are missing.");
          }

          if (mode === "MOCK") {
            return {
              executionMode: "MOCK",
              integration: "slack",
              query: input.query,
              count: 2,
              messages: [
                {
                  channel: "#general",
                  user: "alice",
                  text: "Remember team all-hands is scheduled for tomorrow at 10am.",
                  ts: "1732000000.001",
                  permalink: "https://workspace.slack.com/archives/C123/p1732000000001",
                },
                {
                  channel: "#engineering",
                  user: "bob",
                  text: "The Phase 5 test suite is passing all integration checks.",
                  ts: "1732000500.002",
                  permalink: "https://workspace.slack.com/archives/C456/p1732000500002",
                },
              ].slice(0, input.count ?? 10),
            };
          }

          const settings = await getStoredSettings();
          const token = this.getToken(settings);
          const url = new URL("https://slack.com/api/search.messages");
          url.searchParams.set("query", input.query);
          url.searchParams.set("count", String(input.count || 10));

          const res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8000),
          });

          if (!res.ok) {
            throw new Error(`Slack search failed: HTTP ${res.status}`);
          }

          const data = (await res.json()) as { ok: boolean; messages?: { matches?: unknown[] }; error?: string };
          if (!data.ok) {
            throw new Error(`Slack API error: ${data.error}`);
          }

          return {
            executionMode: "LIVE",
            integration: "slack",
            query: input.query,
            count: data.messages?.matches?.length ?? 0,
            messages: data.messages?.matches ?? [],
          };
        },
      },
      {
        id: "slack_read_channel",
        name: "Read Channel",
        description: "Read channel metadata and recent messages from a Slack channel.",
        category: "read",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel ID or name." },
            limit: { type: "number", description: "Number of messages to retrieve." },
          },
          required: ["channel"],
        },
        zodSchema: z.object({
          channel: z.string().min(1),
          limit: z.number().int().min(1).max(50).optional(),
        }),
        execute: async (rawInput) => {
          const input = rawInput as { channel: string; limit?: number };
          const mode = await this.getExecutionMode();

          if (mode === "UNAVAILABLE") {
            throw new Error("Slack integration is not connected or credentials are missing.");
          }

          if (mode === "MOCK") {
            return {
              executionMode: "MOCK",
              integration: "slack",
              channel: input.channel,
              channelName: input.channel.replace(/^#/, ""),
              topic: "Company announcements & discussions",
              memberCount: 24,
              messages: [
                { user: "carol", text: "Welcome to the new sprint!", ts: "1732001000.001" },
                { user: "dave", text: "Please review PR #42 when free.", ts: "1732001200.002" },
              ].slice(0, input.limit ?? 10),
            };
          }

          const settings = await getStoredSettings();
          const token = this.getToken(settings);
          const url = new URL("https://slack.com/api/conversations.history");
          url.searchParams.set("channel", input.channel);
          url.searchParams.set("limit", String(input.limit || 10));

          const res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8000),
          });

          if (!res.ok) {
            throw new Error(`Slack read channel failed: HTTP ${res.status}`);
          }

          const data = (await res.json()) as { ok: boolean; messages?: unknown[]; error?: string };
          if (!data.ok) {
            throw new Error(`Slack API error: ${data.error}`);
          }

          return {
            executionMode: "LIVE",
            integration: "slack",
            channel: input.channel,
            messages: data.messages ?? [],
          };
        },
      },
      {
        id: "slack_post_message",
        name: "Post Slack Message",
        description: "Post a new message to a Slack channel. Requires human approval under Ask First and Controlled Access.",
        category: "execute",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Target channel ID or name (e.g., #announcements)." },
            text: { type: "string", description: "The message text to post." },
          },
          required: ["channel", "text"],
        },
        zodSchema: z.object({
          channel: z.string().min(1),
          text: z.string().min(1),
        }),
        execute: async (rawInput) => {
          const input = rawInput as { channel: string; text: string };
          const mode = await this.getExecutionMode();

          if (mode === "UNAVAILABLE") {
            throw new Error("Slack integration is not connected or credentials are missing.");
          }

          if (mode === "MOCK") {
            return {
              executionMode: "MOCK",
              integration: "slack",
              posted: true,
              channel: input.channel,
              ts: "1732002000.099",
              message: input.text,
              status: "delivered",
            };
          }

          const settings = await getStoredSettings();
          const token = this.getToken(settings);
          const res = await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ channel: input.channel, text: input.text }),
            signal: AbortSignal.timeout(8000),
          });

          if (!res.ok) {
            throw new Error(`Slack post message failed: HTTP ${res.status}`);
          }

          const data = (await res.json()) as { ok: boolean; channel?: string; ts?: string; error?: string };
          if (!data.ok) {
            throw new Error(`Slack API error: ${data.error}`);
          }

          return {
            executionMode: "LIVE",
            integration: "slack",
            posted: true,
            channel: data.channel,
            ts: data.ts,
            message: input.text,
            status: "delivered",
          };
        },
      },
    ];
  }
}
