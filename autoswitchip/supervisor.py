#!/usr/bin/env python3
"""Tunnel + sing-box supervisor for hosts without systemd.

9router runs on Railway (a container with no init system) and on Windows (no
systemd at all). The engine's restart contract — "give this line a new WARP
session" — is a process restart either way, so this module owns the child
processes and answers ``restart_service`` itself.

Layout under ``DATA_DIR/autoswitchip/``::

    tunnels/<tag>/config.json     usque device credentials (one per tunnel)
    tunnels/<tag>/usque.log       child stdout/stderr
    singbox.log                   sing-box output
    state.json                    what we started, so a restarted dashboard
                                  can tell "already running" from "died"

The supervisor is deliberately a separate process from the Next server: a
Next route handler must not block for the 6-9 s a tunnel restart takes, and a
crash in the engine must not take the gateway down with it.

Commands::

    python supervisor.py run              # foreground (the daemon spawns this)
    python supervisor.py status --json
    python supervisor.py start|stop|restart
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import hostos  # noqa: E402
from config import CFG  # noqa: E402

BASE = os.path.join(hostos.data_dir(), "autoswitchip")
TUNNELS_DIR = os.path.join(BASE, "tunnels")
SINGBOX_LOG = os.path.join(BASE, "singbox.log")
STATE_FILE = os.path.join(BASE, "state.json")
CONTROL_FILE = os.path.join(BASE, "control.json")
USQUE_BIN = hostos.resolve_binary("usque")


def _ensure_dirs() -> None:
    os.makedirs(TUNNELS_DIR, exist_ok=True)


def _read_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _write_state(state: dict) -> None:
    _ensure_dirs()
    tmp = STATE_FILE + f".{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, STATE_FILE)


class ControlServer:
    """Loopback-only HTTP control channel for the daemon.

    A Unix socket would be tidier on POSIX but does not exist on Windows, and
    the daemon already speaks HTTP to everything else (Clash API, 9router), so
    a tiny HTTP server keeps one transport. Bound to 127.0.0.1 with a random
    bearer token written to a 0600 file — without the token, any local process
    could restart tunnels and burn the address pool.
    """

    def __init__(self, supervisor: "Supervisor", token: str) -> None:
        self.sup = supervisor
        self.token = token
        self._httpd = None

    def start(self) -> int:
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        sup, token = self.sup, self.token

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_a):
                pass

            def _json(self, code: int, payload: dict) -> None:
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.headers.get("Authorization") != f"Bearer {token}":
                    return self._json(401, {"error": "unauthorized"})
                if self.path == "/status":
                    return self._json(200, sup.state())
                return self._json(404, {"error": "not found"})

            def do_POST(self):
                if self.headers.get("Authorization") != f"Bearer {token}":
                    return self._json(401, {"error": "unauthorized"})
                length = int(self.headers.get("Content-Length") or 0)
                try:
                    body = json.loads(self.rfile.read(length) or b"{}")
                except ValueError:
                    return self._json(400, {"error": "bad json"})
                if self.path == "/restart":
                    member = next((m for m in CFG["warp"]["members"]
                                   if m["tag"] == body.get("tag")), None)
                    if member is None:
                        return self._json(404, {"error": "unknown tag"})
                    return self._json(200, {"ok": sup.restart_tunnel(member)})
                if self.path == "/singbox/stop":
                    sup.stop_singbox()
                    return self._json(200, {"ok": True})
                if self.path == "/singbox/restart":
                    sup.stop_singbox()
                    return self._json(200, {"ok": sup.start_singbox(
                        CFG["singbox"]["config_file"])})
                return self._json(404, {"error": "not found"})

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._httpd.daemon_threads = True
        threading.Thread(target=self._httpd.serve_forever, daemon=True,
                         name="supervisor-control").start()
        return self._httpd.server_address[1]

    def stop(self) -> None:
        if self._httpd is not None:
            self._httpd.shutdown()


def _control_target() -> tuple[str, str] | None:
    """(base_url, token) of a live supervisor, or None."""
    try:
        with open(CONTROL_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return f"http://127.0.0.1:{int(data['port'])}", str(data["token"])
    except (OSError, ValueError, KeyError):
        return None


def _control_post(path: str, payload: dict | None = None,
                  timeout: float = 30) -> bool:
    target = _control_target()
    if target is None:
        return False
    base, token = target
    body = json.dumps(payload or {}).encode()
    req = urllib.request.Request(
        f"{base}{path}", data=body, method="POST",
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return bool(json.loads(res.read() or b"{}").get("ok"))
    except (urllib.error.URLError, OSError, ValueError):
        return False


def ensure_running(wait_sec: float = 20.0) -> bool:
    """Bring the supervisor up if it is not, and report whether it answers.

    Only meaningful in ``supervisor`` tunnel mode. The daemon calls this at
    boot: without it, ``request_restart`` has no control file to talk to and
    every rotation in the first minutes silently returns False — exactly what
    happened on Railway before this existed. ``wait_sec`` covers the child's
    own startup (tunnel registration can take a while on a fresh volume).
    """
    if _control_target() is not None:
        return True
    try:
        cmd_start()
    except Exception as exc:  # noqa: BLE001 - best effort, logged by caller
        print(f"✗ supervisor start failed: {exc}", file=sys.stderr, flush=True)
        return False
    deadline = time.time() + max(0.0, wait_sec)
    while time.time() < deadline:
        if _control_target() is not None:
            return True
        time.sleep(0.25)
    return _control_target() is not None


def request_restart(member: dict) -> bool:
    """Ask a running supervisor to restart one tunnel (daemon-side client).

    Starts the supervisor on demand: the first switch can land before the
    boot-time ``ensure_running`` has finished, and a failed restart means the
    line never rotates.
    """
    if _control_target() is None and not ensure_running():
        return False
    return _control_post("/restart", {"tag": member["tag"]})


def stop_singbox_for_restart() -> bool:
    """Terminate the supervisor-owned sing-box so the daemon can respawn it.

    The daemon keeps owning sing-box's lifecycle (it writes the config and
    needs the process to pick it up); the supervisor only holds the handle.
    """
    return _control_post("/singbox/stop", timeout=10)


class Supervisor:
    """Owns every tunnel child plus the sing-box child."""

    def __init__(self) -> None:
        self._procs: dict[str, subprocess.Popen] = {}
        self._singbox: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        # Registration is rate-limited cloud-side, so failures are retried on
        # a cooldown rather than on every reap tick. tag -> last attempt ts.
        self._register_attempted: dict[str, float] = {}

    # ------------------------------------------------------------- tunnels

    def tunnel_dir(self, tag: str) -> str:
        return os.path.join(TUNNELS_DIR, tag)

    def _tunnel_argv(self, port: int, ipv6: bool) -> list[str]:
        # Same flags deploy/usque-launch.sh passes: -6 only when the host can
        # actually route to Cloudflare's v6 endpoint. The route probe lives in
        # hostos-free code because it shells out to `ip`, which is Linux-only.
        argv = [USQUE_BIN, "-c", "config.json", "socks"]
        # Transport. MASQUE defaults to HTTP/3 over QUIC (UDP 443); networks
        # that drop UDP — many VPS/cloud egress firewalls, and this project's
        # own test host — accept the TLS connection and then never answer,
        # which shows up as "failed to dial connect-ip: timeout: no recent
        # network activity" on every tunnel. HTTP/2 over TCP+443 works in both
        # cases, so it is the default here. Set ASIP_USQUE_HTTP3=1 to prefer
        # QUIC where UDP is known good.
        if os.environ.get("ASIP_USQUE_HTTP3") != "1":
            argv.append("--http2")
        if ipv6 and self._ipv6_usable():
            argv.append("-6")
        argv += ["-b", "127.0.0.1", "-p", str(port)]
        return argv

    @staticmethod
    def _ipv6_usable() -> bool:
        if hostos.IS_WINDOWS:
            return False
        r = hostos._run(["ip", "-6", "route", "get", "2606:4700:103::2"], 5)
        if r is None or r.returncode != 0:
            return False
        # A stale default route still answers while the global address is
        # gone; usque then fails in sendmsg. Require a real source address.
        return " src " in (r.stdout or "")

    #: How long to wait after a failed registration before trying that line
    #: again. Registration hits Cloudflare's API, so a hot loop would both
    #: spam it and never succeed while the network is down.
    REGISTER_RETRY_SEC = 300.0

    def _ensure_identity(self, tag: str, cwd: str) -> bool:
        """Give this tunnel line its own WARP device credentials.

        On a systemd host `deploy/install.sh` registers them once, at install
        time. Railway and the Windows app have no install step, so the first
        start does it here: same command, same working directory, one
        ``config.json`` (the device identity) per line.
        """
        config_path = os.path.join(cwd, "config.json")
        if os.path.exists(config_path):
            return True
        last = self._register_attempted.get(tag, 0.0)
        if time.time() - last < self.REGISTER_RETRY_SEC:
            return False
        self._register_attempted[tag] = time.time()
        try:
            proc = subprocess.run(
                [USQUE_BIN, "register", "--accept-tos", "-n", tag],
                cwd=cwd, capture_output=True, text=True, timeout=90,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            print(f"✗ {tag} 注册失败: {exc}", file=sys.stderr, flush=True)
            return False
        if proc.returncode != 0 or not os.path.exists(config_path):
            detail = (proc.stderr or proc.stdout or "").strip().splitlines()
            print(f"✗ {tag} 注册失败: {detail[-1][:200] if detail else 'no output'}",
                  file=sys.stderr, flush=True)
            return False
        try:
            os.chmod(config_path, 0o600)
        except OSError:
            pass
        print(f"✓ {tag} 已注册 WARP 身份", flush=True)
        return True

    def start_tunnel(self, member: dict) -> bool:
        tag = member["tag"]
        port = int(member["port"])
        with self._lock:
            proc = self._procs.get(tag)
            if proc is not None and proc.poll() is None:
                return True
        cwd = self.tunnel_dir(tag)
        os.makedirs(cwd, exist_ok=True)
        if not os.path.exists(USQUE_BIN):
            return False
        if not self._ensure_identity(tag, cwd):
            return False
        proc = hostos.spawn_detached(
            self._tunnel_argv(port, bool(member.get("ipv6"))),
            stdout_path=os.path.join(cwd, "usque.log"),
            cwd=cwd,
        )
        if proc is None:
            return False
        with self._lock:
            self._procs[tag] = proc
        return True

    def stop_tunnel(self, tag: str) -> None:
        with self._lock:
            proc = self._procs.pop(tag, None)
        if proc is None or proc.poll() is not None:
            return
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            try:
                proc.kill()
            except OSError:
                pass

    def restart_tunnel(self, member: dict) -> bool:
        """Kill the child and start a new one — that is what rotates the IP.

        Cloudflare's WARP session address is derived from the tunnel's device
        credentials and its connection epoch; a reconnect is the only way to
        move it. Returns once the new process exists, not once it can pass
        traffic — the caller probes the port itself (``_wait_port_ready``).
        """
        tag = member["tag"]
        self.stop_tunnel(tag)
        hostos.free_port(int(member["port"]), wait=2.0)
        return self.start_tunnel(member)

    def start_all(self) -> int:
        started = 0
        for member in CFG["warp"]["members"]:
            if self.start_tunnel(member):
                started += 1
        return started

    def stop_all(self) -> None:
        for member in CFG["warp"]["members"]:
            self.stop_tunnel(member["tag"])

    # ------------------------------------------------------------- sing-box

    def start_singbox(self, config_file: str) -> bool:
        binary = CFG["singbox"]["binary"]
        if not os.path.exists(binary):
            return False
        proc = hostos.spawn_detached(
            [binary, "run", "-c", config_file],
            stdout_path=SINGBOX_LOG,
            cwd=os.path.dirname(os.path.abspath(__file__)),
        )
        if proc is None:
            return False
        self._singbox = proc
        return True

    def stop_singbox(self) -> None:
        proc = self._singbox
        self._singbox = None
        if proc is None or proc.poll() is not None:
            return
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            try:
                proc.kill()
            except OSError:
                pass

    # ------------------------------------------------------------ lifecycle

    def reap_loop(self) -> None:
        """Restart children that exited on their own.

        usque exits on credential loss or a fatal protocol error; without this
        the line stays dead until someone notices. Backoff is per-tunnel so one
        broken credential cannot spin the whole pool.
        """
        backoff: dict[str, float] = {}
        while not self._stop.wait(5.0):
            for member in CFG["warp"]["members"]:
                tag = member["tag"]
                with self._lock:
                    proc = self._procs.get(tag)
                if proc is not None and proc.poll() is None:
                    backoff.pop(tag, None)
                    continue
                delay = backoff.get(tag, 0.0)
                if delay > 60:
                    continue
                backoff[tag] = max(5.0, delay * 2)
                if delay > 0:
                    continue
                self.start_tunnel(member)
            if self._singbox is not None and self._singbox.poll() is not None:
                self._singbox = None
            _write_state(self.state())

    def state(self) -> dict:
        with self._lock:
            tunnels = {
                tag: {"pid": p.pid, "alive": p.poll() is None}
                for tag, p in self._procs.items()
            }
        return {
            "pid": os.getpid(),
            "ts": time.time(),
            "mode": "supervisor",
            "tunnels": tunnels,
            "singbox": ({"pid": self._singbox.pid,
                         "alive": self._singbox.poll() is None}
                        if self._singbox else None),
        }


# ------------------------------------------------------------------ run control

def _supervisor_lock():
    _ensure_dirs()
    return hostos.FileLock(os.path.join(BASE, "supervisor.lock"))


def _write_control_file(port: int, token: str) -> None:
    _ensure_dirs()
    fd = os.open(CONTROL_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.chmod(CONTROL_FILE, 0o600)
    except OSError:
        pass
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"port": port, "token": token, "pid": os.getpid()}, f)


def _write_control_token() -> str:
    """Fresh bearer token for the control port, 0600, removed on exit."""
    import secrets
    token = secrets.token_urlsafe(32)
    _ensure_dirs()
    path = os.path.join(BASE, "control.token")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(token)
    return token


def run_foreground() -> int:
    lock = _supervisor_lock()
    if not lock.acquire():
        print("supervisor already running", file=sys.stderr)
        return 1
    sup = Supervisor()
    config_file = CFG["singbox"]["config_file"]
    started = sup.start_all()
    sup.start_singbox(config_file)
    token = _write_control_token()
    control = ControlServer(sup, token)
    port = control.start()
    _write_control_file(port, token)
    print(f"supervisor up: {started} tunnels, sing-box "
          f"{'started' if sup._singbox else 'unavailable'}, "
          f"control :{port}", flush=True)

    def _shutdown(*_a):
        sup._stop.set()
        control.stop()
        sup.stop_all()
        sup.stop_singbox()
        try:
            os.unlink(CONTROL_FILE)
        except OSError:
            pass
        lock.release()
        sys.exit(0)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _shutdown)
        except (ValueError, OSError):
            pass  # not on the main thread / unsupported signal

    try:
        sup.reap_loop()
    finally:
        _shutdown()
    return 0


def cmd_status() -> dict:
    state = _read_state()
    lock_path = os.path.join(BASE, "supervisor.lock")
    alive = False
    if os.path.exists(lock_path):
        probe = hostos.FileLock(lock_path)
        if probe.acquire():
            probe.release()      # nobody held it: the recorded pid is stale
        else:
            alive = True
    state["alive"] = alive
    state["base"] = BASE
    state["usqueBinary"] = os.path.exists(USQUE_BIN)
    return state


def cmd_start() -> int:
    if cmd_status().get("alive"):
        return 0
    _ensure_dirs()
    proc = hostos.spawn_detached(
        [sys.executable, os.path.abspath(__file__), "run"],
        stdout_path=os.path.join(BASE, "supervisor.log"),
        cwd=os.path.dirname(os.path.abspath(__file__)),
    )
    return 0 if proc else 1


def cmd_stop() -> int:
    state = _read_state()
    pid = state.get("pid")
    if not pid:
        return 0
    try:
        os.kill(int(pid), signal.SIGTERM)
    except OSError:
        pass
    deadline = time.time() + 10
    while time.time() < deadline:
        if not cmd_status().get("alive"):
            return 0
        time.sleep(0.3)
    try:
        os.kill(int(pid), signal.SIGKILL)
    except OSError:
        pass
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["run", "start", "stop", "restart", "status"])
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    if args.command == "run":
        return run_foreground()
    if args.command == "start":
        return cmd_start()
    if args.command == "stop":
        return cmd_stop()
    if args.command == "restart":
        cmd_stop()
        return cmd_start()
    state = cmd_status()
    print(json.dumps(state, indent=2) if args.json else
          f"alive={state['alive']} tunnels={len(state.get('tunnels', {}))} "
          f"singbox={bool(state.get('singbox'))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
