#!/usr/bin/env python3
"""Routine lines go to jev.log, not the host's stderr budget.

The host forwards an extension's stderr to synaps.log up to 128 KiB per
process lifetime, then only counts it. A guard line per call used that up in
about 23 minutes, after which jev's own warnings (relay trouble, crashes)
never reached synaps.log. Routine lines (per-call decisions that are not a
block, skip lines, counters chatter) now go to a rotating file,
<base>/memory/jev/jev.log; stderr keeps the notices (start/stop, activation,
transport and key state, crashes, framing errors, relay and write failures,
evaluation failures, block and warn decisions), and every notice goes to the
file too. `log_routine = stderr` restores the old routing, `off` drops
routine lines.

Offline only: a fake DecisionClient stands in for Jev. Run:

    python3 -B -m unittest discover -s tests -p 'test_log_routing.py' -v
"""
from __future__ import annotations

import json
import os
import stat
import time
import unittest
from pathlib import Path
from unittest import mock

from test_guard_parity import ROOT, FakeClient, GuardCase, score  # noqa: F401 (sys.path set there)

import jev_ext  # noqa: E402
import jev_test_home  # noqa: E402
from jev import keys, logs, relay  # noqa: E402
from jev.client import JevError, Stats  # noqa: E402
from jev.policy import PolicyDenied  # noqa: E402

RM_ROOT = "rm -rf /"
HEREDOC = "cat <<EOF\nhi\nEOF"


class Routing(GuardCase):
    """Extension + dispatch with a recorded stderr and a temp jev.log."""

    def setUp(self):
        super().setUp()
        self.err = bytearray()
        self.sent = []
        self.log_path = self.root / "base" / "memory" / "jev" / "jev.log"
        self.stderr = jev_ext.StderrLog(write=self.sink)
        self.filelog = logs.FileLog(self.log_path)
        for patcher in (mock.patch.object(jev_ext, "STDERR", self.stderr),
                        mock.patch.object(jev_ext, "FILELOG", self.filelog),
                        mock.patch.object(jev_ext, "send", self.sent.append)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def sink(self, data):
        self.err.extend(data)
        return len(data)

    def use_filelog(self, filelog):
        patcher = mock.patch.object(jev_ext, "FILELOG", filelog)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.filelog = filelog

    def reset(self):
        self.err.clear()
        self.sent.clear()
        for p in self.log_path.parent.glob("jev.log*"):
            p.unlink()

    def ext(self, client, **cfg):
        ext = jev_ext.Extension()
        ext.cfg = {"project_root": str(self.ws), **cfg}
        ext.guard_cfg = jev_ext.guard.GuardConfig(ext.cfg)
        client.stats = Stats()  # jev_status reads it
        ext.client = client
        ext.recompute_features()
        return ext

    def initialized(self, client, **cfg):
        """Through initialize(), so `log_routine` is read from the config."""
        with mock.patch.object(jev_ext.Extension, "_initialize_key"), \
                mock.patch.object(jev_ext.Extension, "activate_relay"):
            ext = jev_ext.Extension()
            ext.initialize({"config": {"project_root": str(self.ws), "audit_file": "", **cfg}})
        client.stats = Stats()
        ext.client = client
        ext.recompute_features()
        return ext

    def frame(self, tool, tool_input, rid=1):
        return {"jsonrpc": "2.0", "id": rid, "method": "hook.handle",
                "params": {"kind": "before_tool_call", "tool_name": tool, "tool_runtime_name": tool,
                           "tool_input": tool_input, "session_id": "sess-log", "cwd": str(self.ws)}}

    def hook(self, ext, tool="bash", tool_input=None, rid=1):
        jev_ext.dispatch(ext, self.frame(tool, tool_input or {"command": "ls"}, rid), received=time.monotonic())
        return self.sent[-1]["result"]

    def err_lines(self):
        return [line for line in self.err.decode().split("\n") if line]

    def file_lines(self, path=None):
        path = path or self.log_path
        return path.read_text().splitlines() if path.exists() else []

    def status(self, ext):
        jev_ext.dispatch(ext, {"jsonrpc": "2.0", "id": "s", "method": "tool.call",
                               "params": {"name": "jev_status", "input": {}}})
        return json.loads(self.sent[-1]["result"]["content"])


class RoutineToFile(Routing):
    def test_a_100_guard_continues_write_no_stderr_and_100_file_lines(self):
        ext = self.ext(FakeClient())
        for i in range(100):
            self.assertEqual(self.hook(ext, tool_input={"command": f"ls {i}"}, rid=i), {"action": "continue"})
        self.assertEqual(bytes(self.err), b"", "no stderr byte for a continue")
        lines = self.file_lines()
        self.assertEqual(len(lines), 100)
        for line in lines:
            self.assertIn(" [jev] guard bash: continue (", line)
        self.assertEqual((self.filelog.lines, self.filelog.dropped, self.stderr.lines), (100, 0, 0))
        status = self.status(ext)
        self.assertEqual(status["log_file"], str(self.log_path))
        self.assertEqual(status["log_routine"], "file")
        self.assertEqual({k: status["counters"][k] for k in ("log.file_lines", "log.file_dropped",
                                                               "log.stderr_lines")},
                         {"log.file_lines": 100, "log.file_dropped": 0, "log.stderr_lines": 0})

    def test_a_file_line_carries_time_and_pid_and_is_bounded(self):
        ext = self.ext(FakeClient())
        self.hook(ext)
        line = self.file_lines()[0]
        stamp, pid, rest = line.split(" ", 2)
        time.strptime(stamp[:19], "%Y-%m-%dT%H:%M:%S")
        self.assertEqual(pid, str(os.getpid()))
        self.assertTrue(rest.startswith("[jev] guard bash: continue ("), rest)
        self.reset()
        jev_ext.log("é" * 5000)
        data = self.log_path.read_bytes()
        self.assertLessEqual(len(data), jev_ext.LOG_LINE_MAX)
        self.assertTrue(data.endswith(b"\n"))
        data.decode("utf-8")  # a cut never splits a character

    def test_file_lines_are_written_after_the_reply(self):
        seen = []

        def send(frame):
            seen.append(len(self.file_lines()))
            self.sent.append(frame)
        ext = self.ext(FakeClient())
        with mock.patch.object(jev_ext, "send", send):
            for rid, command in enumerate(("ls", RM_ROOT, "ls")):
                jev_ext.dispatch(ext, self.frame("bash", {"command": command}, rid), received=time.monotonic())
        self.assertEqual(seen, [0, 1, 2], "each frame's line lands after its reply")
        self.assertEqual(len(self.file_lines()), 3)

    def test_a_held_frame_keeps_at_most_the_cap_in_the_file_too(self):
        ext = self.ext(FakeClient())
        extra = 5

        def chatty(params, received=None):
            for i in range(jev_ext.LOG_HOLD_MAX + extra):
                ext.op_log(f"line {i}")
            return {"action": "continue"}
        ext.hook = chatty
        self.hook(ext)
        self.assertEqual(len(self.file_lines()), jev_ext.LOG_HOLD_MAX)
        self.assertEqual(self.filelog.dropped, extra)
        self.assertEqual(bytes(self.err), b"")

    def test_routine_choices_and_confirms_stay_in_the_file(self):
        # No budget-denied case for the guard: it is exempt from budgets and the circuit
        # (client.py: no policy for op guard), so a PolicyDenied never reaches it.
        cases = {
            "model confirm (prompt)": (FakeClient({"risk": score(2.0, 0.9)}), {"guard_confirm": "prompt"},
                                       "confirm", "guard bash: confirm ("),
            "confirm→continue (auto)": (FakeClient({"risk": score(2.0, 0.9)}), {}, "continue",
                                        "guard bash: confirm→continue (auto)"),
        }
        for label, (client, cfg, action, text) in cases.items():
            with self.subTest(label):
                self.reset()
                self.assertEqual(self.hook(self.ext(client, **cfg))["action"], action)
                self.assertEqual(bytes(self.err), b"", label)
                lines = self.file_lines()
                self.assertEqual(len(lines), 1, lines)
                self.assertIn(text, lines[0])

    def test_a_compress_budget_denial_stays_in_the_file(self):
        """A budget denial is the policy working, not a failure: routine, never stderr."""
        ext = self.initialized(FakeClient(error=PolicyDenied("budget_calls")), compress=True)
        jev_ext.dispatch(ext, {"jsonrpc": "2.0", "id": 1, "method": "hook.handle",
                               "params": {"kind": "after_tool_call", "tool_name": "bash",
                                          "tool_runtime_name": "bash", "tool_input": {"command": "make"},
                                          "tool_output": "routine progress\n" * 360, "session_id": "sess-log"}})
        self.assertEqual(self.sent[-1]["result"], {"action": "continue"})
        self.assertEqual(bytes(self.err), b"")
        lines = self.file_lines()
        self.assertEqual(len(lines), 1, lines)
        self.assertIn(" [jev] compress error: keep", lines[0])


class NoticesToBoth(Routing):
    def assert_both(self, text, n_err=1):
        err = self.err_lines()
        self.assertEqual(sum(text in line for line in err), n_err, err)
        for line in err:
            self.assertTrue(line.startswith("[jev] "), line)
            self.assertTrue(any(f.endswith(" " + line) for f in self.file_lines()),
                            f"stderr line also in the file: {line!r}")

    def test_b_a_block_goes_to_stderr_and_the_file(self):
        # risk scores run 0-3: a model block needs guard_block_at at or under 3
        cases = {
            "shell-safety rule": (FakeClient(), {}, {"command": RM_ROOT}),
            "model": (FakeClient({"risk": score(3.0, 1.0)}), {"guard_block_at": 2.8}, {"command": "ls"}),
        }
        for label, (client, cfg, tool_input) in cases.items():
            with self.subTest(label):
                self.reset()
                self.assertEqual(self.hook(self.ext(client, **cfg), tool_input=tool_input)["action"], "block")
                self.assertEqual(len(self.err_lines()), 1, self.err_lines())
                self.assertEqual(len(self.file_lines()), 1, self.file_lines())
                self.assert_both("[jev] guard bash: block (")
        self.assertEqual(self.stderr.lines, 2)

    def test_a_malformed_model_answer_is_a_notice(self):
        # score 3.9 is outside the 0-3 risk scale: an evaluation failure, not a decision
        self.assertEqual(self.hook(self.ext(FakeClient({"risk": score(3.9, 0.99)})))["action"], "continue")
        self.assert_both("guard bash: error after ")
        self.assertIn("(malformed answer)", self.err.decode())

    def test_a_rule_in_warn_mode_and_an_evaluation_failure_go_to_both(self):
        cases = {
            "rule-1 warn": (FakeClient(), {"guard_rule1": "warn", "guard_rule1_scope": "all"},
                            {"command": HEREDOC}, "guard bash: warn (", 2),
            "timeout": (FakeClient(error=JevError("deadline exceeded")), {}, {"command": "ls"},
                        "guard bash: error after ", 1),
        }
        for label, (client, cfg, tool_input, text, n_file) in cases.items():
            with self.subTest(label):
                self.reset()
                self.assertEqual(self.hook(self.ext(client, **cfg), tool_input=tool_input)["action"], "continue")
                self.assertEqual(len(self.err_lines()), 1, self.err_lines())
                self.assertEqual(len(self.file_lines()), n_file, self.file_lines())
                self.assert_both(text)

    def test_c_a_crashed_handler_goes_to_stderr_and_the_file(self):
        def boom(*a, **kw):
            raise RuntimeError("crash")
        with mock.patch.object(jev_ext.guard, "handle", boom):
            self.hook(self.ext(FakeClient()))
        self.assertIn("handler crashed on hook.handle: RuntimeError", self.err.decode())
        self.assertIn("handler crashed on hook.handle: RuntimeError", self.log_path.read_text())

    def test_c_a_relay_failure_goes_to_stderr_and_the_file(self):
        ext = jev_ext.Extension()
        ext.cfg = {"project_root": str(self.ws)}
        ext.guard_cfg = jev_ext.guard.GuardConfig(ext.cfg)
        ext.activate_relay()
        self.assert_both("through the Pria desktop relay")
        self.reset()
        self.assertEqual(self.hook(ext), {"action": "continue"})  # Jev off for this call
        self.assert_both("[jev] relay: Jev is off (")
        self.assertEqual(len(self.err_lines()), 1, self.err_lines())

    def test_main_writes_started_stopped_and_framing_errors_to_both(self):
        def bad_frame():
            raise RuntimeError("missing Content-Length header")
        for reader, texts in ((lambda: None, ["[jev] started", "[jev] stopped"]),
                              (bad_frame, ["[jev] started", "[jev] framing error: missing Content-Length header",
                                           "[jev] stopped"])):
            with self.subTest(texts=texts):
                self.reset()
                with mock.patch.object(jev_ext, "read_frame", reader):
                    jev_ext.main()
                self.assertEqual(self.err_lines(), texts)
                self.assertEqual([line.split(" ", 2)[2] for line in self.file_lines()], texts)

    def test_main_keeps_a_log_file_already_set_and_sets_the_default_otherwise(self):
        with mock.patch.object(jev_ext, "read_frame", lambda: None):
            jev_ext.main()
        self.assertEqual(self.filelog.path, self.log_path)
        unset = logs.FileLog()
        self.use_filelog(unset)
        with mock.patch.object(jev_ext, "read_frame", lambda: None), \
                mock.patch.object(logs, "default_path", lambda: self.root / "dflt" / "jev.log"):
            jev_ext.main()
        self.assertEqual(unset.path, self.root / "dflt" / "jev.log")
        self.assertEqual(len(self.file_lines(unset.path)), 2)


class Rotation(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory(prefix="jev-logrot-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name) / "memory" / "jev"
        self.path = self.dir / "jev.log"

    def numbers(self, path):
        return [int(line.split("line ")[1].split()[0]) for line in path.read_text().splitlines()]

    def test_d_rotation_at_the_cap_keeps_three_files_mode_0600(self):
        self.assertEqual((logs.LOG_FILE_MAX, logs.LOG_FILE_KEEP), (2 * 1024 * 1024, 3))
        fl = logs.FileLog(self.path, max_bytes=1000)
        for i in range(200):
            fl(f"line {i:04d} " + "x" * 50)
        self.assertEqual((fl.lines, fl.dropped), (200, 0))
        names = sorted(p.name for p in self.dir.iterdir())
        self.assertEqual(names, ["jev.log", "jev.log.1", "jev.log.2", "jev.log.3"])
        self.assertEqual(stat.S_IMODE(self.dir.stat().st_mode), 0o700, "a created dir is 0700")
        for p in self.dir.iterdir():
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600, p.name)
            self.assertLessEqual(p.stat().st_size, 1000, p.name)
        order = [self.numbers(self.dir / n) for n in ("jev.log.3", "jev.log.2", "jev.log.1", "jev.log")]
        flat = [n for part in order for n in part]
        self.assertEqual(flat, sorted(flat), "oldest in .3, newest in jev.log")
        self.assertEqual(flat[-1], 199)
        self.assertEqual(flat, list(range(flat[0], 200)), "no line lost inside the kept files")

    def test_d_the_default_cap_rotates_at_2_mib(self):
        self.dir.mkdir(parents=True, mode=0o700)
        with open(self.path, "wb") as f:
            f.truncate(logs.LOG_FILE_MAX - 100)  # sparse
        os.chmod(self.path, 0o600)
        fl = logs.FileLog(self.path)
        fl("x")  # a short line still fits
        self.assertFalse((self.dir / "jev.log.1").exists())
        size = self.path.stat().st_size
        self.assertLessEqual(size, logs.LOG_FILE_MAX)
        fl("line 0001 " + "y" * 60)  # this one does not: rotate first
        self.assertEqual((self.dir / "jev.log.1").stat().st_size, size)
        self.assertEqual(self.numbers(self.path), [1])
        self.assertEqual((fl.lines, fl.dropped), (2, 0))

    def test_a_wider_existing_file_is_tightened_to_0600(self):
        self.dir.mkdir(parents=True, mode=0o700)
        self.path.write_text("")
        os.chmod(self.path, 0o644)
        logs.FileLog(self.path)("hello")
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_two_writers_sharing_the_file_lose_no_line_under_the_cap(self):
        a, b = logs.FileLog(self.path, max_bytes=1000), logs.FileLog(self.path, max_bytes=1000)
        for i in range(40):
            (a if i % 2 else b)(f"line {i:04d} " + "z" * 40)
        seen = sorted(n for p in self.dir.glob("jev.log*") for n in self.numbers(p))
        self.assertEqual(seen, list(range(40)))

    def test_a_symlink_or_fifo_is_never_written_through(self):
        self.dir.mkdir(parents=True, mode=0o700)
        target = self.dir / "elsewhere"
        target.write_text("")
        self.path.symlink_to(target)
        fl = logs.FileLog(self.path)
        fl("x")
        self.assertEqual(target.read_text(), "")
        self.path.unlink()
        os.mkfifo(self.path)
        t0 = time.monotonic()
        fl("y")  # no reader: never blocks
        self.assertLess(time.monotonic() - t0, 0.5)
        self.assertEqual((fl.lines, fl.dropped), (0, 2))

    def test_no_path_writes_nothing(self):
        fl = logs.FileLog()
        fl("x")
        self.assertEqual((fl.lines, fl.dropped), (0, 0))


class Unwritable(Routing):
    def test_e_an_unwritable_log_dir_never_raises_into_a_reply_and_counts_file_dropped(self):
        blocker = self.root / "not-a-dir"
        blocker.write_text("x")
        paths = {"parent is a file": blocker / "jev" / "jev.log"}
        if os.geteuid() != 0:
            ro = self.root / "ro"
            ro.mkdir(mode=0o500)
            self.addCleanup(os.chmod, ro, 0o700)
            paths["read-only dir"] = ro / "jev.log"
        for label, path in paths.items():
            with self.subTest(label):
                self.err.clear()
                self.use_filelog(logs.FileLog(path))
                ext = self.ext(FakeClient())
                for i in range(3):
                    self.assertEqual(self.hook(ext, rid=i), {"action": "continue"})
                self.assertEqual(self.hook(ext, tool_input={"command": RM_ROOT})["action"], "block")
                self.assertIn("guard bash: block (", self.err.decode(), "stderr still has the block")
                self.assertEqual((self.filelog.lines, self.filelog.dropped), (0, 4))
                self.assertFalse(path.exists())
                self.assertEqual(self.status(ext)["counters"]["log.file_dropped"], 4)

    def test_e_any_writer_failure_is_counted_never_raised(self):
        for exc in (OSError(28, "no space"), ValueError("x"), RuntimeError("y")):
            with self.subTest(exc=type(exc).__name__):
                fl = logs.FileLog(self.log_path)
                with mock.patch.object(logs.os, "write", side_effect=exc):
                    fl("x")
                self.assertEqual((fl.lines, fl.dropped), (0, 1))
        fl = logs.FileLog(self.log_path)
        with mock.patch.object(logs.os, "write", lambda fd, data: len(data) - 1):
            fl("short")
        self.assertEqual((fl.lines, fl.dropped), (0, 1))


class LogRoutineConfig(Routing):
    def test_f_log_routine_stderr_restores_the_old_routing(self):
        cases = {"stderr": (3, 3), " STDERR ": (3, 3), "file": (0, 3), None: (0, 3), "off": (0, 0)}
        for value, (want_err, want_file) in cases.items():
            with self.subTest(value=value):
                self.reset()
                cfg = {} if value is None else {"log_routine": value}
                ext = self.initialized(FakeClient(), **cfg)
                for i in range(3):
                    self.assertEqual(self.hook(ext, rid=i), {"action": "continue"})
                self.assertEqual(sum("guard bash: continue (" in x for x in self.err_lines()), want_err)
                self.assertEqual(len(self.err_lines()), want_err, self.err_lines())
                self.assertEqual(sum("guard bash: continue (" in x for x in self.file_lines()), want_file)
                # a notice goes to both whatever the setting
                self.reset()
                self.assertEqual(self.hook(ext, tool_input={"command": RM_ROOT})["action"], "block")
                self.assertEqual(len(self.err_lines()), 1)
                self.assertEqual(len(self.file_lines()), 1)

    def test_an_unrecognised_log_routine_means_file_and_says_so_without_the_value(self):
        ext = self.initialized(FakeClient(), log_routine="stdrr-typo")
        self.assertEqual(ext.log_routine, "file")
        self.assertEqual(self.err_lines(), ["[jev] " + jev_ext.LOG_ROUTINE_UNRECOGNISED])
        self.assertNotIn("stdrr-typo", self.err.decode() + "\n".join(self.file_lines()))
        self.reset()
        self.hook(ext)
        self.assertEqual(bytes(self.err), b"")
        self.assertEqual(len(self.file_lines()), 1)

    def test_the_manifest_declares_log_routine(self):
        # The host hands an extension only the keys its manifest declares.
        manifest = json.loads((Path(ROOT) / ".synaps-plugin" / "plugin.json").read_text())
        entry = [e for e in manifest["extension"]["config"] if e["key"] == "log_routine"]
        self.assertEqual(len(entry), 1)
        self.assertEqual(entry[0]["default"], "file")
        for word in ("file", "stderr", "off"):
            self.assertIn(word, entry[0]["description"])

    def test_the_config_writer_keeps_log_routine(self):
        base = self.root / "synaps"
        with mock.patch.dict(os.environ, {"SYNAPS_BASE_DIR": str(base)}):
            keys.write_plugin_config("log_routine", "stderr")
            keys.write_plugin_config("guard", "false")
            path = keys.plugin_config_path()
            self.assertEqual(keys._read_kv(path, "log_routine"), "stderr")
            self.assertEqual(keys._read_kv(path, "guard"), "false")

    def test_status_without_a_key_reports_the_log_too(self):
        ext = jev_ext.Extension()
        ext.client = None
        ext.transport = "relay"  # no key pick-up
        jev_ext.log("one")
        status = self.status(ext)
        self.assertFalse(status["active"])
        self.assertEqual(status["log_file"], str(self.log_path))
        self.assertEqual((status["counters"]["log.file_lines"], status["counters"]["log.stderr_lines"]), (1, 1))


class TestHome(unittest.TestCase):
    def test_the_suite_never_writes_the_real_jev_log(self):
        real = os.path.join(os.path.realpath(os.path.expanduser("~")), ".synaps-cli")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SYNAPS_BASE_DIR", None)
            path = os.path.realpath(str(logs.default_path()))
        self.assertFalse(path.startswith(real + os.sep), path)
        self.assertTrue(path.startswith(os.path.realpath(jev_test_home.RUN_DIR) + os.sep), path)
        self.assertTrue(path.endswith(os.path.join("memory", "jev", "jev.log")))

    def test_the_default_path_follows_synaps_base_dir(self):
        with mock.patch.dict(os.environ, {"SYNAPS_BASE_DIR": "/tmp/jev-base-x"}):
            self.assertEqual(logs.default_path(), Path("/tmp/jev-base-x/memory/jev/jev.log"))


class Relayed(unittest.TestCase):
    def test_relay_lines_are_notices(self):
        lines = []
        client = relay.RelayClient(state_dir="/nonexistent-jev-relay", log=lines.append)
        client._note("no_socket")
        client._note("ok")
        self.assertEqual(len(lines), 2)
        self.assertTrue(all(isinstance(line, logs.Notice) for line in lines), lines)


if __name__ == "__main__":
    unittest.main()
