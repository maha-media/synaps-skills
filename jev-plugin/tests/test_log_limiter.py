#!/usr/bin/env python3
"""Notices that repeat are limited, so one sustained failure cannot use up
the host's 128 KiB stderr budget.

The 28b review of 4feae54e (jev.log for routine lines) found the guard's
evaluation-error notice written to stderr on EVERY call: the guard is exempt
from budgets and the circuit, so an API outage at ~50 calls/min spent the
host's budget about 28 minutes in. jev now keeps a small limiter per
extension (logs.Limiter): the first occurrence of a key reaches stderr;
repeats inside its window (10 min) go to jev.log only, counted; when the
window ends, ONE summary line; on a change of state (error → ok), ONE
"recovered" line. The key is a category (guard.error:<category>:<outcome>,
guard.27b_record, compress.error, crash:<signature>) or else the line text
with its timings dropped. Lifecycle, activation, key and transport lines are
never limited.

The delta review of c313f002 found that keys of one FAMILY (the guard's
evaluation errors, one key per category: timeout, transport error, each HTTP
status) each wrote a summary per window and, the recovery flag reset at each
window, a "recovered" line per window too: over 5 categories, 85 KB (API
down) to 149 KB (20% errors) in 24 h. So a family (guard errors, handler
crashes, relay states) has ONE window: the first of each key still reaches
stderr at once, the window ends in ONE summary with counts per key, and
"recovered" is said once per episode (until a quiet window), not per window.

  (g) 100 failing guard calls, a real DecisionClient with its wire down (the
      reviewer's probe): at most 2 stderr lines, 100 jev.log lines, counted
  (h) a simulated 24 h at 50 calls/min under each sustained failure, one
      kind or a family's several (the delta probe's mixed categories):
      stderr stays under 64 KiB (half the host budget)
  (i) a multi-line message is ONE stamped jev.log line
  (j) blocks with different texts each reach stderr; a repeat does not

Offline only. Run:

    python3 -B -m unittest discover -s tests -p 'test_log_limiter.py' -v
"""
from __future__ import annotations

import copy
import itertools
import os
import time
import unittest
from pathlib import Path
from unittest import mock

from test_log_routing import RM_ROOT, Routing  # noqa: F401 (sys.path set there)
from test_guard_parity import FakeClient, score

import jev_ext  # noqa: E402
from jev import access, allow_once, compress, guard, logs, relay  # noqa: E402
from jev.client import DecisionClient, JevError, Stats  # noqa: E402

WIRE_DOWN = "decision transport or response failure"
# five categories of a guard evaluation error (guard.error_category): timeout, transport error, HTTP 502/503/504
FIVE_ERRORS = ("deadline exceeded", WIRE_DOWN, "HTTP 502", "HTTP 503", "HTTP 504")
CALLS_PER_MIN = 50
DAY_CALLS = 24 * 60 * CALLS_PER_MIN  # 72,000
STDERR_DAY_MAX = 64 * 1024           # half the host's 128 KiB per process
DAY_WINDOWS = 24 * 60 // 10          # the limiter's 10-min windows in a day
OUTPUT = "routine progress\n" * 360  # a compress candidate (over 6000 bytes, repetitive)


def memoized(fn):
    """fn itself, once per distinct argument list (the day repeats one call)."""
    seen = {}

    def call(*args, **kwargs):
        key = repr((args, sorted(kwargs.items())))
        if key not in seen:
            seen[key] = fn(*args, **kwargs)
        return seen[key]
    return call


class CountingFileLog(logs.FileLog):
    """jev.log without the disk: each line is formatted (escaped, bounded) and counted."""

    def __init__(self, path):
        super().__init__(path)
        self.bytes = 0

    def _append(self, line):
        self.bytes += len(line)
        return True


class Limited(Routing):
    def wire_down(self, text=WIRE_DOWN):
        def fail(client, *a, **kw):
            raise JevError(text)
        for patcher in (mock.patch.object(DecisionClient, "_bounded_post", fail),
                        mock.patch.object(DecisionClient, "_post", fail)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def outage(self, text=WIRE_DOWN, **cfg):
        """The reviewer's probe: a real DecisionClient, budgets and the circuit
        on (the guard is exempt from both), the wire down."""
        self.wire_down(text)
        ext = self.initialized(FakeClient(), budget_enabled=True, budget_error_streak=3, **cfg)
        ext.client = DecisionClient("apikey_probe_not_real", policy=ext.policy, timeout_s=3.0)
        ext.client.stats = Stats()
        ext.recompute_features()
        return ext

    def after(self, ext, output=OUTPUT, rid=1):
        jev_ext.dispatch(ext, {"jsonrpc": "2.0", "id": rid, "method": "hook.handle",
                               "params": {"kind": "after_tool_call", "tool_name": "bash",
                                          "tool_runtime_name": "bash", "tool_input": {"command": "make"},
                                          "tool_output": output, "session_id": "sess-log"}})
        return self.sent[-1]["result"]

    def message(self, ext, rid=1):
        jev_ext.dispatch(ext, {"jsonrpc": "2.0", "id": rid, "method": "hook.handle",
                               "params": {"kind": "before_message", "message": "go", "session_id": "sess-log"}})

    def stop(self, ext):
        """main()'s end of the process: the last summaries, then `stopped`."""
        with mock.patch.object(jev_ext, "read_frame", lambda: None), \
                mock.patch.object(jev_ext, "Extension", lambda: ext), \
                mock.patch.object(self.stderr, "make_nonblocking", lambda: None):
            jev_ext.main()


# ── (g) the blocking finding: a guard outage ─────────────────────────────────

class GuardOutage(Limited):
    def test_g_100_failing_guard_calls_write_at_most_2_stderr_lines(self):
        cases = {"transport error, auto": (WIRE_DOWN, {"guard_confirm": "auto"}, "continue"),
                 "transport error, prompt": (WIRE_DOWN, {"guard_confirm": "prompt"}, "confirm"),
                 "timeout, auto": ("deadline exceeded", {"guard_confirm": "auto"}, "continue")}
        for label, (text, cfg, action) in cases.items():
            with self.subTest(label):
                self.reset()
                ext = self.outage(text, **cfg)
                for i in range(100):
                    self.assertEqual(self.hook(ext, tool_input={"command": f"ls {i}"}, rid=i)["action"], action)
                err = self.err_lines()
                self.assertLessEqual(len(err), 2, err)
                self.assertIn("[jev] guard bash: error after ", err[0])
                lines = self.file_lines()
                self.assertEqual(len(lines), 100, lines[:3])
                self.assertTrue(all(" [jev] guard bash: error after " in line for line in lines))
                self.assertEqual(self.status(ext)["counters"]["log.notices_limited"], 99)
                self.assertEqual(ext.policy.snapshot()["aggregate"]["denied"], {}, "never the circuit")

    def test_an_answer_after_errors_says_recovered_once(self):
        client = FakeClient(error=JevError("deadline exceeded"))
        ext = self.ext(client)
        for i in range(5):
            self.assertEqual(self.hook(ext, rid=i), {"action": "continue"})
        self.assertEqual(len(self.err_lines()), 1, self.err_lines())
        client.error = None
        for i in range(3):
            self.assertEqual(self.hook(ext, rid=10 + i), {"action": "continue"})
        err = self.err_lines()
        self.assertEqual(len(err), 2, err)
        self.assertIn("guard: evaluation errors: recovered after 5 errors (timeout → continue ×5)", err[1])
        self.assertTrue(any(line.endswith(" " + err[1]) for line in self.file_lines()))


# ── the limiter itself ───────────────────────────────────────────────────────

class LimiterUnit(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.lim = logs.Limiter(clock=lambda: self.now)

    def error(self):
        return logs.notice("guard bash: error after 5 ms → continue (auto, local rules passed) (timeout)",
                           key="guard.error:timeout:continue", label="guard: evaluation error (timeout) → continue")

    def test_the_first_is_shown_repeats_are_counted_one_summary_per_window(self):
        self.assertEqual(logs.LIMIT_WINDOW_S, 600)
        self.assertTrue(self.lim(logs.Notice("guard bash: block (3 ms) x")))
        for ms in range(9):
            self.now += 60
            self.assertFalse(self.lim(logs.Notice(f"guard bash: block ({ms} ms) x")), "timings are not the key")
        self.assertEqual((self.lim.take(), self.lim.limited), ([], 9))
        self.now = 600
        self.lim.tick()
        out = self.lim.take()
        self.assertEqual(len(out), 1, out)
        self.assertIn("guard bash: block (… ms) x: repeated 9 more times in the last 10 min", out[0])
        self.assertFalse(self.lim(logs.Notice("guard bash: block (1 ms) x")), "still limited: the next window")
        self.now = 1200
        self.lim.tick()
        self.assertEqual(len(out := self.lim.take()), 1)
        self.assertIn("repeated 1 more time in the last 10 min", out[0])
        self.now = 1800
        self.lim.tick()  # a quiet window: closed, no line
        self.assertEqual((self.lim.take(), len(self.lim)), ([], 0))
        self.assertTrue(self.lim(logs.Notice("guard bash: block (1 ms) x")), "a first again")
        self.assertEqual(self.lim.summaries, 2)

    def test_a_change_of_state_says_recovered_once_per_episode(self):
        ok = logs.routine("guard bash: continue (5 ms) fine", clears="guard.error:")
        self.assertTrue(self.lim(self.error()))
        for _ in range(4):
            self.assertFalse(self.lim(self.error()))
        self.assertTrue(self.lim(ok), "a routine line is never limited")
        self.assertEqual(self.lim.take(), ["guard: evaluation error (timeout) → continue: recovered after 5 errors"])
        for _ in range(3):  # flapping inside the window: counted, no more recovery lines
            self.assertFalse(self.lim(self.error()))
            self.lim(ok)
        self.assertEqual(self.lim.take(), [])
        self.now = 600
        self.lim.tick()
        out = self.lim.take()
        self.assertEqual(len(out), 1, out)
        self.assertIn("repeated 3 more times in the last 10 min", out[0])
        self.assertTrue(out[0].endswith("; ok again"), out[0])
        self.lim(self.error())
        self.lim(ok)  # the next window, the same episode: no recovery line, the summary says it
        self.assertEqual(self.lim.take(), [])
        self.now = 1200
        self.lim.tick()
        self.assertEqual(self.lim.take(), ["guard: evaluation error (timeout) → continue: repeated 1 more time "
                                           "in the last 10 min (each in jev.log); ok again"])
        self.now = 1800
        self.lim.tick()  # a quiet window ends the episode
        self.assertEqual((self.lim.take(), len(self.lim)), ([], 0))
        self.assertTrue(self.lim(self.error()), "a first again")
        self.lim(ok)  # a new episode: one recovery line again
        self.assertEqual(self.lim.take(), ["guard: evaluation error (timeout) → continue: recovered after 1 error"])
        self.assertEqual(self.lim.summaries, 4)

    def family_error(self, category, outcome="continue"):
        return logs.notice(f"guard bash: error after 5 ms → {outcome} ({category})",
                           key=f"guard.error:{category}:{outcome}", label=f"{category} → {outcome}",
                           family="guard: evaluation errors")

    def test_a_family_has_one_window_one_summary_and_one_recovery(self):
        cats = ("timeout", "transport error", "HTTP 502", "HTTP 503", "HTTP 504")
        for cat in cats:
            self.assertTrue(self.lim(self.family_error(cat)), f"the first of each key at once: {cat}")
        for i in range(20):
            self.now += 10
            self.assertFalse(self.lim(self.family_error(cats[i % 5])))
        self.assertEqual((self.lim.take(), len(self.lim), self.lim.limited), ([], 5, 20))
        ok = logs.routine("guard bash: continue (5 ms) fine", clears="guard.error:")
        self.lim(ok)
        self.assertEqual(self.lim.take(), ["guard: evaluation errors: recovered after 25 errors (timeout → continue ×5, "
                                           "transport error → continue ×5, HTTP 502 → continue ×5, "
                                           "HTTP 503 → continue ×5, HTTP 504 → continue ×5)"])
        for cat in ("HTTP 503", "timeout", "timeout"):
            self.assertFalse(self.lim(self.family_error(cat)))
            self.lim(ok)
        self.assertEqual(self.lim.take(), [], "once per episode")
        self.assertTrue(self.lim(self.family_error("rate limited")), "a new key of a live family: at once")
        self.now = 600
        self.lim.tick()
        self.assertEqual(self.lim.take(), ["guard: evaluation errors: repeated 3 more times in the last 10 min "
                                           "(timeout → continue ×2, HTTP 503 → continue ×1) (each in jev.log)"])
        self.now = 1200
        self.lim.tick()  # a quiet window: the family and all its keys are closed
        self.assertEqual((self.lim.take(), len(self.lim)), ([], 0))
        self.assertTrue(self.lim(self.family_error("HTTP 503")), "a first again")
        self.assertEqual(self.lim.summaries, 2)

    def test_a_family_summary_names_its_most_frequent_keys_within_a_bound(self):
        for i in range(40):
            for _ in range(i + 1):
                self.lim(logs.notice(f"crash {i}", key=f"crash:{i}", label=f"kind {i:02d} " + "x" * 30,
                                     family="handler crashes"))
        self.lim.close()
        out = self.lim.take()
        self.assertEqual(len(out), 1, out)
        self.assertTrue(out[0].startswith("handler crashes: repeated 780 more times in the last 1 min "
                                          "(kind 39 " + "x" * 30 + " ×39, kind 38 "), out[0])
        self.assertIn(", +", out[0])
        self.assertTrue(out[0].endswith(" more) (each in jev.log)"), out[0])
        self.assertLess(len(out[0]), 400, out[0])

    def test_a_clear_for_another_key_or_nothing_open_says_nothing(self):
        self.lim(logs.routine("compress fold: 1 -> 1 bytes", clears="compress.error"))
        self.assertTrue(self.lim(self.error()))
        self.lim(logs.routine("compress fold: 1 -> 1 bytes", clears="compress.error"))
        self.assertEqual(self.lim.take(), [])

    def test_keys_are_independent(self):
        self.assertTrue(self.lim(logs.Notice("relay: ok (x)")))
        self.assertTrue(self.lim(logs.Notice("relay: Jev is off (deadline); not reconnecting for 5 s")))
        self.assertFalse(self.lim(logs.Notice("relay: ok (x)")))
        self.assertTrue(self.lim(logs.Notice("relay: ok (y)")))
        self.assertTrue(self.lim(logs.notice("same text", key="a")))
        self.assertTrue(self.lim(logs.notice("same text", key="b")))
        self.assertTrue(self.lim("a plain line"))
        self.assertTrue(self.lim("a plain line"))

    def test_close_summarises_every_open_window(self):
        for text in ("a", "a", "a", "b", "b", "c"):
            self.lim(logs.Notice(text))
        self.now = 120
        self.lim.close()
        out = self.lim.take()
        self.assertEqual(sorted(out), ["a: repeated 2 more times in the last 2 min (each in jev.log)",
                                       "b: repeated 1 more time in the last 2 min (each in jev.log)"])
        self.assertEqual(len(self.lim), 0)

    def test_the_key_table_is_bounded(self):
        lim = logs.Limiter(clock=lambda: self.now, max_keys=3)
        for text in ("a", "a", "b", "c"):
            self.now += 1
            lim(logs.Notice(text))
        self.assertTrue(lim(logs.Notice("d")))  # evicts the oldest (a), with its summary
        self.assertEqual(len(lim), 3)
        self.assertEqual(len(out := lim.take()), 1)
        self.assertTrue(out[0].startswith("a: repeated 1 more time"), out)
        self.assertTrue(lim(logs.Notice("a")), "a first again")
        family = logs.Limiter(clock=lambda: self.now, max_keys=3)
        for name in ("a", "b", "c", "a"):
            family(logs.notice(name, key=name, label=name, family="f"))
        self.assertTrue(family(logs.notice("d", key="d", label="d", family="f")))
        self.assertEqual(len(family), 1, "a family's keys count each: the family is the oldest, closed")
        self.assertEqual(family.take(), ["f: repeated 1 more time in the last 1 min (a ×1) (each in jev.log)"])

    def test_a_long_label_is_cut(self):
        self.lim(logs.Notice("x" * 3000))
        self.lim(logs.Notice("x" * 3000))
        self.lim.close()
        out = self.lim.take()[0]
        self.assertLess(len(out), 200, out)
        self.assertIn("…: repeated 1 more time", out)


class NeverLimited(Limited):
    def test_lifecycle_activation_and_key_lines_are_never_limited(self):
        for _ in range(3):
            jev_ext.log("started")
        ext = self.ext(FakeClient())
        ext.activate_relay()
        ext.activate_relay()
        err = self.err_lines()
        self.assertEqual(err.count("[jev] started"), 3)
        self.assertEqual(sum("through the Pria desktop relay" in line for line in err), 2, err)

    def test_a_relay_state_change_goes_through_the_limiter(self):
        ext = self.ext(FakeClient())
        ext.activate_relay()
        now = [0.0]
        ext.limiter.clock = lambda: now[0]
        self.reset()
        for code in ("deadline", "ok", "deadline", "ok", "deadline"):
            ext.client._note(code)
        err = self.err_lines()
        self.assertEqual(len(err), 2, err)
        self.assertEqual(len(self.file_lines()), 5)
        self.assertEqual(ext.limiter.limited, 3)
        now[0] = 601
        self.message(ext)
        err = self.err_lines()
        self.assertEqual(err[2:], ["[jev] relay: repeated 3 more times in the last 10 min "
                                   "(off (deadline) ×2, ok ×1) (each in jev.log)"], "one family, one summary")

    def test_main_writes_the_pending_summaries_before_stopped(self):
        ext = self.ext(FakeClient(), guard_access="off")  # the shell-safety rule's block, one text
        for i in range(4):
            self.hook(ext, tool_input={"command": RM_ROOT}, rid=i)
        self.stop(ext)
        err = self.err_lines()
        self.assertEqual(err[-1], "[jev] stopped")
        self.assertIn("repeated 3 more times in the last 1 min", err[-2])
        self.assertIn("guard bash: block (… ms) shell-safety rule", err[-2])

    def test_a_summary_is_written_on_the_next_frame_after_the_window(self):
        ext = self.ext(FakeClient(), guard_access="off")
        now = [0.0]
        ext.limiter.clock = lambda: now[0]
        for i in range(3):
            self.hook(ext, tool_input={"command": RM_ROOT}, rid=i)
        self.assertEqual(len(self.err_lines()), 1)
        now[0] = 601
        self.message(ext)  # any frame
        err = self.err_lines()
        self.assertEqual(len(err), 2, err)
        self.assertIn("repeated 2 more times in the last 10 min", err[1])


class Crashes(Limited):
    def test_a_repeated_crash_is_shown_in_full_once_then_counted(self):
        def boom(*a, **kw):
            raise RuntimeError("crash")

        def other(*a, **kw):
            raise KeyError("x")
        ext = self.ext(FakeClient())
        with mock.patch.object(jev_ext.guard, "handle", boom):
            for i in range(5):
                self.assertEqual(self.hook(ext, rid=i)["action"], "block")
        err = self.err.decode()
        self.assertEqual(err.count("handler crashed on hook.handle: RuntimeError"), 1, err)
        self.assertIn('File "', err, "the first is in full, frames and all")
        lines = self.file_lines()
        self.assertEqual(len(lines), 5)
        self.assertIn("\\n  File ", lines[0], "the frames, escaped onto one line")
        for line in lines[1:]:
            self.assertIn("handler crashed on hook.handle: RuntimeError at test_log_limiter.py:", line)
            self.assertNotIn("File ", line)
        with mock.patch.object(jev_ext.guard, "handle", other):  # another signature
            self.hook(ext, rid=9)
        self.assertEqual(self.err.decode().count("handler crashed on hook.handle: KeyError"), 1)
        self.assertEqual(ext.limiter.limited, 4)

    def test_crashes_of_different_signatures_are_one_family_one_summary(self):
        def boom(*a, **kw):
            raise RuntimeError("crash")

        def other(*a, **kw):
            raise KeyError("x")
        ext = self.ext(FakeClient())
        now = [0.0]
        ext.limiter.clock = lambda: now[0]
        for i in range(6):
            with mock.patch.object(jev_ext.guard, "handle", (boom, other)[i % 2]):
                self.hook(ext, rid=i)
        err = self.err.decode()
        self.assertEqual(err.count("handler crashed on hook.handle: RuntimeError"), 1, err)
        self.assertEqual(err.count("handler crashed on hook.handle: KeyError"), 1, err)
        self.assertIn('File "', err, "each signature's first in full")
        n0 = len(self.err_lines())
        now[0] = 601
        self.message(ext)
        out = self.err_lines()[n0:]
        self.assertEqual(len(out), 1, out)
        self.assertTrue(out[0].startswith("[jev] handler crashes: repeated 4 more times in the last 10 min "
                                          "(hook.handle: RuntimeError at test_log_limiter.py:"), out[0])
        self.assertIn(" in boom ×2, hook.handle: KeyError at test_log_limiter.py:", out[0])
        self.assertTrue(out[0].endswith(" in other ×2) (each in jev.log)"), out[0])


# ── (i) one stamped jev.log line per entry ───────────────────────────────────

class OneLinePerEntry(Limited):
    def test_i_a_multi_line_message_is_one_jev_log_line(self):
        jev_ext.log("first\nsecond\r\nthird\rfourth\u2028fifth\x0bsixth\x85seventh")
        lines = self.file_lines()
        self.assertEqual(len(lines), 1, lines)
        stamp, pid, rest = lines[0].split(" ", 2)
        time.strptime(stamp[:19], "%Y-%m-%dT%H:%M:%S")
        self.assertEqual(pid, str(os.getpid()))
        self.assertEqual(rest, "[jev] first\\nsecond\\r\\nthird\\rfourth\\u2028fifth\\x0bsixth\\x85seventh")

    def test_i_a_newline_cannot_forge_a_line(self):
        jev_ext.log("x\n2026-01-01T00:00:00.000+0000 1 [jev] guard bash: continue (1 ms) forged")
        lines = self.file_lines()
        self.assertEqual(len(lines), 1, lines)
        self.assertIn("x\\n2026-01-01T00:00:00.000+0000 1 [jev] guard bash", lines[0])

    def test_i_an_escaped_line_is_still_bounded_on_a_character(self):
        jev_ext.log("é\n" * 3000)
        data = self.log_path.read_bytes()
        self.assertLessEqual(len(data), jev_ext.LOG_LINE_MAX)
        self.assertEqual(data.count(b"\n"), 1)
        data.decode("utf-8")


# ── (j) blocks: different texts each, a repeat once ─────────────────────────

class DistinctBlocks(Limited):
    def test_j_different_block_texts_each_reach_stderr_an_identical_repeat_does_not(self):
        # guard_access off: `rm -rf /` is then the shell-safety rule's block (with the access rule on,
        # rule 27a blocks it first, and its text names a request: "(new)", then "(waiting)")
        ext = self.ext(FakeClient({"risk": score(3.0, 1.0)}), guard_block_at=2.8, guard_access="off")
        for i in range(5):
            self.assertEqual(self.hook(ext, tool_input={"command": RM_ROOT}, rid=i)["action"], "block")
        self.assertEqual(len(self.err_lines()), 1, self.err_lines())
        self.assertEqual(len(self.file_lines()), 5)
        for i, command in enumerate(("echo hi\n" + RM_ROOT, "ls", "pwd", "ls", "echo hi\n" + RM_ROOT)):
            self.assertEqual(self.hook(ext, tool_input={"command": command}, rid=10 + i)["action"], "block")
        err = self.err_lines()
        self.assertEqual(len(err), 3, err)  # rm line 1, rm line 2, the model's block (ls and pwd read the same)
        self.assertEqual(len(set(err)), 3, err)
        self.assertTrue(all(line.startswith("[jev] guard bash: block (") for line in err), err)
        self.assertIn("shell-safety rule", err[0])
        self.assertIn("line 2", err[1])
        self.assertEqual(len(self.file_lines()), 10)

    def test_j_the_access_rule_s_new_and_waiting_requests_each_reach_stderr_once(self):
        ext = self.ext(FakeClient())
        for i in range(5):
            self.assertEqual(self.hook(ext, tool_input={"command": RM_ROOT}, rid=i)["action"], "block")
        err = self.err_lines()
        self.assertEqual(len(err), 2, err)
        self.assertIn("access rule 27a", err[0])
        self.assertIn("(new)", err[0])
        self.assertIn("(waiting)", err[1])
        self.assertEqual(len(self.file_lines()), 5)


# ── (h) the 24 h budget, one sustained failure at a time ─────────────────────

class DayBudget(Limited):
    """72,000 calls (24 h at 50 a minute) on a fake clock: stderr < 64 KiB."""
    measured = {}

    def setUp(self):
        super().setUp()
        self.counting = CountingFileLog(self.log_path)
        self.use_filelog(self.counting)
        self.now = [10_000.0]
        # The redaction of the model's state is 3/4 of a guard call's time here and logs nothing:
        # stubbed (the state passes unredacted to the fake wire), so a day runs in seconds, not minutes.
        for patcher in (mock.patch.object(relay, "_clock", self.clock),
                        mock.patch.object(guard.relay_redact, "redact_state",
                                          lambda state, questions, *, budget=None: state)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def clock(self):
        return self.now[0]

    def clocked(self, ext):
        """Every clock that counts a window on the fake one, from the first call on:
        the limiter's and the guard's relay asks per minute (50, as many as the day sends)."""
        ext.limiter.clock = self.clock
        ext.guard_cfg.asks.clock = self.clock
        return ext

    def ext(self, client, **cfg):
        return self.clocked(super().ext(client, **cfg))

    def initialized(self, client, **cfg):
        return self.clocked(super().initialized(client, **cfg))

    def assert_day(self, label, ext, call, *, first, file_min=DAY_CALLS):
        """The whole test's stderr counts, the first occurrence (before the day) included."""
        lines0 = self.counting.lines
        t0 = time.monotonic()
        for i in range(DAY_CALLS):
            call(ext, i)
            self.now[0] += 60.0 / CALLS_PER_MIN
        self.stop(ext)
        size, err = len(self.err), self.err_lines()
        self.measured[label] = size
        print(f"\n[24h] {label}: stderr {size} B in {len(err)} lines; jev.log {self.counting.lines - lines0} "
              f"lines; {time.monotonic() - t0:.1f} s", flush=True)
        self.assertLess(size, STDERR_DAY_MAX, err[:5])
        shown = [line for line in err if not line.startswith(("[jev] active", "[jev] started"))]
        self.assertIn(first, shown[0])
        self.assertTrue(any("repeated" in line for line in err), err[:5])
        self.assertGreaterEqual(self.counting.lines - lines0, file_min)
        self.assertEqual(self.counting.dropped, 0)

    def test_h_guard_api_down_direct_transport(self):
        ext = self.outage(guard_confirm="auto")
        self.assert_day("guard API down (direct)", ext,
                        lambda ext, i: self.hook(ext, tool_input={"command": "ls"}, rid=i),
                        first="[jev] guard bash: error after ")

    def errors_in_turn(self, label, texts, every, mode="auto"):
        """The delta probe on c313f002: the direct transport failing on every `every`-th call, the
        texts in turn (each its own category: timeout, transport error, HTTP 5xx), answers between."""
        client = FakeClient()
        ext = self.ext(client, guard_confirm=mode)
        texts = itertools.cycle(texts)

        def call(ext, i):
            client.error = JevError(next(texts)) if i % every == 0 else None
            self.hook(ext, tool_input={"command": "ls"}, rid=i)
        self.assert_day(label, ext, call, first="[jev] guard bash: error after ")
        err = self.err_lines()
        self.assertLessEqual(sum("recovered after" in line for line in err), 1, "once per episode")
        self.assertLessEqual(sum("repeated" in line for line in err), DAY_WINDOWS + 1, "one summary a window")

    def test_h_guard_api_down_five_categories(self):
        self.errors_in_turn("guard API down, 5 categories", FIVE_ERRORS, 1)

    def test_h_guard_flaky_one_call_in_5_five_categories(self):
        self.errors_in_turn("guard 20% errors, 5 categories", FIVE_ERRORS, 5)

    def test_h_guard_flaky_one_call_in_2_three_categories_auto(self):
        self.errors_in_turn("guard 50% errors, 3 categories, auto", FIVE_ERRORS[:3], 2)

    def test_h_guard_flaky_one_call_in_10_three_categories_prompt(self):
        self.errors_in_turn("guard 10% errors, 3 categories, prompt", FIVE_ERRORS[:3], 10, mode="prompt")

    def test_h_27b_store_broken(self):
        home = self.root / "home"
        sessions = home / ".synaps-cli" / "sandbox" / "sessions"
        sessions.mkdir(parents=True)
        (sessions / "old.conf").write_text("mode = enforce\n")
        switch = Path(access.switch_path(str(home)))
        switch.parent.mkdir(parents=True, exist_ok=True)
        switch.write_text("auto\n")

        def broken(*a, **kw):
            raise allow_once.StoreError("the request store is unwritable")
        edit = {"path": str(sessions / "old.conf"), "old_string": "a", "new_string": "b"}
        with mock.patch.dict(os.environ, {"HOME": str(home)}), mock.patch.object(allow_once, "record_auto", broken):
            ext = self.ext(FakeClient())
            self.assertEqual(self.hook(ext, "edit", edit), {"action": "continue"})
            self.assertIn("27b auto record could not be written", self.err.decode())
            self.assert_day("27b record store broken", ext,
                            lambda ext, i: self.hook(ext, "edit", edit, rid=i),
                            first="the 27b auto record could not be written")

    def test_h_compress_erroring(self):
        # The same output on every call: its checks and outbound redaction (local work that logs
        # nothing, ~4 ms a call) are computed once and the same answers returned, so a day runs
        # in seconds; the decision, the error and its log lines are each call's own.
        with mock.patch.object(compress, "safe_text", memoized(compress.safe_text)), \
                mock.patch.object(compress.relay_redact, "redact_string", memoized(compress.relay_redact.redact_string)), \
                mock.patch.object(compress.relay_redact, "redact_request", memoized(compress.relay_redact.redact_request)):
            ext = self.initialized(FakeClient(error=JevError(WIRE_DOWN)), compress=True)
            self.assertEqual(self.after(ext), {"action": "continue"})
            self.assertIn("compress error: keep", self.err.decode())
            self.assert_day("compress erroring", ext, lambda ext, i: self.after(ext, rid=i),
                            first="[jev] compress error: keep")

    def test_h_an_identical_block_retried_shell_rule(self):
        ext = self.ext(FakeClient(), guard_access="off")
        self.assert_day("identical block retried (shell-safety rule)", ext,
                        lambda ext, i: self.hook(ext, tool_input={"command": RM_ROOT}, rid=i),
                        first="[jev] guard bash: block (")

    def test_h_an_identical_block_retried_access_rule(self):
        ext = self.ext(FakeClient())
        self.assert_day("identical block retried (access rule 27a)", ext,
                        lambda ext, i: self.hook(ext, tool_input={"command": RM_ROOT}, rid=i),
                        first="[jev] guard bash: block (")

    def test_h_relay_flapping_ok_deadline(self):
        ext = self.initialized(FakeClient())
        ext.activate_relay()
        answer = FakeClient().decide(None, guard.QUESTIONS)
        wire = itertools.count()

        def flap(client, body, remaining):
            if next(wire) % 2:
                raise JevError("deadline exceeded")
            return copy.deepcopy(answer)
        with mock.patch.object(relay.RelayClient, "_bounded_post", flap):
            self.assert_day("relay flapping ok/deadline (5 s hold)", ext,
                            lambda ext, i: self.hook(ext, rid=i), first="[jev] relay: ok", file_min=DAY_CALLS // 6)

    def test_h_relay_state_changing_on_every_call(self):
        ext = self.initialized(FakeClient())
        ext.activate_relay()

        def call(ext, i):
            ext.client._note("deadline" if i % 2 else "ok")
            self.message(ext, rid=i)
        self.assert_day("relay ok/deadline every call", ext, call, first="[jev] relay: ok")

    def test_h_a_handler_crash_on_every_call(self):
        # alternating frames: traceback collapses a run of identical ones
        def ping(depth):
            if not depth:
                raise RuntimeError("crash")
            return pong(depth - 1)

        def pong(depth):
            return ping(depth)
        ext = self.ext(FakeClient())
        with mock.patch.object(jev_ext.guard, "handle", lambda *a, **kw: ping(9)):
            self.hook(ext)
            self.assertGreater(len(self.err), 2500, "the first crash is in full")
            self.assert_day("handler crash on every call", ext, lambda ext, i: self.hook(ext, rid=i),
                            first="[jev] handler crashed on hook.handle: RuntimeError")

    def test_h_handler_crashes_of_four_signatures_in_turn(self):
        def runtime():
            raise RuntimeError("a")

        def key():
            raise KeyError("b")

        def value():
            raise ValueError("c")

        def lookup():
            raise IndexError("d")
        turn = itertools.cycle((runtime, key, value, lookup))
        ext = self.ext(FakeClient())
        with mock.patch.object(jev_ext.guard, "handle", lambda *a, **kw: next(turn)()):
            self.assert_day("handler crashes, 4 signatures in turn", ext, lambda ext, i: self.hook(ext, rid=i),
                            first="[jev] handler crashed on hook.handle: RuntimeError")
        self.assertLessEqual(sum("repeated" in line for line in self.err_lines()), DAY_WINDOWS + 1)

    def test_h_relay_state_cycling_over_five_codes(self):
        ext = self.initialized(FakeClient())
        ext.activate_relay()
        codes = ("ok", "deadline", "error", "malformed", "closed")

        def call(ext, i):
            ext.client._note(codes[i % 5])
            self.message(ext, rid=i)
        self.assert_day("relay state over 5 codes, a change every call", ext, call, first="[jev] relay: ok")
        self.assertLessEqual(sum("repeated" in line for line in self.err_lines()), DAY_WINDOWS + 1)


if __name__ == "__main__":
    unittest.main()
