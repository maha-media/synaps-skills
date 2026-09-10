#!/usr/bin/env python3
"""Offline tests for the bell plugin: framing, turn-boundary logic, tty path."""

import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as bell  # noqa: E402


class FakeTimer:
    """Deterministic stand-in for threading.Timer: fires only on demand."""

    instances = []

    def __init__(self, delay, fn):
        self.delay = delay
        self.fn = fn
        self.cancelled = False
        self.started = False
        self.daemon = False
        FakeTimer.instances.append(self)

    def start(self):
        self.started = True

    def cancel(self):
        self.cancelled = True

    def fire(self):
        if not self.cancelled:
            self.fn()


def make_bell(**overrides):
    FakeTimer.instances.clear()
    rings = []
    clock = {"now": 100.0}
    config = bell.resolve_config(overrides)
    b = bell.Bell(config, ring=lambda path: rings.append(path), clock=lambda: clock["now"], timer_factory=FakeTimer)
    return b, rings, clock


def complete(has_tool_use):
    return {"kind": "on_message_complete", "message": "ignored", "data": {"has_tool_use": has_tool_use}}


class TurnBoundaryTests(unittest.TestCase):
    def test_final_message_rings_after_settle(self):
        b, rings, _ = make_bell()
        self.assertEqual(b.handle_hook(complete(False)), {"action": "continue"})
        self.assertEqual(rings, [])
        timer = FakeTimer.instances[-1]
        self.assertTrue(timer.started)
        self.assertAlmostEqual(timer.delay, 0.4)
        timer.fire()
        self.assertEqual(rings, [None])

    def test_configured_tty_override_is_passed_to_ring(self):
        b, rings, _ = make_bell(tty="/tmp/some-tty")
        b.handle_hook(complete(False))
        FakeTimer.instances[-1].fire()
        self.assertEqual(rings, ["/tmp/some-tty"])

    def test_tool_use_message_never_arms(self):
        b, rings, _ = make_bell()
        b.handle_hook(complete(True))
        self.assertEqual(FakeTimer.instances, [])
        self.assertEqual(rings, [])

    def test_before_message_cancels_candidate(self):
        b, rings, _ = make_bell()
        b.handle_hook(complete(False))
        timer = FakeTimer.instances[-1]
        self.assertEqual(b.handle_hook({"kind": "before_message", "message": "x"}), {"action": "continue"})
        self.assertTrue(timer.cancelled)
        timer.fire()
        self.assertEqual(rings, [])

    def test_second_candidate_replaces_first(self):
        b, rings, _ = make_bell()
        b.handle_hook(complete(False))
        first = FakeTimer.instances[-1]
        b.handle_hook(complete(False))
        second = FakeTimer.instances[-1]
        self.assertTrue(first.cancelled)
        first.fire()
        second.fire()
        self.assertEqual(rings, [None])

    def test_rate_limit(self):
        b, rings, clock = make_bell(min_interval_ms=1000)
        b.handle_hook(complete(False))
        FakeTimer.instances[-1].fire()
        clock["now"] += 0.5
        b.handle_hook(complete(False))
        FakeTimer.instances[-1].fire()
        self.assertEqual(rings, [None])
        clock["now"] += 0.6
        b.handle_hook(complete(False))
        FakeTimer.instances[-1].fire()
        self.assertEqual(rings, [None, None])

    def test_disabled_never_arms(self):
        b, rings, _ = make_bell(enabled=False)
        b.handle_hook(complete(False))
        self.assertEqual(FakeTimer.instances, [])

    def test_missing_or_malformed_data_does_not_ring(self):
        b, rings, _ = make_bell()
        b.handle_hook({"kind": "on_message_complete"})
        b.handle_hook({"kind": "on_message_complete", "data": {"has_tool_use": "no"}})
        b.handle_hook({"kind": "on_message_complete", "data": None})
        b.handle_hook("garbage")
        self.assertEqual(FakeTimer.instances, [])

    def test_other_hooks_continue_without_effect(self):
        b, rings, _ = make_bell()
        for kind in ("on_session_start", "before_tool_call", "on_compaction"):
            self.assertEqual(b.handle_hook({"kind": kind}), {"action": "continue"})
        self.assertEqual(FakeTimer.instances, [])

    def test_shutdown_cancels_armed_timer(self):
        b, rings, _ = make_bell()
        b.handle_hook(complete(False))
        timer = FakeTimer.instances[-1]
        b.shutdown()
        self.assertTrue(timer.cancelled)
        timer.fire()
        self.assertEqual(rings, [])

    def test_real_timer_fires(self):
        rings = []
        fired = threading.Event()
        b = bell.Bell(bell.resolve_config({"settle_ms": 20}), ring=lambda path: (rings.append(1), fired.set()))
        b.handle_hook(complete(False))
        self.assertTrue(fired.wait(2.0))
        self.assertEqual(rings, [1])


class ConfigTests(unittest.TestCase):
    def test_defaults(self):
        self.assertEqual(bell.resolve_config(None), {"enabled": True, "settle_ms": 400, "min_interval_ms": 1000, "tty": ""})

    def test_coercion_and_fallback(self):
        cfg = bell.resolve_config({"enabled": "off", "settle_ms": "250", "min_interval_ms": -5})
        self.assertEqual(cfg, {"enabled": False, "settle_ms": 250, "min_interval_ms": 1000, "tty": ""})
        cfg = bell.resolve_config({"enabled": 7, "settle_ms": True, "min_interval_ms": "soon", "tty": 12})
        self.assertEqual(cfg, {"enabled": True, "settle_ms": 400, "min_interval_ms": 1000, "tty": ""})
        self.assertEqual(bell.resolve_config({"tty": "  /dev/pts/9 "})["tty"], "/dev/pts/9")
        self.assertEqual(bell.resolve_config({"settle_ms": 999_999})["settle_ms"], 400)


class TerminalTests(unittest.TestCase):
    def test_writes_bel_to_override_file(self):
        with tempfile.TemporaryDirectory() as d:
            target = os.path.join(d, "tty.log")
            open(target, "wb").close()
            self.assertTrue(bell.ring_terminal(target))
            self.assertTrue(bell.ring_terminal(target))
            with open(target, "rb") as f:
                self.assertEqual(f.read(), b"\x07\x07")

    def test_missing_target_is_silent(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(bell.ring_terminal(os.path.join(d, "absent")))

    def test_directory_target_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(bell.ring_terminal(d))

    def test_no_controlling_terminal_is_silent(self):
        # Under the test runner /dev/tty may or may not exist; either way the
        # call must not raise. Force the no-tty path via a bogus path.
        self.assertFalse(bell.ring_terminal("/dev/null/nope"))


# ── Framing + real process fixture ────────────────────────────────────

def frame(obj):
    body = json.dumps(obj).encode()
    return f"Content-Length: {len(body)}\r\n\r\n".encode() + body


def recv(stream):
    length = None
    while True:
        line = stream.readline()
        if line == b"":
            return None
        if line in (b"\r\n", b"\n"):
            break
        name, _, value = line.decode().partition(":")
        if name.strip().lower() == "content-length":
            length = int(value.strip())
    return json.loads(stream.read(length))


class FramingTests(unittest.TestCase):
    def test_serve_roundtrip_in_process(self):
        rings = []
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"config": {"settle_ms": 0}}},
            {"jsonrpc": "2.0", "id": 2, "method": "hook.handle", "params": complete(True)},
            {"jsonrpc": "2.0", "id": 3, "method": "bogus"},
            {"jsonrpc": "2.0", "id": 4, "method": "shutdown"},
        ]
        stdin = io.BytesIO(b"".join(frame(r) for r in requests))
        stdout = io.BytesIO()
        bell.serve(stdin=stdin, stdout=stdout, ring=lambda path: rings.append(path))
        stdout.seek(0)
        replies = [recv(stdout) for _ in range(4)]
        self.assertEqual(replies[0]["result"]["protocol_version"], 1)
        self.assertEqual(replies[1]["result"], {"action": "continue"})
        self.assertEqual(replies[2]["error"]["code"], -32601)
        self.assertEqual(replies[3]["id"], 4)
        self.assertEqual(rings, [])

    def test_truncated_frame_ends_loop_cleanly(self):
        stdin = io.BytesIO(b"Content-Length: 50\r\n\r\n{\"short\":1}")
        stdout = io.BytesIO()
        bell.serve(stdin=stdin, stdout=stdout, ring=lambda path: None)
        self.assertEqual(stdout.getvalue(), b"")

    def test_real_process_rings_captured_tty(self):
        with tempfile.TemporaryDirectory() as d:
            tty = os.path.join(d, "tty.log")
            open(tty, "wb").close()
            env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "TERM")}
            proc = subprocess.Popen(
                [sys.executable, str(ROOT / "main.py")],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                cwd=str(ROOT), env=env,
            )
            try:
                proc.stdin.write(frame({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                        "params": {"plugin_id": "bell", "config": {"settle_ms": 30, "min_interval_ms": 0, "tty": tty}}}))
                proc.stdin.flush()
                self.assertEqual(recv(proc.stdout)["result"]["protocol_version"], 1)
                # Mid-turn message with tool use: no bell.
                proc.stdin.write(frame({"jsonrpc": "2.0", "id": 2, "method": "hook.handle", "params": complete(True)}))
                proc.stdin.flush()
                self.assertEqual(recv(proc.stdout)["result"], {"action": "continue"})
                # Final message: bell after settle.
                proc.stdin.write(frame({"jsonrpc": "2.0", "id": 3, "method": "hook.handle", "params": complete(False)}))
                proc.stdin.flush()
                self.assertEqual(recv(proc.stdout)["result"], {"action": "continue"})
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and os.path.getsize(tty) == 0:
                    time.sleep(0.02)
                # Cancelled candidate: before_message arrives inside the window.
                proc.stdin.write(frame({"jsonrpc": "2.0", "id": 4, "method": "hook.handle", "params": complete(False)}))
                proc.stdin.write(frame({"jsonrpc": "2.0", "id": 5, "method": "hook.handle", "params": {"kind": "before_message"}}))
                proc.stdin.flush()
                recv(proc.stdout)
                recv(proc.stdout)
                time.sleep(0.15)
                proc.stdin.write(frame({"jsonrpc": "2.0", "id": 6, "method": "shutdown"}))
                proc.stdin.flush()
                self.assertEqual(recv(proc.stdout)["id"], 6)
                out, err = proc.communicate(timeout=5)
            finally:
                if proc.poll() is None:
                    proc.kill()
            self.assertEqual(proc.returncode, 0)
            self.assertEqual(out, b"", "stdout must carry only framed replies")
            self.assertEqual(err, b"", "plugin must not write to stderr")
            with open(tty, "rb") as f:
                self.assertEqual(f.read(), b"\x07")


if __name__ == "__main__":
    unittest.main()
