"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Toggle } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

const MAX_LOG_LINES = 500;
const POLL_MS = 15000;

const VERDICT_VARIANT = {
  OK: "success",
  quota: "warning",
  flagged: "error",
  blocked: "error",
  unreachable: "error",
  err: "warning",
};

function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return "never";
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${(seconds / 3600).toFixed(1)}h ago`;
}

function formatBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Color by the engine's own level markers; the daemon prefixes lines with
// ✓ / ✗ / ⚠ and tags health summaries, so matching those beats re-parsing.
function lineClass(line) {
  if (line.includes("✗") || line.includes("🚨")) return "text-red-400";
  if (line.includes("⚠") || line.includes("↻")) return "text-amber-400";
  if (line.includes("✓") || line.includes("→")) return "text-green-400";
  if (line.includes("出口=")) return "text-blue-300";
  return "text-neutral-300";
}

export default function AutoSwitchIpClient() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const [consoleCollapsed, setConsoleCollapsed] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef(null);
  const notify = useNotificationStore();

  const loadStatus = useCallback(
    async (deep = true) => {
      try {
        const res = await fetch(`/api/autoswitchip/status${deep ? "?deep=1" : ""}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to load status");
        setStatus(data);
      } catch (err) {
        // Status polling must not spam toasts: a gateway restart would emit one
        // per interval. The console panel already shows the engine's own log.
        if (err?.message && !/fetch|network|Failed to load/i.test(err.message)) {
          notify?.error?.(err.message);
        }
      } finally {
        setLoading(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    // Deferred one tick: the first poll must not setState synchronously in the
    // effect body (cascading render), and the interval covers every later poll.
    const kick = setTimeout(() => loadStatus(true), 0);
    const timer = setInterval(() => loadStatus(true), POLL_MS);
    return () => {
      clearTimeout(kick);
      clearInterval(timer);
    };
  }, [loadStatus]);

  // Log stream: EventSource reconnects on its own after a server restart, which
  // matters here because enabling the engine can restart nothing but still
  // produces a new log file.
  useEffect(() => {
    const es = new EventSource("/api/autoswitchip/logs/stream");
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "init") {
        setLogs((msg.lines || []).slice(-MAX_LOG_LINES));
      } else if (msg.type === "lines") {
        setLogs((prev) => {
          const next = [...prev, ...msg.lines];
          return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
        });
      } else if (msg.type === "clear") {
        setLogs([]);
      }
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  useEffect(() => {
    if (!autoScroll || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, autoScroll]);

  const handleToggle = async (enabled) => {
    setToggling(true);
    try {
      const res = await fetch("/api/autoswitchip", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to update");
      setStatus(data);
      notify?.success?.(enabled ? "Auto Switch IP enabled" : "Auto Switch IP disabled");
    } catch (err) {
      notify?.error?.(err.message);
      await loadStatus(false);
    } finally {
      setToggling(false);
    }
  };

  const handleClearLog = async () => {
    try {
      await fetch("/api/autoswitchip/logs", { method: "DELETE" });
      setLogs([]);
    } catch (err) {
      notify?.error?.(err.message);
    }
  };

  const engine = status?.engine;
  const enabled = status?.enabled === true;
  const running = status?.running === true;
  const ready = status?.installed && status?.binaries?.singbox !== false;

  const stateBadge = useMemo(() => {
    if (running) return { variant: "success", label: "running" };
    if (enabled) return { variant: "warning", label: "enabled, not running" };
    return { variant: "default", label: "off" };
  }, [running, enabled]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-text-main">Auto Switch IP</h1>
        <p className="text-sm text-text-muted mt-1">
          Rotates the WARP egress used for OpenCode&apos;s free tier so its per-IP quota
          keeps resetting. Runs as a local engine alongside the gateway.
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="p-2.5 rounded-[10px] bg-bg text-text-muted">
              <span className="material-symbols-outlined text-[22px]">swap_horiz</span>
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-text-main font-semibold">Engine</h2>
                <Badge variant={stateBadge.variant} size="sm" dot>
                  {stateBadge.label}
                </Badge>
                {engine?.host?.tunnelMode && (
                  <Badge variant="info" size="sm">
                    tunnels: {engine.host.tunnelMode}
                  </Badge>
                )}
                {status?.platform && (
                  <Badge variant="default" size="sm">
                    {status.platform === "win32" ? "Windows" : status.platform}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-text-muted mt-1">
                {running
                  ? `PID ${status.pid} · engine log and tunnels below`
                  : enabled
                    ? "Enabled, but the engine process is not running. Check the log."
                    : "The engine is stopped. Enable it to start rotating egress IPs."}
              </p>
              {status && !status.installed && (
                <p className="text-xs text-red-500 mt-1">
                  Engine source missing at autoswitchip/daemon.py
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Toggle
              checked={enabled}
              onChange={handleToggle}
              disabled={toggling || loading || !status?.installed}
              label={enabled ? "On" : "Off"}
            />
            <Button
              size="sm"
              variant="outline"
              icon="refresh"
              loading={toggling || loading}
              onClick={() => loadStatus(true)}
            >
              Refresh
            </Button>
          </div>
        </div>

        {status?.lastError && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
            <p className="text-xs font-semibold text-red-500">Last start failure</p>
            <p className="text-xs text-red-400 mt-0.5 break-words">{status.lastError}</p>
          </div>
        )}

        {status && !ready && status.installed && (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <p className="text-xs font-semibold text-amber-500">Requirements not provisioned</p>
            <p className="text-xs text-amber-400 mt-0.5">
              Enabling downloads sing-box and usque for this host into{" "}
              <code className="font-mono">{status.binDir}</code>. Python with{" "}
              <code className="font-mono">requests</code> and{" "}
              <code className="font-mono">PyYAML</code> is required to run the engine.
            </p>
          </div>
        )}

        {engine?.ok && (
          <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-4 border-t border-border-subtle pt-5">
            <div>
              <p className="text-xs text-text-muted">Exit mode</p>
              <p className="text-sm font-medium text-text-main mt-0.5">
                {engine.mode === "warp"
                  ? "WARP tunnel"
                  : engine.mode === "proxy"
                    ? "Proxy pool"
                    : "Unknown"}
              </p>
            </div>
            <div>
              <p className="text-xs text-text-muted">Active line</p>
              <p className="text-sm font-medium text-text-main mt-0.5">{engine.activeTag || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-text-muted">Egress IP</p>
              <p className="text-sm font-mono text-text-main mt-0.5 truncate">
                {engine.egressIp || "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-text-muted">IP ledger</p>
              <p className="text-sm font-medium text-text-main mt-0.5">
                {engine.ledger?.ips ?? 0} seen ·{" "}
                <span className="text-red-500">{engine.ledger?.blocked ?? 0} blocked</span>
              </p>
            </div>
          </div>
        )}

        {engine?.ok && engine.tunnels?.length > 0 && (
          <div className="mt-5 border-t border-border-subtle pt-5">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
              WARP tunnels
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {engine.tunnels.map((t) => (
                <div
                  key={t.tag}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-text-main truncate">{t.tag}</span>
                      {t.active && (
                        <Badge variant="success" size="sm">
                          active
                        </Badge>
                      )}
                    </div>
                    <p className="text-[11px] font-mono text-text-muted truncate">
                      {t.ip || "no address"}
                    </p>
                  </div>
                  <div className="flex flex-col items-end shrink-0">
                    <Badge variant={VERDICT_VARIANT[t.verdict] || "default"} size="sm">
                      {t.verdict || "unprobed"}
                    </Badge>
                    <span className="text-[10px] text-text-muted mt-0.5">{formatAge(t.okAge)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* Docked console: sticky to the bottom of the page's scroll container
          so the log stays visible while the engine cards scroll above it.
          Sticky rather than fixed on purpose — fixed would have to re-derive
          the sidebar and header offsets this layout owns. */}
      <div className="sticky bottom-0 z-20 -mx-6 lg:-mx-10 -mb-6 lg:-mb-10">
        <div className="border-t border-border-subtle bg-surface shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.25)]">
          <div className="flex items-center justify-between gap-3 px-4 lg:px-10 py-2.5 border-b border-border-subtle bg-surface">
            <div className="flex items-center gap-2 min-w-0">
              <span className="material-symbols-outlined text-[18px] text-text-muted">terminal</span>
              <h2 className="text-sm font-semibold text-text-main whitespace-nowrap">
                Engine console
              </h2>
              <Badge variant={connected ? "success" : "default"} size="sm" dot>
                {connected ? "live" : "disconnected"}
              </Badge>
              {status?.logSize ? (
                <span className="text-[11px] text-text-muted hidden sm:inline">
                  {formatBytes(status.logSize)}
                </span>
              ) : null}
              <span className="text-[11px] text-text-muted hidden sm:inline">{logs.length} lines</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setAutoScroll((v) => !v)}
                className={`text-[11px] px-2 py-1 rounded border ${
                  autoScroll
                    ? "border-brand-500/40 text-brand-500"
                    : "border-border-subtle text-text-muted"
                }`}
                title="Follow new output"
              >
                follow
              </button>
              <button
                type="button"
                onClick={() => setConsoleCollapsed((v) => !v)}
                className="text-[11px] px-2 py-1 rounded border border-border-subtle text-text-muted"
              >
                {consoleCollapsed ? "expand" : "collapse"}
              </button>
              <Button size="sm" variant="outline" icon="delete" onClick={handleClearLog}>
                Clear
              </Button>
            </div>
          </div>
          {!consoleCollapsed && (
            <div
              ref={logRef}
              className="h-64 overflow-y-auto custom-scrollbar bg-neutral-950 px-4 lg:px-10 py-3 font-mono text-[11px] leading-5"
            >
              {logs.length === 0 ? (
                <p className="text-neutral-500">
                  {running
                    ? "Waiting for output…"
                    : enabled
                      ? "Engine is enabled but produced no output yet."
                      : "No log output yet. Enable the engine to start it."}
                </p>
              ) : (
                logs.map((line, i) => (
                  <div key={i} className={`whitespace-pre-wrap break-words ${lineClass(line)}`}>
                    {line}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
