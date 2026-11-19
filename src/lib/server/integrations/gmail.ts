import { z } from "zod";
import { isMock } from "../config";
import { getSetting, setSetting } from "../db";
import type { ExecutionMode, IntegrationState } from "@/lib/shared/types";
import type { IntegrationAction, IntegrationHandler } from "./types";

const SETTING_KEY = "integration.gmail";

interface GmailSettings {
  connected: boolean;
  accessToken?: string;
  forceMock?: boolean;
}

async function getStoredSettings(): Promise<GmailSettings> {
  const s = await getSetting<GmailSettings>(SETTING_KEY);
  return s ?? { connected: true };
}

export class GmailIntegration implements IntegrationHandler {
  readonly id = "gmail";
  readonly name = "Gmail";
  readonly slug = "gmail";
  readonly category = "communication";
  readonly authType = "oauth";

  private getToken(settings: GmailSettings): string | undefined {
    return settings.accessToken || process.env.GOOGLE_OAUTH_TOKEN || process.env.GMAIL_API_KEY;
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
      accessToken: token || undefined,
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
        message: "Gmail integration is disconnected or missing OAuth credentials.",
        actionsCount,
      };
    }

    if (mode === "MOCK") {
      return {
        ok: true,
        executionMode: mode,
        message: "Gmail simulated connection verified in mock environment.",
        actionsCount,
      };
    }

    const settings = await getStoredSettings();
    const token = this.getToken(settings);
    try {
      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(4000),
      });

      if (!res.ok) {
        return {
          ok: false,
          executionMode: "LIVE",
          message: `Gmail profile check failed: HTTP ${res.status}`,
          actionsCount,
        };
      }

      const data = (await res.json()) as { emailAddress?: string };
      return {
        ok: true,
        executionMode: "LIVE",
        message: `Connected to Gmail as ${data.emailAddress || "user@gmail.com"}.`,
        actionsCount,
      };
    } catch (err) {
      return {
        ok: false,
        executionMode: "LIVE",
        message: `Gmail connection error: ${err instanceof Error ? err.message : String(err)}`,
        actionsCount,
      };
    }
  }

  getActions(): IntegrationAction[] {
    return [
      {
        id: "gmail_search_emails",
        name: "Search Emails",
        description: "Search Gmail messages matching a query.",
        category: "read",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query string (e.g., from:colleague, subject:launch)." },
            maxResults: { type: "number", description: "Maximum number of messages to return." },
          },
          required: ["query"],
        },
        zodSchema: z.object({
          query: z.string().min(1),
          maxResults: z.number().int().min(1).max(20).optional(),
        }),
        execute: async (rawInput) => {
          const input = rawInput as { query: string; maxResults?: number };
          const mode = await this.getExecutionMode();

          if (mode === "UNAVAILABLE") {
            throw new Error("Gmail integration is not connected or credentials are missing.");
          }

          if (mode === "MOCK") {
            return {
              executionMode: "MOCK",
              integration: "gmail",
              query: input.query,
              count: 2,
              messages: [
                {
                  id: "msg_mock_001",
                  threadId: "th_001",
                  subject: "Q4 Project Roadmap & Launch Schedule",
                  from: "sarah@company.com",
                  date: "2026-11-19T08:30:00Z",
                  snippet: "Here is the finalized roadmap for OpenCrewBot 2.0 release...",
                },
                {
                  id: "msg_mock_002",
                  threadId: "th_002",
                  subject: "Action required: Architecture review",
                  from: "alex@company.com",
                  date: "2026-11-18T16:45:00Z",
                  snippet: "Please review the proposed security and tool gating specification.",
                },
              ].slice(0, input.maxResults ?? 10),
            };
          }

          const settings = await getStoredSettings();
          const token = this.getToken(settings);
          const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
          url.searchParams.set("q", input.query);
          url.searchParams.set("maxResults", String(input.maxResults || 10));

          const res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8000),
          });

          if (!res.ok) {
            throw new Error(`Gmail search failed: HTTP ${res.status}`);
          }

          const data = (await res.json()) as { messages?: Array<{ id: string; threadId: string }> };
          return {
            executionMode: "LIVE",
            integration: "gmail",
            query: input.query,
            count: data.messages?.length ?? 0,
            messages: data.messages ?? [],
          };
        },
      },
      {
        id: "gmail_read_email",
        name: "Read Email",
        description: "Read full details, sender, recipient, and content of an email message.",
        category: "read",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The ID of the message to retrieve." },
          },
          required: ["messageId"],
        },
        zodSchema: z.object({
          messageId: z.string().min(1),
        }),
        execute: async (rawInput) => {
          const input = rawInput as { messageId: string };
          const mode = await this.getExecutionMode();

          if (mode === "UNAVAILABLE") {
            throw new Error("Gmail integration is not connected or credentials are missing.");
          }

          if (mode === "MOCK") {
            return {
              executionMode: "MOCK",
              integration: "gmail",
              id: input.messageId,
              subject: "Q4 Project Roadmap & Launch Schedule",
              from: "sarah@company.com",
              to: "team@company.com",
              date: "2026-11-19T08:30:00Z",
              body: "Team,\n\nThe phase 5 milestone is on track for completion this week. Let's make sure the tool registry and external integrations pass security review.\n\nBest,\nSarah",
              labels: ["INBOX", "IMPORTANT"],
            };
          }

          const settings = await getStoredSettings();
          const token = this.getToken(settings);
          const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${input.messageId}?format=full`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8000),
          });

          if (!res.ok) {
            throw new Error(`Gmail read message failed: HTTP ${res.status}`);
          }

          const data = (await res.json()) as Record<string, unknown>;
          return {
            executionMode: "LIVE",
            integration: "gmail",
            id: input.messageId,
            snippet: data.snippet,
            headers: (data.payload as { headers?: unknown[] })?.headers,
          };
        },
      },
      {
        id: "gmail_create_draft",
        name: "Create Email Draft",
        description: "Create an email draft in Gmail without sending it. Requires human approval under Controlled Access.",
        category: "edit",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
          },
          required: ["to", "subject", "body"],
        },
        zodSchema: z.object({
          to: z.string().min(1),
          subject: z.string().min(1),
          body: z.string().min(1),
        }),
        execute: async (rawInput) => {
          const input = rawInput as { to: string; subject: string; body: string };
          const mode = await this.getExecutionMode();

          if (mode === "UNAVAILABLE") {
            throw new Error("Gmail integration is not connected or credentials are missing.");
          }

          if (mode === "MOCK") {
            return {
              executionMode: "MOCK",
              integration: "gmail",
              draftCreated: true,
              draftId: "draft_mock_9921",
              to: input.to,
              subject: input.subject,
              status: "draft_saved",
            };
          }

          const settings = await getStoredSettings();
          const token = this.getToken(settings);
          const emailLines = [`To: ${input.to}`, `Subject: ${input.subject}`, "Content-Type: text/plain; charset=utf-8", "", input.body];
          const raw = Buffer.from(emailLines.join("\r\n")).toString("base64url");

          const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ message: { raw } }),
            signal: AbortSignal.timeout(8000),
          });

          if (!res.ok) {
            throw new Error(`Gmail create draft failed: HTTP ${res.status}`);
          }

          const data = (await res.json()) as { id: string };
          return {
            executionMode: "LIVE",
            integration: "gmail",
            draftCreated: true,
            draftId: data.id,
            to: input.to,
            subject: input.subject,
            status: "draft_saved",
          };
        },
      },
      {
        id: "gmail_send_email",
        name: "Send Email",
        description: "Send an email message via Gmail. Requires human approval under Ask First and Controlled Access.",
        category: "execute",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
          },
          required: ["to", "subject", "body"],
        },
        zodSchema: z.object({
          to: z.string().min(1),
          subject: z.string().min(1),
          body: z.string().min(1),
        }),
        execute: async (rawInput) => {
          const input = rawInput as { to: string; subject: string; body: string };
          const mode = await this.getExecutionMode();

          if (mode === "UNAVAILABLE") {
            throw new Error("Gmail integration is not connected or credentials are missing.");
          }

          if (mode === "MOCK") {
            return {
              executionMode: "MOCK",
              integration: "gmail",
              sent: true,
              messageId: "sent_mock_8812",
              to: input.to,
              subject: input.subject,
              status: "delivered",
            };
          }

          const settings = await getStoredSettings();
          const token = this.getToken(settings);
          const emailLines = [`To: ${input.to}`, `Subject: ${input.subject}`, "Content-Type: text/plain; charset=utf-8", "", input.body];
          const raw = Buffer.from(emailLines.join("\r\n")).toString("base64url");

          const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ raw }),
            signal: AbortSignal.timeout(8000),
          });

          if (!res.ok) {
            throw new Error(`Gmail send message failed: HTTP ${res.status}`);
          }

          const data = (await res.json()) as { id: string };
          return {
            executionMode: "LIVE",
            integration: "gmail",
            sent: true,
            messageId: data.id,
            to: input.to,
            subject: input.subject,
            status: "delivered",
          };
        },
      },
    ];
  }
}
