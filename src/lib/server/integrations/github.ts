import { z } from "zod";
import { isMock } from "../config";
import { getSetting, setSetting } from "../db";
import type { ExecutionMode, IntegrationState } from "@/lib/shared/types";
import type { IntegrationAction, IntegrationHandler } from "./types";

const SETTING_KEY = "integration.github";

interface GitHubSettings {
  connected: boolean;
  token?: string;
  forceMock?: boolean;
}

async function getStoredSettings(): Promise<GitHubSettings> {
  const s = await getSetting<GitHubSettings>(SETTING_KEY);
  return s ?? { connected: true }; // default connected in mock mode
}

export class GitHubIntegration implements IntegrationHandler {
  readonly id = "github";
  readonly name = "GitHub";
  readonly slug = "github";
  readonly category = "developer_tools";
  readonly authType = "pat";

  private getToken(settings: GitHubSettings): string | undefined {
    return settings.token || process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
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
      token: token || undefined,
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
        message: "GitHub integration is disconnected or missing GITHUB_TOKEN.",
        actionsCount,
      };
    }

    if (mode === "MOCK") {
      return {
        ok: true,
        executionMode: mode,
        message: "GitHub simulated connection verified in mock environment.",
        actionsCount,
      };
    }

    // LIVE mode: check GitHub API
    const settings = await getStoredSettings();
    const token = this.getToken(settings);
    try {
      const res = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "OpenCrewBot-2.0",
          Accept: "application/vnd.github.v3+json",
        },
        signal: AbortSignal.timeout(4000),
      });

      if (!res.ok) {
        return {
          ok: false,
          executionMode: "LIVE",
          message: `GitHub authentication failed: HTTP ${res.status}`,
          actionsCount,
        };
      }

      const user = (await res.json()) as { login?: string };
      return {
        ok: true,
        executionMode: "LIVE",
        message: `Connected to GitHub as @${user.login || "authenticated-user"}.`,
        actionsCount,
      };
    } catch (err) {
      return {
        ok: false,
        executionMode: "LIVE",
        message: `GitHub connection error: ${err instanceof Error ? err.message : String(err)}`,
        actionsCount,
      };
    }
  }

  getActions(): IntegrationAction[] {
    return [
      {
        id: "github_inspect_repo",
        name: "Inspect Repository",
        description: "Inspect metadata, stars, default branch, and overview of a GitHub repository.",
        category: "read",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "Repository owner or organization." },
            repo: { type: "string", description: "Repository name." },
          },
          required: ["owner", "repo"],
        },
        zodSchema: z.object({
          owner: z.string().min(1).describe("Repository owner or org"),
          repo: z.string().min(1).describe("Repository name"),
        }),
        execute: async (rawInput) => {
          const input = rawInput as { owner: string; repo: string };
          const mode = await this.getExecutionMode();

          if (mode === "UNAVAILABLE") {
            throw new Error("GitHub integration is not connected or credentials are missing.");
          }

          if (mode === "MOCK") {
            return {
              executionMode: "MOCK",
              integration: "github",
              owner: input.owner,
              repo: input.repo,
              fullName: `${input.owner}/${input.repo}`,
              description: `Open-source codebase repository for ${input.repo}`,
              defaultBranch: "main",
              stars: 142,
              forks: 28,
              openIssues: 5,
              license: "MIT",
              archived: false,
            };
          }

          const settings = await getStoredSettings();
          const token = this.getToken(settings);
          const res = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}`, {
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              "User-Agent": "OpenCrewBot-2.0",
              Accept: "application/vnd.github.v3+json",
            },
            signal: AbortSignal.timeout(8000),
          });

          if (!res.ok) {
            throw new Error(`GitHub inspect repo failed: HTTP ${res.status}`);
          }

          const data = (await res.json()) as Record<string, unknown>;
          return {
            executionMode: "LIVE",
            integration: "github",
            owner: input.owner,
            repo: input.repo,
            fullName: data.full_name,
            description: data.description,
            defaultBranch: data.default_branch,
            stars: data.stargazers_count,
            forks: data.forks_count,
            openIssues: data.open_issues_count,
            license: (data.license as { spdx_id?: string })?.spdx_id ?? "unknown",
            archived: data.archived,
          };
        },
      },
      {
        id: "github_read_file",
        name: "Read Repository File",
        description: "Read the text contents of a file inside a GitHub repository.",
        category: "read",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "Repository owner." },
            repo: { type: "string", description: "Repository name." },
            path: { type: "string", description: "Path to file inside repository." },
            ref: { type: "string", description: "Optional git branch, tag, or commit hash." },
          },
          required: ["owner", "repo", "path"],
        },
        zodSchema: z.object({
          owner: z.string().min(1),
          repo: z.string().min(1),
          path: z.string().min(1),
          ref: z.string().optional(),
        }),
        execute: async (rawInput) => {
          const input = rawInput as { owner: string; repo: string; path: string; ref?: string };
          const mode = await this.getExecutionMode();

          if (mode === "UNAVAILABLE") {
            throw new Error("GitHub integration is not connected or credentials are missing.");
          }

          if (mode === "MOCK") {
            return {
              executionMode: "MOCK",
              integration: "github",
              path: input.path,
              content: `# ${input.repo}\nSimulated content for ${input.path} on branch ${input.ref || "main"}.\n\nexport const VERSION = "2.0.0";`,
              size: 84,
              encoding: "utf-8",
            };
          }

          const settings = await getStoredSettings();
          const token = this.getToken(settings);
          const url = new URL(`https://api.github.com/repos/${input.owner}/${input.repo}/contents/${input.path}`);
          if (input.ref) url.searchParams.set("ref", input.ref);

          const res = await fetch(url.toString(), {
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              "User-Agent": "OpenCrewBot-2.0",
              Accept: "application/vnd.github.v3+json",
            },
            signal: AbortSignal.timeout(8000),
          });

          if (!res.ok) {
            throw new Error(`GitHub read file failed: HTTP ${res.status}`);
          }

          const data = (await res.json()) as { content?: string; size?: number; encoding?: string };
          let content = "";
          if (data.content && data.encoding === "base64") {
            content = Buffer.from(data.content, "base64").toString("utf-8");
          }

          return {
            executionMode: "LIVE",
            integration: "github",
            path: input.path,
            content,
            size: data.size,
            encoding: "utf-8",
          };
        },
      },
      {
        id: "github_list_issues",
        name: "List Issues & Pull Requests",
        description: "List issues and pull requests in a GitHub repository.",
        category: "read",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            state: { type: "string", enum: ["open", "closed", "all"] },
            limit: { type: "number" },
          },
          required: ["owner", "repo"],
        },
        zodSchema: z.object({
          owner: z.string().min(1),
          repo: z.string().min(1),
          state: z.enum(["open", "closed", "all"]).optional(),
          limit: z.number().int().min(1).max(50).optional(),
        }),
        execute: async (rawInput) => {
          const input = rawInput as { owner: string; repo: string; state?: "open" | "closed" | "all"; limit?: number };
          const mode = await this.getExecutionMode();

          if (mode === "UNAVAILABLE") {
            throw new Error("GitHub integration is not connected or credentials are missing.");
          }

          if (mode === "MOCK") {
            return {
              executionMode: "MOCK",
              integration: "github",
              count: 3,
              issues: [
                { number: 42, title: "Implement Dynamic Tool Registry", state: "open", author: "lead-dev", createdAt: "2026-11-19T10:00:00Z" },
                { number: 41, title: "Optimize Mastra turn queue", state: "closed", author: "cipher", createdAt: "2026-11-18T14:30:00Z" },
                { number: 40, title: "Fix SQLite schema v4 indexes", state: "closed", author: "atlas", createdAt: "2026-11-18T09:15:00Z" },
              ].slice(0, input.limit ?? 10),
            };
          }

          const settings = await getStoredSettings();
          const token = this.getToken(settings);
          const url = new URL(`https://api.github.com/repos/${input.owner}/${input.repo}/issues`);
          url.searchParams.set("state", input.state || "open");
          url.searchParams.set("per_page", String(input.limit || 10));

          const res = await fetch(url.toString(), {
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              "User-Agent": "OpenCrewBot-2.0",
              Accept: "application/vnd.github.v3+json",
            },
            signal: AbortSignal.timeout(8000),
          });

          if (!res.ok) {
            throw new Error(`GitHub list issues failed: HTTP ${res.status}`);
          }

          const data = (await res.json()) as Array<{ number: number; title: string; state: string; user?: { login?: string }; created_at: string }>;
          return {
            executionMode: "LIVE",
            integration: "github",
            count: data.length,
            issues: data.map((i) => ({
              number: i.number,
              title: i.title,
              state: i.state,
              author: i.user?.login ?? "anonymous",
              createdAt: i.created_at,
            })),
          };
        },
      },
      {
        id: "github_create_issue",
        name: "Create Repository Issue",
        description: "Create a new issue on a GitHub repository. Requires human approval under Controlled Access.",
        category: "edit",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
          },
          required: ["owner", "repo", "title"],
        },
        zodSchema: z.object({
          owner: z.string().min(1),
          repo: z.string().min(1),
          title: z.string().min(1),
          body: z.string().optional(),
        }),
        execute: async (rawInput) => {
          const input = rawInput as { owner: string; repo: string; title: string; body?: string };
          const mode = await this.getExecutionMode();

          if (mode === "UNAVAILABLE") {
            throw new Error("GitHub integration is not connected or credentials are missing.");
          }

          if (mode === "MOCK") {
            return {
              executionMode: "MOCK",
              integration: "github",
              created: true,
              issueNumber: 105,
              title: input.title,
              url: `https://github.com/${input.owner}/${input.repo}/issues/105`,
              state: "open",
            };
          }

          const settings = await getStoredSettings();
          const token = this.getToken(settings);
          if (!token) throw new Error("A GitHub token with repo scope is required to create issues.");

          const res = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/issues`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "User-Agent": "OpenCrewBot-2.0",
              Accept: "application/vnd.github.v3+json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ title: input.title, body: input.body }),
            signal: AbortSignal.timeout(8000),
          });

          if (!res.ok) {
            throw new Error(`GitHub create issue failed: HTTP ${res.status}`);
          }

          const data = (await res.json()) as { number: number; html_url: string; state: string; title: string };
          return {
            executionMode: "LIVE",
            integration: "github",
            created: true,
            issueNumber: data.number,
            title: data.title,
            url: data.html_url,
            state: data.state,
          };
        },
      },
    ];
  }
}
