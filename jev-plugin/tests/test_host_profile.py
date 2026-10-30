"""HostProfile and Platform: the host facts jev reads and every OS difference.

Covers the reader contract (absent CLI, old CLI exit 2, exit 9, exit 6/1/8,
a timeout, malformed output, a valid snapshot), the refresh rule (a stat at
most once a second, a reload on an mtime/size/inode change or after 60 s),
the per-OS defaults, validation, and the pins that keep Linux unchanged: the
protected tables equal the old ones, and the scratch roots are the old
("/var/tmp", "/tmp") plus scratch.dir only when the profile sets a valid one.
Zero-touch: nothing here asks the user anything or writes host.toml.

Every profile is built here and injected through the class
(HostProfile(...), HostProfile.use(...)); no test runs the real pria-fleet.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import jev_test_home  # noqa: F401,E402  (fixed empty profile; keeps the suite off the real store)

sys.path.insert(0, os.path.join(os.path.dirname(HERE), "extensions"))

import jev_ext  # noqa: E402
from jev import access, host_profile, relay, roster, rule1  # noqa: E402

HP = host_profile.HostProfile
Platform = host_profile.Platform
CLI_PATH = "/usr/bin/pria-fleet"


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class Stat:
    """A fake os.stat of host.toml: sig = (mtime_ns, size, ino), or missing."""

    def __init__(self):
        self.sig = (1, 10, 7)
        self.missing = False
        self.calls = 0

    def __call__(self, path):
        self.calls += 1
        if self.missing:
            raise FileNotFoundError(path)
        return mock.Mock(st_mtime_ns=self.sig[0], st_size=self.sig[1], st_ino=self.sig[2])


class Runner:
    def __init__(self, code=0, out=b"{}", err=b"", exc=None):
        self.code, self.out, self.err, self.exc = code, out, err, exc
        self.calls = []

    def __call__(self, argv):
        self.calls.append(list(argv))
        if self.exc is not None:
            raise self.exc
        return self.code, self.out, self.err


def live(runner, *, os_name="linux", home="/home/user", clock=None, stat=None, which=None):
    return HP(None, os_name=os_name, home=home, runner=runner,
              which=which or (lambda name: CLI_PATH), clock=clock or Clock(), stat=stat or Stat())


def snap(**values):
    return json.dumps(values).encode()


class LogCase(unittest.TestCase):
    def setUp(self):
        self.logs = []
        patcher = mock.patch.object(HP, "log", self.logs.append)
        patcher.start()
        self.addCleanup(patcher.stop)


# ── loading: the reader contract ──────────────────────────────────────────────

class Loading(LogCase):
    def test_no_cli_anywhere_is_absent_and_silent(self):
        with tempfile.TemporaryDirectory() as home:
            r = Runner()
            p = live(r, home=home, which=lambda name: None)
            self.assertIsNone(p.workspace_root())
            self.assertEqual(p.state, "absent")
            self.assertEqual(r.calls, [])
            self.assertEqual(self.logs, [])
            self.assertFalse(os.path.exists(os.path.join(home, ".pria")))  # never writes host.toml

    def test_the_cli_in_home_local_bin_is_used_when_not_on_path(self):
        with tempfile.TemporaryDirectory() as home:
            cli = Path(home) / ".local" / "bin" / "pria-fleet"
            cli.parent.mkdir(parents=True)
            cli.write_text("#!/bin/sh\nexit 2\n")
            cli.chmod(0o755)
            r = Runner(code=2)
            p = live(r, home=home, which=lambda name: None)
            p.refresh()
            self.assertEqual(r.calls, [[str(cli), "host", "--json"]])

    def test_the_call_is_host_json(self):
        r = Runner()
        live(r).refresh()
        self.assertEqual(r.calls, [[CLI_PATH, "host", "--json"]])

    def test_a_cli_that_vanished_is_absent(self):
        p = live(Runner(exc=FileNotFoundError("pria-fleet")))
        p.refresh()
        self.assertEqual((p.state, self.logs), ("absent", []))

    def test_old_cli_and_unset_are_silent_defaults(self):
        for code, err, state in [(2, b"pria-fleet: unknown command host\n", "old_cli"),
                                 (9, b"missing: workspace.root\n", "unset")]:
            with self.subTest(code=code):
                self.logs.clear()
                p = live(Runner(code=code, out=b"", err=err))
                self.assertIsNone(p.workspace_root())
                self.assertEqual(p.state, state)
                self.assertEqual(p.scratch_dir(), "/home/user/.cache/pria/scratch")
                self.assertEqual(p.service_manager(), "systemd")
                self.assertEqual(self.logs, [])

    def test_errors_are_unset_with_one_warning_line(self):
        cases = [(Runner(code=6, out=b""), "unsafe profile file (exit 6)"),
                 (Runner(code=1, out=b""), "malformed profile (exit 1)"),
                 (Runner(code=8, out=b""), "unsupported OS (exit 8)"),
                 (Runner(code=5, out=b""), "exit 5"),
                 (Runner(exc=subprocess.TimeoutExpired(["pria-fleet"], 1.0)), "timeout"),
                 (Runner(exc=PermissionError("denied")), "PermissionError"),
                 (Runner(out=b"not json"), "malformed output"),
                 (Runner(out=b"[1, 2]"), "malformed output"),
                 (Runner(out=b"\xff\xfe"), "malformed output"),
                 (Runner(out=b"{" * 5000), "malformed output"),
                 (Runner(out=b" " * (host_profile.SNAPSHOT_MAX + 1)), "malformed output")]
        for runner, reason in cases:
            with self.subTest(reason=reason):
                self.logs.clear()
                p = live(runner)
                for _ in range(3):
                    p.refresh(force=True)
                    self.assertIsNone(p.workspace_root())
                self.assertEqual(p.state, "error:" + reason)
                self.assertEqual(self.logs, [f"host profile: {reason}; using the defaults"])
                self.assertNotIn("ask", self.logs[0].lower())  # zero-touch: a log line, never a question

    def test_a_new_error_after_a_good_load_warns_again(self):
        r = Runner(code=6, out=b"")
        p = live(r)
        p.refresh(force=True)
        r.code, r.out = 0, snap(workspace={"root": "/home/user/w"})
        p.refresh(force=True)
        self.assertEqual(p.workspace_root(), "/home/user/w")
        r.code, r.out = 6, b""
        p.refresh(force=True)
        self.assertIsNone(p.workspace_root())
        self.assertEqual(len(self.logs), 2)

    def test_a_warning_logger_that_fails_never_reaches_the_guard(self):
        def broken(line):
            raise OSError("disk full")
        with mock.patch.object(HP, "log", broken):
            p = live(Runner(code=1, out=b""))
            p.refresh()
            self.assertEqual(p.state, "error:malformed profile (exit 1)")

    def test_a_valid_snapshot_in_each_shape(self):
        body = {"schema": 1, "owner": {"name": "Sam"},
                "workspace": {"root": "/home/user/work"}, "scratch.dir": "/home/user/.scratch",
                "app": {"state_dir": {"value": "/run/user/1000/pria", "source": "computed"},
                        "fleet_dir": "/home/user/.pria/fleet2"},
                "host": {"service_manager": "none"},
                "tools": {"python": "/opt/py/bin/python3", "heavy": "/opt/bin/myrunner"},
                "runners": [{"name": "h1", "role": "heavy", "kind": "ssh", "tool": "heavy"}]}
        for shape, out in [("plain", json.dumps(body)), ("envelope", json.dumps({"snapshot": body})),
                           ("values envelope", json.dumps({"ok": True, "values": body}))]:
            with self.subTest(shape=shape):
                p = live(Runner(out=out.encode()))
                self.assertEqual(p.workspace_root(), "/home/user/work")
                self.assertEqual(p.state, "ok")
                self.assertEqual(p.owner_name(), "Sam")
                self.assertEqual(p.worktrees_dir(), "/home/user/work/.worktrees")
                self.assertEqual(p.scratch_dir(), "/home/user/.scratch")
                self.assertEqual(p.app_state_dir(), "/run/user/1000/pria")
                self.assertEqual(p.app_fleet_dir(), "/home/user/.pria/fleet2")
                self.assertEqual(p.service_manager(), "none")
                self.assertEqual(p.tools("python"), "/opt/py/bin/python3")
                self.assertEqual([r["tool"] for r in p.runners()], ["heavy"])
                self.assertEqual(self.logs, [])


class RealCall(unittest.TestCase):
    """host_profile._run: the one real subprocess call (stdin closed, 1 s)."""

    def fake_cli(self, body):
        d = tempfile.mkdtemp(prefix="jev-hp-")
        self.addCleanup(shutil.rmtree, d, True)
        path = os.path.join(d, "pria-fleet")
        with open(path, "w") as f:
            f.write("#!/bin/sh\n" + body + "\n")
        os.chmod(path, 0o755)
        return path

    def test_stdin_is_closed(self):
        # cat would wait on an inherited stdin; /dev/null ends it at once
        code, out, _err = host_profile._run([self.fake_cli("cat; echo '{\"a\": 1}'")])
        self.assertEqual((code, out), (0, b'{"a": 1}\n'))

    def test_a_hanging_cli_is_cut_off_after_about_a_second(self):
        sleep = shutil.which("sleep")
        if not sleep:
            self.skipTest("no sleep on PATH")
        cli = self.fake_cli(f"exec '{sleep}' 20")
        p = HP(None, home="/nonexistent-home", which=lambda name: cli)
        start = time.monotonic()
        p.refresh()
        self.assertLess(time.monotonic() - start, 8)
        self.assertEqual(p.state, "error:timeout")


# ── refresh ───────────────────────────────────────────────────────────────────

class Refresh(unittest.TestCase):
    def setUp(self):
        self.clock, self.stat, self.runner = Clock(), Stat(), Runner(out=snap(workspace={"root": "/home/user/w"}))
        self.p = live(self.runner, clock=self.clock, stat=self.stat)
        self.p.refresh()

    def test_a_fixed_snapshot_never_runs_the_cli(self):
        r = Runner()
        p = HP({"workspace": {"root": "/home/user/w"}}, runner=r, which=lambda n: CLI_PATH)
        p.refresh(force=True)
        self.assertEqual((p.workspace_root(), p.state, r.calls), ("/home/user/w", "fixed", []))

    def test_no_stat_within_a_second(self):
        stats = self.stat.calls
        self.clock.t += 0.5
        self.p.workspace_root()
        self.assertEqual((self.stat.calls, len(self.runner.calls)), (stats, 1))

    def test_an_unchanged_file_is_not_reloaded(self):
        self.clock.t += 1.5
        self.p.workspace_root()
        self.assertEqual(len(self.runner.calls), 1)

    def test_a_change_of_mtime_size_or_inode_reloads(self):
        for sig in [(2, 10, 7), (2, 11, 7), (2, 11, 8)]:
            with self.subTest(sig=sig):
                before = len(self.runner.calls)
                self.stat.sig = sig
                self.clock.t += 1.5
                self.p.workspace_root()
                self.assertEqual(len(self.runner.calls), before + 1)

    def test_the_file_appearing_or_going_reloads(self):
        self.stat.missing = True
        self.clock.t += 1.5
        self.p.workspace_root()
        self.stat.missing = False
        self.clock.t += 1.5
        self.p.workspace_root()
        self.assertEqual(len(self.runner.calls), 3)

    def test_sixty_seconds_reload_even_unchanged(self):
        self.clock.t += 59
        self.p.workspace_root()
        self.assertEqual(len(self.runner.calls), 1)
        self.clock.t += 1
        self.p.workspace_root()
        self.assertEqual(len(self.runner.calls), 2)

    def test_a_load_cut_short_propagates_and_is_retried(self):
        class Interrupted(Exception):
            pass
        clock, stat = Clock(), Stat()
        r = Runner(exc=Interrupted())
        p = live(r, clock=clock, stat=stat)
        with self.assertRaises(Interrupted):  # e.g. the guard's budget alarm: never swallowed
            p.refresh()
        r.exc, r.out = None, snap(workspace={"root": "/home/user/w"})
        clock.t += 1.5
        self.assertEqual(p.workspace_root(), "/home/user/w")
        self.assertEqual(len(r.calls), 2)


# ── per-OS defaults ───────────────────────────────────────────────────────────

class Defaults(unittest.TestCase):
    def test_scratch_dir(self):
        self.assertEqual(HP({}, os_name="linux", home="/home/u").scratch_dir(), "/home/u/.cache/pria/scratch")
        self.assertEqual(HP({}, os_name="macos", home="/Users/u").scratch_dir(),
                         "/Users/u/Library/Caches/Pria/scratch")
        self.assertEqual(HP({}, os_name="other", home="/home/u").scratch_dir(), "/home/u/.cache/pria/scratch")
        self.assertIsNone(HP({}, os_name="linux", home="/home/u").scratch_dir(default=False))
        set_ = HP({"scratch": {"dir": "/home/u/s"}}, os_name="macos", home="/Users/u")
        self.assertEqual((set_.scratch_dir(), set_.scratch_dir(default=False)), ("/home/u/s", "/home/u/s"))

    def test_fleet_dir(self):
        for os_name in host_profile.OS_NAMES:
            self.assertEqual(HP({}, os_name=os_name, home="/h/u").app_fleet_dir(), "/h/u/.pria/fleet")
        self.assertEqual(HP({"app": {"fleet_dir": "/srv/fleet"}}, home="/h/u").app_fleet_dir(), "/srv/fleet")

    def test_state_dir_is_linux_only_by_default(self):
        self.assertEqual(HP({}, os_name="linux", home="/home/u").app_state_dir(),
                         "/home/u/.local/state/pria-desktop")
        self.assertIsNone(HP({}, os_name="macos", home="/Users/u").app_state_dir())
        self.assertIsNone(HP({}, os_name="other", home="/home/u").app_state_dir())
        self.assertEqual(HP({"app": {"state_dir": "/Users/u/Library/App"}}, os_name="macos",
                            home="/Users/u").app_state_dir(), "/Users/u/Library/App")

    def test_service_manager(self):
        for os_name, want in [("linux", "systemd"), ("macos", "launchd"), ("other", "none")]:
            self.assertEqual(HP({}, os_name=os_name).service_manager(), want)
        self.assertEqual(HP({"host": {"service_manager": "none"}}, os_name="linux").service_manager(), "none")
        self.assertEqual(HP({"host": {"service_manager": "upstart"}}, os_name="linux").service_manager(),
                         "systemd")

    def test_no_home_means_no_home_dirs(self):
        for home in ("", "/", "relative"):
            p = HP({}, os_name="linux", home=home)
            self.assertEqual((p.scratch_dir(), p.app_fleet_dir(), p.app_state_dir(), p.profile_path()),
                             (None, None, None, None))


# ── validation: anything invalid is unset ─────────────────────────────────────

class Validation(unittest.TestCase):
    def test_bad_paths_are_unset(self):
        for bad in ["relative/w", "/a/../b", "/a\nb", "/a\x00b", "/", 5, ["/x"], "/" + "x" * 5000, ""]:
            with self.subTest(bad=bad):
                p = HP({"workspace": {"root": bad}, "scratch": {"dir": bad}, "app": {"state_dir": bad}},
                       os_name="macos", home="/Users/u")
                self.assertIsNone(p.workspace_root())
                self.assertIsNone(p.worktrees_dir())
                self.assertIsNone(p.scratch_dir(default=False))
                self.assertIsNone(p.app_state_dir())

    def test_paths_are_normalised(self):
        self.assertEqual(HP({"workspace": {"root": "//home//u/w/"}}).workspace_root(), "/home/u/w")

    def test_tools_need_a_plain_name_and_an_absolute_path(self):
        p = HP({"tools": {"python": "/opt/py", "bad name": "/x", ".hidden": "/y", "rel": "bin/z", "root": "/"}})
        self.assertEqual(p.tools("python"), "/opt/py")
        for name in ("bad name", ".hidden", "rel", "root", "missing"):
            self.assertIsNone(p.tools(name))

    def test_runners(self):
        runners = [{"name": "ok", "role": "heavy", "kind": "ssh", "tool": "t1"},
                   {"name": "ok", "role": "gpu", "kind": "local", "tool": "t2"},          # duplicate name
                   {"name": "r2", "role": "boss", "kind": "ssh", "tool": "t2"},           # unknown role
                   {"name": "r3", "role": "gpu", "kind": "telnet", "tool": "t2"},         # unknown kind
                   {"name": "r4", "role": "gpu", "kind": "aws", "tool": "bad tool"},      # bad tool key
                   {"name": "no tool", "role": "gpu", "kind": "aws"},                     # bad name
                   "not a table",
                   {"name": "r5", "role": "render", "kind": "local", "tool": None},
                   {"name": "r6", "role": "cloud", "kind": "aws", "tool": "unset"}]
        p = HP({"runners": runners, "tools": {"t1": "/opt/bin/one", "t2": "/opt/bin/two"}})
        self.assertEqual([r["name"] for r in p.runners()], ["ok", "r5", "r6"])


# ── Platform ──────────────────────────────────────────────────────────────────

# The tables exactly as base cca8330's access._protected_tables had them.
OLD_ALWAYS = [("/etc/ssh", "ssh config"), ("/etc/sudoers", "sudoers"), ("/etc/sudoers.d", "sudoers"),
              ("/etc/sudo.conf", "sudoers"), ("/etc/doas.conf", "sudoers"),
              ("/etc/polkit-1", "polkit"), ("/usr/share/polkit-1", "polkit"), ("/var/lib/polkit-1", "polkit"),
              ("/etc/passwd", "users and groups"), ("/etc/group", "users and groups"),
              ("/etc/shadow", "users and groups"), ("/etc/gshadow", "users and groups"),
              ("/etc/subuid", "users and groups"), ("/etc/subgid", "users and groups"),
              ("/etc/security", "pam and limits"), ("/etc/pam.d", "pam and limits"),
              ("/etc/login.defs", "pam and limits"),
              ("/etc/ufw", "firewall config"), ("/etc/default/ufw", "firewall config"),
              ("/etc/nftables.conf", "firewall config"), ("/etc/iptables", "firewall config"),
              ("/etc/firewalld", "firewall config")]
OLD_SYSTEMD = ["/etc/systemd", "/usr/lib/systemd", "/lib/systemd", "/run/systemd"]
OLD_UMASK = ["/etc/profile", "/etc/profile.d", "/etc/bash.bashrc", "/etc/zsh", "/etc/environment"]


def old_tables(home):
    always, systemd, umask, synaps = list(OLD_ALWAYS), list(OLD_SYSTEMD), list(OLD_UMASK), []
    if home:
        always += [(os.path.join(home, ".ssh"), "~/.ssh"),
                   (os.path.join(home, ".synaps-cli", "plugins", "jev", "config"), "the jev guard's config"),
                   (os.path.join(home, ".synaps-cli", "memory", "jev"), "the jev guard's state and switch")]
        systemd += [os.path.join(home, ".config", "systemd"), os.path.join(home, ".local", "share", "systemd")]
        umask += [os.path.join(home, n) for n in (".bashrc", ".bash_profile", ".bash_login", ".profile",
                                                  ".zshrc", ".zprofile", ".zshenv", ".zlogin",
                                                  ".pam_environment", os.path.join(".config", "environment.d"))]
        synaps = [os.path.join(home, ".synaps-cli", "config")]
    return always, systemd, umask, synaps


class PlatformTables(unittest.TestCase):
    def test_linux_and_other_tables_are_exactly_the_old_ones(self):
        for os_name in ("linux", "other"):
            for home in ("/home/user", None):
                with self.subTest(os=os_name, home=home):
                    got = Platform(os_name).protected_tables(home)
                    self.assertEqual([list(t) for t in got], [list(t) for t in old_tables(home)])

    def test_macos_adds_and_never_removes(self):
        home = "/Users/user"
        mac = Platform("macos").protected_tables(home)
        for got, old in zip(mac, old_tables(home)):
            self.assertLessEqual(set(old), set(got))
        always = dict(mac[0])
        for path in ("/Library/LaunchAgents", "/Library/LaunchDaemons", "/Users/user/Library/LaunchAgents",
                     "/etc/pf.conf", "/private/etc/pf.conf", "/private/etc/sudoers", "/private/etc/sudoers.d",
                     "/private/etc/pam.d", "/private/var/lib/polkit-1"):
            self.assertIn(path, always)
        self.assertIn("/private/etc/zshrc", mac[2])

    def test_temp_roots(self):
        for os_name in ("linux", "other"):
            self.assertEqual(Platform(os_name, tmpdir="/home/user/tmp").temp_roots(), ("/var/tmp", "/tmp"))

        def real(path):
            if path.startswith("/var/"):
                return "/private" + path.rstrip("/")
            if path == "/boom":
                raise OSError("x")
            return path.rstrip("/")
        mac = Platform("macos", tmpdir="/var/folders/ab/xyz123/T/", realpath=real)
        self.assertEqual(mac.temp_roots(), ("/private/var/tmp", "/private/tmp", "/private/var/folders/ab/xyz123/T"))
        for bad in [None, "", "/", "/Users/user", "relative/T", "/var/folders/ab", "/boom", "/private/tmp"]:
            with self.subTest(tmpdir=bad):
                self.assertEqual(Platform("macos", tmpdir=bad, realpath=real).temp_roots(),
                                 ("/private/var/tmp", "/private/tmp"))

    def test_kill_readings_and_service_gates(self):
        self.assertEqual(Platform("linux").kill_readings(), ("procps",))
        for os_name in ("macos", "other"):
            self.assertEqual(Platform(os_name).kill_readings(), ("bsd", "procps"))
        required = {"load", "unload", "bootstrap", "bootout", "enable", "disable", "setenv", "unsetenv",
                    "limit", "kickstart"}
        for os_name in host_profile.OS_NAMES:
            gates = Platform(os_name).service_gates()
            self.assertEqual(gates["systemctl"], frozenset({"set-property", "edit", "revert"}))
            self.assertLessEqual(required, gates["launchctl"])
            self.assertNotIn("list", gates["launchctl"])

    def test_os_detection(self):
        self.assertEqual([host_profile.detect_os(p) for p in ("linux", "darwin", "freebsd14", "win32")],
                         ["linux", "macos", "other", "other"])


# ── the access rule's scratch roots ───────────────────────────────────────────

class ScratchRoots(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="jev-hp-home-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.realpath(os.path.join(self.tmp, "home"))
        os.makedirs(self.home)

    def roots(self, snapshot, os_name="linux", home=None):
        p = HP(snapshot, os_name=os_name, home=self.home)
        return access.Context(self.home, self.home if home is None else home, profile=p).scratch_roots

    def test_without_a_profile_the_linux_set_is_the_old_set(self):
        self.assertEqual(self.roots({}), ("/var/tmp", "/tmp"))

    def test_a_valid_scratch_dir_adds_nothing(self):
        # facts are not authority: scratch.dir never widens the own-scratch exception
        for rel in (".cache/pria/scratch", "scratch"):
            path = os.path.join(self.home, rel)
            os.makedirs(path, exist_ok=True)
            self.assertEqual(self.roots({"scratch": {"dir": path}}), ("/var/tmp", "/tmp"))
        self.assertEqual(self.roots({"scratch": {"dir": "/var/tmp/lanes"}}), ("/var/tmp", "/tmp"))

    def test_an_invalid_scratch_dir_adds_nothing(self):
        for bad in ["/", self.home, self.tmp, "/etc/scratch", "/usr", os.path.dirname(self.home), "/var/tmp"]:
            with self.subTest(bad=bad):
                self.assertEqual(self.roots({"scratch": {"dir": bad}}), ("/var/tmp", "/tmp"))

    def test_a_symlink_into_a_protected_place_is_judged_by_its_realpath(self):
        link = os.path.join(self.home, "scratch")
        os.symlink("/etc", link)
        self.assertEqual(self.roots({"scratch": {"dir": link}}), ("/var/tmp", "/tmp"))

    def test_no_home_adds_nothing(self):
        self.assertEqual(self.roots({"scratch": {"dir": os.path.join(self.home, "s")}}, home=""),
                         ("/var/tmp", "/tmp"))


# ── facts are not authority: the wrapper set is jev's own ─────────────────────

# base cca8330's rule1.WRAPPERS, names and option specs (heavy1 included).
OLD_WRAPPERS = {
    "sudo": (frozenset({"-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"}), 0, False),
    "doas": (frozenset({"-u", "-C"}), 0, False),
    "env": (frozenset({"-u", "-C", "-S", "--unset", "--chdir", "--split-string"}), 0, True),
    "nohup": (frozenset(), 0, False),
    "exec": (frozenset({"-a"}), 0, False),
    "command": (frozenset(), 0, False),
    "builtin": (frozenset(), 0, False),
    "time": (frozenset(), 0, False),
    "nice": (frozenset({"-n", "--adjustment"}), 0, False),
    "timeout": (frozenset({"-s", "-k", "--signal", "--kill-after"}), 1, False),
    "setsid": (frozenset(), 0, False),
    "stdbuf": (frozenset({"-i", "-o", "-e"}), 0, False),
    "taskset": (frozenset(), 1, False),
    "ionice": (frozenset({"-c", "-n", "-p", "-P", "-u"}), 0, False),
    "chrt": (frozenset(), 1, False),
    "xargs": (frozenset({"-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "--max-args", "--max-procs",
                         "--delimiter", "--arg-file", "--replace"}), 0, False),
    "flock": (frozenset({"-w", "-E", "--timeout", "--conflict-exit-code"}), 1, False),
    "watch": (frozenset({"-n", "--interval"}), 0, False),
    "heavy1": (frozenset({"--lease", "--cancel"}), 0, False),
}


class WrappersAreJevsOwn(unittest.TestCase):
    """A host-profile fact (tools.*, runners[].tool) never adds, drops or
    changes a rule-1 wrapper: the set is exactly the pre-port table."""

    def families(self, text):
        return [h.family for h in rule1.scan_rule1(text)]

    def runner_profile(self, path):
        return HP({"tools": {"run": path}, "runners": [{"name": "r", "role": "heavy", "kind": "ssh", "tool": "run"}]})

    def test_the_wrapper_set_is_the_pre_port_table(self):
        self.assertEqual({**rule1.WRAPPERS, **rule1.RUNNER_FLAGS}, OLD_WRAPPERS)
        self.assertEqual(set(rule1.WRAPPERS) & set(rule1.RUNNER_FLAGS), set())
        for name, spec in OLD_WRAPPERS.items():
            self.assertEqual(rule1.wrapper_spec(name), spec)

    def test_a_profile_runner_is_never_a_wrapper(self):
        texts = ["myrunner sed -i s/a/b/ f", "heavy1 --lease 2h sed -i s/a/b/ f", "sudo sed -i s/a/b/ f",
                 "python3 x.py", "myrunner --opt v rm -rf x"]
        with HP.use(HP({})):
            before = {t: self.families(t) for t in texts}
        for path in ("/opt/bin/myrunner", "/opt/bin/heavy1", "/opt/bin/sudo", "/opt/bin/python3", "/opt/bin/rm"):
            name = os.path.basename(path)
            with self.subTest(path=path), HP.use(self.runner_profile(path)):
                self.assertEqual(rule1.wrapper_spec(name), OLD_WRAPPERS.get(name))
                self.assertEqual({t: self.families(t) for t in texts}, before)

    def test_heavy1_keeps_its_flags_without_a_profile(self):
        with HP.use(HP({})):
            self.assertEqual(self.families("heavy1 --lease 2h sed -i s/a/b/ f"), ["E1"])
            self.assertNotIn("heavy1", rule1.WRAPPERS)

    def test_the_profile_has_no_wrapper_or_trust_getter(self):
        for attr in ("runner_tools", "wrappers", "trusted"):
            self.assertFalse(hasattr(HP, attr), attr)


# ── relay state dir and roster fleet dir ──────────────────────────────────────

class RelayAndRoster(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="jev-hp-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        for module, name in ((relay, "STATE_DIR"), (roster, "FLEET_DIR")):
            patcher = mock.patch.object(module, name, None)  # the modules' own test seam: back to the profile
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_linux_keeps_the_old_socket_dir(self):
        with HP.use(HP({}, os_name="linux", home="/home/user")):
            self.assertEqual(relay.state_dir(), Path("/home/user/.local/state/pria-desktop"))

    def test_macos_without_a_state_dir_has_no_relay(self):
        with HP.use(HP({}, os_name="macos", home=self.tmp)):
            self.assertIsNone(relay.state_dir())
            self.assertEqual(jev_ext.select_transport("auto"), "direct")
            client = relay.RelayClient()
            with self.assertRaises(relay.RelayOff) as cm:
                client._post(b"{}", timeout_s=1.0)
            self.assertEqual(cm.exception.code, "no_socket")

    def test_a_profile_state_dir_is_used(self):
        with HP.use(HP({"app": {"state_dir": self.tmp}}, os_name="macos", home="/Users/u")):
            self.assertEqual(relay.state_dir(), Path(self.tmp))
            self.assertEqual(jev_ext.select_transport("auto"), "relay")

    def test_the_roster_follows_the_profile_fleet_dir(self):
        fleets = []
        for name in ("one", "two"):
            fleet = Path(self.tmp) / name
            (fleet / "projects").mkdir(parents=True)
            (fleet / "roster.toml").write_text(f'[master]\nsession = "{name}-master"\n')
            fleets.append(fleet)
        with HP.use(HP({}, home=self.tmp)):
            self.assertEqual(roster.default_fleet_dir(), Path(self.tmp) / ".pria" / "fleet")
        with HP.use(HP({"app": {"fleet_dir": str(fleets[0])}})):
            self.assertEqual(roster.default_fleet_dir(), fleets[0])
            r = roster.FleetRoster()
            self.assertEqual(r.lookup("one-master"), (True, "listed"))
        with HP.use(HP({"app": {"fleet_dir": str(fleets[1])}})):
            self.assertEqual(r.lookup("one-master")[1], "unlisted")
            self.assertEqual(r.lookup("two-master"), (True, "listed"))


if __name__ == "__main__":
    unittest.main()
