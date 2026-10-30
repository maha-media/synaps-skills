"""bin/jev-python: Jev starts under a Python 3.11+ and fails loudly otherwise.

Run from jev-plugin/:
    python3 -B -m unittest discover -s tests -p 'test_jev_python.py' -v

The macOS-only branch (skip /usr/bin/python3 when the Command Line Tools are absent, so
nothing prompts) can't be exercised on Linux; the rest of the launcher can.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = Path(HERE).parent
LAUNCHER = ROOT / "bin" / "jev-python"
ABSOLUTE_CANDIDATES = ("/opt/homebrew/bin/python3", "/usr/local/bin/python3")
PROBE = "import sys; print('ok', sys.version_info >= (3, 11))"


def run(path_env: str, *args: str, home: str | None = None) -> subprocess.CompletedProcess:
    env = {"PATH": path_env, "HOME": home or os.environ.get("HOME", "/nonexistent")}
    return subprocess.run([str(LAUNCHER), *args], env=env, capture_output=True,
                          text=True, timeout=30, stdin=subprocess.DEVNULL)


def fake_old_python(d: Path, name: str = "python3") -> None:
    """A python3 that fails the 3.11 check, like Apple's 3.9."""
    p = d / name
    p.write_text("#!/bin/sh\nexit 1\n")
    p.chmod(0o755)


class JevPython(unittest.TestCase):
    def test_manifest_starts_jev_through_the_launcher(self):
        manifest = json.loads((ROOT / ".synaps-plugin" / "plugin.json").read_text())
        ext = manifest["extension"]
        self.assertEqual(ext["command"], "bin/jev-python")
        self.assertEqual(ext["args"], ["-u", "extensions/jev_ext.py"])
        self.assertTrue(LAUNCHER.stat().st_mode & stat.S_IXUSR)
        self.assertTrue(LAUNCHER.read_text().startswith("#!/bin/sh\n"))

    def test_runs_the_args_under_a_new_enough_python3(self):
        r = run(os.environ.get("PATH", "/usr/bin:/bin"), "-c", PROBE)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "ok True"), r.stderr)

    def test_skips_an_old_python3_for_a_newer_versioned_one(self):
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            fake_old_python(d)
            (d / "python3.13").symlink_to(sys.executable)
            r = run(str(d), "-c", PROBE, home=str(d / "home"))
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "ok True"), r.stderr)

    @unittest.skipIf(any(os.path.exists(p) for p in ABSOLUTE_CANDIDATES),
                     "an absolute candidate exists on this host")
    def test_no_new_enough_python_fails_loudly_with_127(self):
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            fake_old_python(d)
            r = run(str(d), "-c", PROBE, home=str(d / "home"))
        self.assertEqual(r.returncode, 127)
        self.assertEqual(r.stdout, "")
        self.assertIn("needs Python 3.11 or newer", r.stderr)
        self.assertIn("guard rules are OFF", r.stderr)

    def test_finds_a_per_user_uv_link_with_a_bare_path(self):
        # A standard Mac user: no Homebrew; `uv python install 3.13` links ~/.local/bin/python3.13.
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            fake_old_python(d)
            home = d / "home"
            (home / ".local" / "bin").mkdir(parents=True)
            (home / ".local" / "bin" / "python3.13").symlink_to(sys.executable)
            r = run(str(d), "-c", PROBE, home=str(home))
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "ok True"), r.stderr)

    def test_finds_a_uv_managed_install_without_the_link(self):
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            fake_old_python(d)
            home = d / "home"
            b = home / ".local" / "share" / "uv" / "python" / "cpython-3.13.1-macos-aarch64-none" / "bin"
            b.mkdir(parents=True)
            (b / "python3").symlink_to(sys.executable)
            r = run(str(d), "-c", PROBE, home=str(home))
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "ok True"), r.stderr)

    def test_exec_keeps_the_pid(self):
        # Synaps tracks the spawned pid; the launcher must exec, not fork.
        p = subprocess.Popen([str(LAUNCHER), "-c", "import os; print(os.getpid())"],
                             stdout=subprocess.PIPE, text=True, stdin=subprocess.DEVNULL)
        out, _ = p.communicate(timeout=30)
        self.assertEqual(int(out.strip()), p.pid)


MARK_PROBE = "import os, sys; print(os.environ.get('JEV_PY_MARK', 'probe'), sys.version_info >= (3, 11))"


def fake_pria_fleet(d: Path, calls: Path, python: Path) -> None:
    """A pria-fleet that records each call in `calls` and answers any query
    with `python`, as on a host whose profile sets tools.python."""
    p = d / "pria-fleet"
    p.write_text("#!/bin/sh\n"
                 f"echo \"$*\" >> '{calls}'\n"
                 f"echo '{python}'\n"
                 "exit 0\n")
    p.chmod(0o755)


def marked_python(path: Path) -> Path:
    """A 3.11+ python that says it was the one picked."""
    path.write_text(f"#!/bin/sh\nJEV_PY_MARK=profile exec '{sys.executable}' \"$@\"\n")
    path.chmod(0o755)
    return path


class NoProfilePython(unittest.TestCase):
    """Host-profile facts are not authority: the launcher never asks
    pria-fleet for tools.python and never runs an interpreter a profile
    names. It takes the first 3.11+ of its own probe, or fails loudly."""

    def setUp(self):
        t = tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.d = Path(t.name)
        self.home = self.d / "home"
        (self.home / ".local" / "bin").mkdir(parents=True)
        self.calls = self.d / "calls"
        prof = marked_python(self.d / "profile-python")
        fake_pria_fleet(self.d, self.calls, prof)
        fake_pria_fleet(self.home / ".local" / "bin", self.calls, prof)

    def test_a_profile_python_is_never_consulted_or_run(self):
        (self.d / "python3").symlink_to(sys.executable)  # the probe's pick
        r = run(str(self.d), "-c", MARK_PROBE, home=str(self.home))
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "probe True"), r.stderr)
        self.assertFalse(self.calls.exists())

    @unittest.skipIf(any(os.path.exists(p) for p in ABSOLUTE_CANDIDATES),
                     "an absolute candidate exists on this host")
    def test_no_probe_python_fails_loudly_rather_than_run_the_profiles(self):
        fake_old_python(self.d)
        r = run(str(self.d), "-c", MARK_PROBE, home=str(self.home))
        self.assertEqual((r.returncode, r.stdout), (127, ""), r.stderr)
        self.assertFalse(self.calls.exists())

    def test_the_launcher_names_no_profile_reader(self):
        text = LAUNCHER.read_text()
        for word in ("pria-fleet", "tools.python", "host.toml"):
            self.assertNotIn(word, text)


if __name__ == "__main__":
    unittest.main()
