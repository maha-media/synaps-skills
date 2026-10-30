"""host_profile — the host facts jev reads, and every OS difference it needs.

Two types, and no host or OS check anywhere else in the plugin:

- Platform: what the operating system decides. The OS name (linux, macos
  or other, from sys.platform), the realpath'd temp roots, the protected-path
  tables, the service commands the access rule gates, the kill-flag readings
  of the signal_all rule, and the per-OS default dirs.
- HostProfile: the owner's host facts from the Pria host profile (schema 1),
  read only through `pria-fleet host --json` (never the file, never env), with
  the per-OS defaults when a key is unset.

Most Synaps users have no Pria Desktop: `pria-fleet` missing, an older one
("unknown command host", exit 2), or exit 9 means every key is unset and the
defaults apply, silently. Exit 6 (unsafe file), 1 (malformed), 8
(unsupported OS), a timeout or unreadable output means unset as well, plus one
warning line per change of state (to jev's log, never to the user). Nothing
here raises into the guard: only OSError, subprocess errors, ValueError,
TypeError and decode/recursion errors are caught, so the guard's own budget
alarm still goes through.

Zero-touch: jev never asks the user for a host fact, asks no setup
question, and never writes ~/.pria/host.toml. Every key it reads has a safe
default, so a missing key never needs a `missing: KEY` line:
- scratch.dir, workspace.root: no extra scratch root, and the old project
  heuristic;
- app.state_dir: Linux's path, else no relay (direct transport);
- app.fleet_dir: ~/.pria/fleet;
- host.service_manager: from the OS;
- tools.*, runners: read and validated only; jev acts on neither.

Facts, not authority: no host-profile value (tools.*, runners[].tool, a
runner's interpreter or launcher, PATH) is ever approval to execute, a
trusted wrapper or a trusted interpreter. jev runs nothing a profile names;
the rule-1 wrapper set stays in rule1's own tables; bin/jev-python does not
consult tools.python. A missing fact never relaxes a policy and never falls
back to a bare-PATH or local run.

The profile otherwise only names where things live. Owner-supplied paths
that would widen an exception (scratch.dir, workspace.root) are validated in
access.Context; without a profile the guard behaves exactly as before on
Linux.

The snapshot is loaded once per process, cached, and reloaded when
~/.pria/host.toml changes (mtime, size or inode; a stat at most once a
second) or after MAX_AGE_S. jev never writes that file.

Tests inject a profile through the class: HostProfile(snapshot=..., os_name=
..., home=...) and HostProfile.use(profile) (or install), never by patching a
call site.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import Callable

CLI = "pria-fleet"
TIMEOUT_S = 1.0          # one `pria-fleet host --json` call
STAT_EVERY_S = 1.0       # at most one stat of host.toml per second
MAX_AGE_S = 60.0         # reload at least this often
SNAPSHOT_MAX = 256 * 1024
PATH_MAX = 4096
RUNNERS_MAX = 16
TOOLS_MAX = 64

OS_NAMES = ("linux", "macos", "other")
SERVICE_MANAGERS = frozenset({"systemd", "launchd", "none"})
RUNNER_ROLES = frozenset({"heavy", "gpu", "render", "cloud"})
RUNNER_KINDS = frozenset({"local", "ssh", "aws"})
_IDENT = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def detect_os(sys_platform: str | None = None) -> str:
    p = sys.platform if sys_platform is None else sys_platform
    if p.startswith("linux"):
        return "linux"
    if p == "darwin":
        return "macos"
    return "other"


# ── Platform ──────────────────────────────────────────────────────────────────

# The Linux tables, exactly as the access rule had them before the port.
_LINUX_ALWAYS = (("/etc/ssh", "ssh config"), ("/etc/sudoers", "sudoers"), ("/etc/sudoers.d", "sudoers"),
                 ("/etc/sudo.conf", "sudoers"), ("/etc/doas.conf", "sudoers"),
                 ("/etc/polkit-1", "polkit"), ("/usr/share/polkit-1", "polkit"), ("/var/lib/polkit-1", "polkit"),
                 ("/etc/passwd", "users and groups"), ("/etc/group", "users and groups"),
                 ("/etc/shadow", "users and groups"), ("/etc/gshadow", "users and groups"),
                 ("/etc/subuid", "users and groups"), ("/etc/subgid", "users and groups"),
                 ("/etc/security", "pam and limits"), ("/etc/pam.d", "pam and limits"),
                 ("/etc/login.defs", "pam and limits"),
                 ("/etc/ufw", "firewall config"), ("/etc/default/ufw", "firewall config"),
                 ("/etc/nftables.conf", "firewall config"), ("/etc/iptables", "firewall config"),
                 ("/etc/firewalld", "firewall config"))
_LINUX_SYSTEMD = ("/etc/systemd", "/usr/lib/systemd", "/lib/systemd", "/run/systemd")
_LINUX_UMASK = ("/etc/profile", "/etc/profile.d", "/etc/bash.bashrc", "/etc/zsh", "/etc/environment")
_HOME_ALWAYS = ((".ssh", "~/.ssh"),
                (os.path.join(".synaps-cli", "plugins", "jev", "config"), "the jev guard's config"),
                (os.path.join(".synaps-cli", "memory", "jev"), "the jev guard's state and switch"))
_HOME_SYSTEMD = (os.path.join(".config", "systemd"), os.path.join(".local", "share", "systemd"))
_HOME_UMASK = (".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin",
               ".pam_environment", os.path.join(".config", "environment.d"))
_HOME_SYNAPS = (os.path.join(".synaps-cli", "config"),)
# macOS adds these to the Linux set (kept whole: stricter only). A launchd
# job is always protected (any write asks), unlike a systemd unit, whose
# write asks only when it sets a gated key: the restrictive choice.
_MACOS_ALWAYS = (("/Library/LaunchAgents", "launchd job"), ("/Library/LaunchDaemons", "launchd job"),
                 ("/System/Library/LaunchAgents", "launchd job"), ("/System/Library/LaunchDaemons", "launchd job"),
                 ("/etc/pf.conf", "firewall config"), ("/etc/pf.anchors", "firewall config"),
                 ("/etc/launchd.conf", "launchd job"))
_MACOS_HOME_ALWAYS = ((os.path.join("Library", "LaunchAgents"), "launchd job"),)
_MACOS_UMASK = ("/etc/zshrc", "/etc/zprofile", "/etc/zshenv", "/etc/zlogin", "/etc/bashrc")
# macOS: /etc, /var and /tmp are symlinks into /private; a realpath lands there
_MACOS_ALIASES = ("/etc", "/var", "/tmp")

# Service commands and the subcommands the access rule gates (a "command"
# hit). Both tables apply on every OS: a gate never depends on the OS
# (launchctl does not exist on Linux, so nothing changes there; restrictive).
SYSTEMCTL_GATED = frozenset({"set-property", "edit", "revert"})
LAUNCHCTL_GATED = frozenset({"load", "unload", "bootstrap", "bootout", "enable", "disable", "setenv", "unsetenv",
                             "limit", "kickstart",
                             # also: submit/remove a job, set config, run as another user/bootstrap
                             "submit", "remove", "config", "asuser", "bsexec"})


class Platform:
    """The OS concern. Pure tables plus the realpath'd temp roots; inject
    os_name (and tmpdir/realpath) to test another OS on any machine."""

    def __init__(self, os_name: str | None = None, *, tmpdir: str | None = None,
                 realpath: Callable[[str], str] = os.path.realpath,
                 temp_roots: tuple | None = None) -> None:
        """temp_roots: a test seam replacing the OS temp roots (a test whose
        temp HOME sits below /var/tmp names its own scratch root)."""
        self.os = os_name if os_name in OS_NAMES else detect_os()
        self._tmpdir = os.environ.get("TMPDIR") if tmpdir is None else tmpdir
        self._realpath = realpath
        self._tables: dict = {}
        self._temp_roots: tuple | None = tuple(temp_roots) if temp_roots is not None else None

    def __repr__(self) -> str:
        return f"Platform({self.os!r})"

    def default_service_manager(self) -> str:
        return {"linux": "systemd", "macos": "launchd"}.get(self.os, "none")

    def temp_roots(self) -> tuple:
        """The OS temp roots, as realpaths. Linux (and any other OS):
        /var/tmp and /tmp, as before. macOS: /private/var/tmp, /private/tmp
        and realpath($TMPDIR), only when that lies in the per-user
        /private/var/folders area (a TMPDIR of / or $HOME is ignored)."""
        if self._temp_roots is None:
            if self.os != "macos":
                self._temp_roots = ("/var/tmp", "/tmp")
            else:
                roots = ["/private/var/tmp", "/private/tmp"]
                t = self._tmpdir
                if isinstance(t, str) and t.startswith("/") and "\x00" not in t:
                    try:
                        real = self._realpath(t).rstrip("/")
                    except (OSError, ValueError):
                        real = ""
                    if real.startswith("/private/var/folders/") and len(real.split("/")) >= 6 \
                            and real not in roots:
                        roots.append(real)
                self._temp_roots = tuple(roots)
        return self._temp_roots

    def protected_tables(self, home: str | None) -> tuple:
        """(always [(base, class)], systemd [base], umask [base], synaps
        [base]) for one home. Linux: the old tables exactly."""
        key = home or ""
        hit = self._tables.get(key)
        if hit is not None:
            return hit
        always, systemd, umask, synaps = list(_LINUX_ALWAYS), list(_LINUX_SYSTEMD), list(_LINUX_UMASK), []
        if self.os == "macos":
            always += _MACOS_ALWAYS
            umask += _MACOS_UMASK
        if home:
            always += [(os.path.join(home, rel), name) for rel, name in _HOME_ALWAYS]
            systemd += [os.path.join(home, rel) for rel in _HOME_SYSTEMD]
            umask += [os.path.join(home, rel) for rel in _HOME_UMASK]
            synaps = [os.path.join(home, rel) for rel in _HOME_SYNAPS]
            if self.os == "macos":
                always += [(os.path.join(home, rel), name) for rel, name in _MACOS_HOME_ALWAYS]
        if self.os == "macos":
            always += [(_private(b), n) for b, n in always if _private(b) != b]
            systemd += [_private(b) for b in systemd if _private(b) != b]
            umask += [_private(b) for b in umask if _private(b) != b]
        out = (tuple(always), tuple(systemd), tuple(umask), tuple(synaps))
        if len(self._tables) < 8:
            self._tables[key] = out
        return out

    def service_gates(self) -> dict:
        """command name -> subcommands that change service limits or jobs."""
        return {"systemctl": SYSTEMCTL_GATED, "launchctl": LAUNCHCTL_GATED}

    def kill_readings(self) -> tuple:
        """How pkill/killall flags are read. Linux: procps/psmisc only
        (unchanged). macOS (and any other OS): the BSD reading AND the
        procps one; either one finding is a finding (restrictive)."""
        return ("procps",) if self.os == "linux" else ("bsd", "procps")

    def default_scratch_dir(self, home: str | None) -> str | None:
        if not home:
            return None
        if self.os == "macos":
            return os.path.join(home, "Library", "Caches", "Pria", "scratch")
        return os.path.join(home, ".cache", "pria", "scratch")

    def default_state_dir(self, home: str | None) -> str | None:
        """The Pria Desktop state dir when the profile names none: today's
        path on Linux; none elsewhere (the relay stays off)."""
        if not home or self.os != "linux":
            return None
        return os.path.join(home, ".local", "state", "pria-desktop")


def _private(path: str) -> str:
    for a in _MACOS_ALIASES:
        if path == a or path.startswith(a + "/"):
            return "/private" + path
    return path


# ── HostProfile ───────────────────────────────────────────────────────────────

def _abs_path(v) -> str | None:
    if not isinstance(v, str) or not v.startswith("/") or len(v) > PATH_MAX or _CONTROL.search(v):
        return None
    if ".." in v.split("/"):
        return None
    norm = os.path.normpath(v)
    if norm.startswith("//"):
        norm = "/" + norm.lstrip("/")
    return norm


def _flatten(obj: dict, prefix: str, out: dict, depth: int) -> None:
    if depth > 6:
        return
    for k, v in obj.items():
        if not isinstance(k, str) or not k or len(out) > 4096:
            continue
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            if "value" in v and all(isinstance(x, str) for x in v) and \
                    set(v) <= {"value", "source", "origin", "set", "default", "computed", "state", "status", "type"}:
                out[key] = v["value"]
            else:
                _flatten(v, key, out, depth + 1)
        else:
            out[key] = v


def parse_snapshot(text) -> dict:
    """A `pria-fleet host --json` snapshot as {dotted key: value}. The shape
    is not frozen: nested tables or dotted keys, an optional envelope
    (snapshot/values/result/keys), and {"value": x} leaves are all read.
    Raises ValueError when it is no JSON object."""
    if isinstance(text, bytes):
        if len(text) > SNAPSHOT_MAX:
            raise ValueError("snapshot too large")
        text = text.decode("utf-8")
    if not isinstance(text, str) or len(text) > SNAPSHOT_MAX:
        raise ValueError("snapshot too large")
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("snapshot is not an object")
    for _ in range(3):
        env = next((data[k] for k in ("snapshot", "values", "result", "keys", "profile")
                    if isinstance(data.get(k), dict)), None)
        if env is None or "schema" in data:
            break
        data = env
    out: dict = {}
    _flatten(data, "", out, 0)
    return out


class HostProfile:
    """The host facts (schema 1), with per-OS defaults. One shared instance
    (current()); tests inject their own (use/install)."""

    _current: "HostProfile | None" = None
    _lock = threading.Lock()
    log: Callable[[str], None] | None = None   # set by jev_ext.initialize

    def __init__(self, snapshot: dict | None = None, *, os_name: str | None = None, home: str | None = None,
                 platform: Platform | None = None,
                 runner: Callable[[list], tuple] | None = None,
                 which: Callable[[str], str | None] | None = None,
                 clock: Callable[[], float] = time.monotonic,
                 stat: Callable[[str], os.stat_result] = os.stat) -> None:
        """snapshot: a fixed snapshot ({dotted or nested keys}; {} = nothing
        set), never reloaded. None: a live profile read from pria-fleet.
        runner(argv) -> (returncode, stdout bytes, stderr bytes) or raises."""
        self.platform = platform or Platform(os_name)
        h = os.path.expanduser("~") if home is None else home
        self.home = h if isinstance(h, str) and h.startswith("/") and h != "/" else None
        self._fixed = snapshot is not None
        self._values: dict = {}
        self._runner = runner or _run
        self._which = which or _which
        self._clock = clock
        self._stat = stat
        self._loaded_at: float | None = None
        self._checked_at: float | None = None
        self._sig = None
        self.state = "fixed" if self._fixed else "unloaded"  # ok | absent | old_cli | unset | error:...
        self._warned = None
        self._mutex = threading.Lock()
        if self._fixed:
            self._values = self._validate(_as_flat(snapshot))

    # ── the shared instance ──
    @classmethod
    def current(cls) -> "HostProfile":
        p = cls._current
        if p is None:
            with cls._lock:
                if cls._current is None:
                    cls._current = cls()
                p = cls._current
        return p

    @classmethod
    def install(cls, profile: "HostProfile | None") -> "HostProfile | None":
        """Make `profile` the shared one (None: a fresh live one on next
        use). Returns the one it replaced."""
        with cls._lock:
            old, cls._current = cls._current, profile
        return old

    @classmethod
    @contextlib.contextmanager
    def use(cls, profile: "HostProfile"):
        old = cls.install(profile)
        try:
            yield profile
        finally:
            cls.install(old)

    # ── loading ──
    def profile_path(self) -> str | None:
        return os.path.join(self.home, ".pria", "host.toml") if self.home else None

    def _file_sig(self):
        path = self.profile_path()
        if not path:
            return None
        try:
            st = self._stat(path)
        except (OSError, ValueError):
            return None
        return (st.st_mtime_ns, st.st_size, st.st_ino)

    def refresh(self, force: bool = False) -> None:
        """Reload when host.toml changed or the snapshot is MAX_AGE_S old.
        Cheap when nothing changed (one stat at most every STAT_EVERY_S)."""
        if self._fixed:
            return
        now = self._clock()
        if not force and self._checked_at is not None and now - self._checked_at < STAT_EVERY_S:
            return
        with self._mutex:
            self._checked_at = now
            sig = self._file_sig()
            stale = self._loaded_at is None or now - self._loaded_at >= MAX_AGE_S
            if force or stale or sig != self._sig:
                # Mark the load done only after it returns: a load cut short
                # (the guard's alarm, an interrupt) is retried next time.
                self._load()
                self._sig = sig
                self._loaded_at = now

    def _load(self) -> None:
        cli = self._which(CLI)
        if cli is None and self.home:
            local = os.path.join(self.home, ".local", "bin", CLI)
            cli = local if os.path.isfile(local) and os.access(local, os.X_OK) else None
        if cli is None:
            self._set({}, "absent")
            return
        try:
            code, out, err = self._runner([cli, "host", "--json"])
        except subprocess.TimeoutExpired:
            self._set({}, "error:timeout")
            return
        except FileNotFoundError:
            self._set({}, "absent")
            return
        except (OSError, subprocess.SubprocessError, ValueError) as e:
            self._set({}, f"error:{type(e).__name__}")
            return
        if code == 0:
            try:
                values = self._validate(parse_snapshot(out))
            except (ValueError, TypeError, UnicodeDecodeError, RecursionError):
                self._set({}, "error:malformed output")
                return
            self._set(values, "ok")
        elif code == 2:
            self._set({}, "old_cli")       # "unknown command host" or usage: no reader yet
        elif code == 9:
            self._set({}, "unset")
        elif code == 6:
            self._set({}, "error:unsafe profile file (exit 6)")
        elif code == 1:
            self._set({}, "error:malformed profile (exit 1)")
        elif code == 8:
            self._set({}, "error:unsupported OS (exit 8)")
        else:
            self._set({}, f"error:exit {int(code) if isinstance(code, int) else '?'}")

    def _set(self, values: dict, state: str) -> None:
        self._values = values
        self.state = state
        if state.startswith("error:") and self._warned != state:
            self._warned = state
            fn = type(self).log
            if fn is not None:
                try:
                    fn(f"host profile: {state[6:]}; using the defaults")
                except (OSError, ValueError, TypeError):
                    pass
        elif not state.startswith("error:"):
            self._warned = None

    # ── validation (anything invalid is unset) ──
    def _validate(self, flat: dict) -> dict:
        out: dict = {}
        name = flat.get("owner.name")
        if isinstance(name, str) and 1 <= len(name) <= 128 and not _CONTROL.search(name) and name.strip():
            out["owner.name"] = name
        for key in ("workspace.root", "workspace.worktrees_dir", "scratch.dir", "app.state_dir", "app.fleet_dir"):
            p = _abs_path(flat.get(key))
            if p is not None and p != "/":
                out[key] = p
        sm = flat.get("host.service_manager")
        if sm in SERVICE_MANAGERS:
            out["host.service_manager"] = sm
        tools = {}
        for key, v in flat.items():
            if key.startswith("tools.") and len(tools) < TOOLS_MAX:
                tname = key[6:]
                p = _abs_path(v)
                if _IDENT.fullmatch(tname) and p is not None and p != "/":
                    tools[tname] = p
        out["tools"] = tools
        runners = []
        raw = flat.get("runners")
        if isinstance(raw, list):
            seen = set()
            for r in raw[:RUNNERS_MAX]:
                if not isinstance(r, dict):
                    continue
                rname, role, kind, tool = r.get("name"), r.get("role"), r.get("kind"), r.get("tool")
                if not (isinstance(rname, str) and _IDENT.fullmatch(rname)) or rname in seen:
                    continue
                if role not in RUNNER_ROLES or kind not in RUNNER_KINDS:
                    continue
                if tool is not None and not (isinstance(tool, str) and _IDENT.fullmatch(tool)):
                    continue
                seen.add(rname)
                runners.append({"name": rname, "role": role, "kind": kind, "tool": tool})
        out["runners"] = tuple(runners)
        return out

    def _get(self, key: str):
        self.refresh()
        return self._values.get(key)

    # ── typed getters ──
    def os(self) -> str:
        return self.platform.os

    def owner_name(self) -> str | None:
        return self._get("owner.name")

    def workspace_root(self) -> str | None:
        return self._get("workspace.root")

    def worktrees_dir(self) -> str | None:
        """Set, or workspace.root/.worktrees when the root is set, else None."""
        wt = self._get("workspace.worktrees_dir")
        if wt is None:
            root = self.workspace_root()
            wt = os.path.join(root, ".worktrees") if root else None
        return wt

    def scratch_dir(self, *, default: bool = True) -> str | None:
        """scratch.dir; with default=False only a value the profile sets
        (the guard's own-scratch exception takes only that)."""
        p = self._get("scratch.dir")
        if p is None and default:
            p = self.platform.default_scratch_dir(self.home)
        return p

    def runners(self) -> tuple:
        """The validated runners table: a FACT, never authority (no jev
        code runs, trusts or unwraps what it names)."""
        self.refresh()
        return self._values.get("runners", ())

    def tools(self, name: str) -> str | None:
        """tools.<name>, an absolute path: a FACT, never approval to run
        it or to trust it as a wrapper or interpreter."""
        self.refresh()
        return self._values.get("tools", {}).get(name)

    def service_manager(self) -> str:
        sm = self._get("host.service_manager")
        return sm if sm is not None else self.platform.default_service_manager()

    def app_state_dir(self) -> str | None:
        p = self._get("app.state_dir")
        return p if p is not None else self.platform.default_state_dir(self.home)

    def app_fleet_dir(self) -> str | None:
        p = self._get("app.fleet_dir")
        if p is None and self.home:
            p = os.path.join(self.home, ".pria", "fleet")
        return p


def _as_flat(snapshot: dict) -> dict:
    if not isinstance(snapshot, dict):
        return {}
    out: dict = {}
    _flatten(snapshot, "", out, 0)
    return out


def _which(name: str) -> str | None:
    try:
        return shutil.which(name)
    except (OSError, ValueError):
        return None


def _run(argv: list) -> tuple:
    """One CLI call: stdin closed, stdout and stderr captured (never the
    extension's own pipes), TIMEOUT_S."""
    p = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=TIMEOUT_S, check=False, close_fds=True)
    return p.returncode, p.stdout[:SNAPSHOT_MAX + 1], p.stderr[:4096]


def current() -> HostProfile:
    return HostProfile.current()
