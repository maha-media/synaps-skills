#!/usr/bin/env python3
"""Review r2 R2-3(b): logging never delays the reply.

A frame's reply is written and flushed before any of that frame's log
lines, on stderr and in jev.log alike. The stderr log is best-effort and
non-blocking: one write per line, O_NONBLOCK when fd 2 is a pipe or socket,
and on EAGAIN or any other error the line is dropped and counted
(`log.dropped`). Routine lines (a continue, a confirm) go to jev.log only,
so these tests record both sinks on one timeline.

Offline only: a fake DecisionClient stands in for Jev. Run:

    python3 -B -m unittest discover -s tests -p 'test_stderr_log.py' -v
"""
from __future__ import annotations

import errno
import fcntl
import os
import select
import signal
import socket
import tempfile
import time
import unittest
from unittest import mock

from test_guard_parity import CANARY, FakeClient, GuardCase, score  # noqa: F401 (sys.path set there)

import jev_ext  # noqa: E402
from jev import audit as audit_mod  # noqa: E402
from jev import guard, logs  # noqa: E402
from jev.client import JevError  # noqa: E402

BLOCK_S = 1.0     # how long the blocking log sink stalls each write
REPLY_BY_S = 0.5  # the reply must be out well before the first stall ends


class Recorder:
    """Shared timeline of replies (send) and log writes (the sink)."""

    def __init__(self, block_s=BLOCK_S):
        self.events = []
        self.block_s = block_s
        self.t0 = time.monotonic()

    def send(self, frame):
        self.events.append(("reply", time.monotonic() - self.t0, frame))

    def sink(self, data):
        self.events.append(("log", time.monotonic() - self.t0, data))
        time.sleep(self.block_s)
        return len(data)

    def kinds(self):
        return [e[0] for e in self.events]

    def replies(self):
        return [e for e in self.events if e[0] == "reply"]

    def logs(self):
        return b"".join(e[2] for e in self.events if e[0] == "log")


class RecordingFileLog(logs.FileLog):
    """jev.log with FileLog's hold/release, its writes going to the blocking sink."""

    def __init__(self, sink):
        super().__init__("recorded-jev.log")
        self._sink = sink

    def _append(self, line):
        return self._sink(line) == len(line)


class ReplyBeforeLog(GuardCase):
    """A blocking log callback never delays the reply: the reply is the
    first thing written for the frame, and goes out within REPLY_BY_S."""

    def ext(self, client):
        ext = jev_ext.Extension()
        ext.cfg = {"project_root": str(self.ws), "guard_confirm": "prompt"}  # today's confirms
        ext.guard_cfg = guard.GuardConfig(ext.cfg)
        ext.client = client
        ext.recompute_features()
        return ext

    def run_frame(self, ext, frame, rec, *, file=True):
        """`file`: record jev.log writes too (else no jev.log at all)."""
        stderr = jev_ext.StderrLog(write=rec.sink)
        filelog = RecordingFileLog(rec.sink) if file else logs.FileLog()
        with mock.patch.object(jev_ext, "send", rec.send), mock.patch.object(jev_ext, "STDERR", stderr), \
                mock.patch.object(jev_ext, "FILELOG", filelog):
            rec.t0 = time.monotonic()
            running = jev_ext.dispatch(ext, frame, received=time.monotonic())
        return running, stderr

    def assert_reply_first(self, rec, label):
        kinds = rec.kinds()
        self.assertIn("reply", kinds, label)
        self.assertIn("log", kinds, f"{label}: the frame did log (the test needs a log line)")
        self.assertEqual(kinds[0], "reply", f"{label}: reply before any log line, got {kinds}")
        self.assertEqual(len(rec.replies()), 1, label)
        self.assertLess(rec.replies()[0][1], REPLY_BY_S, f"{label}: the reply waited for the log")

    def hook_frame(self, tool, tool_input, rid=1):
        return {"jsonrpc": "2.0", "id": rid, "method": "hook.handle",
                "params": {"kind": "before_tool_call", "tool_name": tool, "tool_runtime_name": tool,
                           "tool_input": tool_input, "session_id": "sess-log", "cwd": str(self.ws)}}

    def test_a_blocking_log_never_delays_a_guard_reply(self):
        cases = {
            "bash continue": (FakeClient(), "bash", {"command": "ls"}, "continue"),
            "bash upstream error": (FakeClient(error=JevError("boom")), "bash", {"command": "ls"}, "confirm"),
            "bash high risk": (FakeClient({"risk": score(3, 0.99)}), "bash", {"command": "rm -rf /"}, None),
            "multi_edit": (FakeClient(), "multi_edit",
                           {"edits": [{"path": "a.txt", "op": "append", "text": "x"}]}, "continue"),
            "multi_edit malformed": (FakeClient(), "multi_edit", {"edits": []}, "confirm"),
            "send_events pattern": (FakeClient(), "send_events",
                                    {"source": "w", "messages": [{"session": "s",
                                     "body": "x" * 600 + " ghp_" + "Zy9x" * 9}]}, "confirm"),
        }
        for label, (client, tool, tool_input, action) in cases.items():
            with self.subTest(label):
                rec = Recorder()
                running, _ = self.run_frame(self.ext(client), self.hook_frame(tool, tool_input), rec)
                self.assertTrue(running)
                self.assert_reply_first(rec, label)
                result = rec.replies()[0][2]["result"]
                if action:
                    self.assertEqual(result["action"], action, label)
                else:
                    self.assertIn(result["action"], ("confirm", "block"), label)
                self.assertIn(f"guard {tool}".encode(), rec.logs(), f"{label}: the line is written, late")

    def test_a_crashed_guard_replies_before_it_logs(self):
        rec = Recorder()

        def boom(*a, **kw):
            raise RuntimeError(CANARY)
        with mock.patch.object(jev_ext.guard, "handle", boom):
            self.run_frame(self.ext(FakeClient()), self.hook_frame("bash", {"command": "ls"}), rec)
        self.assert_reply_first(rec, "crashed guard")
        self.assertEqual(rec.replies()[0][2]["result"]["action"], "confirm")
        self.assertIn(b"RuntimeError", rec.logs())
        self.assertNotIn(CANARY.encode(), rec.logs())

    def test_a_crash_in_any_method_replies_before_it_logs(self):
        frames = {
            "after_tool_call": ({"jsonrpc": "2.0", "id": 2, "method": "hook.handle",
                                 "params": {"kind": "after_tool_call", "tool_name": "bash"}}, "hook"),
            "tool.call": ({"jsonrpc": "2.0", "id": 3, "method": "tool.call",
                           "params": {"name": "jev_status", "input": {}}}, "tool_call"),
            "info.get": ({"jsonrpc": "2.0", "id": 4, "method": "info.get"}, "info"),
        }
        for label, (frame, attr) in frames.items():
            with self.subTest(label):
                ext = self.ext(FakeClient())

                def boom(*a, **kw):
                    raise RuntimeError("crash")
                setattr(ext, attr, boom)
                rec = Recorder()
                self.run_frame(ext, frame, rec)
                self.assert_reply_first(rec, label)
                self.assertIn("error", rec.replies()[0][2], label)

    def test_a_held_frame_keeps_at_most_the_cap_and_counts_the_rest(self):
        ext = self.ext(FakeClient())
        extra = 7

        def chatty(params, received=None):
            for i in range(jev_ext.LOG_HOLD_MAX + extra):
                jev_ext.log(f"line {i}")
            return {"action": "continue"}
        ext.hook = chatty
        rec = Recorder(block_s=0)
        _, stderr = self.run_frame(ext, self.hook_frame("bash", {"command": "ls"}), rec, file=False)
        self.assertEqual(rec.kinds()[0], "reply")
        self.assertEqual(rec.kinds().count("log"), jev_ext.LOG_HOLD_MAX)
        self.assertEqual(stderr.dropped, extra)
        self.assertIn(b"line 0\n", rec.logs())
        self.assertNotIn(f"line {jev_ext.LOG_HOLD_MAX}\n".encode(), rec.logs())

    def test_lines_outside_a_frame_are_written_at_once(self):
        rec = Recorder(block_s=0)
        stderr = jev_ext.StderrLog(write=rec.sink)
        with mock.patch.object(jev_ext, "STDERR", stderr):
            jev_ext.log("started")
            self.assertEqual(rec.logs(), b"[jev] started\n")
            with mock.patch.object(jev_ext, "send", rec.send):
                jev_ext.dispatch(self.ext(FakeClient()), {"jsonrpc": "2.0", "id": 5, "method": "info.get"})
            jev_ext.log("stopped")  # after a frame: no longer held (pinned by mutation, r3)
            self.assertEqual(rec.kinds(), ["log", "reply", "log"])
            self.assertTrue(rec.logs().endswith(b"[jev] stopped\n"))


class StderrLogUnit(unittest.TestCase):
    """The sink itself: one bounded write per line, never blocks, drops and
    counts on any failure."""

    def counted(self, **kw):
        drops = []
        log = jev_ext.StderrLog(on_drop=lambda: drops.append(1), **kw)
        return log, drops

    def full_pipe(self):
        r, w = os.pipe()
        self.addCleanup(os.close, r)
        self.addCleanup(os.close, w)
        fcntl.fcntl(w, fcntl.F_SETFL, fcntl.fcntl(w, fcntl.F_GETFL) | os.O_NONBLOCK)
        chunk = b"z" * 4096
        while True:
            try:
                os.write(w, chunk)
            except BlockingIOError:
                break
        while True:  # top up to the last byte
            try:
                os.write(w, b"z")
            except BlockingIOError:
                break
        return r, w

    def drain(self, r):
        fcntl.fcntl(r, fcntl.F_SETFL, fcntl.fcntl(r, fcntl.F_GETFL) | os.O_NONBLOCK)
        out = b""
        while True:
            try:
                data = os.read(r, 65536)
            except BlockingIOError:
                return out
            if not data:
                return out
            out += data

    def test_a_full_non_blocking_pipe_drops_the_line_and_counts_it(self):
        r, w = self.full_pipe()
        log, drops = self.counted(fd=w)
        t0 = time.monotonic()
        log("guard bash: confirm")
        self.assertLess(time.monotonic() - t0, 0.05)
        self.assertEqual((log.dropped, len(drops)), (1, 1))
        self.drain(r)
        log("after drain")
        self.assertEqual(log.dropped, 1)
        self.assertEqual(self.drain(r), b"[jev] after drain\n")

    def test_make_nonblocking_sets_o_nonblock_on_a_pipe_and_a_socket_only(self):
        r, w = os.pipe()
        self.addCleanup(os.close, r)
        self.addCleanup(os.close, w)
        a, b = socket.socketpair()
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        a.setblocking(True)
        fcntl.fcntl(w, fcntl.F_SETFL, fcntl.fcntl(w, fcntl.F_GETFL) | os.O_APPEND)  # a flag to keep
        with tempfile.TemporaryFile() as f:
            for fd, want in ((w, True), (a.fileno(), True), (f.fileno(), False)):
                before = fcntl.fcntl(fd, fcntl.F_GETFL)
                self.assertFalse(before & os.O_NONBLOCK)
                jev_ext.StderrLog(fd=fd).make_nonblocking()
                after = fcntl.fcntl(fd, fcntl.F_GETFL)
                self.assertEqual(bool(after & os.O_NONBLOCK), want, fd)
                self.assertEqual(after & ~os.O_NONBLOCK, before & ~os.O_NONBLOCK, "no other flag changes")

    def test_make_nonblocking_on_a_closed_fd_is_harmless(self):
        fd = os.open(os.devnull, os.O_WRONLY)
        os.close(fd)
        jev_ext.StderrLog(fd=fd).make_nonblocking()

    def test_a_closed_fd_drops_and_counts(self):
        fd = os.open(os.devnull, os.O_WRONLY)
        os.close(fd)
        log, drops = self.counted(fd=fd)
        log("x")
        self.assertEqual((log.dropped, len(drops)), (1, 1))

    def test_any_write_failure_drops_and_counts(self):
        def raising(exc):
            def write(data):
                raise exc
            return write
        writers = {
            "EAGAIN": raising(BlockingIOError(errno.EAGAIN, "again")),
            "EPIPE": raising(BrokenPipeError(errno.EPIPE, "pipe")),
            "EBADF": raising(OSError(errno.EBADF, "bad fd")),
            "EIO": raising(OSError(errno.EIO, "io")),
            "ValueError": raising(ValueError("closed")),
            "partial": lambda data: len(data) - 1,
            "nothing": lambda data: 0,
        }
        for label, write in writers.items():
            with self.subTest(label):
                log, drops = self.counted(write=write)
                log("x")
                self.assertEqual((log.dropped, len(drops)), (1, 1), label)

    def test_a_failing_drop_counter_never_raises(self):
        def bad_counter():
            raise RuntimeError("counter")

        def write(data):
            raise OSError(errno.EIO, "io")
        log = jev_ext.StderrLog(write=write, on_drop=bad_counter)
        log("x")
        self.assertEqual(log.dropped, 1)

    def test_a_line_is_one_write_capped_below_pipe_buf(self):
        writes = []
        log = jev_ext.StderrLog(write=lambda data: writes.append(data) or len(data))
        log("é" * 5000)
        log("two\nlines")
        self.assertEqual(len(writes), 2, "one write per line")
        self.assertLessEqual(jev_ext.LOG_LINE_MAX, select.PIPE_BUF)
        self.assertLessEqual(len(writes[0]), jev_ext.LOG_LINE_MAX)
        self.assertTrue(writes[0].startswith(b"[jev] "))
        self.assertTrue(writes[0].endswith(b"\n"))
        writes[0].decode("utf-8")  # a cut never splits a character
        self.assertEqual(writes[1], b"[jev] two\nlines\n")


class Wiring(unittest.TestCase):
    """main() makes fd 2 non-blocking and counts drops in log.dropped."""

    def test_main_makes_the_log_non_blocking_and_counts_drops(self):
        r, w = os.pipe()
        self.addCleanup(os.close, r)
        self.addCleanup(os.close, w)
        ext = jev_ext.Extension()
        ext.audit = audit_mod.Audit(None)
        stderr = jev_ext.StderrLog(fd=w)
        with mock.patch.object(jev_ext, "Extension", lambda: ext), \
                mock.patch.object(jev_ext, "read_frame", lambda: None), \
                mock.patch.object(jev_ext, "STDERR", stderr):
            fcntl.fcntl(w, fcntl.F_SETFL, fcntl.fcntl(w, fcntl.F_GETFL) | os.O_NONBLOCK)
            while True:
                try:
                    os.write(w, b"z" * 4096)
                except BlockingIOError:
                    break
            fcntl.fcntl(w, fcntl.F_SETFL, fcntl.fcntl(w, fcntl.F_GETFL) & ~os.O_NONBLOCK)
            def stuck(signum, frame):
                raise TimeoutError("main() blocked on a full stderr pipe")
            previous = signal.signal(signal.SIGALRM, stuck)
            signal.alarm(3)
            try:
                t0 = time.monotonic()
                jev_ext.main()  # logs "started" and "stopped" into a full pipe
                self.assertLess(time.monotonic() - t0, 1.0)
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, previous)
        self.assertTrue(fcntl.fcntl(w, fcntl.F_GETFL) & os.O_NONBLOCK)
        self.assertEqual(ext.audit.counters.get("log.dropped"), 2)
        self.assertEqual(stderr.dropped, 2)


if __name__ == "__main__":
    unittest.main()
