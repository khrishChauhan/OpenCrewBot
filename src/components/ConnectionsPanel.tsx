"use client";

import clsx from "clsx";
import {
  ArrowUpRight,
  Check,
  Plug,
  Search,
  Server,
  Trash2,
  Wrench,
  Activity,
  RotateCw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { useConnections } from "@/lib/client/use-connections";
import type {
  ComposioApp,
  IntegrationState,
  RegisteredTool,
  ToolCategory,
  ToolExecutionLog,
} from "@/lib/shared/types";
import { useApp } from "./OpenCrewBotApp";
import { Button, Drawer, Field, inputClass } from "./ui";

function AppLogo({ app, size = 28 }: { app: { name: string; logo?: string }; size?: number }) {
  return app.logo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={app.logo} alt="" width={size} height={size} className="shrink-0 rounded-lg bg-white/90 object-contain p-1" />
  ) : (
    <span className="flex shrink-0 items-center justify-center rounded-lg bg-raised-2 text-[12px] font-semibold" style={{ width: size, height: size }}>
      {app.name.slice(0, 1)}
    </span>
  );
}

function AppRow({ app, onChanged }: { app: ComposioApp; onChanged: () => void }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    try {
      const { redirectUrl } = await api.connectApp(app.slug);
      window.location.href = redirectUrl;
    } catch (error) {
      toast(error instanceof Error ? error.message : `Couldn't start connecting ${app.name}.`);
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm(`Disconnect ${app.name}? Bots lose access to it until you connect it again.`)) return;
    setBusy(true);
    try {
      await api.disconnectApp(app.slug);
      toast(`${app.name} disconnected.`);
      onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : `Couldn't disconnect ${app.name}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <AppLogo app={app} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium">{app.name}</span>
        {app.connected && (
          <span className="flex items-center gap-1 text-[12px] text-ok">
            <Check size={12} strokeWidth={3} /> Connected
          </span>
        )}
      </span>
      {app.connected ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={disconnect}>
          Disconnect
        </Button>
      ) : (
        <Button size="sm" variant="primary" disabled={busy} onClick={connect}>
          Connect
        </Button>
      )}
    </li>
  );
}

function AddServerForm({ onAdded }: { onAdded: () => void }) {
  const { toast } = useApp();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.addMcpServer({ name, url, token: token || undefined });
      toast(`${name} added.`);
      setName("");
      setUrl("");
      setToken("");
      setOpen(false);
      onAdded();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't add MCP server.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} className="w-full">
        + Add MCP server
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-2xl bg-raised p-4">
      <h4 className="mb-3 text-[14px] font-medium">Add MCP server</h4>
      <Field label="Name">
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sentry" className={inputClass} />
      </Field>
      <div className="mt-3">
        <Field label="URL (SSE endpoint)">
          <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" className={inputClass} />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Auth token (optional)">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Bearer token, if the server requires one"
            className={inputClass}
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {busy ? "Connecting…" : "Add server"}
        </Button>
      </div>
    </form>
  );
}

function ModeBadge({ mode }: { mode: "LIVE" | "MOCK" | "UNAVAILABLE" }) {
  const styles = {
    LIVE: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    MOCK: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    UNAVAILABLE: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  };
  return (
    <span className={clsx("inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-mono font-medium border", styles[mode])}>
      {mode}
    </span>
  );
}

function CategoryBadge({ category }: { category: ToolCategory }) {
  const colors: Record<ToolCategory, string> = {
    read: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    edit: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    execute: "bg-purple-500/15 text-purple-400 border-purple-500/30",
    mcp: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
    other: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  };
  return (
    <span className={clsx("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase font-mono border", colors[category] ?? colors.other)}>
      {category}
    </span>
  );
}

export function ConnectionsPanel({ onClose }: { onClose: () => void }) {
  const { toast, state } = useApp();
  const { data, error, reload, loading } = useConnections(state.connectionsVersion);
  const [tab, setTab] = useState<"integrations" | "tools" | "logs" | "mcp">("integrations");

  // Integrations state
  const [integrations, setIntegrations] = useState<IntegrationState[]>([]);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  // Tools state
  const [tools, setTools] = useState<RegisteredTool[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [togglingToolId, setTogglingToolId] = useState<string | null>(null);

  // Logs state
  const [logs, setLogs] = useState<ToolExecutionLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  // Composio search state
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ComposioApp[] | null>(null);
  const [testingMcp, setTestingMcp] = useState<string | null>(null);

  const fetchIntegrations = async () => {
    try {
      const res = await api.listIntegrations();
      setIntegrations(res.integrations);
    } catch {
      // fallback to data
    }
  };

  const fetchTools = async () => {
    try {
      const res = await api.listTools();
      setTools(res.tools);
    } catch {
      // ignore
    }
  };

  const fetchLogs = async () => {
    setLoadingLogs(true);
    try {
      const res = await api.getToolExecutionLogs({ limit: 40 });
      setLogs(res.logs);
    } catch {
      // ignore
    } finally {
      setLoadingLogs(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    api
      .listIntegrations()
      .then((res) => {
        if (!cancelled) setIntegrations(res.integrations);
      })
      .catch(() => {});
    api
      .listTools()
      .then((res) => {
        if (!cancelled) setTools(res.tools);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [state.connectionsVersion]);

  useEffect(() => {
    if (tab !== "logs") return;
    let cancelled = false;
    api
      .getToolExecutionLogs({ limit: 40 })
      .then((res) => {
        if (!cancelled) setLogs(res.logs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tab]);

  // Search Composio
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const timer = window.setTimeout(() => {
      api
        .searchApps(q)
        .then(({ apps }) => setResults(apps))
        .catch(() => setResults([]));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const handleTestIntegration = async (id: string, name: string) => {
    setTestingId(id);
    try {
      const res = await api.testIntegration(id);
      toast(`${name}: ${res.message} [${res.executionMode}]`);
      await fetchIntegrations();
    } catch (e) {
      toast(`${name} test failed: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setTestingId(null);
    }
  };

  const handleToggleIntegration = async (intg: IntegrationState) => {
    setConnectingId(intg.id);
    try {
      if (intg.status === "connected") {
        await api.disconnectIntegration(intg.id);
        toast(`Disconnected ${intg.name}`);
      } else {
        await api.connectIntegration(intg.id);
        toast(`Connected ${intg.name}`);
      }
      await fetchIntegrations();
      await fetchTools();
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setConnectingId(null);
    }
  };

  const handleToggleTool = async (tool: RegisteredTool) => {
    setTogglingToolId(tool.id);
    try {
      if (tool.enabled) {
        await api.disableTool(tool.id);
        toast(`Disabled tool "${tool.name}"`);
      } else {
        await api.enableTool(tool.id);
        toast(`Enabled tool "${tool.name}"`);
      }
      await fetchTools();
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setTogglingToolId(null);
    }
  };

  const handleDeleteTool = async (id: string, name: string) => {
    if (!window.confirm(`Delete custom tool "${name}"?`)) return;
    try {
      await api.removeTool(id);
      toast(`Deleted tool "${name}"`);
      await fetchTools();
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const testMcp = async (id: string, name: string) => {
    setTestingMcp(id);
    try {
      const { tools: count } = await api.testMcpServer(id);
      toast(`${name} is reachable: ${count} tools.`);
    } catch (e) {
      toast(`${name}: ${e instanceof Error ? e.message : "couldn't connect"}`);
    } finally {
      setTestingMcp(null);
    }
  };

  const removeMcp = async (id: string, name: string) => {
    if (!window.confirm(`Remove ${name}? Bots that use it lose access.`)) return;
    try {
      await api.removeMcpServer(id);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't remove it.");
    }
  };

  const displayedIntegrations = integrations.length > 0 ? integrations : data?.integrations ?? [];
  const filteredTools = selectedCategory === "all" ? tools : tools.filter((t) => t.category === selectedCategory);
  const apps = query.trim() ? results ?? [] : data?.composio.apps ?? [];

  return (
    <Drawer title="Integrations & Tool Registry" onClose={onClose}>
      <p className="text-[13px] leading-relaxed text-mute">
        Manage verified integrations (GitHub, Gmail, Slack), dynamically registered agent tools, execution logs, and external MCP servers.
      </p>

      {/* Tabs */}
      <div className="mt-4 flex rounded-xl bg-raised p-1 text-[13px] font-medium">
        <button
          onClick={() => setTab("integrations")}
          className={clsx(
            "flex-1 py-1.5 px-3 rounded-lg text-center transition-colors",
            tab === "integrations" ? "bg-raised-2 text-ink shadow-sm" : "text-mute hover:text-ink",
          )}
        >
          Integrations
        </button>
        <button
          onClick={() => setTab("tools")}
          className={clsx(
            "flex-1 py-1.5 px-3 rounded-lg text-center transition-colors",
            tab === "tools" ? "bg-raised-2 text-ink shadow-sm" : "text-mute hover:text-ink",
          )}
        >
          Tools ({tools.length})
        </button>
        <button
          onClick={() => setTab("logs")}
          className={clsx(
            "flex-1 py-1.5 px-3 rounded-lg text-center transition-colors",
            tab === "logs" ? "bg-raised-2 text-ink shadow-sm" : "text-mute hover:text-ink",
          )}
        >
          History
        </button>
        <button
          onClick={() => setTab("mcp")}
          className={clsx(
            "flex-1 py-1.5 px-3 rounded-lg text-center transition-colors",
            tab === "mcp" ? "bg-raised-2 text-ink shadow-sm" : "text-mute hover:text-ink",
          )}
        >
          MCP & Apps
        </button>
      </div>

      {/* ── TAB 1: INTEGRATIONS ────────────────────────────────────────── */}
      {tab === "integrations" && (
        <section className="mt-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[12.5px] font-medium text-mute flex items-center gap-1.5">
              <Plug size={13} /> Verified External Integrations
            </h3>
            <button
              onClick={fetchIntegrations}
              className="text-[12px] text-faint hover:text-ink flex items-center gap-1"
            >
              <RotateCw size={11} /> Refresh
            </button>
          </div>

          <div className="space-y-3">
            {displayedIntegrations.map((intg) => (
              <div key={intg.id} className="rounded-2xl bg-raised p-4 border border-line">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[14px]">{intg.name}</span>
                      <ModeBadge mode={intg.executionMode} />
                    </div>
                    <p className="mt-1 text-[12px] text-mute">
                      {intg.category} &middot; {intg.actionsCount} actions &middot; {intg.authType.toUpperCase()} auth
                    </p>
                    {intg.error && <p className="mt-1 text-[11px] text-danger">{intg.error}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={testingId === intg.id}
                      onClick={() => handleTestIntegration(intg.id, intg.name)}
                    >
                      {testingId === intg.id ? "Testing..." : "Test"}
                    </Button>
                    <Button
                      size="sm"
                      variant={intg.status === "connected" ? "ghost" : "primary"}
                      disabled={connectingId === intg.id}
                      onClick={() => handleToggleIntegration(intg)}
                    >
                      {intg.status === "connected" ? "Disconnect" : "Connect"}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── TAB 2: TOOL REGISTRY ──────────────────────────────────────── */}
      {tab === "tools" && (
        <section className="mt-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[12.5px] font-medium text-mute flex items-center gap-1.5">
              <Wrench size={13} /> Dynamic Tool Registry
            </h3>
            <div className="flex items-center gap-1 text-[12px]">
              {(["all", "read", "edit", "execute"] as const).map((cat) => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={clsx(
                    "px-2 py-0.5 rounded text-[11px] uppercase transition-colors",
                    selectedCategory === cat ? "bg-raised-2 text-ink font-semibold" : "text-faint hover:text-mute",
                  )}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y divide-line rounded-2xl bg-raised overflow-hidden">
            {filteredTools.map((t) => (
              <div key={t.id} className="p-3.5 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[13px] font-medium truncate">{t.id}</span>
                    <CategoryBadge category={t.category} />
                    <span className="text-[10px] uppercase font-mono px-1 rounded bg-raised-2 text-faint">
                      {t.source}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] text-mute line-clamp-1">{t.description}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant={t.enabled ? "ghost" : "primary"}
                    disabled={togglingToolId === t.id}
                    onClick={() => handleToggleTool(t)}
                  >
                    {t.enabled ? "Disable" : "Enable"}
                  </Button>
                  {t.source === "custom" && (
                    <button
                      onClick={() => handleDeleteTool(t.id, t.name)}
                      className="p-1.5 text-faint hover:text-danger rounded-lg transition-colors"
                      title="Delete custom tool"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
            {filteredTools.length === 0 && (
              <p className="p-6 text-center text-[13px] text-faint">No tools match the selected category.</p>
            )}
          </div>
        </section>
      )}

      {/* ── TAB 3: EXECUTION LOGS ─────────────────────────────────────── */}
      {tab === "logs" && (
        <section className="mt-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[12.5px] font-medium text-mute flex items-center gap-1.5">
              <Activity size={13} /> Tool Execution History
            </h3>
            <button
              onClick={fetchLogs}
              disabled={loadingLogs}
              className="text-[12px] text-faint hover:text-ink flex items-center gap-1"
            >
              <RotateCw size={11} className={clsx(loadingLogs && "animate-spin")} /> Refresh
            </button>
          </div>

          <div className="space-y-2">
            {logs.map((log) => (
              <div key={log.id} className="rounded-xl bg-raised p-3 border border-line text-[12px]">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-mono">
                    <span className="font-semibold">{log.toolName}</span>
                    <ModeBadge mode={log.executionMode} />
                  </div>
                  <span
                    className={clsx(
                      "font-mono text-[11px] px-1.5 py-0.2 rounded font-medium",
                      log.status === "success" && "text-emerald-400 bg-emerald-500/10",
                      log.status === "denied" && "text-amber-400 bg-amber-500/10",
                      log.status === "error" && "text-rose-400 bg-rose-500/10",
                    )}
                  >
                    {log.status.toUpperCase()}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] text-faint">
                  <span>{log.durationMs !== undefined ? `${log.durationMs}ms` : "-"}</span>
                  <span>{new Date(log.createdAt).toLocaleTimeString()}</span>
                </div>
                {log.error && <p className="mt-1 text-[11px] text-danger">{log.error}</p>}
              </div>
            ))}
            {logs.length === 0 && (
              <p className="p-6 text-center text-[13px] text-faint">No tool executions recorded yet.</p>
            )}
          </div>
        </section>
      )}

      {/* ── TAB 4: COMPOSIO & MCP ─────────────────────────────────────── */}
      {tab === "mcp" && (
        <>
          <section className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-[12.5px] font-medium text-mute">
                <Plug size={13} /> Apps via Composio
              </h3>
              <a
                href="https://composio.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-[12px] text-faint hover:text-ink"
              >
                composio.dev <ArrowUpRight size={12} />
              </a>
            </div>

            {loading && <p className="rounded-2xl bg-raised px-4 py-6 text-center text-[13px] text-mute">Loading…</p>}
            {error && <p className="rounded-2xl bg-danger-soft px-4 py-3 text-[13px] text-danger">{error}</p>}

            {data && !data.composio.enabled && (
              <div className="rounded-2xl bg-raised px-4 py-4">
                <p className="text-[14px] font-medium">Connect 1,000+ Apps with Composio</p>
                <p className="mt-1 text-[13px] leading-relaxed text-mute">
                  Add <code className="rounded-md bg-raised-2 px-1 font-mono text-[12px]">COMPOSIO_API_KEY</code> to{" "}
                  <code className="rounded-md bg-raised-2 px-1 font-mono text-[12px]">.env</code> to enable extra catalog apps.
                </p>
              </div>
            )}

            {data?.composio.enabled && (
              <>
                {data.composio.error && (
                  <p className="mb-2 rounded-2xl bg-danger-soft px-4 py-3 text-[13px] text-danger">{data.composio.error}</p>
                )}
                <label className="mb-2 flex h-10 items-center gap-2 rounded-full bg-raised px-3.5 ring-1 ring-line focus-within:ring-2 focus-within:ring-accent">
                  <Search size={15} className="text-faint" aria-hidden />
                  <input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      if (!e.target.value.trim()) setResults(null);
                    }}
                    placeholder="Search all apps"
                    aria-label="Search apps"
                    className="min-w-0 flex-1 bg-transparent text-[14px] placeholder:text-faint focus:outline-none"
                  />
                </label>
                <ul className={clsx("divide-y divide-line rounded-2xl bg-raised", apps.length === 0 && "hidden")}>
                  {apps.map((app) => (
                    <AppRow key={app.slug} app={app} onChanged={reload} />
                  ))}
                </ul>
                {query.trim() && results && results.length === 0 && (
                  <p className="px-1 py-3 text-[13px] text-mute">No apps match.</p>
                )}
              </>
            )}
          </section>

          <section className="mt-7">
            <h3 className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-mute">
              <Server size={13} /> Your MCP servers
            </h3>
            {data && data.mcpServers.length > 0 && (
              <ul className="mb-3 divide-y divide-line rounded-2xl bg-raised">
                {data.mcpServers.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium">{s.name}</span>
                      <span className="block truncate text-[12px] text-faint">
                        {s.url}
                        {s.hasToken ? " · token set" : ""}
                      </span>
                    </span>
                    <Button size="sm" variant="ghost" disabled={testingMcp === s.id} onClick={() => testMcp(s.id, s.name)}>
                      {testingMcp === s.id ? "Testing…" : "Test"}
                    </Button>
                    <button
                      aria-label={`Remove ${s.name}`}
                      onClick={() => removeMcp(s.id, s.name)}
                      className="rounded-full p-2 text-faint hover:bg-raised-2 hover:text-danger"
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <AddServerForm onAdded={reload} />
          </section>
        </>
      )}
    </Drawer>
  );
}
