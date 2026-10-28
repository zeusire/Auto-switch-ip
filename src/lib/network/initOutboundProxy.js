import { getSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";

let initialized = false;
let watchTimer = null;

const WATCH_MS = 5000;

export async function ensureOutboundProxyInitialized() {
  if (initialized) return true;

  try {
    const settings = await getSettings();
    applyOutboundProxyEnv(settings);
    initialized = true;
  } catch (error) {
    console.error("[ServerInit] Error initializing outbound proxy:", error);
  }

  return initialized;
}

/**
 * Keep `HTTPS_PROXY` in step with the settings row.
 *
 * The Auto Switch IP engine flips the egress by writing `outboundProxyUrl`
 * straight into 9router's SQLite (it has to: restarting the server to apply a
 * proxy would drop every in-flight request, and the whole point is to switch
 * mid-stream). Nothing else re-reads that row, so without this watcher the
 * engine's rewrites sat in the DB and the gateway kept dialling whatever proxy
 * it booted with — the IP never actually changed.
 *
 * Polling rather than a DB change hook because the writer is a different
 * process. One indexed row read every few seconds is cheap; the alternative is
 * a new IPC channel for a value that changes a handful of times per hour.
 */
export function startOutboundProxyWatch() {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    getSettings()
      .then((settings) => applyOutboundProxyEnv(settings))
      .catch(() => {});
  }, WATCH_MS);
  if (watchTimer.unref) watchTimer.unref();
}

export function stopOutboundProxyWatch() {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}

// Defer init so HTTP server accepts connections first
setImmediate(() => {
  ensureOutboundProxyInitialized()
    .then(() => startOutboundProxyWatch())
    .catch(console.log);
});

export default ensureOutboundProxyInitialized;
