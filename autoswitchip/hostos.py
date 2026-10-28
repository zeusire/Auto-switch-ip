"""Cross-platform host operations for auto-switch-ip.

The engine was written for Linux + systemd. 9router also ships as a Windows
desktop app and as a Railway container, where neither systemd nor ``pwd`` nor
``fcntl`` exists. Everything platform-specific lives here so ``daemon.py``
keeps one code path.

Three deployment shapes are supported, in this order of preference:

* **systemd user units** (Linux with a user session): tunnels are units and
  ``systemctl --user restart`` is how they get a fresh WARP session. This is
  the original behaviour and is unchanged.
* **In-process supervisor** (Railway, Docker, Windows, or Linux without
  systemd): ``supervisor.py`` owns the tunnel child processes and restarts
  them itself. Same contract — ``restart_service`` returns once the process
  is respawned.
* **Externally managed** (someone else runs usque): restart is a no-op that
  reports failure, so the daemon backs off instead of hammering.

The selection is made once, at import, by probing for a working
``systemctl --user``. Override with ``ASIP_TUNNEL_MODE=systemd|supervisor``.
"""

from __future__ import annotations

import errno
import os
import signal
import socket
import subprocess
import sys
import time

IS_WINDOWS = os.name == "nt"


# ---------------------------------------------------------------- home / paths

def home_dir() -> str:
    """Home directory that does not trust ``$HOME``.

    ``sudo -u`` can leave HOME=/root while the units and secrets belong to the
    invoking user, so on POSIX the passwd database is authoritative. Windows
    has no ``pwd``; USERPROFILE is the equivalent and is not spoofed the way
    HOME can be.
    """
    if IS_WINDOWS:
        return os.environ.get("USERPROFILE") or os.path.expanduser("~")
    try:
        import pwd
        return pwd.getpwuid(os.getuid()).pw_dir
    except Exception:
        return os.path.expanduser("~")


def default_data_dir() -> str:
    """Per-user state directory used when 9router does not pass DATA_DIR."""
    if IS_WINDOWS:
        base = os.environ.get("APPDATA") or os.path.join(home_dir(), "AppData", "Roaming")
        return os.path.join(base, "9router")
    return os.path.join(home_dir(), ".9router")


def data_dir() -> str:
    """9router's data directory (``DATA_DIR`` env, else the platform default).

    The engine keeps its ledgers next to 9router's database so a single
    ``DATA_DIR`` moves both — on Railway the container filesystem is the only
    durable-enough place to write, and in the desktop app it is the app's own
    folder rather than the repo checkout.
    """
    configured = os.environ.get("DATA_DIR")
    if configured:
        # Mirror src/lib/dataDir.js: a Unix absolute path on Windows is a
        # Linux-targeted .env leaking into the desktop app; ignore it.
        if not (IS_WINDOWS and configured.startswith("/")):
            return configured
    return default_data_dir()


# ------------------------------------------------------------------- binaries
#
# The engine drives two external programs: sing-box (the proxy itself) and
# usque (the WARP client behind each tunnel line). Neither is committed any
# more — sing-box alone is 55 MB and usque ships a per-platform archive — so
# `fetch-binaries.mjs` downloads the host's pair into `<engine>/bin/`.
#
# Lookup order matters on each deployment shape:
#
#   Railway / Docker   the build provisions them under DATA_DIR (the only
#                      writable volume), not in the image, so a redeploy
#                      re-downloads once rather than bloating the layer.
#   Windows desktop    <engine>/bin/sing-box.exe, provisioned on first enable.
#   Linux + systemd    the original repo-root `sing-box` and
#                      `.warp/usque/usque` still win — existing installs keep
#                      working without a migration.
#
# `ENGINE_BIN_DIR` / `DATA_DIR_BIN_DIR` env overrides exist for the CLI, which
# unpacks assets outside the app directory.

def engine_dir() -> str:
    """Directory holding the engine sources (this file's parent)."""
    return os.path.dirname(os.path.abspath(__file__))


def project_dir() -> str:
    """9router's repo/install root — the parent of the engine directory."""
    return os.path.dirname(engine_dir())


def binary_names(name: str) -> list[str]:
    """Candidate file names for a tool on this host (``usque``/``usque.exe``)."""
    base = name[:-4] if name.endswith(".exe") else name
    return [f"{base}.exe", base] if IS_WINDOWS else [base]


# Env overrides per tool, checked before the directory search. Both spellings
# are honoured: the engine historically used `<TOOL>_BINARY` (SINGBOX_BINARY),
# and the nested-npm CLI passes ASIP_* so a bundled asset dir can be injected.
_BINARY_ENV = {
    "sing-box": ("ASIP_SINGBOX_BIN", "SINGBOX_BINARY"),
    "usque": ("ASIP_USQUE_BIN", "USQUE_BINARY"),
}


def binary_search_paths(name: str) -> list[str]:
    """Every place a tool may live, most-specific first. Deduplicated."""
    candidates: list[str] = []
    for key in _BINARY_ENV.get(name, ()):
        override = os.environ.get(key)
        if override:
            candidates.append(os.path.expanduser(os.path.expandvars(override)))
            break
    for directory in (
        os.environ.get("ASIP_BIN_DIR"),
        os.path.join(data_dir(), "autoswitchip", "bin"),
        os.path.join(engine_dir(), "bin"),
        engine_dir(),
        project_dir(),
        os.path.join(project_dir(), ".warp", "usque"),
    ):
        if not directory:
            continue
        for filename in binary_names(name):
            candidates.append(os.path.join(directory, filename))
    seen: set[str] = set()
    out: list[str] = []
    for path in candidates:
        key = os.path.normcase(os.path.abspath(path))
        if key not in seen:
            seen.add(key)
            out.append(path)
    return out


def resolve_binary(name: str) -> str:
    """Absolute path to ``name``, or the first candidate when none exists.

    Returning a path even when nothing was found keeps call sites simple: the
    spawn fails with a clear ENOENT naming that path, and the status endpoint
    reports it via :func:`describe_binaries`. Callers that must branch use
    :func:`find_binary`.
    """
    found = find_binary(name)
    if found:
        return found
    candidates = binary_search_paths(name)
    return candidates[0] if candidates else name


def find_binary(name: str) -> str | None:
    """Absolute path to an executable ``name``, or None."""
    for path in binary_search_paths(name):
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    # A provisioned-but-not-yet-chmodded file (Windows has no exec bit) still
    # counts: the containers copy with mode preserved, but a manual unzip
    # often does not.
    for path in binary_search_paths(name):
        if os.path.isfile(path):
            return path
    import shutil as _shutil
    which = _shutil.which(name)
    return which or None


def describe_binaries() -> dict:
    """What the dashboard shows when provisioning is incomplete."""
    return {
        "singbox": find_binary("sing-box"),
        "usque": find_binary("usque"),
        "binDir": os.path.join(engine_dir(), "bin"),
    }


# ------------------------------------------------------------------- file lock

class FileLock:
    """Exclusive, non-blocking inter-process lock.

    ``fcntl.flock`` on POSIX, ``msvcrt.locking`` on Windows. The lock file is
    never unlinked: deleting it lets the next process create a fresh inode and
    take a lock that does not exclude the first holder.
    """

    def __init__(self, path: str) -> None:
        self.path = path
        self._fd: int | None = None

    def acquire(self) -> bool:
        """Take the lock; False when another live process holds it."""
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            if IS_WINDOWS:
                import msvcrt
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            os.close(fd)
            # EACCES/EAGAIN on POSIX, EACCES on Windows: someone else holds it.
            if e.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK, 13):
                return False
            raise
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()}\n".encode())
        self._fd = fd
        return True

    def release(self) -> None:
        fd, self._fd = self._fd, None
        if fd is None:
            return
        try:
            if IS_WINDOWS:
                import msvcrt
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            try:
                os.close(fd)
            except OSError:
                pass


# -------------------------------------------------------------------- processes

def _run(argv: list[str], timeout: float) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None


def find_pids(pattern: str) -> list[int]:
    """PIDs whose command line matches the regex ``pattern``.

    ``pgrep`` on POSIX. Windows has no portable equivalent, and shipping a
    psutil dependency for one call is not worth it: the engine only ever asks
    about its own sing-box child, which the supervisor already tracks by pid.
    """
    if IS_WINDOWS:
        return []
    r = _run(["pgrep", "-f", pattern], 5)
    if r is None or r.returncode != 0:
        return []
    return [int(p) for p in r.stdout.split() if p.isdigit()]


def kill_pids(pids: list[int], sig: int | None = None) -> None:
    for pid in pids:
        try:
            os.kill(pid, sig if sig is not None else signal.SIGTERM)
        except OSError:
            pass


def kill_matching(pattern: str, wait: float = 3.0) -> bool:
    """Terminate every process matching ``pattern``; True if none survive.

    Used for sing-box, which is spawned with ``start_new_session=True`` and is
    therefore not in our process group. On Windows ``taskkill /T /F`` walks
    the tree because ``os.kill`` cannot signal a group.
    """
    if IS_WINDOWS:
        r = _run(["taskkill", "/F", "/T", "/FI", f"WINDOWTITLE eq {pattern}"], 10)
        return r is not None and r.returncode == 0
    pids = find_pids(pattern)
    if not pids:
        return True
    kill_pids(pids, signal.SIGTERM)
    deadline = time.time() + wait
    while time.time() < deadline:
        if not find_pids(pattern):
            return True
        time.sleep(0.2)
    kill_pids(find_pids(pattern), signal.SIGKILL)
    return not find_pids(pattern)


def free_port(port: int, wait: float = 3.0) -> bool:
    """Ensure nothing is listening on ``port``.

    Replaces ``fuser -k <port>/tcp``: that call is a Linux-only shortcut and it
    kills by port, which on Windows would take down whatever else holds the
    port. Here we only wait for the previous owner to release it, which is what
    the restart path actually needs.
    """
    deadline = time.time() + wait
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return True
            except OSError:
                time.sleep(0.2)
    return False


def spawn_detached(argv: list[str], stdout_path: str | None = None,
                   cwd: str | None = None) -> subprocess.Popen | None:
    """Start a long-lived child that outlives the caller's request handler."""
    kwargs: dict = {"cwd": cwd}
    if IS_WINDOWS:
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    if stdout_path:
        os.makedirs(os.path.dirname(stdout_path), exist_ok=True)
        log_fd = os.open(stdout_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.chmod(stdout_path, 0o600)
        except OSError:
            pass
        kwargs["stdout"] = os.fdopen(log_fd, "a")
        kwargs["stderr"] = subprocess.STDOUT
    try:
        return subprocess.Popen(argv, **kwargs)
    except OSError:
        return None


# ---------------------------------------------------------------------- systemd

_systemd_ok: bool | None = None


def systemd_available() -> bool:
    """Whether ``systemctl --user`` can actually manage units here.

    Presence of the binary is not enough: inside a container it exists but
    fails with "Failed to connect to bus", and the daemon would then spend
    every restart on a doomed D-Bus call.
    """
    global _systemd_ok
    if _systemd_ok is not None:
        return _systemd_ok
    if IS_WINDOWS or os.environ.get("ASIP_TUNNEL_MODE") == "supervisor":
        _systemd_ok = False
        return False
    if os.environ.get("ASIP_TUNNEL_MODE") == "systemd":
        _systemd_ok = True
        return True
    r = _run(["systemctl", "--user", "is-system-running"], 5)
    # "running", "degraded" and "starting" all mean the bus answered.
    _systemd_ok = bool(r is not None and r.returncode in (0, 1)
                       and (r.stdout or "").strip() in
                       ("running", "degraded", "starting", "initializing"))
    return _systemd_ok


def tunnel_mode() -> str:
    """``systemd`` | ``supervisor`` | ``external`` — how tunnels get restarted."""
    override = os.environ.get("ASIP_TUNNEL_MODE")
    if override in ("systemd", "supervisor", "external"):
        return override
    return "systemd" if systemd_available() else "supervisor"


def restart_systemd_unit(service: str) -> bool:
    r = _run(["systemctl", "--user", "restart", service], 20)
    return bool(r is not None and r.returncode == 0)


def describe_host() -> dict:
    """One-line host summary for the dashboard status card."""
    return {
        "platform": sys.platform,
        "windows": IS_WINDOWS,
        "python": sys.version.split()[0],
        "tunnelMode": tunnel_mode(),
        "systemd": systemd_available(),
        "dataDir": data_dir(),
    }
