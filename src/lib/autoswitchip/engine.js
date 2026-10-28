import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { DATA_DIR } from "@/lib/dataDir.js";

/**
 * Auto Switch IP — process control for the Python engine.
 *
 * The engine (autoswitchip/) is a long-running daemon: it polls 9router's
 * requestDetails, probes WARP tunnels and flips sing-box selectors. A Next
 * route handler cannot host it — the handler is short-lived, and a tunnel
 * restart blocks for 6-9 s. So the dashboard only ever does three things:
 * provision what the engine needs to start, spawn the daemon detached, and
 * read its state back off disk/sockets.
 *
 * Layout under `<DATA_DIR>/autoswitchip/`:
 *   daemon.log        the engine's own log (what the console panel shows)
 *   daemon.pid        last spawned pid, for stop/status
 *   bin/              sing-box + usque for this host (download on first use)
 *   singbox-config.json, .warp_*.json, ...   engine ledgers
 *   supervisor/       tunnel + sing-box children on hosts without systemd
 *
 * Source lives in the repo at `autoswitchip/`; runtime files never do, because
 * the container image is read-only and the desktop app must not write into its
 * install directory.
 */

export const ENGINE_DIR = path.join(process.cwd(), "autoswitchip");
export const STATE_DIR = path.join(DATA_DIR, "autoswitchip");
export const LOG_FILE = path.join(STATE_DIR, "daemon.log");
export const PID_FILE = path.join(STATE_DIR, "daemon.pid");
export const SINGBOX_LOG = path.join(STATE_DIR, "singbox.log");
export const BIN_DIR = path.join(STATE_DIR, "bin");
const SETTINGS_KEY = "autoSwitchIp";
const IS_WINDOWS = process.platform === "win32";

/**
 * Interpreter search order.
 *
 * `ASIP_PYTHON` wins so a deployment can pin its own (Railway's image installs
 * `python3` from apk; the Windows app may be pointed at a specific install).
 * A venv under the state dir comes next: managed hosts often have a Python
 * without pip rights, and creating a venv there needs no elevation.
 */
function pythonCandidates() {
  const configured = process.env.ASIP_PYTHON;
  const venv = path.join(STATE_DIR, "venv", IS_WINDOWS ? "Scripts" : "bin", IS_WINDOWS ? "python.exe" : "python");
  const out = [];
  if (configured) out.push(configured);
  out.push(venv);
  if (IS_WINDOWS) out.push("py", "python", "python3");
  else out.push("python3", "python");
  return out;
}

export function findPython() {
  return process.env.ASIP_PYTHON || (IS_WINDOWS ? "python" : "python3");
}

export function enginePaths() {
  return {
    engineDir: ENGINE_DIR,
    stateDir: STATE_DIR,
    daemon: path.join(ENGINE_DIR, "daemon.py"),
    supervisor: path.join(ENGINE_DIR, "supervisor.py"),
    fetchBinaries: path.join(ENGINE_DIR, "fetch-binaries.mjs"),
    logFile: LOG_FILE,
    singboxLog: SINGBOX_LOG,
    binDir: BIN_DIR,
  };
}

export function engineInstalled() {
  return fs.existsSync(path.join(ENGINE_DIR, "daemon.py"));
}

/** Read the pid file and report whether that process is still alive. */
export function readPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0); // signal 0 = liveness probe, does not touch it
      return pid;
    } catch (e) {
      // EPERM means it exists but belongs to another user; treat as alive.
      if (e?.code === "EPERM") return pid;
      return null;
    }
  } catch {
    return null;
  }
}

function writePid(pid) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, `${pid}\n`, { mode: 0o600 });
}

export function clearPid() {
  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Environment the engine inherits.
 *
 * `DATA_DIR` is passed explicitly rather than read from config.py so both
 * processes resolve the same directory even when the env differs (the CLI
 * launcher sets DATA_DIR for the server, not for its children). `ASIP_BIN_DIR`
 * points the engine's binary lookup at the provisioned directory, which is the
 * only writable one on Railway.
 *
 * PYTHONUTF8 matters on Windows: the engine logs Chinese/marker glyphs, and a
 * console defaulting to cp1252 would crash it on the first `print` rather than
 * show the message.
 */
function engineEnv() {
  const env = {
    ...process.env,
    DATA_DIR,
    ASIP_BIN_DIR: BIN_DIR,
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
  // The gateway's own port is what the engine probes for health; the container
  // sets PORT=20128 while the desktop default is 20127.
  if (!env.NINE_ROUTER_BASE_URL && env.PORT) {
    env.NINE_ROUTER_BASE_URL = `http://127.0.0.1:${env.PORT}`;
  }
  return env;
}

/** Run a command to completion, resolving to { code, stdout, stderr }. */
function runOnce(command, args, { timeoutMs = 120000, env = process.env, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, env, cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || error?.message || ""),
        });
      },
    );
  });
}

/**
 * Which interpreter actually works here, and does it have the two imports the
 * engine needs? Verified by running it rather than by `which`: the Windows
 * Store ships a `python3.exe` stub that only opens the store.
 */
export async function checkPython() {
  const attempts = [];
  for (const candidate of pythonCandidates()) {
    const r = await runOnce(candidate, ["-c", "import requests, yaml; print('ok')"], {
      timeoutMs: 20000,
    });
    attempts.push({ candidate, code: r.code, error: r.stderr.trim().split("\n").pop() || "" });
    if (r.code === 0 && r.stdout.trim() === "ok") {
      return { ok: true, python: candidate, attempts };
    }
  }
  return { ok: false, python: null, attempts };
}

/**
 * Download sing-box + usque for this host into the state dir, once.
 *
 * Not baked into the image: sing-box is 55 MB and the release CDN is not
 * always reachable from a build sandbox, while runtime downloads happen inside
 * the same network the engine itself uses. Skips work when both files are
 * already valid, so calling it on every enable is cheap.
 */
export async function provisionBinaries({ force = false } = {}) {
  const fetchScript = path.join(ENGINE_DIR, "fetch-binaries.mjs");
  if (!fs.existsSync(fetchScript)) {
    return { ok: false, error: "fetch-binaries.mjs missing from the engine directory" };
  }
  const env = { ...process.env, ASIP_BIN_DIR: BIN_DIR };
  const r = await runOnce(process.execPath, [fetchScript, ...(force ? ["--force"] : [])], {
    timeoutMs: 6 * 60 * 1000,
    env,
    cwd: ENGINE_DIR,
  });
  const present = {
    singbox: fs.existsSync(path.join(BIN_DIR, IS_WINDOWS ? "sing-box.exe" : "sing-box")),
    usque: fs.existsSync(path.join(BIN_DIR, IS_WINDOWS ? "usque.exe" : "usque")),
  };
  if (!present.singbox) {
    return {
      ok: false,
      error: `sing-box provisioning failed: ${(r.stderr || r.stdout).trim().slice(-400)}`,
      present,
    };
  }
  return { ok: true, present, output: r.stdout.trim().slice(-400) };
}

/** Spawn the daemon detached so it survives the request that started it. */
export function startEngine() {
  if (!engineInstalled()) {
    return { ok: false, error: "Engine source not found (autoswitchip/daemon.py)" };
  }
  const running = readPid();
  if (running) return { ok: true, pid: running, already: true };

  fs.mkdirSync(STATE_DIR, { recursive: true });
  let out;
  try {
    out = fs.openSync(LOG_FILE, "a", 0o600);
  } catch (err) {
    return { ok: false, error: `Cannot open engine log: ${err?.message || err}` };
  }
  let child;
  try {
    child = spawn(findPython(), [path.join(ENGINE_DIR, "daemon.py")], {
      cwd: ENGINE_DIR,
      env: engineEnv(),
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    // The child holds its own duplicate of the descriptor; ours is done. A
    // failed spawn closes it here too, which is why this is in `finally`.
    try {
      fs.closeSync(out);
    } catch {
      /* already closed */
    }
  }
  child.unref();
  if (!child.pid) return { ok: false, error: "Failed to spawn engine process" };
  writePid(child.pid);
  return { ok: true, pid: child.pid };
}

/**
 * Stop the daemon.
 *
 * On POSIX SIGTERM lets the daemon run its handler (it logs a shutdown line and
 * closes the DB). Windows has no deliverable SIGTERM — `process.kill` there is
 * TerminateProcess, which would leave the supervisor and sing-box orphaned, so
 * `taskkill /T` walks the tree instead.
 */
export async function stopEngine() {
  const pid = readPid();
  if (!pid) {
    clearPid();
    return { ok: true, stopped: false };
  }
  if (IS_WINDOWS) {
    const r = await runOnce("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 15000 });
    clearPid();
    // 128 = "process not found" — it already exited, which is the goal.
    if (r.code === 0 || /not found|no process/i.test(r.stderr)) {
      return { ok: true, stopped: true, pid };
    }
    return { ok: false, error: r.stderr.trim() || `taskkill exited with ${r.code}` };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    if (e?.code !== "ESRCH") return { ok: false, error: e?.message || String(e) };
  }
  // Give the daemon a moment to unwind its own children before reporting.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  clearPid();
  return { ok: true, stopped: true, pid };
}

/** Engine status as the dashboard shows it: process state + host readiness. */
export function getEngineStatus(settings = {}) {
  const pid = readPid();
  const enabled = settings?.[SETTINGS_KEY]?.enabled === true;
  let logSize = 0;
  let logUpdatedAt = null;
  try {
    const st = fs.statSync(LOG_FILE);
    logSize = st.size;
    logUpdatedAt = st.mtime.toISOString();
  } catch {
    /* no log yet */
  }
  const singbox = path.join(BIN_DIR, IS_WINDOWS ? "sing-box.exe" : "sing-box");
  const usque = path.join(BIN_DIR, IS_WINDOWS ? "usque.exe" : "usque");
  return {
    enabled,
    running: Boolean(pid),
    pid: pid || null,
    installed: engineInstalled(),
    python: findPython(),
    platform: process.platform,
    stateDir: STATE_DIR,
    binDir: BIN_DIR,
    logFile: LOG_FILE,
    logSize,
    logUpdatedAt,
    binaries: {
      singbox: fs.existsSync(singbox),
      usque: fs.existsSync(usque),
    },
    // The last error the enable path hit, kept in settings so it survives the
    // request that produced it.
    lastError: settings?.[SETTINGS_KEY]?.lastError || null,
  };
}

/**
 * Read the tail of the engine log.
 *
 * Reads backwards in chunks rather than loading the file: a daemon that has
 * been up for days has a multi-megabyte log and the console only ever shows
 * the last screenful.
 */
export function readLogTail({ lines = 200, maxBytes = 512 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(LOG_FILE, "r");
  } catch {
    return { lines: [], size: 0, truncated: false };
  }
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    // A chunk boundary can land mid-character; drop the partial first line.
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const all = text.split(/\r?\n/).filter((l) => l.length > 0);
    return {
      lines: all.slice(-lines),
      size,
      truncated: start > 0,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function clearLog() {
  try {
    fs.truncateSync(LOG_FILE, 0);
    return { ok: true };
  } catch (e) {
    if (e?.code === "ENOENT") return { ok: true };
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Run `daemon.py status` and parse its JSON.
 *
 * Spawned rather than imported: it reads the engine's ledgers and talks to the
 * Clash API, and doing that inside the Next server would duplicate the engine's
 * state model. Bounded by a timeout — a wedged Clash API must not wedge the
 * dashboard.
 */
export function queryEngineStatus(timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (!engineInstalled()) {
      resolve({ ok: false, error: "Engine source not installed" });
      return;
    }
    let stdout = "";
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    let child;
    try {
      child = spawn(findPython(), [path.join(ENGINE_DIR, "daemon.py"), "status"], {
        cwd: ENGINE_DIR,
        env: engineEnv(),
        windowsHide: true,
      });
    } catch (err) {
      done({ ok: false, error: err?.message || String(err) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      done({ ok: false, error: "Engine status timed out" });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 2 * 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, error: err?.message || String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        done({ ok: false, error: `Engine status exited with code ${code}` });
        return;
      }
      // The engine logs to stdout as well as its file; the JSON is the last
      // line that parses as an object.
      const candidates = stdout.trim().split(/\r?\n/).filter(Boolean).reverse();
      for (const line of candidates.slice(0, 20)) {
        if (!line.startsWith("{")) continue;
        try {
          done(JSON.parse(line));
          return;
        } catch {
          /* keep looking */
        }
      }
      done({ ok: false, error: "Engine status returned unparseable output" });
    });
  });
}
