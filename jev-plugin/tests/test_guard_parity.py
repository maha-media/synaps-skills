#!/usr/bin/env python3
"""Guard parity for the multi_edit and send_events builtin tools (slice V1).

Offline only: a fake DecisionClient stands in for Jev, so no network and no
API key are used. Run:

    python3 -B -m unittest discover -s tests -p 'test_guard_parity.py' -v
"""
from __future__ import annotations

import contextlib
import copy
import io
import json
import os
import sys
import tempfile
import time
import unittest
import warnings
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "extensions"))
import jev_test_home  # noqa: F401,E402  (keeps the suite out of the real Allow-once store)

from jev import audit as audit_mod  # noqa: E402
from jev import guard  # noqa: E402
from jev.client import JevError  # noqa: E402


def score(s, conf):
    lvl = str(min(3, max(0, round(s)))) if s == s and abs(s) != float("inf") else "0"
    probs = {str(i): 0.0 for i in range(4)}
    probs[lvl] = 1.0
    return {"type": "score", "score": s, "confidence": conf,
            "legend": {str(i): f"L{i}" for i in range(4)}, "probabilities": probs}


def noul(p):
    return {"type": "noul", "noul": p}


SAFE = {"risk": score(0.1, 0.95), "leak": noul(0.02), "leaves_workspace": noul(0.03)}


class FakeClient:
    """Records every decide() call; answers each question key from a table."""

    def __init__(self, overrides=None, error=None):
        self.overrides = dict(overrides or {})
        self.error = error
        self.calls = []
        self.kwargs = []

    def decide(self, state, questions, *, op="decide", **kw):
        self.calls.append((copy.deepcopy(state), copy.deepcopy(questions), op))
        self.kwargs.append(kw)
        if self.error is not None:
            raise self.error
        answers = {}
        for key in questions:
            if key in self.overrides:
                answers[key] = self.overrides[key]
            else:
                base = key.rsplit("_", 1)[0] if key[-1:].isdigit() else key
                answers[key] = copy.deepcopy(SAFE[base])
        return {"answers": answers, "model": "fake", "usage": {"input_tokens": 1}}


class GuardCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="jev-parity-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.ws = self.root / "ws"
        self.ws.mkdir()
        self.outside = self.root / "outside"
        self.outside.mkdir()
        self.audit_path = self.root / "audit.jsonl"
        self.audit = audit_mod.Audit(str(self.audit_path))
        self.logs = []
        # today's confirms: guard_confirm = auto is test_guard_confirm_auto's
        self.cfg = guard.GuardConfig({"project_root": str(self.ws), "guard_confirm": "prompt"})

    def run_guard(self, tool, tool_input, client, cfg=None, *, cwd=..., **extra):
        """`cwd` is the host's HookEvent.cwd (the session cwd). Default: the
        workspace root, as a current host sends it. None: an old host that
        sends no cwd at all."""
        params = {"kind": "before_tool_call", "tool_name": tool, "tool_runtime_name": tool,
                  "tool_input": tool_input, "session_id": "sess-1", **extra}
        if cwd is not None:
            params["cwd"] = str(self.ws) if cwd is ... else cwd
        return guard.handle(params, client, cfg or self.cfg, self.audit, self.logs.append)

    def audit_text(self):
        return self.audit_path.read_text() if self.audit_path.exists() else ""


# ── multi_edit ──────────────────────────────────────────────────────────────

class MultiEditParity(GuardCase):
    def edits(self, *paths, **kw):
        return {"edits": [{"path": p, "op": "replace", "anchor": "old", "text": "new", **kw} for p in paths]}

    def test_one_request_three_questions_per_distinct_file(self):
        (self.ws / "a.txt").write_text("old")
        (self.ws / "b.txt").write_text("old")
        client = FakeClient()
        r = self.run_guard("multi_edit", self.edits("a.txt", "./a.txt", str(self.ws / "b.txt")), client)
        self.assertEqual(r, {"action": "continue"})
        self.assertEqual(len(client.calls), 1, "one Jev request per multi_edit call")
        state, questions, op = client.calls[0]
        self.assertEqual(op, "guard")
        self.assertEqual(set(questions), {"risk_0", "leak_0", "leaves_workspace_0",
                                          "risk_1", "leak_1", "leaves_workspace_1"})
        files = state["call"]["files"]
        self.assertEqual(len(files), 2, "two spellings of a.txt are one target file")
        self.assertEqual(files[0]["path"], "a.txt")
        self.assertEqual(files[0]["realpath"], os.path.realpath(self.ws / "a.txt"))
        self.assertEqual(files[0]["edits"], 2)
        self.assertEqual(files[1]["realpath"], os.path.realpath(self.ws / "b.txt"))
        self.assertEqual(files[1]["edits"], 1)
        self.assertEqual(state["call"]["edit_count"], 3)
        self.assertEqual(state["cwd"], str(self.ws))
        # Each question is about its own file and reuses edit's criteria.
        self.assertIn("`call.files[1]`", questions["risk_1"]["instructions"])
        self.assertIn("`call.files[1]`", questions["leak_1"]["instructions"])
        self.assertIn("`call.files[1]`", questions["leaves_workspace_1"]["instructions"])
        self.assertEqual(questions["risk_0"]["criteria"], guard.RISK_LEVELS)
        self.assertEqual(questions["leak_0"]["criteria"], guard.QUESTIONS["leak"]["criteria"])
        self.assertEqual(questions["leaves_workspace_0"]["criteria"], guard.QUESTIONS["leaves_workspace"]["criteria"])

    def test_sixteen_files_is_forty_eight_questions(self):
        client = FakeClient()
        r = self.run_guard("multi_edit", self.edits(*[f"f{i}.txt" for i in range(16)]), client)
        self.assertEqual(r["action"], "continue")
        self.assertEqual(len(client.calls[0][1]), 48)

    def test_seventeen_files_is_malformed_and_confirms_without_a_call(self):
        client = FakeClient()
        r = self.run_guard("multi_edit", self.edits(*[f"f{i}.txt" for i in range(17)]), client)
        self.assertEqual(r["action"], "confirm")
        self.assertIn("16", r["message"])
        self.assertEqual(client.calls, [])

    def test_previews_are_bounded_and_per_edit(self):
        long = "A" * 5000
        inp = {"edits": [
            {"path": "a.txt", "op": "replace", "anchor": "X" * 900, "text": long},
            {"path": "a.txt", "op": "append_jsonl", "value": {"k": "V" * 900}, "create": True},
            {"path": "a.txt", "op": "insert_after", "anchor": "^x", "anchor_mode": "line_regex", "text": "t"},
        ]}
        client = FakeClient()
        self.run_guard("multi_edit", inp, client)
        f = client.calls[0][0]["call"]["files"][0]
        self.assertEqual(f["ops"], ["replace", "append_jsonl", "insert_after"])
        self.assertEqual(len(f["previews"]), 3)
        self.assertEqual(f["previews"][0]["anchor_preview"], "X" * 200)
        self.assertEqual(f["previews"][0]["text_preview"], "A" * 200)
        self.assertEqual(f["previews"][0]["text_chars"], 5000)
        self.assertTrue(f["previews"][1]["text_preview"].startswith('{"k": "VVV'))
        self.assertEqual(len(f["previews"][1]["text_preview"]), 200)
        self.assertTrue(f["previews"][1]["create"])
        self.assertEqual(f["previews"][2]["anchor_mode"], "line_regex")
        self.assertNotIn("A" * 201, json.dumps(client.calls[0][0]))

    def test_strictest_file_wins_and_message_names_only_tripped_files(self):
        client = FakeClient({"leak_1": noul(0.9)})
        r = self.run_guard("multi_edit", self.edits("safe.txt", "creds.env", "also-safe.txt"), client)
        self.assertEqual(r["action"], "confirm")
        self.assertIn("creds.env", r["message"])
        self.assertNotIn("safe.txt", r["message"])
        self.assertIn("leak=0.90", r["message"])
        self.assertNotIn("secrets=", r["message"])

    def test_block_beats_confirm_with_todays_thresholds_per_file(self):
        hot = guard.GuardConfig({"project_root": str(self.ws), "guard_block_at": 2.8, "guard_confirm": "prompt"})
        client = FakeClient({"risk_0": score(1.0, 0.9), "leaves_workspace_0": noul(0.95),
                             "risk_2": score(3.0, 1.0)})
        r = self.run_guard("multi_edit", self.edits("a.txt", "b.txt", "c.txt"), client, cfg=hot)
        self.assertEqual(r["action"], "block")
        self.assertIn("c.txt", r["reason"])
        # Under default config the same answers confirm: block needs guard_block_at.
        client = FakeClient({"risk_2": score(3.0, 1.0)})
        r = self.run_guard("multi_edit", self.edits("a.txt", "b.txt", "c.txt"), client)
        self.assertEqual(r["action"], "confirm")
        self.assertIn("c.txt", r["message"])

    def test_each_per_file_threshold_trips_independently(self):
        cases = {
            "low confidence": {"risk_1": score(0.2, 0.4)},
            "risk at ask_at": {"risk_1": score(1.5, 0.9)},
            "secrets at 0.5": {"leak_1": noul(0.5)},
            "escape at 0.7": {"leaves_workspace_1": noul(0.7)},
        }
        for name, overrides in cases.items():
            with self.subTest(name):
                r = self.run_guard("multi_edit", self.edits("a.txt", "b.txt"), FakeClient(overrides))
                self.assertEqual(r["action"], "confirm")
                self.assertIn("b.txt", r["message"])
                self.assertNotIn("a.txt", r["message"])
        just_below = {"risk_1": score(1.49, 0.6), "leak_1": noul(0.49),
                      "leaves_workspace_1": noul(0.69)}
        r = self.run_guard("multi_edit", self.edits("a.txt", "b.txt"), FakeClient(just_below))
        self.assertEqual(r["action"], "continue")

    def test_relative_paths_resolve_against_the_session_cwd_not_process_cwd(self):
        client = FakeClient()
        self.run_guard("multi_edit", self.edits("sub/new.txt"), client)
        f = client.calls[0][0]["call"]["files"][0]
        self.assertEqual(f["realpath"], os.path.realpath(self.ws / "sub" / "new.txt"))
        self.assertNotEqual(os.path.realpath(os.getcwd()), str(self.ws))

    def test_symlink_resolves_to_its_outside_target_and_groups_spellings(self):
        target = self.outside / "secret.cfg"
        target.write_text("old")
        (self.ws / "link.cfg").symlink_to(target)
        client = FakeClient({"leaves_workspace_0": noul(0.95)})
        r = self.run_guard("multi_edit", self.edits("link.cfg", str(target)), client)
        files = client.calls[0][0]["call"]["files"]
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0]["realpath"], os.path.realpath(target))
        self.assertEqual(files[0]["aliases"], [str(target)])
        self.assertEqual(r["action"], "confirm")
        self.assertIn("link.cfg", r["message"])
        self.assertIn(os.path.realpath(target), r["message"], "message shows where the symlink lands")

    def test_tilde_expands_like_the_host(self):
        client = FakeClient()
        old = os.environ.get("HOME")
        os.environ["HOME"] = str(self.outside)
        try:
            self.run_guard("multi_edit", self.edits("~/x.txt"), client)
        finally:
            if old is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = old
        f = client.calls[0][0]["call"]["files"][0]
        self.assertEqual(f["realpath"], os.path.realpath(self.outside / "x.txt"))

    def test_malformed_inputs_confirm_without_a_call(self):
        bad = {
            "not an object": ["edits"],
            "edits missing": {},
            "edits not a list": {"edits": {"path": "a"}},
            "edits empty": {"edits": []},
            "too many edits": {"edits": [{"path": "a.txt", "op": "append", "text": "x"}] * 65},
            "edit not an object": {"edits": ["a.txt"]},
            "path missing": {"edits": [{"op": "append", "text": "x"}]},
            "path empty": {"edits": [{"path": " ", "op": "append", "text": "x"}]},
            "path not a string": {"edits": [{"path": 7, "op": "append", "text": "x"}]},
            "path has NUL": {"edits": [{"path": "a\x00b", "op": "append", "text": "x"}]},
            "unknown op": {"edits": [{"path": "a.txt", "op": "delete"}]},
            "anchor not a string": {"edits": [{"path": "a.txt", "op": "replace", "anchor": 3, "text": "x"}]},
            "text not a string": {"edits": [{"path": "a.txt", "op": "append", "text": ["x"]}]},
        }
        for name, inp in bad.items():
            with self.subTest(name):
                client = FakeClient()
                r = self.run_guard("multi_edit", inp, client)
                self.assertEqual(r["action"], "confirm")
                self.assertIn("malformed multi_edit", r["message"])
                self.assertEqual(client.calls, [])
        r = self.run_guard("multi_edit", bad["path has NUL"], FakeClient())
        self.assertIn("path contains NUL", r["message"], "rejected by the guard, not left to realpath")

    def test_upstream_errors_and_bad_answers_confirm(self):
        cases = {
            "transport": FakeClient(error=JevError("HTTP 500")),
            "missing answer": FakeClient({"risk_1": None}),
            "missing noul": FakeClient({"leak_0": {"type": "noul"}}),
        }
        for name, client in cases.items():
            with self.subTest(name):
                if name == "missing answer":
                    orig = client.decide

                    def drop(state, questions, *, op="decide", orig=orig, **kw):
                        resp = orig(state, questions, op=op, **kw)
                        resp["answers"].pop("risk_1")
                        return resp
                    client.decide = drop
                r = self.run_guard("multi_edit", self.edits("a.txt", "b.txt"), client)
                self.assertEqual(r["action"], "confirm")

    def test_counters_and_audit_rows(self):
        self.run_guard("multi_edit", self.edits("a.txt"), FakeClient())
        self.run_guard("multi_edit", {"edits": []}, FakeClient())
        self.assertEqual(self.audit.counters.get("guard.continue"), 1)
        self.assertEqual(self.audit.counters.get("guard.malformed"), 1)
        rows = [json.loads(line) for line in self.audit_text().splitlines()]
        self.assertEqual([r["tool"] for r in rows], ["multi_edit", "multi_edit"])
        self.assertEqual([r["action"] for r in rows], ["continue", "confirm"])


class PathClient(FakeClient):
    """Path-aware fake: answers leaves_workspace from the realpath the guard
    actually sent, so a wrongly resolved target shows up as a wrong verdict."""

    def __init__(self, workspace, **kw):
        super().__init__(**kw)
        self.workspace = os.path.realpath(workspace)

    def decide(self, state, questions, *, op="decide", **kw):
        for f in state["call"]["files"]:
            inside = f["realpath"].startswith(self.workspace + os.sep)
            self.overrides[f"leaves_workspace_{f['file']}"] = noul(0.01 if inside else 0.99)
        return super().decide(state, questions, op=op, **kw)


class SessionCwdTargets(GuardCase):
    """Review r1 #1: multi_edit resolves a relative path exactly as the tool
    does (tools/util.rs resolve_path_in: `~`/`~/` from HOME, then a relative
    path joined to the session cwd). The host sends that cwd as
    HookEvent.cwd; without it a relative target cannot be established and
    confirms without a call."""

    def edit(self, path):
        return {"edits": [{"path": path, "op": "append", "text": "x"}]}

    def test_relative_target_joins_the_session_cwd(self):
        (self.ws / "sub").mkdir()
        client = FakeClient()
        r = self.run_guard("multi_edit", self.edit("new.txt"), client, cwd=str(self.ws / "sub"))
        self.assertEqual(r, {"action": "continue"})
        state = client.calls[0][0]
        self.assertEqual(state["call"]["files"][0]["realpath"], os.path.realpath(self.ws / "sub" / "new.txt"))
        self.assertEqual(state["cwd"], str(self.ws / "sub"), "the model judges against the session cwd")

    def test_session_subdirectory_symlink_to_outside_is_caught(self):
        # The reviewer's probe: workspace/sub/target -> outside/sensitive, a
        # call from workspace/sub with raw path `target`.
        (self.ws / "sub").mkdir()
        (self.outside / "sensitive").write_text("x")
        (self.ws / "sub" / "target").symlink_to(self.outside / "sensitive")
        (self.ws / "target").write_text("decoy inside the project root")
        client = PathClient(self.ws)
        r = self.run_guard("multi_edit", self.edit("target"), client, cwd=str(self.ws / "sub"))
        f = client.calls[0][0]["call"]["files"][0]
        self.assertEqual(f["realpath"], os.path.realpath(self.outside / "sensitive"))
        self.assertEqual(r["action"], "confirm")
        self.assertIn(os.path.realpath(self.outside / "sensitive"), r["message"])

    def test_old_host_without_cwd_confirms_relative_targets_without_a_call(self):
        for raw in ("a.txt", "./a.txt", "sub/../a.txt", "~someone/a.txt"):
            with self.subTest(raw):
                client = FakeClient()
                edits = {"edits": [{"path": str(self.ws / "abs.txt"), "op": "append", "text": "x"},
                                   {"path": raw, "op": "append", "text": "x"}]}
                r = self.run_guard("multi_edit", edits, client, cwd=None)
                self.assertEqual(r["action"], "confirm")
                self.assertIn("edits[1]", r["message"])
                self.assertIn("session cwd", r["message"])
                self.assertEqual(client.calls, [], "never approximated with the project root")
        self.assertEqual(self.audit.counters.get("guard.unresolved"), 4)

    def test_old_host_still_checks_absolute_and_home_targets(self):
        old = os.environ.get("HOME")
        os.environ["HOME"] = str(self.outside)
        try:
            client = FakeClient()
            r = self.run_guard("multi_edit", {"edits": [
                {"path": str(self.ws / "a.txt"), "op": "append", "text": "x"},
                {"path": "~/b.txt", "op": "append", "text": "x"}]}, client, cwd=None)
        finally:
            if old is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = old
        self.assertEqual(r, {"action": "continue"})
        files = client.calls[0][0]["call"]["files"]
        self.assertEqual([f["realpath"] for f in files],
                         [os.path.realpath(self.ws / "a.txt"), os.path.realpath(self.outside / "b.txt")])

    def test_unusable_cwd_counts_as_absent(self):
        for name, cwd in {"relative": "sub", "empty": "", "not a string": 7, "NUL": str(self.ws) + "\x00x",
                          "list": [str(self.ws)], "longer than PATH_MAX": "/" + "a" * 5000}.items():
            with self.subTest(name):
                client = FakeClient()
                r = self.run_guard("multi_edit", self.edit("a.txt"), client, cwd=cwd)
                self.assertEqual(r["action"], "confirm")
                self.assertIn("session cwd", r["message"], "the old-host path, not some other failure")
                self.assertEqual(client.calls, [])
                client = FakeClient()
                r = self.run_guard("multi_edit", self.edit(str(self.ws / "a.txt")), client, cwd=cwd)
                self.assertEqual(r, {"action": "continue"})
                self.assertEqual(client.calls[0][0]["cwd"], self.cfg.workspace)

    def with_home(self, value):
        old = os.environ.get("HOME")
        if value is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = value
        self.addCleanup(lambda: os.environ.pop("HOME", None) if old is None
                        else os.environ.__setitem__("HOME", old))

    def target_of(self, raw, cwd=...):
        client = FakeClient()
        self.run_guard("multi_edit", self.edit(raw), client, cwd=cwd)
        return client.calls[0][0]["call"]["files"][0]["realpath"]

    def test_tilde_follows_rust_path_join(self):
        # PathBuf::from(home).join(rest): an absolute rest replaces home.
        self.with_home(str(self.ws))
        self.assertEqual(self.target_of("~/" + str(self.outside / "y.txt")),
                         os.path.realpath(self.outside / "y.txt"))
        self.assertEqual(self.target_of("~"), os.path.realpath(self.ws))
        self.assertEqual(self.target_of("~/"), os.path.realpath(self.ws))

    def test_empty_home_expands_to_a_relative_path_like_the_host(self):
        # std::env::var("HOME") is Ok("") here: "~/x" becomes "x", relative.
        self.with_home("")
        (self.ws / "sub").mkdir()
        self.assertEqual(self.target_of("~/x.txt", cwd=str(self.ws / "sub")),
                         os.path.realpath(self.ws / "sub" / "x.txt"))

    def test_unset_home_leaves_tilde_literal(self):
        self.with_home(None)
        self.assertEqual(self.target_of("~/x.txt"), os.path.realpath(self.ws / "~" / "x.txt"))

    def test_edit_is_judged_against_the_session_cwd_once_the_host_sends_it(self):
        (self.ws / "sub").mkdir()
        client = FakeClient()
        self.run_guard("edit", {"path": "a.txt", "old_string": "a", "new_string": "b"}, client,
                       cwd=str(self.ws / "sub"))
        self.assertEqual(client.calls[0][0]["cwd"], str(self.ws / "sub"))
        client = FakeClient()
        self.run_guard("edit", {"path": "a.txt", "old_string": "a", "new_string": "b"}, client, cwd=None)
        self.assertEqual(client.calls[0][0]["cwd"], self.cfg.workspace, "old host: today's behaviour")

    def test_bash_write_and_read_keep_the_project_root_until_ruled(self):
        # The r1 ruling covers edit and multi_edit only.
        for tool, inp in {"bash": {"command": "ls"}, "write": {"path": "a.txt", "content": "x"},
                          "read": {"path": "a.txt"}}.items():
            with self.subTest(tool):
                client = FakeClient()
                self.run_guard(tool, inp, client, cwd=str(self.outside))
                self.assertEqual(client.calls[0][0]["cwd"], self.cfg.workspace)


class DroppingClient(FakeClient):
    """FakeClient that removes answer keys after answering (a short reply)."""

    def __init__(self, overrides=None, drop=()):
        super().__init__(overrides)
        self.drop = tuple(drop)

    def decide(self, state, questions, *, op="decide", **kw):
        resp = super().decide(state, questions, op=op, **kw)
        for key in self.drop:
            resp["answers"].pop(key, None)
        return resp


class StrictestUnderFailure(GuardCase):
    """Review r1 #4: a file whose answers cannot be evaluated is that file's
    confirm; aggregation goes on, so a valid block elsewhere still blocks."""

    BLOCK = {"risk": score(3, 1.0)}
    FAILURES = {
        "risk NaN": ({"risk": score(float("nan"), 1.0)}, ()),
        "risk answer null": ({"risk": None}, ()),
        "risk answer missing": ({}, ("risk",)),
        "secrets answer missing": ({}, ("leak",)),
        "noul field missing": ({"leaves_workspace": {"type": "noul"}}, ()),
        "score not a number": ({"risk": {**score(0.1, 1.0), "score": "high"}}, ()),
        # review r2 R2-2: a 401-digit JSON integer is valid JSON, and float()
        # of it raises OverflowError, not ValueError
        "score overflows a float": ({"risk": {**score(0.1, 1.0), "score": 10 ** 400}}, ()),
        "confidence overflows a float": ({"risk": score(0.1, 10 ** 400)}, ()),
        "secrets probability overflows a float": ({"leak": noul(10 ** 400)}, ()),
        "escape probability overflows a float": ({"leaves_workspace": noul(10 ** 400)}, ()),
        # any failure in one file's answer is that file's, e.g. an IndexError
        # from probabilities sent as a list
        "probabilities a list": ({"risk": {**score(0.1, 1.0), "probabilities": [5, 0]}}, ()),
    }
    PROBLEM = {"risk NaN": "malformed answer", "risk answer null": "malformed answer",
               "risk answer missing": "missing answer", "secrets answer missing": "missing answer",
               "noul field missing": "missing answer", "score not a number": "malformed answer",
               "score overflows a float": "malformed answer", "confidence overflows a float": "malformed answer",
               "secrets probability overflows a float": "malformed answer",
               "escape probability overflows a float": "malformed answer",
               "probabilities a list": "malformed answer"}

    def setUp(self):
        super().setUp()
        self.hot = guard.GuardConfig({"project_root": str(self.ws), "guard_block_at": 2.8, "guard_confirm": "prompt"})

    def two_files(self):
        return {"edits": [{"path": "a.txt", "op": "append", "text": "x"},
                          {"path": "b.txt", "op": "append", "text": "x"}]}

    def client_for(self, block_index, fail_index, failure):
        overrides, drop = failure
        answers = {f"{k}_{block_index}": v for k, v in self.BLOCK.items()}
        answers.update({f"{k}_{fail_index}": v for k, v in overrides.items()})
        return DroppingClient(answers, [f"{k}_{fail_index}" for k in drop])

    def test_a_valid_block_survives_a_failing_file_in_either_order(self):
        for name, failure in self.FAILURES.items():
            for block_i, fail_i in ((0, 1), (1, 0)):
                with self.subTest(f"{name}, block at {block_i}"):
                    r = self.run_guard("multi_edit", self.two_files(),
                                       self.client_for(block_i, fail_i, failure), self.hot)
                    self.assertEqual(r["action"], "block")
                    blocked, failed = ("a.txt", "b.txt") if block_i == 0 else ("b.txt", "a.txt")
                    self.assertIn(f"{blocked} [block]", r["reason"])
                    self.assertIn(f"{failed} [confirm]: could not evaluate", r["reason"])

    def test_a_failing_file_alone_confirms_and_is_named(self):
        for name, failure in self.FAILURES.items():
            with self.subTest(name):
                overrides, drop = failure
                client = DroppingClient({f"{k}_1": v for k, v in overrides.items()}, [f"{k}_1" for k in drop])
                r = self.run_guard("multi_edit", self.two_files(), client, self.hot)
                self.assertEqual(r["action"], "confirm")
                self.assertIn(f"b.txt [confirm]: could not evaluate ({self.PROBLEM[name]})", r["message"])
                self.assertNotIn("a.txt", r["message"])

    def test_a_batch_failure_before_any_answer_still_confirms(self):
        class NoAnswers(FakeClient):
            def decide(self, state, questions, *, op="decide", **kw):
                return {"model": "fake"}
        for name, client in {"transport": FakeClient(error=JevError("HTTP 500")), "no answers": NoAnswers(),
                             "answers not an object": DroppingClient()}.items():
            with self.subTest(name):
                if name == "answers not an object":
                    client.decide = lambda state, questions, **kw: {"answers": ["risk_0"]}
                r = self.run_guard("multi_edit", self.two_files(), client, self.hot)
                self.assertEqual(r["action"], "confirm")
                self.assertIn("could not evaluate", r["message"])

    def test_answers_that_are_not_an_object_fail_the_batch_once(self):
        client = DroppingClient()
        client.decide = lambda state, questions, **kw: {"answers": ["risk_0", "risk_1"]}
        r = self.run_guard("multi_edit", self.two_files(), client, self.hot)
        self.assertEqual(r["action"], "confirm")
        self.assertIn("could not evaluate this multi_edit call (malformed answer)", r["message"])
        self.assertNotIn("guard.file_error", self.audit.counters)

    def test_counters_name_the_failed_files(self):
        r = self.run_guard("multi_edit", self.two_files(),
                           self.client_for(0, 1, self.FAILURES["risk NaN"]), self.hot)
        self.assertEqual(r["action"], "block")
        self.assertEqual(self.audit.counters.get("guard.block"), 1)
        self.assertEqual(self.audit.counters.get("guard.file_error"), 1)


# ── send_events ─────────────────────────────────────────────────────────────

FAKE_SECRETS = {
    # Assembled at runtime so the repository never holds a literal token.
    "private_key": "-----BEGIN " + "OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
    "private_key_pgp": "-----BEGIN " + "PGP PRIVATE KEY BLOCK-----",
    "sk_token": "sk-" + "ant-api03-" + "Q" * 40,
    "github_token": "ghp_" + "a1B2" * 9,
    "github_pat": "github_pat_" + "11ABCDEFG0" + "x" * 50,
    "gitlab_token": "glpat-" + "Zz9" * 7,
    "slack_token": "xoxb-" + "123456789012-" + "abcdefABCDEF",
    "slack_user_token": "xoxp-" + "1234567890-" + "ABCDEFGHIJ",
    "aws_access_key": "AKIA" + "IOSFODNN7EXAMPLE",
    "bearer_token": "Authorization: Bearer " + "eyJhbGciOi" + "J" * 30,
    "api_key_pair": "api_key = " + "'" + "9f8e7d6c5b4a3f2e1d0c" + "'",
    "api_key_pair_json": '"client_secret": "' + "Abc123Def456Ghi789" + '"',
    "typesafe_key": "apikey_" + "0123456789abcdefABCDEF",
    "url_credentials": "postgres://svc:" + "s3cretPassw0rd" + "@db.internal:5432/app",
    "jwt": "eyJ" + "hbGciOiJIUzI1NiJ9" + ".eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0" + "." + "dozjgNryP4J3jVmNHl0w5N",
    "google_api_key": "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
    "stripe_key": "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc",
    "stripe_restricted_test": "rk_" + "test_" + "51HxYzAbCdEf0123",
    "aws_session_key": "ASIA" + "ZZZZ1234ZZZZ5678",
    "pair_secret_key": "SECRET_KEY=" + "abcdef1234567890",
    "pair_access_key_id": "aws_access_key_id: " + "AbCdEf1234567890",
    "pair_access_token": "access-token=" + "Zm9vYmFyYmF6cXV4",
    "pair_auth_token": '{"auth_token": "' + "q1w2e3r4t5y6u7i8" + '"}',
    "pair_refresh_token": "refresh_token = " + "r3fr3shT0k3nV4lu3",
    "pair_private_key": "private_key: " + "MIIEvQIBADANBgkqhkiG",
    "pair_password": "password: " + "correct-horse-battery-1",
    "pair_passwd": "passwd=" + "Tr0ub4dor&3xyz",
    "pair_env_style": "OPENAI_API_KEY=" + "abcDEF123456ghiJKL",
}
EXPECTED_KIND = {
    "private_key": "private_key", "private_key_pgp": "private_key", "sk_token": "sk_token",
    "github_token": "github_token", "github_pat": "github_token", "gitlab_token": "gitlab_token",
    "slack_token": "slack_token", "slack_user_token": "slack_token", "aws_access_key": "aws_access_key",
    "bearer_token": "bearer_token", "api_key_pair": "api_key_pair", "api_key_pair_json": "secret_assignment",
    "typesafe_key": "typesafe_key", "url_credentials": "url_credentials", "jwt": "jwt",
    "google_api_key": "google_api_key", "stripe_key": "stripe_key",
    "stripe_restricted_test": "stripe_key", "aws_session_key": "aws_access_key",
    "pair_secret_key": "api_key_pair", "pair_access_key_id": "api_key_pair",
    "pair_access_token": "token_assignment", "pair_auth_token": "token_assignment",
    "pair_refresh_token": "token_assignment", "pair_private_key": "api_key_pair",
    "pair_password": "password_assignment", "pair_passwd": "password_assignment",
    "pair_env_style": "api_key_pair",
}
# Review r1 #3: ordinary assignments the V1 scanner missed (all synthetic).
RECALL_SECRETS = {
    # the reviewer's probe forms
    "probe: punctuation-first password": ('password="!VeryStrongPass123"', "password_assignment"),
    "probe: dollar inside a password": ('password="a$VeryStrongPass123"', "password_assignment"),
    "probe: standalone token": ('token="AbcDef1234567890"', "token_assignment"),
    "probe: standalone secret": ('secret="AbcDef1234567890"', "secret_assignment"),
    "probe: digitless sk- token": ("sk-" + "aBcDeFgHiJ" * 5, "sk_token"),
    "probe: 12-char bearer token": ("Authorization: Bearer " + "abcdef123456", "bearer_token"),
    # quoted, any value shape
    "single-quoted password": ("password = '" + "Pa55-word!" + "'", "password_assignment"),
    "quoted letters-only token": ('"token": "' + "AbCdEfGhIjKlMnOp" + '"', "token_assignment"),
    "escaped JSON password": ('{\\"password\\": \\"' + "!VeryStrongPass123" + '\\"}', "password_assignment"),
    "dollar-first password, not a variable": ('password="' + "$ecret!Pa55" + '"', "password_assignment"),
    # unquoted, credential-shaped (a digit or a symbol)
    "unquoted punctuation-first password": ("password=" + "!VeryStrongPass123", "password_assignment"),
    "env-style suffixed password": ("DB_PASSWORD=" + "Xy9pQr7sTu", "password_assignment"),
    "env-style suffixed token": ("GITHUB_TOKEN=" + "abc123def456ghi", "token_assignment"),
    "yaml token": ("token: " + "AbcDef1234567890", "token_assignment"),
    "suffixed secret": ("webhook_secret: " + "whs3cr3t-value!", "secret_assignment"),
    "go short assign": ("token := " + "\"q9w8e7r6t5y4\"", "token_assignment"),
    "ruby hash rocket": (":password => " + "\"s3cretpass!\"", "password_assignment"),
    "passphrase": ("passphrase=" + "Purple-Monkey-77", "password_assignment"),
    "api key, letters only, unquoted": ("api_key: " + "MIIEvQIBADANBgkqhkiG", "api_key_pair"),
    # provider shapes revisited
    "bearer, letters only, 20+": ("bearer " + "AbCdEfGhIjKlMnOpQrSt", "bearer_token"),
    "bearer header, short": ("Authorization: Bearer " + "a1b2c3d4", "bearer_token"),
    # compound names: camelCase is lower-cased before the scan, so the name
    # follows a letter or digit (found by mutation, r2)
    "camelCase access token": ('accessToken: "' + "AbCdEf1234567890" + '"', "token_assignment"),
    "camelCase auth token, JSON": ('{"authToken": "' + "q9w8e7r6t5y4u3" + '"}', "token_assignment"),
    "digit-prefixed token name": ("oauth2token=" + "AbCdEf1234567890", "token_assignment"),
    "camelCase db password": ('dbPassword = "' + "Xy9pQr7sTu" + '"', "password_assignment"),
    "run-together admin password": ("adminpassword=" + "Xy9pQr7sTu!", "password_assignment"),
    "camelCase client secret": ('clientSecret: "' + "AbCdEf1234567890" + '"', "secret_assignment"),
    "camelCase api key": ('googleApiKey: "' + "AbCdEfGhIjKlMnOp" + '"', "api_key_pair"),
    # exact minimum lengths (each has a one-shorter twin in BELOW_MINIMUM)
    "shaped password of exactly 8": ("password=" + "hunter2!", "password_assignment"),
    "quoted token of exactly 8": ('token="' + "AbCd1234" + '"', "token_assignment"),
    "keyed value of exactly 12": ("api_key=" + "abcdefghijkl", "api_key_pair"),
    "bare bearer of exactly 12 with a digit": ("Bearer " + "abcdefghij12", "bearer_token"),
    "bare bearer of exactly 20, no digit": ("Bearer " + "abcdefghijklmnopqrst", "bearer_token"),
    "sk- with a 32-character run, no digit": ("sk-" + "a" * 32, "sk_token"),
    "sk- hyphenated with digits, exactly 20": ("sk-" + "abcd-1234-efgh-56789", "sk_token"),
    "stripe live key, exactly 16": ("sk_live_" + "a1B2c3D4e5F6g7H8", "stripe_key"),
    "stripe restricted test key, exactly 16": ("rk_test_" + "a1B2c3D4e5F6g7H8", "stripe_key"),
    "github fine-grained token, exactly 22": ("github_pat_" + "a1B2c3D4e5F6g7H8i9J0k1", "github_token"),
    "gitlab token, exactly 20": ("glpat-" + "a1B2c3D4e5F6g7H8i9J0", "gitlab_token"),
    "slack token, exactly 10": ("xoxb-" + "1234567890", "slack_token"),
    "typesafe key, exactly 16": ("apikey_" + "a1B2c3D4e5F6g7H8", "typesafe_key"),
    "jwt, 8 per segment": ("eyJ" + "abcdefgh" + ".eyJ" + "abcdefgh" + "." + "abcdefgh", "jwt"),
    "url credentials, 3-character password": ("https://deploy:" + "x9!" + "@db.internal", "url_credentials"),
    # Review r2 R2-1: a placeholder is exempt only as the whole value. The
    # reviewer's forms: a placeholder-like start, an embedded mask, a path.
    "r2: angle-bracketed password": ('password="<' + "ActualPass123!" + '>"', "password_assignment"),
    "r2: dollar-brace password": ('password="${' + "ActualPass123!" + '}"', "password_assignment"),
    "r2: single-brace password": ('password="{' + "ActualPass123!" + '}"', "password_assignment"),
    "r2: embedded xxxx": ('password="abcxxxx' + "RealPass123!" + '"', "password_assignment"),
    "r2: embedded ***": ('password="Abc***' + "RealPass123!" + '"', "password_assignment"),
    "r2: %NAME% then a real tail": ('password="%ACTUAL%' + "RealPass123!" + '"', "password_assignment"),
    "r2: slash-first password": ('password="/' + "ActualPass123!" + '"', "password_assignment"),
    # formerly exempt by a prefix or an inner run, scanned now
    "r2: whole $VAR, quoted": ('token="$GITHUB_TOKEN"', "token_assignment"),
    "r2: your-...-here": ('api_key: "your-api-key-here"', "api_key_pair"),
    "r2: elided with an ellipsis": ("token: abc123def\u2026", "token_assignment"),
    "r2: a path value": ("password = /run/secrets/db", "password_assignment"),
    "r2: a home path value": ("token: ~/.config/gh/token", "token_assignment"),
    "r2: x-groups with hyphens": ('token: "xxxx-xxxx-xxxx"', "token_assignment"),
    "r2: a tail of stars": ('"password": "hunter***"', "password_assignment"),
    "r2: a tail of x": ('"api_key": "abcdxxxxxxxxxxxx"', "api_key_pair"),
    "r2: a tail of dots": ('"secret": "s3cr3tval..."', "secret_assignment"),
    "r2: a path in prose": ("rotate via password = /run/secrets/db_password_file", "password_assignment"),
}
# Review r2 R2-1: each whole-value placeholder form stays quiet; anything
# added to it (a tail, a prefix, other punctuation inside, an unclosed or a
# different bracket) is scanned. Quoted, so only the placeholder rule decides.
PLACEHOLDER_FORMS = {
    # (word bounds and punctuation pinned by mutation, r3)
    "<WORD>": (["<db_password>", "<your-token.here>", "<" + "a" * 64 + ">"],
               ["<db_password>1x", "x<db_password>", "<db_password", "<db_pass!word>",
                "<" + "a" * 65 + ">", "<db/password>", "<pa$$word123>"]),
    "${WORD}": (["${DB_PASSWORD}", "${A.B-C_1}"],
                ["${DB_PASSWORD}x1", "${{secrets.TOKEN}}", "$DB_PASSWORD", "${DB_PASS!}", "${DB_PASSWORD"]),
    "{{WORD}}": (["{{db_password}}"],
                 ["{{db_password}}9", "{db_password}", "{{db_password}", "{{db:password}}"]),
    "%(word)s": (["%(db_password)s"],
                 ["%(db_password)sX1", "%(db!password)s", "%(db_password)", "%(db_password)d"]),
    "%WORD%": (["%DB_PASSWORD%"],
               ["%DB_PASSWORD%x", "%DB!PASSWORD%", "x%DB_PASSWORD%", "%DB_PASSWORD"]),
    "mask": (["xxxxxxxx", "XXXXXXXX", "********", "\u2022" * 8, "_" * 8, "\u2026" * 8, "x*x*x*x*", "x" * 256],
             ["********a", "a********", "xxxx-xxxx", "........", "xxxx.xxxx", "####****", "x" * 257, "*" * 300]),
    "word": (["changeme", "CHANGEME", "placeholder"],
             ["changeme1", "changeme!", "mychangeme", "CHANGEME2024", "placeholders"]),
    # Inside quotes the value ends at the closing quote, so a placeholder
    # followed by list or call punctuation, a space or a backslash and then
    # more text is a prefix: scanned (found in the r3 mutation analysis).
    "quoted tail": ([],
                    ["<db_password>,RealPass123!", "${DB_PASSWORD};RealPass123!", "{{db_password}})RealPass123!",
                     "%(db_password)s]RealPass123!", "%DB_PASSWORD%}RealPass123!", "xxxxxxxx\\RealPass123!",
                     "changeme,RealPass123!", "<db_password> RealPass123!", "********'RealPass123!",
                     "redacted`RealPass123!"]),
}
# One character short of each minimum above: quiet.
BELOW_MINIMUM = [
    "password=hunt3r!", 'token="AbCd123"', "api_key=abcdefghijk", "Bearer abcdefghi12",
    "Bearer abcdefghijklmnopqrs", "sk-" + "a" * 31, "sk-" + "abcd-1234-efgh-5678",
    "sk_live_" + "a1B2c3D4e5F6g7H", "rk_test_" + "a1B2c3D4e5F6g7H", "github_pat_" + "a1B2c3D4e5F6g7H8i9J0k",
    "glpat-" + "a1B2c3D4e5F6g7H8i9J", "xoxb-" + "123456789", "apikey_" + "a1B2c3D4e5F6g7H",
    "eyJ" + "abcdefg" + ".eyJ" + "abcdefgh" + "." + "abcdefgh", "eyJ" + "abcdefgh" + ".eyJ" + "abcdefg" + "." + "abcdefgh",
    "eyJ" + "abcdefgh" + ".eyJ" + "abcdefgh" + "." + "abcdefg", "https://deploy:" + "x9" + "@db.internal",
]
# A provider prefix inside a longer identifier is not that provider's key
# (and AWS ids are exactly 20 characters): quiet.
NEAR_MISSES = [
    "task-" + "abcdefghij" * 4, "pk_live_" + "a1B2c3D4e5F6g7H8i9", "pk_test_" + "a1B2c3D4e5F6g7H8i9",
    "xsk_live_" + "a1B2c3D4e5F6g7H8i9", "xrk_test_" + "a1B2c3D4e5F6g7H8i9", "xghp_" + "a1B2c3D4e5" * 4,
    "xgithub_pat_" + "a1B2c3D4e5F6g7H8i9J0k1l2", "xglpat-" + "a1B2c3D4e5F6g7H8i9J0k1", "xxoxb-" + "1234567890ab",
    "XAKIA" + "ABCDEFGHIJKLMNOP", "AKIA" + "ABCDEFGHIJKLMNOPQ", "XASIA" + "ABCDEFGHIJKLMNOP",
    "ASIA" + "ABCDEFGHIJKLMNOPQ", "xAIza" + "a1B2c3D4e5" * 3 + "a1B2c", "xapikey_" + "a1B2c3D4e5F6g7H8i9",
    "xeyJ" + "abcdefgh" + ".eyJ" + "abcdefgh" + "." + "abcdefgh", "xauthorization: Bearer " + "abcdefgh",
    "forbearer " + "abcdefghij12", "see ://deploy:" + "x9!pass" + "@db.internal",
]
# Explicit placeholders and prose stay quiet (and must keep doing so).
PLACEHOLDER_BODIES = [
    'password="<redacted>"', "password: <your password>", "token=${GITHUB_TOKEN}",
    "secret=$(cat /run/secrets/x)", "password: xxx", "password=xxxxxxxx",
    "token: ********", 'password: "********"', "password: changeme", "password=CHANGEME",
    "token: {{ secrets.TOKEN }}", "secret: %SECRET%",
    'password: "..."', "token: sk-abc...", "token: TYPESAFE_API_KEY", "password: required",
    "secret: rotating keys weekly", "max_tokens=4096", "tokens: 1234567890", '"token": null',
    '"password": ""', "password: <none>", "access_token: <redacted>", "secret_key = ${SECRET_KEY}",
    "the token: unchanged", "Bearer authentication is required", "bearer tokens are rotated",
    "password_file=/etc/app/pw", "csrf_token: (set per request)",
    "Authorization: Bearer <token>", "Authorization: Bearer ${TOKEN}",
    # one per placeholder alternative, each quoted so that only the
    # placeholder rule keeps it quiet (found by mutation, r2)
    'password: "{{db_password}}"', 'password = "%(db_password)s"', '"password": "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"',
    '"token": "__________"',
    '"password": "changeme"', '"password": "change_me"', '"password": "change-me"', '"token": "redacted"',
    '"secret": "placeholder"', '"password": "undefined"', '"password": "required"', '"token": "optional"',
    '"password": "password"',
]
ROUTINE_BODIES = [
    "Status: V1 done, 690 passed. task-1234567890abcdefghijklmnop merged.",
    "risk-assessment-for-the-whole-quarter-looks-fine",
    "Bearer tokens are documented in docs/auth.md; rotate them monthly.",
    "Set api_key = ${TYPESAFE_API_KEY} in the env, never inline.",
    "password policy: at least 12 chars",
    "See https://github.com/maha-media/synaps-skills/pull/12 and AKIA prefix docs.",
    "ghp_ is the GitHub prefix; xoxb- is Slack's; sk- is OpenAI's.",
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqh\n-----END PUBLIC KEY-----",
    "use sk-learn-style-pipelines-for-the-whole-thing",
    "PWD=/home/user/Projects/example/.worktrees/example-repo-jev",
    "clone https://github.com/maha-media/synaps-skills.git and ssh://git@github.com/x",
    "the registry is http://localhost:8080/api/@scope/pkg for now",
]


class SendEventsParity(GuardCase):
    def msgs(self, *bodies):
        return {"source": "worker-v", "messages": [{"session": f"s{i}", "body": b} for i, b in enumerate(bodies)]}

    def test_one_request_secrets_question_per_message_only(self):
        client = FakeClient()
        r = self.run_guard("send_events", self.msgs("hello", "B" * 5000), client)
        self.assertEqual(r, {"action": "continue"})
        self.assertEqual(len(client.calls), 1)
        state, questions, op = client.calls[0]
        self.assertEqual(op, "guard")
        self.assertEqual(set(questions), {"leak_0", "leak_1"},
                         "risk and workspace escape do not apply to send_events")
        self.assertIn("`call.messages[1]`", questions["leak_1"]["instructions"])
        self.assertEqual(questions["leak_0"]["criteria"], guard.QUESTIONS["leak"]["criteria"])
        m = state["call"]["messages"]
        self.assertEqual(m[1]["body_preview"], "B" * guard.BODY_PREVIEW_CHARS)
        self.assertEqual(m[1]["body_bytes"], 5000)
        self.assertLessEqual(guard.BODY_PREVIEW_CHARS, 400)

    def test_model_secrets_answer_confirms_naming_the_index(self):
        client = FakeClient({"leak_2": noul(0.5)})
        r = self.run_guard("send_events", self.msgs("a", "b", "c"), client)
        self.assertEqual(r["action"], "confirm")
        self.assertIn("messages[2]", r["message"])
        self.assertNotIn("messages[0]", r["message"])
        r = self.run_guard("send_events", self.msgs("a", "b", "c"), FakeClient({"leak_2": noul(0.49)}))
        self.assertEqual(r["action"], "continue")

    def test_send_events_confirm_numbers_survive_the_hosts_confirm_scrub(self):
        from host_scrub import scrub
        r = self.run_guard("send_events", self.msgs("a", "b", "c"), FakeClient({"leak_2": noul(0.5)}))
        self.assertEqual(r["action"], "confirm")
        self.assertIn("messages[2] leak=0.50", r["message"])
        self.assertNotIn("secrets=", r["message"])
        self.assertEqual(scrub(r["message"]), r["message"])

    def test_each_pattern_kind_is_detected(self):
        for name, secret in FAKE_SECRETS.items():
            with self.subTest(name):
                self.assertEqual(guard.scan_secrets(f"context before\n{secret}\nafter"), [EXPECTED_KIND[name]])

    def test_every_regex_has_a_positive_fixture(self):
        # Self-enforcing coverage: a regex without a fixture could be dropped
        # (or broken) without any test going red.
        from jev import secret_patterns
        samples = list(FAKE_SECRETS.values()) + [secret for secret, _ in RECALL_SECRETS.values()]
        for kind, folded, regexes in secret_patterns.PATTERNS:
            for j, rx in enumerate(regexes):
                with self.subTest(f"{kind}[{j}]"):
                    self.assertTrue(any(rx.search(x.lower() if folded else x) for x in samples),
                                    f"no fixture for {kind} regex {j}")

    def test_recall_forms_are_detected(self):
        for name, (secret, kind) in RECALL_SECRETS.items():
            with self.subTest(name):
                self.assertEqual(guard.scan_secrets(f"context before\n{secret}\nafter"), [kind])

    def test_placeholders_and_prose_stay_quiet(self):
        for body in PLACEHOLDER_BODIES:
            with self.subTest(body):
                self.assertEqual(guard.scan_secrets(f"before {body} after"), [])

    def test_each_placeholder_word_stays_quiet_as_a_whole_value(self):
        # A value ends at whitespace, a quote or `,;)]}\`, so a short word
        # followed by more arguments still decides the match:
        # password=None,timeout=30 (listed here, not imported, so dropping a
        # word from the scanner goes red).
        words = ("changeme change_me change-me redacted placeholder example dummy sample secret password passwd "
                 "token none null nil undefined hidden masked required optional string unset empty todo tbd")
        for word in words.split():
            for body in (f"password={word},timeout=30", f"password={word.upper()};retries=3"):
                with self.subTest(body):
                    self.assertEqual(guard.scan_secrets(f"before {body} after"), [])

    def test_a_whole_placeholder_stays_quiet_and_anything_added_is_scanned(self):
        # Review r2 R2-1: exempt only a value that is a placeholder as a whole.
        for form, (quiet, scanned) in PLACEHOLDER_FORMS.items():
            for name in ("password", "token", "secret", "api_key"):
                kind = {"password": "password_assignment", "token": "token_assignment",
                        "secret": "secret_assignment", "api_key": "api_key_pair"}[name]
                for value in quiet:
                    with self.subTest(f"{form}: {name}={value!r} is quiet"):
                        self.assertEqual(guard.scan_secrets(f'before {name}="{value}" after'), [])
                        self.assertEqual(guard.scan_secrets(f"before {name}={value},timeout=30 after"), [])
                for value in scanned:
                    with self.subTest(f"{form}: {name}={value!r} is scanned"):
                        self.assertEqual(guard.scan_secrets(f'before {name}="{value}" after'), [kind])

    def test_an_unquoted_placeholder_with_a_tail_is_scanned(self):
        # An unquoted value ends only at whitespace, a closing quote or
        # , ; ) ] } (pinned by mutation, r3; the closing quote since r4).
        tails = ["<db_password>!RealPass123", "${DB_PASSWORD}#RealPass123", "{{db_password}}+RealPass123",
                 "%(db_password)s@RealPass123", "%DB_PASSWORD%:RealPass123", "xxxxxxxx/RealPass123",
                 "changeme.RealPass123", "redacted-RealPass123"]
        kinds = {"password": "password_assignment", "token": "token_assignment",
                 "secret": "secret_assignment", "api_key": "api_key_pair"}
        for name, kind in kinds.items():
            for value in tails:
                with self.subTest(f"{name}={value}"):
                    self.assertEqual(guard.scan_secrets(f"before {name}={value} after"), [kind])

    # Review r4 ruling (the unquoted side of B1): an unquoted value runs on
    # across a quote or backslash that does not close an enclosing string. A
    # closing quote is one followed by whitespace, , ; : ) ] } or the end.

    UNQUOTED_KINDS = {"password": "password_assignment", "token": "token_assignment",
                      "secret": "secret_assignment", "api_key": "api_key_pair"}

    def test_an_unquoted_value_runs_on_across_a_quote_that_closes_nothing(self):
        shapes = ['{name}=<NAME>"RealPass123!', '{name}=ab"RealPass123!"', "{name}=<NAME>'RealPass123!",
                  "{name}=ab`RealPass123!`", '{name}=<NAME>\\"RealPass123!', "{name}=<NAME>\\RealPass123!",
                  '{name}=${{NAME}}"RealPass123!', '{name}=xxxxxxxx"RealPass123!', '{name}=changeme"RealPass123!']
        for name, kind in self.UNQUOTED_KINDS.items():
            for shape in shapes:
                text = shape.format(name=name)
                with self.subTest(text):
                    self.assertEqual(guard.scan_secrets(f"before {text} after"), [kind])
                    self.assertEqual(guard.scan_secrets(f"before {text}"), [kind])
                    body = "routine status. " * 40 + "\n" + text + "\nend of report"
                    client = FakeClient()
                    r = self.run_guard("send_events", self.msgs("fine", body), client)
                    self.assertEqual(r["action"], "confirm")
                    self.assertIn(f"messages[1] ({kind}", r["message"])
                    self.assertEqual(client.calls, [])
                    self.assertNotIn("RealPass", r["message"] + "\n".join(self.logs) + self.audit_text())

    def test_a_quote_that_closes_an_enclosing_string_ends_an_unquoted_value(self):
        # The quote closes the string the assignment sits in: a whole-value
        # placeholder stays quiet, at any depth and before any terminator.
        quiet = ['"cmd": "export PASSWORD=<NAME>"', '"env": ["DB_PASSWORD=<NAME>", "TOKEN=${TOKEN}"]',
                 "run('PASSWORD=<NAME>')", "`password=<NAME>` and `token=xxxxxxxx`",
                 '{\\"cmd\\": \\"export PASSWORD=<NAME>\\"}', '"SECRET=changeme";', '"API_KEY=<NAME>": 1',
                 '"PASSWORD=<NAME>" ', '"PASSWORD=<NAME>"', '"PASSWORD=<NAME>")', '"PASSWORD=<NAME>"}',
                 '"PASSWORD=<NAME>"]', '"PASSWORD=<NAME>",', '"PASSWORD=<NAME>";', '"PASSWORD=<NAME>":',
                 '"PASSWORD=<NAME>"\n', '"PASSWORD=<NAME>"\t', '\\\\\\"PASSWORD=<NAME>\\\\\\",']
        for text in quiet:
            with self.subTest(text):
                self.assertEqual(guard.scan_secrets(f"before {text}"), [])
        # A short real value before the closing quote stays below the minimum.
        for text in ('"PASSWORD=ab1"', '"TOKEN=a1!"', '"API_KEY=abcdefghijk"'):
            with self.subTest(text):
                self.assertEqual(guard.scan_secrets(f"before {text} after"), [])

    def test_each_closing_follower_and_terminator_ends_an_unquoted_placeholder(self):
        # Pinned by mutation (r4): every member of both sets, and the end of
        # the text. A long placeholder under api_key (12+ characters, any
        # shape) would hit if the value ran on past it.
        ph = "<DB_PASSWORD_VALUE>"
        for t in " \t\n,;:)]}":
            for text in (f'"API_KEY={ph}"{t}abcdefghijkl', f'\\"API_KEY={ph}\\"{t}abcdefghijkl',
                         f"'API_KEY={ph}'{t}abcdefghijkl"):
                with self.subTest(text):
                    self.assertEqual(guard.scan_secrets(f"before {text}"), [])
        for t in " \t\n,;)]}":
            text = f"f(API_KEY={ph}{t}abcdefghijkl"
            with self.subTest(text):
                self.assertEqual(guard.scan_secrets(f"before {text}"), [])
        for text in (f'"API_KEY={ph}"', f'\\"API_KEY={ph}\\"', f"API_KEY={ph}", f"`API_KEY={ph}`"):
            with self.subTest(f"{text} at the end"):
                self.assertEqual(guard.scan_secrets(f"before {text}"), [])
        self.assertEqual(guard.scan_secrets(f'["API_KEY={ph}","DB_PASSWORD={ph}"]'), [])
        self.assertEqual(guard.scan_secrets(f'{{\\"cmd\\": \\"export API_KEY={ph}\\"}}'), [])

    def test_the_closing_quote_and_its_backslashes_are_not_part_of_the_value(self):
        # Seven characters, then an escaped closing quote: still short (the
        # backslash before the quote belongs to the quote; pinned, r4).
        for text in ('{\\"env\\": \\"PASSWORD=abc1234\\", \\"x\\": 1}', '\\\\\\"TOKEN=abc1234\\\\\\",',
                     '"PASSWORD=abc1234",', '{\\"k\\": \\"API_KEY=abcdefghijk\\"}'):
            with self.subTest(text):
                self.assertEqual(guard.scan_secrets(f"before {text}"), [])

    PROSE_KINDS = {"password": "password_assignment", "token": "token_assignment", "secret": "secret_assignment"}

    def test_the_symbol_window_is_the_first_64_characters_of_the_value(self):
        # Under a name common in prose, an unquoted value needs a digit or a
        # symbol within its first 64 characters (r4 benchmark: read by
        # characters, as before r4, so no repeat per token). A quote that
        # closes nothing is one character; a run of backslashes counts by its
        # length.
        for name, kind in self.PROSE_KINDS.items():
            hits = [name + "=" + "a" * 63 + "1", name + '=<NAME>"' + "a" * 56 + "!",
                    name + "=<NAME>'" + "a" * 56 + "#", name + "=<NAME>`" + "a" * 56 + "@",
                    name + "=abcdefgh" + "\\" * 54 + "1", name + "=abcdefgh" + '\\"' * 27 + "1"]
            quiet = [name + "=" + "a" * 64 + "1", name + '=<NAME>"' + "a" * 57 + "!",
                     name + "=<NAME>'" + "a" * 57 + "#", name + "=a" + "\\" * 70 + "bcdefgh1",
                     name + "=a" + '\\"b' * 22 + "1"]
            for text in hits:
                with self.subTest(text):
                    self.assertEqual(guard.scan_secrets(f"before {text} after"), [kind])
            for text in quiet:
                with self.subTest(text):
                    self.assertEqual(guard.scan_secrets(f"before {text} after"), [])

    def test_a_symbol_after_the_closing_quote_is_not_in_the_value(self):
        # The value ends at a closing quote, so a digit or symbol after it
        # does not make it credential-shaped, whichever closing follower
        # comes first; a quote that closes nothing is crossed.
        for name, kind in self.PROSE_KINDS.items():
            for t in ",;:)]}":
                for text in (f'"{name}=abcdefghij"{t}1', f'\\"{name}=abcdefghij\\"{t}1',
                             f"'{name}=abcdefghij'{t}1", f"`{name}=abcdefghij`{t}1"):
                    with self.subTest(text):
                        self.assertEqual(guard.scan_secrets(f"before {text}"), [])
            for q in "\"'`":
                for text in (f"{name}=abcdefghij{q}1", f"{name}=abcdefghij{q}x1", f"{name}=abcdefghij\\{q}1",
                             f"{name}=abcdefghij{q}{q}1", f"{name}=abcdefghij{q}\\x1"):
                    with self.subTest(text):
                        self.assertEqual(guard.scan_secrets(f"before {text} after"), [kind])

    # Review r4 R4-1 (the quoted side of the r4 ruling): a quoted placeholder
    # is the whole value only when its closing quote is followed by
    # whitespace, , ; : ) ] }, a quote that closes an enclosing string, or the
    # end. Anything else continues the value, as in shell, where
    # password="<NAME>"RealPass123! assigns <NAME>RealPass123!. The value is
    # then the whole concatenation, and the hit reads that complete value.

    ALL_KINDS = {"password": "password_assignment", "token": "token_assignment",
                 "secret": "secret_assignment", "api_key": "api_key_pair"}
    QUOTES = {'"': "'", "'": "`", "`": '"'}  # each quote, and another kind

    def assert_deep_confirm(self, text, kind):
        body = "routine status. " * 40 + "\n" + text + "\nend of report"
        client = FakeClient()
        r = self.run_guard("send_events", self.msgs("fine", body), client)
        self.assertEqual(r["action"], "confirm")
        self.assertIn(f"messages[1] ({kind}", r["message"])
        self.assertEqual(client.calls, [])
        self.assertNotIn("RealPass", r["message"] + "\n".join(self.logs) + self.audit_text())

    def test_a_quoted_placeholder_with_a_suffix_is_scanned_as_one_value(self):
        # @Q is the quote, @O a quote of another kind.
        shapes = ["@Q<NAME>@QRealPass123!", "@Q${DB_PASSWORD}@QRealPass123!", "@Q********@QRealPass123!",
                  "@Qchangeme@QRealPass123!", "@Q{{db_password}}@QRealPass123!", "@Q%(db_password)s@QRealPass123!",
                  "@Q%DB_PASSWORD%@QRealPass123!", "@Q@QRealPass123!", "@Qab@QRealPass123!",
                  "@Q<A>@QReal@QPass123!@Q", "@Q<A>@Qx@Qy@QRealPass123!", "@Q<A>@Q@OReal@OPass123!",
                  "\\@Q<NAME>\\@QRealPass123!", "@Q<NAME>@Q\\RealPass123!"]
        for q, o in self.QUOTES.items():
            for shape in shapes:
                value = shape.replace("@Q", q).replace("@O", o)
                for name, kind in self.ALL_KINDS.items():
                    for sep in ("=", ": ", '": '):
                        text = ('"' + name if sep == '": ' else name) + sep + value
                        with self.subTest(text):
                            self.assertEqual(guard.scan_secrets(f"before {text} after"), [kind])
                            self.assertEqual(guard.scan_secrets(f"before {text}"), [kind])
                    with self.subTest(f"{name}={value} beyond the preview"):
                        self.assert_deep_confirm(f"{name}={value}", kind)

    def test_a_quote_of_another_kind_is_part_of_a_quoted_value(self):
        # A quoted value ends only at its own closing quote, so a quote of
        # another kind inside it does not end its first word (found with
        # R4-1: valid JSON such as {"password": "<NAME>'RealPass123!"}).
        for q, o in self.QUOTES.items():
            for name, kind in self.ALL_KINDS.items():
                for value in (f"{q}<NAME>{o}RealPass123!{q}", f"{q}ab{o}RealPass123!{q}",
                              f"\\{q}<NAME>{o}RealPass123!\\{q}", f"{q}<NAME>{o}{o}RealPass123!{q}"):
                    with self.subTest(f"{name}: {value}"):
                        self.assertEqual(guard.scan_secrets(f"before {name}: {value} after"), [kind])
        for name, kind in self.ALL_KINDS.items():
            for value in ("<NAME>'RealPass123!", "ab`RealPass123!", "${DB_PASSWORD}'RealPass123!"):
                for text in (json.dumps({name: value, "user": "bob"}),
                             json.dumps(json.dumps({name: value, "user": "bob"}))):
                    with self.subTest(text):
                        self.assertEqual(guard.scan_secrets(text), [kind])
                        self.assert_deep_confirm(text, kind)
        # Still below the minimum: the value's own closing quote, or a
        # space, ends its first word.
        for text in ('password: "isn\'t"', "password: 'it`s ok'", 'password: "<NAME>\'"', 'token: "it\'s a token"'):
            with self.subTest(text):
                self.assertEqual(guard.scan_secrets(f"before {text} after"), [])

    def test_a_quoted_placeholder_before_a_boundary_stays_quiet(self):
        # The long placeholder would hit under api_key (12+ characters, any
        # shape) if the value ran on past its closing quote.
        placeholders = ("<DB_PASSWORD_VALUE>", "${DB_PASSWORD}", "********", "changeme")
        for ph in placeholders:
            for q in self.QUOTES:
                for name in self.ALL_KINDS:
                    for t in " \t\n,;:)]}":
                        text = f"{name}={q}{ph}{q}{t}abcdefghijkl1!"
                        with self.subTest(text):
                            self.assertEqual(guard.scan_secrets(f"before {text}"), [])
                    for text in (f"{name}={q}{ph}{q}", f"{name}: \\{q}{ph}\\{q}"):
                        with self.subTest(f"{text} at the end"):
                            self.assertEqual(guard.scan_secrets(f"before {text}"), [])
            # A quote that closes an enclosing string, at any depth.
            for text in (f'"cmd": "export API_KEY=\'{ph}\'"', f'"cmd": "export API_KEY=`{ph}`" ',
                         f'"API_KEY=\'{ph}\'",', f'["API_KEY=\'{ph}\'"]', f"`api_key=\"{ph}\"` and more",
                         f'{{\\"cmd\\": \\"export API_KEY=\'{ph}\'\\"}}', f"run('API_KEY=\"{ph}\"')"):
                with self.subTest(text):
                    self.assertEqual(guard.scan_secrets(f"before {text}"), [])
            # Ordinary JSON, compact or nested.
            for name in self.ALL_KINDS:
                obj = {name: ph, "user": "bobbobbobbob1!"}
                for text in (json.dumps(obj), json.dumps(obj, separators=(",", ":")), json.dumps(json.dumps(obj)),
                             json.dumps(json.dumps(json.dumps(obj, separators=(",", ":"))))):
                    with self.subTest(text):
                        self.assertEqual(guard.scan_secrets(text), [])
        # Benign shell placeholders and code: a concatenation is judged as
        # the bare word it becomes, so under password/token/secret it needs a
        # digit or symbol within its first 64 characters, like any unquoted
        # value.
        for text in ('export PASSWORD="<your-password>"\nnext line', "PASSWORD='${DB_PASSWORD}'; ./run.sh",
                     'DB_PASSWORD="changeme" docker compose up', 'TOKEN="${TOKEN}" make test',
                     'secret = "".join(choice(alphabet) for _ in range(n))', 'token = "abc".upper()',
                     'password = "{}".format(user)', "token = ''.join(parts)", 'api_key = "".join(x)'):
            with self.subTest(text):
                self.assertEqual(guard.scan_secrets(f"before {text} after"), [])

    def test_a_concatenation_is_judged_as_the_bare_word_it_becomes(self):
        # Read from the opening quote, quotes included, by the unquoted rules
        # (pinned by mutation, r5): under api_key 12+ characters of any shape,
        # under password/token/secret 8+ with a digit or symbol.
        for q in self.QUOTES:
            for text, kinds in ((f"api_key={q}ab{q}cdefghij", ["api_key_pair"]),
                                (f"api_key={q}ab{q}cdefghi", []),
                                (f"api_key={q}<NAME>{q}abcdefghijklmnop", ["api_key_pair"]),
                                (f"password={q}ab{q}cd1!", ["password_assignment"]),
                                (f"password={q}ab{q}c1!", [])):
                with self.subTest(text):
                    self.assertEqual(guard.scan_secrets(f"before {text} after"), kinds)
        self.assert_deep_confirm('api_key="<NAME>"abcdefghijklmnop', "api_key_pair")

    def test_an_unescaped_quote_inside_an_escaped_layer_is_part_of_it(self):
        # An escaped layer ends only at its own escaped quote, so an
        # unescaped quote of the same kind inside it does not end its first
        # word (pinned by mutation, r5; missed at d4b253c).
        for q in self.QUOTES:
            for name, kind in self.ALL_KINDS.items():
                for value in (f"\\{q}<NAME>{q}RealPass123!\\{q}", f"\\{q}ab{q}RealPass123!\\{q}",
                              f"\\\\\\{q}<NAME>{q}RealPass123!\\\\\\{q}"):
                    with self.subTest(f"{name}: {value}"):
                        self.assertEqual(guard.scan_secrets(f"before {name}: {value} after"), [kind])
                with self.subTest(f"{name} beyond the preview"):
                    self.assert_deep_confirm(f'{{"cmd": "x {name}: \\{q}<NAME>{q}RealPass123!\\{q}"}}', kind)

    def test_a_deeper_escaped_quote_inside_an_escaped_layer_is_part_of_it(self):
        # JSON inside JSON: the value's layer is an odd run, and a quote
        # escaped once more inside it (a longer run) is one token of the
        # value, not its close. Letters only, so only the quoted reading
        # hits; a value cut at the inner quote would be a concatenation
        # with no digit or symbol (pinned by mutation, r5).
        for name, kind in self.ALL_KINDS.items():
            for value in ('ab"cdefghij', 'abcdefg"hij', "ab'cd\"efghij"):
                text = json.dumps({name: value, "user": "bob"})
                for depth in (1, 2):
                    text = json.dumps(text)
                    with self.subTest(text):
                        self.assertEqual(guard.scan_secrets(text), [kind])
                        self.assert_deep_confirm(text, kind)

    def test_an_escaped_quote_ends_a_quoted_value_too(self):
        # JSON inside a string: \"password\": \"<redacted>\" is a whole placeholder.
        self.assertEqual(guard.scan_secrets('{\\"password\\": \\"<redacted>\\"}'), [])
        self.assertEqual(guard.scan_secrets('{\\"token\\": \\"********\\"}'), [])
        self.assertEqual(guard.scan_secrets('{\\"password\\": \\"<redacted>,RealPass123!\\"}'),
                         ["password_assignment"])

    # Review r3 B1: a quoted value is found by its quote layer, with
    # backslash parity, not by a pattern after the placeholder.

    def test_an_escaped_quote_inside_a_json_value_is_part_of_it(self):
        # Valid JSON whose escaped quote belongs to the value: not a whole
        # placeholder, so it is scanned, beyond the preview too.
        kinds = {"password": "password_assignment", "token": "token_assignment",
                 "secret": "secret_assignment", "api_key": "api_key_pair"}
        for head in ("<DB_PASSWORD>", "${DB_PASSWORD}", "********", "changeme"):
            for name, kind in kinds.items():
                value = head + '"RealPass123!'
                text = json.dumps({name: value})
                self.assertEqual(json.loads(text)[name], value)
                with self.subTest(text):
                    self.assertEqual(guard.scan_secrets(text), [kind])
                    body = "routine status. " * 40 + "\n" + text + "\nend of report"
                    client = FakeClient()
                    r = self.run_guard("send_events", self.msgs("fine", body), client)
                    self.assertEqual(r["action"], "confirm")
                    self.assertIn(f"messages[1] ({kind}", r["message"])
                    self.assertEqual(client.calls, [])
                    self.assertNotIn("RealPass", r["message"] + "\n".join(self.logs) + self.audit_text())

    def test_the_quote_layer_decides_where_a_placeholder_ends(self):
        # n backslashes before the opening quote, k before the closing one.
        # An unescaped opening quote (n even) ends at the next unescaped quote
        # of its kind, so the value is the placeholder alone only when that
        # quote follows it directly (k == 0); an escaped one (n odd) ends only
        # at the same escape (k == n). Anything else is scanned.
        bs = "\\"
        for value in ("<redacted>", "${DB_PASSWORD}", "********", "changeme"):
            for q in "\"'`":
                for n in range(5):
                    for k in range(5):
                        quiet = k == 0 if n % 2 == 0 else k == n
                        text = f"before password: {bs * n}{q}{value}{bs * k}{q} after"
                        with self.subTest(text):
                            self.assertEqual(guard.scan_secrets(text), [] if quiet else ["password_assignment"])

    def test_nested_json_values_are_read_at_their_own_depth(self):
        # JSON text inside a JSON string, up to three levels: the value's
        # quote layer is its depth's escape (1, 3, 7 backslashes).
        def nested(obj, depth, **kw):
            text = json.dumps(obj, **kw)
            for _ in range(depth):
                text = json.dumps(text)
            return text

        for depth in range(4):
            with self.subTest(depth=depth):
                for value in ("<redacted>", "${DB_PASSWORD}", "********", "changeme"):
                    self.assertEqual(guard.scan_secrets(nested({"password": value, "user": "bob"}, depth)), [])
                for value in ("RealPass123!", '<DB_PASSWORD>"RealPass123!', 'ab"RealPass123!',
                              "<redacted>,RealPass123!", "<redacted>\\RealPass123!"):
                    self.assertEqual(guard.scan_secrets(nested({"password": value, "user": "bob"}, depth)),
                                     ["password_assignment"], value)
                # The value's own closing quote ends it: a short value is not
                # joined to the next key, even with no spaces in between.
                compact = nested({"password": "ab", "user": "bobbobbob"}, depth, separators=(",", ":"))
                self.assertEqual(guard.scan_secrets(compact), [])

    def test_a_mismatched_or_missing_closing_quote_is_scanned(self):
        bs = "\\"
        for open_q, close_q in (('"', "'"), ("'", '"'), ('"', "`"), ("`", "'")):
            for n, k in ((0, 0), (1, 1), (3, 3)):
                text = f"before password: {bs * n}{open_q}<redacted>{bs * k}{close_q} after"
                with self.subTest(text):
                    self.assertEqual(guard.scan_secrets(text), ["password_assignment"])
        for n in range(4):
            text = f"before password: {bs * n}\"<redacted>"
            with self.subTest(text):
                self.assertEqual(guard.scan_secrets(text), ["password_assignment"])

    def test_an_escaped_quote_does_not_end_the_first_word(self):
        # The first word of a quoted value runs to whitespace or the value's
        # own closing quote; an escaped quote inside it is part of it.
        for text in ('password: "ab\\"RealPass123!"', 'password: "<x>\\"RealPass123!"',
                     "password: '<x>\\'RealPass123!'", 'password: \\"<x>\\\\\\"RealPass123!\\"'):
            with self.subTest(text):
                self.assertEqual(guard.scan_secrets(f"before {text} after"), ["password_assignment"])
        # Still below the minimum: the first word ends at a space, or at the
        # value's closing quote.
        for text in ('password: "ab RealPass123!"', 'password: "abc\\\\" RealPass123!',
                     'password: \\"abc\\" RealPass123!'):
            with self.subTest(text):
                self.assertEqual(guard.scan_secrets(f"before {text} after"), [])

    def test_an_unescaped_quote_after_an_escaped_backslash_ends_the_value(self):
        # "ab\\" is the value ab\ and its closing quote: before a boundary,
        # what follows is outside it, so the value is short (pinned by
        # mutation, r4).
        for text in ('password: "ab\\\\",RealPass123!', "password: 'ab\\\\\\\\',RealPass123!"):
            with self.subTest(text):
                self.assertEqual(guard.scan_secrets(f"before {text} after"), [])
        # With no boundary after that quote the text runs on as one value
        # (R4-1): ab\RealPass123! (until r4 these were quiet).
        for text in ('password: "ab\\\\"RealPass123!', "password: 'ab\\\\\\\\'RealPass123!"):
            with self.subTest(text):
                self.assertEqual(guard.scan_secrets(f"before {text} after"), ["password_assignment"])

    # Review r5 R5-1, the scan-cost fix: the unquoted token spells out the
    # closing followers itself, and a short plain first word takes its own
    # path. Both copies are pinned here (by mutation, r6).

    def test_a_short_unquoted_value_with_a_quote_inside_ends_at_a_closing_quote(self):
        # Seven characters, one of them a quote that closes nothing, then a
        # quote (bare or escaped) that closes the enclosing string: still
        # short, before each closing follower and at the end. With no
        # closing follower the value runs on to eight and hits.
        bs = "\\"
        for q in ('"', "'", "`", bs + '"', bs + "'"):
            for t in (" ", "\t", "\n", ",", ";", ":", ")", "]", "}"):
                text = f"{q}PASSWORD=ab'cde1{q}{t}x"
                with self.subTest(text):
                    self.assertEqual(guard.scan_secrets(f"before {text}"), [])
            with self.subTest(f"{q} at the end"):
                self.assertEqual(guard.scan_secrets(f"before {q}PASSWORD=ab'cde1{q}"), [])
            text = f"PASSWORD=ab'cde1{q}x"
            with self.subTest(text):
                self.assertEqual(guard.scan_secrets(f"before {text} after"), ["password_assignment"])
        self.assertEqual(guard.scan_secrets('["PASSWORD=ab\'cde1","TOKEN=xyz12"]'), [])
        self.assertEqual(guard.scan_secrets('{\\"cmd\\": \\"export PASSWORD=ab\'cde1\\"}'), [])
        self.assert_deep_confirm("PASSWORD=ab'cde1\"x", "password_assignment")

    def test_a_short_value_with_a_quote_or_backslash_ends_at_its_own_close(self):
        # Compact JSON, depths 0-3: a short value holding a quote, an escaped
        # backslash or an escaped quote ends at its own closing quote, not
        # the next key's. These values take the general reading, not the
        # plain-word path.
        for depth in range(4):
            for value in ("a'b", "a`b", "a\\b", 'a"b', 'a\\"b'):
                text = json.dumps({"password": value, "user": "bobbobbob"}, separators=(",", ":"))
                for _ in range(depth):
                    text = json.dumps(text)
                with self.subTest(text):
                    self.assertEqual(guard.scan_secrets(text), [])

    def test_a_short_quoted_word_with_a_quote_inside_is_not_a_concatenation(self):
        # Seven characters with an escaped quote, or a quote of another
        # kind, inside: before a closing follower or at the end it is the
        # whole value, and short. Followed by more value it is a
        # concatenation, eight or more with a symbol.
        for name, kind in self.PROSE_KINDS.items():
            for word in ('ab\\"cde1', "a'cdef1", "a`cdef1"):
                for after in ("", ",", ";", ":", ")", "]", "}", " next"):
                    text = f'{name}: "{word}"{after}'
                    with self.subTest(text):
                        self.assertEqual(guard.scan_secrets(f"before {text}"), [])
                text = f'{name}: "{word}"x'
                with self.subTest(text):
                    self.assertEqual(guard.scan_secrets(f"before {text} after"), [kind])
        self.assert_deep_confirm('password: "ab\\"cde1"x', "password_assignment")

    def test_a_short_plain_word_concatenated_up_to_a_closing_quote_hits(self):
        # "abc12" then d and a quote that closes the enclosing string: the
        # value is the concatenation "abc12"d, eight characters with a digit.
        for name, kind in self.PROSE_KINDS.items():
            for after in ("", ",", ")", " next"):
                text = f'{name}="abc12"d"{after}'
                with self.subTest(text):
                    self.assertEqual(guard.scan_secrets(f"before {text}"), [kind])
        self.assert_deep_confirm('password="abc12"d",', "password_assignment")

    def test_near_miss_placeholders_confirm_beyond_the_preview(self):
        for form, (_, scanned) in PLACEHOLDER_FORMS.items():
            for value in scanned:
                with self.subTest(f"{form}: {value!r}"):
                    body = "routine status. " * 40 + f'\npassword="{value}"\nend of report'
                    client = FakeClient()
                    r = self.run_guard("send_events", self.msgs("fine", body), client)
                    self.assertEqual(r["action"], "confirm")
                    self.assertIn("messages[1] (password_assignment", r["message"])
                    self.assertEqual(client.calls, [])

    def test_one_character_below_each_minimum_stays_quiet(self):
        for body in BELOW_MINIMUM:
            with self.subTest(body):
                self.assertEqual(guard.scan_secrets(f"before {body} after"), [])

    def test_a_prefix_inside_a_longer_identifier_stays_quiet(self):
        for body in NEAR_MISSES:
            with self.subTest(body):
                self.assertEqual(guard.scan_secrets(f"before {body} after"), [])

    def test_every_fixture_is_caught_beyond_the_preview(self):
        # A hit after the 400-char preview is only visible to the full scan.
        fixtures = {name: (secret, EXPECTED_KIND[name]) for name, secret in FAKE_SECRETS.items()}
        fixtures.update(RECALL_SECRETS)
        for name, (secret, kind) in fixtures.items():
            with self.subTest(name):
                body = "routine status. " * 40 + "\n" + secret + "\nend of report"
                client = FakeClient()
                r = self.run_guard("send_events", self.msgs("fine", body), client)
                self.assertEqual(r["action"], "confirm")
                self.assertIn(f"messages[1] ({kind}", r["message"])
                self.assertEqual(client.calls, [])

    def test_routine_bodies_do_not_match(self):
        for body in ROUTINE_BODIES:
            with self.subTest(body[:30]):
                self.assertEqual(guard.scan_secrets(body), [])

    def test_pattern_hit_deep_in_a_large_body_confirms_without_leaking(self):
        secret = FAKE_SECRETS["github_token"]
        body = ("x" * 200_000) + " " + secret + " " + ("y" * 50_000)
        client = FakeClient()
        r = self.run_guard("send_events", self.msgs("fine", body), client)
        self.assertEqual(r["action"], "confirm")
        self.assertIn("messages[1]", r["message"])
        self.assertIn("github_token", r["message"])
        self.assertEqual(client.calls, [], "a known secret is never sent upstream as a preview")
        for sink, text in (("message", r["message"]), ("log", "\n".join(self.logs)), ("audit", self.audit_text())):
            with self.subTest(sink):
                self.assertNotIn(secret, text)
                self.assertNotIn(secret[:8], text)
                self.assertNotIn("xxxxxxxx", text)
        self.assertEqual(self.audit.counters.get("guard.secret_pattern"), 1)

    def test_several_hits_name_every_index_and_kind(self):
        r = self.run_guard("send_events", self.msgs(FAKE_SECRETS["aws_access_key"], "ok",
                                                    FAKE_SECRETS["private_key"] + "\n" + FAKE_SECRETS["sk_token"]),
                           FakeClient())
        self.assertEqual(r["action"], "confirm")
        self.assertIn("messages[0] (aws_access_key)", r["message"])
        self.assertIn("messages[2] (private_key, sk_token)", r["message"])
        self.assertNotIn("messages[1]", r["message"])

    def test_model_path_audit_and_log_hold_no_body_text(self):
        body = "the quarterly numbers are 12345 and the codename is PELICAN"
        self.run_guard("send_events", self.msgs(body), FakeClient({"leak_0": noul(0.7)}))
        for sink, text in (("log", "\n".join(self.logs)), ("audit", self.audit_text())):
            with self.subTest(sink):
                self.assertNotIn("PELICAN", text)
                self.assertNotIn("quarterly", text)
        row = json.loads(self.audit_text().splitlines()[-1])
        self.assertEqual(row["tool"], "send_events")
        self.assertEqual(row["action"], "confirm")
        self.assertNotIn("state", row)
        self.assertEqual(row["body_bytes"], [len(body)])

    def test_malformed_inputs_confirm_without_a_call(self):
        bad = {
            "not an object": "hello",
            "messages missing": {"source": "x"},
            "messages empty": {"source": "x", "messages": []},
            "too many messages": {"source": "x", "messages": [{"session": "s", "body": f"b{i}"} for i in range(33)]},
            "message not an object": {"source": "x", "messages": ["hi"]},
            "body missing": {"source": "x", "messages": [{"session": "s"}]},
            "body not a string": {"source": "x", "messages": [{"session": "s", "body": {"x": 1}}]},
            "body empty": {"source": "x", "messages": [{"session": "s", "body": ""}]},
            "bodies over the scan cap": {"source": "x", "messages": [{"session": "s", "body": "x" * (4 << 20) + str(i)}
                                                      for i in range(3)]},
        }
        for name, inp in bad.items():
            with self.subTest(name):
                client = FakeClient()
                r = self.run_guard("send_events", inp, client)
                self.assertEqual(r["action"], "confirm")
                self.assertIn("malformed send_events", r["message"])
                self.assertEqual(client.calls, [])

    def test_upstream_errors_confirm_without_echoing_bodies(self):
        for name, client in {"transport": FakeClient(error=JevError("HTTP 503")),
                             "bad answer": FakeClient({"leak_0": {"type": "noul"}})}.items():
            with self.subTest(name):
                r = self.run_guard("send_events", self.msgs("CODENAME-OSPREY body"), client)
                self.assertEqual(r["action"], "confirm")
                self.assertNotIn("OSPREY", r["message"])

    def test_unexpected_exception_still_confirms_without_echo(self):
        class Boom(FakeClient):
            def decide(self, state, questions, *, op="decide", **kw):
                raise RuntimeError("leaked " + state["call"]["messages"][0]["body_preview"])
        r = self.run_guard("send_events", self.msgs("CODENAME-HERON"), Boom())
        self.assertEqual(r["action"], "confirm")
        self.assertNotIn("HERON", r["message"])
        self.assertNotIn("HERON", "\n".join(self.logs) + self.audit_text())

    def test_adversarial_near_misses_scan_fast(self):
        # Review r1 #3: benchmark every expansion. The reviewer's shapes plus
        # assignment near misses, 32 x 256 KiB each, scan only.
        # The units are NEAR_MISS_UNITS (below); each is timed against the
        # host's own speed (review r6 R6-1): see assert_scan_under_bound.
        for name, unit in NEAR_MISS_UNITS.items():
            with self.subTest(name):
                body = unit_body(unit)
                assert_scan_under_bound(self, name, lambda: time_pair(body))

    def test_full_scan_of_max_sized_call_is_fast(self):
        # The host treats a hook slower than 5 s as continue, and the Jev call
        # still has to fit after the scan: the scan gets a small slice.
        prose = ("lorem ipsum dolor sit amet api key token bearer " * 6000)[:256 * 1024 - 2]
        near_misses = ("api_key: ${X} bearer abc ghp_x xoxb- eyJa.eyJb AKIA AIza sk- apikey_ "
                       "glpat- -----BEGIN x://a:b password = aaaaaaaaaaa ") * 2600
        for name, body in (("prose", prose), ("near misses", near_misses[:256 * 1024 - 2])):
            with self.subTest(name):
                t0 = time.monotonic()
                r = self.run_guard("send_events", self.msgs(*[body + str(i) for i in range(32)]), FakeClient())
                self.assertEqual(r["action"], "continue")
                self.assertLess(time.monotonic() - t0, 0.5, "32 x 256 KiB must scan in a fraction of the hook budget")


# ── the near-miss speed bound, relative to the host (review r6 Q1, R6-1) ────

NEAR_MISS_UNITS = {
    "prose": "ordinary text ", "sk misses": " sk-" + "a" * 201, "url misses": " x://" + "a" * 128 + ":" + "b" * 256 + "!",
    "jwt misses": " eyJ" + "a" * 1000 + ".eyJ" + "b" * 1000 + "!", "bearer spaces": " bearer" + " " * 1000 + "!",
    "pair misses": ' password        :        "abcdefg ', "unicode": "\u0130\U0001f600 API_KEY: ${X} ",
    "token colons": "token:" * 10, "token runs": "token:" + "a" * 300 + " ",
    "password placeholders": "password=${X} token: <y> secret: xxxxxxxx ",
    "quoted short": "token='abc' " * 3, "sk letters": "sk-" + "abcdefghij-" * 30 + " ",
    "bearer letters": "bearer " + "abcdefghijk " * 3,
    # r4: quote layers with backslash parity
    "backslash runs": "password: " + "\\" * 1000 + "x ",
    "escaped short values": 'password: \\\\\\"ab\\\\\\" ',
    "escaped masks": 'token: \\"' + "x" * 256 + '\\" ',
    "runs inside a value": 'password: \\"ab' + "\\" * 1000 + " ",
    "deep names": '\\\\\\"password\\\\\\": \\\\\\"ab\\\\\\" ',
    # r4 ruling: quotes and backslashes inside an unquoted value
    "a quote in an unquoted value": 'password=<NAME>"' + "a" * 60 + " ",
    "a closing quote before a symbol": 'password=<NAME>"' + "a" * 48 + '",1 ',
    "quotes in an unquoted value": "password=a" + '"a' * 30 + '",1 ',
    "short keyed values in JSON": '"API_KEY=abcdefghijk","x" ',
    "quote runs": "token=" + 'ab"' * 100 + " ",
    "escaped quote runs": "secret=" + 'a\\"' * 100 + " ",
    "backslash pairs before a symbol": "password=a\\\\" + "a" * 70 + "! ",
    # r4 R4-1: concatenations and quotes of another kind
    "a quoted placeholder before a suffix": 'password="<NAME>"' + "a" * 60 + " ",
    "a concatenation closed before a symbol": 'password="<NAME>"' + "a" * 48 + '",1 ',
    "short quoted runs": "token=" + '"ab"' * 100 + " ",
    "empty quoted runs": "secret=" + '""' * 300 + " ",
    "a short first word without a close": 'secret="abcdefg ',
    "an escaped concatenation": 'password=\\"<NAME>\\"' + "a" * 60 + " ",
    "quotes of another kind": 'password: "' + "'a" * 200 + '" ',
    "unescaped quotes in an escaped layer": 'token: \\"' + '"a' * 200 + " ",
    "a ladder of layers": "".join("token=" + "\\" * (2 * d + 1) + '"ab' for d in range(40)) + " ",
    # r5 R5-1: a short quoted first word, then more value, under a
    # keyed name (the concatenation's 12-token bare read), and the
    # reviewer's near-bound shapes.
    "a keyed short concatenation": 'api_key="abcdefg"xx ',
    "comma runs": 'token=",',
    "a short concatenation": 'token="abcdefg"z ',
    "a 63-character window": "password=" + 'a"' * 30 + "aa1 ",
    "a 64-character window": "password=" + 'a"' * 31 + "aa1 ",
    "a window closed before a symbol": "password=" + 'a"' * 30 + '";1 ',
    "an odd layer of pairs": 'password=\\"' + "\\\\x" * 7 + '\\"a ',
    "an empty concatenation": 'password=""""""""a ',
    "no symbol in the window": "password=" + 'a"' * 31 + "b" * 64 + " ",
    # r6: the same family under other names, quotes and layers
    "a keyed short concatenation, secret_key": 'secret_key="abcdefg"xx ',
    "a keyed short concatenation in an escaped layer": 'api_key=\\"abcdefg\\"xx ',
    "a keyed concatenation with escaped quotes": 'api_key="a\\"b\\"c\\"d"x ',
    "a keyed concatenation with quotes of another kind": "api_key=\"a'b'c'd\"x ",
    "a short concatenation, password": 'password="abcdefg"z ',
    "a short quoted word": 'token="abcdefg" ',
    "single-quoted comma runs": "token=',",
    "a short concatenation of several parts": 'token="ab"cd"ef"g ',
    "a short concatenation with escaped quotes": 'token="a\\"b\\"c\\"d"z ',
    "a short quoted word before a comma": 'password="abcdefg",',
    "a short shaped word": "token=abcdef1 ",
    "a short shaped word with escaped quotes": 'token=a\\"b\\"c\\"1 ',
    "a short keyed word": "api_key=abcdefghijk ",
    "a short keyed word with escaped quotes": 'api_key=a\\"b\\"c\\"d\\"e\\"f ',
}

# Contract (review r6 R6-1): the old 0.5 s bound, expressed in units of this
# host's own speed. A unit's 32 scans are timed between two timings of 32
# scans of a linear benign body of the same size (REFERENCE_PROSE), all
# three on one CPU, and the unit must take less than SCAN_RATIO x the
# smaller of the two reference timings. SCAN_RATIO is 0.5 s over the
# reference's steady time on a P-core of the review host, so on that core
# class the bound is the old 0.5 s, not a looser one; on a slower core (an
# E-core of a hybrid CPU, a slower CI runner) it scales with the core
# instead of failing on whichever core class the test landed on.
# Why two reference timings: one contended reading makes the bound lenient
# (a reading of 0.108 s against the usual 0.07-0.08 s once let the old
# scanner's R5-1 regression pass on a P-core). A regression is slow every
# time, but the reference is noisy too, so the bound takes the faster of the
# readings just before and just after the unit.
SCAN_BOUND = 0.5  # seconds for 32 scans of one unit body, on the reference P-core
SCAN_TRIES = 3    # a pair over the bound is re-timed up to twice more (r6 Q1)
# REFERENCE_P_S was measured on 2026-10-18 on the review host, an Intel
# i9-14900K (CPUs 0-15 P-cores at 5.7 GHz, CPUs 16-31 E-cores at 4.4 GHz).
# It is the median of 33 reference timings taken with `taskset -c 2`, in
# three sessions between 19:16 and 19:25. Range 0.0695-0.0904 s, giving
# R = 6.69 (/var/tmp/synapscli-v/r7/ref-pooled.txt).
# The load was 20-22, not 15 or less. A loaded reference is slower, so this
# R is the stricter one; re-measuring at a quiet time is a follow-up.
# The estimator was checked against the min-of-two rule at 19:37-19:38, load
# 13.6-19.0: 171 (before, unit, after) triples on CPU 2, every unit once in
# each of three sessions. The median of a single reading (the one before
# the unit) was 0.0710 s and the median of min(before, after) 0.0701 s,
# 1.3% lower. That is within 3%, so REFERENCE_P_S stays as measured
# (/var/tmp/synapscli-v/r7/calib-minref-1.log).
#
# Known property: the ratio tracks the core class only for the units that
# can reach the bound. On a P-core (CPU 2) and an E-core (CPU 20), the units
# at 0.4 R or more differ by at most about 11% between the two classes.
# Some far units (url, jwt and sk misses, token colons and runs, quote runs)
# differ by up to about 39%, because the E-core is slower on them than on
# the prose reference. All of them stay at about 40% of R or less on either
# core, so the difference can't flip their verdict. ("About": the near/far
# cut is made on the P-core ratio, so a far unit's E-core ratio can sit
# slightly above 0.4 R; the highest measured was 42%.)
REFERENCE_P_S = 0.0747
SCAN_RATIO = SCAN_BOUND / REFERENCE_P_S
REFERENCE_PROSE = "lorem ipsum dolor sit amet api key token bearer "


class ScanRetimed(UserWarning):
    """A near-miss unit went over the scan bound and was re-timed."""


def unit_body(unit):
    """One unit repeated to the body size the bound is defined on."""
    return (unit * (KIB256 // len(unit) + 1))[:KIB256 - 64]


def reference_body(size):
    """The reference: benign prose (as in the max-sized-call test), `size` chars."""
    return (REFERENCE_PROSE * (size // len(REFERENCE_PROSE) + 1))[:size]


def time_scans(body, scan=None, scans=32):
    """`scans` calls of `scan` (default: the secret scan) on body + str(i)."""
    scan = guard.scan_secrets if scan is None else scan
    t0 = time.monotonic()
    for i in range(scans):
        scan(body + str(i))
    return time.monotonic() - t0


def current_cpu():
    """The CPU this thread is running on, or None where it can't be read."""
    getcpu = getattr(os, "sched_getcpu", None)
    if getcpu is not None:
        return getcpu()
    try:
        with open("/proc/thread-self/stat") as f:
            return int(f.read().rsplit(")", 1)[1].split()[36])  # field 39, "processor"
    except (OSError, ValueError, IndexError):
        return None


@contextlib.contextmanager
def pinned_to_current_cpu():
    """Pin this thread to the CPU it is running on and restore the old mask
    after. Yields the CPU, or None (unpinned) where CPU affinity or the
    current CPU is unavailable (not Linux)."""
    getaff = getattr(os, "sched_getaffinity", None)
    setaff = getattr(os, "sched_setaffinity", None)
    cpu = current_cpu()
    if getaff is None or setaff is None or cpu is None:
        yield None
        return
    before = getaff(0)
    try:
        setaff(0, {cpu})
    except OSError:
        yield None
        return
    try:
        yield cpu
    finally:
        setaff(0, before)


def time_pair(body, scan=None, scans=32):
    """(reference before s, unit s, reference after s, cpu): `scans` calls
    of `scan` (default: 32 secret scans) on body, timed between two timings
    of the reference (32 secret scans of the prose body at the unit size),
    all three pinned to one CPU. The bound uses the faster reference."""
    reference = reference_body(len(unit_body("x")))
    with pinned_to_current_cpu() as cpu:
        before = time_scans(reference)
        unit = time_scans(body, scan, scans)
        after = time_scans(reference)
    return before, unit, after, cpu


def _reference(trial):
    """The bound's reference: the faster of the readings around the unit."""
    before, _, after, _ = trial
    return min(before, after)


def _over(trial):
    return trial[1] >= SCAN_RATIO * _reference(trial)


def _shown(trial):
    before, unit, after, cpu = trial
    reference = _reference(trial)
    ratio = unit / reference if reference > 0 else float("inf")
    where = f"cpu {cpu}" if cpu is not None else "unpinned"
    return (f"{unit:.3f} s / reference min({before:.3f} s, {after:.3f} s) = {reference:.3f} s:"
            f" ratio {ratio:.2f} ({where})")


def assert_scan_under_bound(case, name, timer):
    """Fail only when all SCAN_TRIES pairs of one unit are over the bound:
    unit >= SCAN_RATIO x min(reference before, reference after).

    A single transient spike must not fail the suite, so a pair over the
    bound is re-timed, for that unit only (r6 Q1). Each unit's pairs are
    printed as one line (pytest shows it with -rP or -s); a re-time is also
    raised as a ScanRetimed warning, which pytest lists even when the test
    passes, so a unit near the bound cannot hide."""
    trials = [timer()]
    while _over(trials[-1]) and len(trials) < SCAN_TRIES:
        trials.append(timer())
    shown = "; ".join(_shown(t) for t in trials)
    line = f"scan bound ratio {SCAN_RATIO:.2f}: {name!r}: {shown}"
    if len(trials) > 1:
        line = "re-timed: " + line
        warnings.warn(line, ScanRetimed, stacklevel=2)
    print(line)
    if _over(trials[-1]):
        case.fail(f"{name}: all {len(trials)} pairs over the bound ratio {SCAN_RATIO:.2f}: {shown}")


class ScanBoundRetry(unittest.TestCase):
    """The re-time rule and the relative bound, with a fake timer (no
    scanning); the pinning with the real OS calls where available."""

    REF = 0.1  # a reference time for the fake pairs

    def at(self, factor, reference=None, cpu=2, after=None):
        """A fake (before, unit, after, cpu) whose unit is `factor` x the
        bound for `reference` (both readings `reference` unless `after`)."""
        reference = self.REF if reference is None else reference
        after = reference if after is None else after
        return (reference, factor * SCAN_RATIO * min(reference, after), after, cpu)

    def run_bound(self, trials):
        pending = iter(trials)
        used = []

        def timer():
            used.append(next(pending))
            return used[-1]

        out = io.StringIO()
        error = None
        with warnings.catch_warnings(record=True) as caught, contextlib.redirect_stdout(out):
            warnings.simplefilter("always")
            try:
                assert_scan_under_bound(self, "unit-x", timer)
            except self.failureException as e:
                error = str(e)
        retimed = [str(w.message) for w in caught if issubclass(w.category, ScanRetimed)]
        return used, out.getvalue().splitlines(), retimed, error

    def assert_shows(self, text, trials):
        for before, unit, after, cpu in trials:
            reference = min(before, after)
            for part in (f"{unit:.3f} s", f"reference min({before:.3f} s, {after:.3f} s)",
                         f"= {reference:.3f} s:", f"ratio {unit / reference:.2f}", f"cpu {cpu}"):
                self.assertIn(part, text)

    def test_the_bound_and_the_tries_are_unchanged(self):
        self.assertEqual((SCAN_BOUND, SCAN_TRIES), (0.5, 3))
        self.assertEqual(SCAN_RATIO, SCAN_BOUND / REFERENCE_P_S)
        self.assertTrue(0 < REFERENCE_P_S < SCAN_BOUND)

    def test_a_unit_under_the_bound_is_timed_once_and_not_re_timed(self):
        first = self.at(0.6)
        used, lines, retimed, error = self.run_bound([first, self.at(9), self.at(9)])
        self.assertEqual(used, [first])
        self.assertEqual((retimed, error), ([], None))
        self.assertEqual(len(lines), 1)
        self.assertIn("unit-x", lines[0])
        self.assert_shows(lines[0], used)

    def test_one_spike_is_re_timed_and_reported_on_one_line(self):
        trials = [self.at(1.4, cpu=20), self.at(0.6, cpu=3), self.at(9)]
        used, lines, retimed, error = self.run_bound(trials)
        self.assertEqual(used, trials[:2])
        self.assertIsNone(error)
        self.assertEqual(len(lines), 1)
        self.assertIn("unit-x", lines[0])
        self.assert_shows(lines[0], used)
        self.assertEqual(retimed, lines)

    def test_two_spikes_then_a_pair_under_the_bound_pass(self):
        trials = [self.at(1.4), self.at(1.2), self.at(0.8), self.at(9)]
        used, lines, retimed, error = self.run_bound(trials)
        self.assertEqual(used, trials[:3])
        self.assertIsNone(error)
        self.assertEqual(len(lines), 1)
        self.assert_shows(lines[0], used)
        self.assertEqual(retimed, lines)

    def test_three_pairs_over_the_bound_fail_and_list_all_three(self):
        trials = [self.at(1.4, after=0.13), self.at(1.2, reference=0.12), self.at(1.1, cpu=20), self.at(0.1)]
        used, lines, retimed, error = self.run_bound(trials)
        self.assertEqual(used, trials[:3])
        self.assertIsNotNone(error)
        self.assertIn("unit-x", error)
        self.assert_shows(error, used)
        self.assertEqual(len(lines), 1)
        self.assert_shows(lines[0], used)
        self.assertEqual(retimed, lines)

    def test_a_pair_at_the_bound_counts_as_over(self):
        trials = [self.at(1.0)] * 3
        used, lines, retimed, error = self.run_bound(trials)
        self.assertEqual(len(used), 3)
        self.assertIsNotNone(error)

    def test_the_bound_uses_the_faster_of_the_two_references(self):
        # One contended reference reading, before or after the unit, must
        # not loosen the bound: this unit is over the bound for the faster
        # reading and under it for the slower one (0.75 x), so it fails.
        fast, slow = self.REF, 2 * self.REF
        unit = 1.5 * SCAN_RATIO * fast
        for name, trial in (("slow before", (slow, unit, fast, 20)), ("slow after", (fast, unit, slow, 2))):
            with self.subTest(name):
                used, lines, retimed, error = self.run_bound([trial] * 3)
                self.assertEqual(len(used), 3)
                self.assertIsNotNone(error)
                self.assert_shows(error, used)
                self.assert_shows(lines[0], used)
        # ... and a unit under the bound for the faster reading passes.
        unit = 0.9 * SCAN_RATIO * fast
        for name, trial in (("slow before", (slow, unit, fast, 20)), ("slow after", (fast, unit, slow, 2))):
            with self.subTest("under: " + name):
                used, lines, retimed, error = self.run_bound([trial] * 3)
                self.assertEqual((used, retimed, error), ([trial], [], None))
                self.assert_shows(lines[0], used)

    def test_the_bound_scales_with_the_reference(self):
        # A slower core: twice the reference time allows twice the unit
        # time (an absolute 0.5 s bound would fail this one) ...
        slow = (2 * REFERENCE_P_S, 0.9, 2 * REFERENCE_P_S, 20)
        used, lines, retimed, error = self.run_bound([slow])
        self.assertEqual((used, error), ([slow], None))
        # ... and a faster one allows less (an absolute bound would pass this).
        fast = (0.5 * REFERENCE_P_S, 0.3, 0.5 * REFERENCE_P_S, 2)
        used, lines, retimed, error = self.run_bound([fast] * 3)
        self.assertEqual(len(used), 3)
        self.assertIsNotNone(error)

    def test_a_pair_is_timed_on_one_cpu_and_the_mask_is_restored(self):
        if not hasattr(os, "sched_setaffinity") or current_cpu() is None:
            self.skipTest("no CPU affinity here: the pairs run unpinned")
        before = os.sched_getaffinity(0)
        with pinned_to_current_cpu() as cpu:
            self.assertIn(cpu, before)
            self.assertEqual(os.sched_getaffinity(0), {cpu})
        self.assertEqual(os.sched_getaffinity(0), before)
        first, unit, second, cpu = time_pair("token=abc " * 40)
        self.assertIn(cpu, before)
        self.assertGreater(first, 0)
        self.assertGreater(unit, 0)
        self.assertGreater(second, 0)
        self.assertEqual(os.sched_getaffinity(0), before)

    def test_a_pair_times_the_reference_the_unit_then_the_reference_again(self):
        module = sys.modules[__name__]
        calls = []
        times = iter([0.25, 0.5, 0.125])
        getaff = getattr(os, "sched_getaffinity", None)

        def fake(body, scan=None, scans=32):
            calls.append((body, scan, scans, getaff(0) if getaff else None))
            return next(times)

        def unit_scan(text):
            return []

        original = module.time_scans
        module.time_scans = fake
        try:
            before, unit, after, cpu = time_pair("unit body", unit_scan, 1)
        finally:
            module.time_scans = original
        reference = reference_body(len(unit_body("x")))
        self.assertEqual([c[:3] for c in calls],
                         [(reference, None, 32), ("unit body", unit_scan, 1), (reference, None, 32)])
        self.assertEqual((before, unit, after), (0.25, 0.5, 0.125))
        if cpu is not None:  # all three timings run under the one pin
            self.assertEqual([c[3] for c in calls], [{cpu}] * 3)

    def test_the_reference_is_benign_prose_of_the_unit_body_size(self):
        size = len(unit_body("token=abc "))
        self.assertEqual(size, KIB256 - 64)
        body = reference_body(size)
        self.assertEqual(len(body), size)
        self.assertTrue(body.startswith(REFERENCE_PROSE))
        self.assertEqual(guard.scan_secrets(body), [])


# ── frozen input contracts (review r1 #2) ───────────────────────────────────

CANARY = "CANARY-VALUE-7f3e"
MIB = 1 << 20
KIB256 = 256 * 1024


def _edit(base, **changes):
    """One schema fault applied to a valid edit: a value, or ABSENT to drop it."""
    e = copy.deepcopy(base)
    for k, v in changes.items():
        if v is ABSENT:
            e.pop(k, None)
        else:
            e[k] = v
    return e


ABSENT = object()
R = {"path": "a.txt", "op": "replace", "anchor": "old", "text": "new"}
IB = {"path": "a.txt", "op": "insert_before", "anchor": "old", "text": "new"}
IA = {"path": "a.txt", "op": "insert_after", "anchor": "old", "text": "new"}
A = {"path": "a.txt", "op": "append", "text": "x"}
J = {"path": "a.jsonl", "op": "append_jsonl", "value": {"k": 1}}

# Negatives written from tools-design.md §A.1 (and the tool's parse: unknown
# fields refused, optional fields may be absent or null) — each breaks one rule.
MULTI_EDIT_BAD = {
    # the reviewer's probe inputs
    "probe: append missing text": {"edits": [_edit(A, text=ABSENT)]},
    "probe: replace missing anchor": {"edits": [_edit(R, anchor=ABSENT)]},
    "probe: append_jsonl value 42": {"edits": [_edit(J, value=42)]},
    "probe: occurrence false": {"edits": [_edit(R, occurrence=False)]},
    "probe: anchor_mode INVALID": {"edits": [_edit(R, anchor_mode="INVALID")]},
    "probe: text 1 MiB + 1": {"edits": [_edit(A, text="x" * (MIB + 1))]},
    # top level
    "unknown top-level field": {"edits": [A], "dry_run": True},
    "placeholders a string": {"edits": [A], "placeholders": "true"},
    "placeholders an integer": {"edits": [A], "placeholders": 1},
    "edits null": {"edits": None},
    # required fields: absent or null
    "path null": {"edits": [_edit(A, path=None)]},
    "op missing": {"edits": [_edit(A, op=ABSENT)]},
    "op null": {"edits": [_edit(A, op=None)]},
    "op wrong case": {"edits": [_edit(A, op="Append")]},
    "op an integer": {"edits": [_edit(A, op=1)]},
    "unknown edit field": {"edits": [_edit(A, mode="x")]},
    # anchor rules
    "replace anchor null": {"edits": [_edit(R, anchor=None)]},
    "replace anchor empty": {"edits": [_edit(R, anchor="")]},
    "insert_before missing anchor": {"edits": [_edit(IB, anchor=ABSENT)]},
    "insert_after missing anchor": {"edits": [_edit(IA, anchor=ABSENT)]},
    "append with an anchor": {"edits": [_edit(A, anchor="old")]},
    "append with anchor_mode": {"edits": [_edit(A, anchor_mode="exact")]},
    "append_jsonl with occurrence": {"edits": [_edit(J, occurrence=1)]},
    "anchor_mode empty": {"edits": [_edit(R, anchor_mode="")]},
    "anchor_mode an integer": {"edits": [_edit(R, anchor_mode=0)]},
    # occurrence: integer >= 1, bool is not an integer
    "occurrence true": {"edits": [_edit(R, occurrence=True)]},
    "occurrence zero": {"edits": [_edit(R, occurrence=0)]},
    "occurrence negative": {"edits": [_edit(R, occurrence=-1)]},
    "occurrence a float": {"edits": [_edit(R, occurrence=1.0)]},
    "occurrence a string": {"edits": [_edit(R, occurrence="1")]},
    # text rules
    "append text null": {"edits": [_edit(A, text=None)]},
    "append text empty": {"edits": [_edit(A, text="")]},
    "insert_after text empty": {"edits": [_edit(IA, text="")]},
    "replace missing text": {"edits": [_edit(R, text=ABSENT)]},
    "append_jsonl with text": {"edits": [_edit(J, text="x")]},
    "text an integer": {"edits": [_edit(A, text=1)]},
    # value / timestamp_field rules
    "append_jsonl missing value": {"edits": [_edit(J, value=ABSENT)]},
    "append_jsonl value null": {"edits": [_edit(J, value=None)]},
    "append_jsonl value a list": {"edits": [_edit(J, value=[1])]},
    "append_jsonl value a string": {"edits": [_edit(J, value="{}")]},
    "replace with a value": {"edits": [_edit(R, value={"k": 1})]},
    "append with timestamp_field": {"edits": [_edit(A, timestamp_field="ts")]},
    "timestamp_field empty": {"edits": [_edit(J, timestamp_field="")]},
    "timestamp_field an integer": {"edits": [_edit(J, timestamp_field=1)]},
    # review r2 S1: "Error if already present" (the reviewer's probe, and a
    # key present with a null value, which the tool's contains_key refuses too)
    "timestamp_field already in value": {"edits": [_edit(J, value={"ts": "existing"}, timestamp_field="ts")]},
    "timestamp_field already in value as null": {"edits": [_edit(J, value={"ts": None}, timestamp_field="ts")]},
    # unless_present / create
    "unless_present empty": {"edits": [_edit(A, unless_present="")]},
    "unless_present an integer": {"edits": [_edit(A, unless_present=1)]},
    "create on replace": {"edits": [_edit(R, create=True)]},
    "create a string": {"edits": [_edit(A, create="true")]},
    "create an integer": {"edits": [_edit(A, create=1)]},
    # per-field bounds: 1 MiB of UTF-8 each
    "anchor over 1 MiB": {"edits": [_edit(R, anchor="a" * (MIB + 1))]},
    "unless_present over 1 MiB": {"edits": [_edit(A, unless_present="u" * (MIB + 1))]},
    "value over 1 MiB": {"edits": [_edit(J, value={"k": "v" * MIB})]},
    "text over 1 MiB in bytes, under in chars": {"edits": [_edit(A, text="\u00e9" * (MIB // 2 + 1))]},
    # a fault in a later edit still counts
    "second edit faulty": {"edits": [A, _edit(A, text=ABSENT)]},
}

MULTI_EDIT_GOOD = {
    "replace with empty text (a deletion)": {"edits": [_edit(R, text="")]},
    "optional fields null": {"edits": [_edit(A, anchor=None, anchor_mode=None, occurrence=None, value=None,
                                             timestamp_field=None, unless_present=None, create=None)],
                             "placeholders": None},
    "every replace option": {"edits": [_edit(R, anchor_mode="line_regex", occurrence=2, unless_present="x",
                                             create=False)], "placeholders": True},
    "append_jsonl options": {"edits": [_edit(J, timestamp_field="ts", create=True, unless_present="k")]},
    "timestamp_field only in a nested object": {"edits": [_edit(J, value={"k": {"ts": 1}}, timestamp_field="ts")]},
    "insert ops with line_prefix": {"edits": [_edit(IB, anchor_mode="line_prefix"), _edit(IA, anchor_mode="exact")]},
    "text of exactly 1 MiB": {"edits": [_edit(A, text="x" * MIB)]},
}

S = {"session": "s", "body": "hello"}
SEND_BAD = {
    # the reviewer's probe inputs
    "probe: missing session (and source)": {"messages": [{"body": "hello"}]},
    "probe: whitespace-only body": {"source": "review", "messages": [{"session": "s", "body": "   "}]},
    "probe: body 256 KiB + 1": {"source": "review", "messages": [{"session": "s", "body": "x" * (KIB256 + 1)}]},
    # top level
    "unknown top-level field": {"source": "v", "messages": [S], "channel": "x"},
    "messages null": {"source": "v", "messages": None},
    "on_error not in the enum": {"source": "v", "messages": [S], "on_error": "abort"},
    "on_error an integer": {"source": "v", "messages": [S], "on_error": 0},
    "record_dir empty": {"source": "v", "messages": [S], "record_dir": ""},
    "record_dir an integer": {"source": "v", "messages": [S], "record_dir": 1},
    "record_dir with NUL": {"source": "v", "messages": [S], "record_dir": "/tmp/a\x00b"},
    # source: required (own or the call's), CLI format
    "no source anywhere": {"messages": [S]},
    "source null everywhere": {"source": None, "messages": [_edit(S, source=None)]},
    "call source empty": {"source": "", "messages": [S]},
    "call source with a space": {"source": "worker v", "messages": [S]},
    "call source 65 characters": {"source": "v" * 65, "messages": [S]},
    "call source an integer": {"source": 7, "messages": [S]},
    "message source bad, call source good": {"source": "v", "messages": [_edit(S, source="bad/slash")]},
    # messages
    "unknown message field": {"source": "v", "messages": [_edit(S, channel="x")]},
    "session missing": {"source": "v", "messages": [_edit(S, session=ABSENT)]},
    "session null": {"source": "v", "messages": [_edit(S, session=None)]},
    "session empty": {"source": "v", "messages": [_edit(S, session="")]},
    "session whitespace": {"source": "v", "messages": [_edit(S, session=" \t")]},
    "session an integer": {"source": "v", "messages": [_edit(S, session=1)]},
    "body null": {"source": "v", "messages": [_edit(S, body=None)]},
    "body newlines and tabs only": {"source": "v", "messages": [_edit(S, body="\n\t\r\n")]},
    "body over 256 KiB in bytes, under in chars": {"source": "v", "messages": [_edit(S, body="\u00e9" * (KIB256 // 2 + 1))]},
    "severity not in the enum": {"source": "v", "messages": [_edit(S, severity="urgent")]},
    "severity upper case": {"source": "v", "messages": [_edit(S, severity="HIGH")]},
    "severity an integer": {"source": "v", "messages": [_edit(S, severity=1)]},
    "record_name with a slash": {"source": "v", "messages": [_edit(S, record_name="a/b.md")]},
    "record_name with a backslash": {"source": "v", "messages": [_edit(S, record_name="a\\b.md")]},
    "record_name dot-dot": {"source": "v", "messages": [_edit(S, record_name="..")]},
    "record_name with a control char": {"source": "v", "messages": [_edit(S, record_name="a\x01.md")]},
    "record_name empty": {"source": "v", "messages": [_edit(S, record_name="")]},
    "record_name 129 bytes": {"source": "v", "messages": [_edit(S, record_name="n" * 129)]},
    "record_name an integer": {"source": "v", "messages": [_edit(S, record_name=1)]},
    "duplicate (session, body) pair": {"source": "v", "messages": [S, dict(S)]},
    "second message faulty": {"source": "v", "messages": [S, _edit(S, session="t", body=" ")]},
}

SEND_GOOD = {
    "message-level source only": {"messages": [_edit(S, source="worker-v")]},
    "optional fields null": {"source": "v", "record_dir": None, "on_error": None,
                             "messages": [_edit(S, severity=None, source=None, record_name=None)]},
    "every option": {"source": "a.b:c@d-1", "record_dir": "/tmp", "on_error": "stop",
                     "messages": [_edit(S, severity="critical", source="w", record_name="20261018-1-s.md")]},
    "same body to two sessions": {"source": "v", "messages": [S, _edit(S, session="t")]},
    "body of exactly 256 KiB": {"source": "v", "messages": [_edit(S, body="x" * KIB256)]},
    "source of 64 characters": {"source": "v" * 64, "messages": [S]},
}


def _nested(depth):
    value = {}
    for _ in range(depth):
        value = {"k": value}
    return value


# Found by mutation (r2): values that cannot even be iterated must fail the
# contract check itself, not a later step; bounds at their exact edges.
MULTI_EDIT_BAD.update({
    "input is a number": 5,
    "edits is a number": {"edits": 5},
    "edits is true": {"edits": True},
    "an edit is a number": {"edits": [5]},
    "an edit is null": {"edits": [None]},
    "occurrence above u64": {"edits": [_edit(R, occurrence=2 ** 64)]},
    "value nested past any JSON parser": {"edits": [_edit(J, value=_nested(100_000))]},
    "path longer than PATH_MAX": {"edits": [_edit(A, path="/" + "a/" * 2100)]},
})
MULTI_EDIT_GOOD.update({
    "occurrence at the u64 maximum": {"edits": [_edit(R, occurrence=2 ** 64 - 1)]},
})
SEND_BAD.update({
    "input is a number": 5,
    "a message is a number": {"source": "v", "messages": [5]},
    "a message is null": {"source": "v", "messages": [None]},
    "record_name with DEL": {"source": "v", "messages": [_edit(S, record_name="a\x7fb")]},
    "record_name with a C1 control (NEL)": {"source": "v", "messages": [_edit(S, record_name="a\x85b")]},
})


class FrozenContracts(GuardCase):
    """Review r1 #2: input outside the frozen tool contract confirms with no
    model call, before anything is summarized."""

    def check(self, tool, cases, *, good):
        for name, inp in cases.items():
            with self.subTest(name):
                client = FakeClient()
                r = self.run_guard(tool, inp, client)
                if good:
                    self.assertEqual(r, {"action": "continue"})
                    self.assertEqual(len(client.calls), 1)
                else:
                    self.assertEqual(r["action"], "confirm")
                    self.assertIn(f"malformed {tool}", r["message"])
                    self.assertEqual(client.calls, [], "no model call for malformed input")

    def test_multi_edit_negatives_from_the_schema(self):
        self.check("multi_edit", MULTI_EDIT_BAD, good=False)

    def test_multi_edit_valid_shapes_still_reach_the_model(self):
        self.check("multi_edit", MULTI_EDIT_GOOD, good=True)

    def test_send_events_negatives_from_the_schema(self):
        self.check("send_events", SEND_BAD, good=False)

    def test_send_events_valid_shapes_still_reach_the_model(self):
        self.check("send_events", SEND_GOOD, good=True)

    def test_malformed_messages_never_echo_values(self):
        cases = {
            "multi_edit": [{"edits": [_edit(A, op=CANARY)]}, {"edits": [_edit(R, anchor_mode=CANARY)]},
                           {"edits": [_edit(A, **{CANARY: 1})]}, {"edits": [A], CANARY: 1},
                           {"edits": [_edit(J, value=CANARY)]}, {"edits": [_edit(A, text=CANARY * 70000)]}],
            "send_events": [{"source": CANARY + " x", "messages": [S]},
                            {"source": "v", "messages": [_edit(S, severity=CANARY)]},
                            {"source": "v", "messages": [_edit(S, record_name=CANARY + "/x")]},
                            {"source": "v", "messages": [_edit(S, **{CANARY: 1})]},
                            {"source": "v", "messages": [_edit(S, body=CANARY), _edit(S, body=CANARY)]}],
        }
        for tool, inputs in cases.items():
            for j, inp in enumerate(inputs):
                with self.subTest(f"{tool}[{j}]"):
                    r = self.run_guard(tool, inp, FakeClient())
                    self.assertEqual(r["action"], "confirm")
                    for sink, text in (("message", r["message"]), ("log", "\n".join(self.logs)),
                                       ("audit", self.audit_text())):
                        self.assertNotIn(CANARY, text, sink)


class Sanitized(GuardCase):
    """Review r1 #5: exception text and response metadata never reach the
    hook message, the log or the audit. Errors are fixed categories; model
    and usage are allowlisted scalars."""

    CALLS = {
        "bash": {"command": "ls"},
        "multi_edit": {"edits": [{"path": "a.txt", "op": "append", "text": "x"}]},
        "send_events": {"source": "worker-v", "messages": [{"session": "s", "body": "status ok"}]},
    }

    def fresh(self):
        self.logs.clear()
        if self.audit_path.exists():
            self.audit_path.unlink()

    def sinks(self, r):
        return {"message": r.get("message", "") + r.get("reason", ""), "log": "\n".join(self.logs),
                "audit": self.audit_text()}

    def assert_clean(self, r, label):
        for sink, text in self.sinks(r).items():
            self.assertNotIn(CANARY, text, f"{label}: {sink}")

    def test_exception_text_never_leaks_from_any_class(self):
        from jev.client import InvalidResponse
        from jev.policy import PolicyDenied
        errors = {
            "JevError": JevError(CANARY), "InvalidResponse": InvalidResponse(CANARY),
            "RuntimeError": RuntimeError(CANARY), "KeyError": KeyError(CANARY),
            "ValueError": ValueError(CANARY), "TypeError": TypeError(CANARY), "OSError": OSError(CANARY),
            "PolicyDenied": PolicyDenied("budget_calls"),
        }
        for tool, inp in self.CALLS.items():
            for name, error in errors.items():
                with self.subTest(f"{tool}: {name}"):
                    self.fresh()
                    r = self.run_guard(tool, inp, FakeClient(error=error))
                    self.assertEqual(r["action"], "confirm")
                    self.assertIn("could not evaluate", r["message"])
                    self.assert_clean(r, f"{tool}/{name}")

    def test_known_upstream_failures_keep_a_useful_fixed_category(self):
        cases = {"deadline exceeded": "timeout", "HTTP 503": "HTTP 503", "retry budget exhausted": "rate limited",
                 "HTTP 503 " + CANARY: "upstream error", CANARY: "upstream error"}
        for text, category in cases.items():
            with self.subTest(text):
                self.fresh()
                r = self.run_guard("bash", {"command": "ls"}, FakeClient(error=JevError(text)))
                self.assertIn(f"({category})", r["message"])
                self.assert_clean(r, text)

    def test_response_metadata_is_allowlisted(self):
        class MetaClient(FakeClient):
            def __init__(self, model, usage):
                super().__init__()
                self.meta = (model, usage)

            def decide(self, *a, **kw):
                resp = super().decide(*a, **kw)
                resp["model"], resp["usage"] = self.meta
                return resp
        hostile = [(CANARY + " with spaces", {"echo": CANARY, "input_tokens": CANARY}),
                   ({"name": CANARY}, [CANARY]), ("m" * 65 + CANARY, {"input_tokens": {"x": CANARY}}),
                   # identifier-shaped: an echoed body or token can look like a model id
                   # (the reviewer's metadata probe, rerun for r2)
                   (CANARY, {"input_tokens": 5}), ("jev-1.13.0-" + CANARY, None)]
        for tool, inp in self.CALLS.items():
            for j, (model, usage) in enumerate(hostile):
                with self.subTest(f"{tool}[{j}]"):
                    self.fresh()
                    r = self.run_guard(tool, inp, MetaClient(model, usage))
                    self.assert_clean(r, f"{tool}[{j}]")
        self.fresh()
        self.run_guard("send_events", self.CALLS["send_events"],
                       MetaClient("jev-1.2", {"input_tokens": 12, "output_tokens": 0, "echo": "x"}))
        row = json.loads(self.audit_text().splitlines()[-1])
        self.assertEqual(row["model"], "jev-1.2")
        self.assertEqual(row["usage"], {"input_tokens": 12, "output_tokens": 0})
        for model in ("jev-latest", "jev-1.13.0"):
            with self.subTest(model):
                self.assertEqual(guard.safe_model({"model": model}), model)

    def test_every_exception_class_has_its_own_fixed_category(self):
        from jev.client import InvalidResponse
        from jev.policy import PolicyDenied
        cases = [(guard.BudgetSpent(), "hook budget spent"), (guard.MalformedInput(CANARY), "malformed input"),
                 (PolicyDenied("budget_calls"), "budget denied"), (InvalidResponse(CANARY), "invalid response"),
                 (JevError("deadline exceeded"), "timeout"), (JevError("HTTP 429"), "HTTP 429"),
                 (JevError("HTTP 429 " + CANARY), "upstream error"), (JevError(CANARY), "upstream error"),
                 (KeyError(CANARY), "missing answer"), (TypeError(CANARY), "malformed answer"),
                 (ValueError(CANARY), "malformed answer"), (AttributeError(CANARY), "malformed answer"),
                 (RuntimeError(CANARY), "internal error"), (OSError(CANARY), "internal error")]
        for error, category in cases:
            with self.subTest(type(error).__name__):
                self.assertEqual(guard.error_category(error), category)

    def test_each_known_client_text_maps_to_its_category(self):
        # The table mirrors client.py's fixed JevError texts; a text the
        # client no longer raises would silently become "upstream error".
        source = (Path(ROOT) / "extensions" / "jev" / "client.py").read_text()
        for text, category in guard._JEV_CATEGORIES.items():
            with self.subTest(text):
                self.assertIn(f'JevError("{text}")', source)
                self.assertEqual(guard.error_category(JevError(text)), category)
                self.assertNotEqual(category, "upstream error")

    def test_usage_keeps_only_plain_non_negative_integers(self):
        self.assertIsNone(guard.safe_usage({"usage": {"input_tokens": True, "output_tokens": -1}}))
        self.assertIsNone(guard.safe_usage({"usage": {"input_tokens": 1.5, "output_tokens": "3"}}))
        self.assertEqual(guard.safe_usage({"usage": {"input_tokens": 2 ** 53, "output_tokens": 2 ** 53 - 1}}),
                         {"output_tokens": 2 ** 53 - 1})
        self.assertEqual(guard.safe_usage({"usage": {"input_tokens": 0, "output_tokens": 4}}),
                         {"input_tokens": 0, "output_tokens": 4})

    def test_a_crash_in_another_hook_reports_only_the_type(self):
        import io
        import jev_ext
        ext = jev_ext.Extension()
        sent, err = [], io.StringIO()
        orig_send, orig_stderr = jev_ext.send, jev_ext.STDERR

        def boom(*a, **kw):
            raise RuntimeError(CANARY)
        ext.hook = boom
        jev_ext.send = sent.append
        jev_ext.STDERR = jev_ext.StderrLog(write=lambda data: err.write(data.decode()) and len(data))
        try:
            jev_ext.dispatch(ext, {"jsonrpc": "2.0", "id": 8, "method": "hook.handle",
                                   "params": {"kind": "after_tool_call", "tool_name": "bash"}})
        finally:
            jev_ext.send, jev_ext.STDERR = orig_send, orig_stderr
        self.assertEqual(sent[0]["error"]["message"], "internal error: RuntimeError")
        self.assertNotIn(CANARY, json.dumps(sent))
        self.assertNotIn(CANARY, err.getvalue())

    def test_a_crashed_guard_confirms_without_echoing_the_exception(self):
        import io
        import jev_ext
        ext = jev_ext.Extension()
        ext.cfg = {"project_root": str(self.ws), "guard_confirm": "prompt"}
        ext.guard_cfg = guard.GuardConfig(ext.cfg)
        ext.client = FakeClient()
        ext.recompute_features()
        sent, err = [], io.StringIO()
        orig_send, orig_handle, orig_stderr = jev_ext.send, jev_ext.guard.handle, jev_ext.STDERR

        def boom(*a, **kw):
            raise RuntimeError(CANARY)
        jev_ext.send, jev_ext.guard.handle = sent.append, boom
        jev_ext.STDERR = jev_ext.StderrLog(write=lambda data: err.write(data.decode()) and len(data))
        try:
            jev_ext.dispatch(ext, {"jsonrpc": "2.0", "id": 7, "method": "hook.handle",
                                   "params": {"kind": "before_tool_call", "tool_name": "bash",
                                              "tool_runtime_name": "bash", "tool_input": {"command": "ls"}}})
        finally:
            jev_ext.send, jev_ext.guard.handle, jev_ext.STDERR = orig_send, orig_handle, orig_stderr
        self.assertEqual(sent[0]["result"]["action"], "confirm")
        self.assertNotIn(CANARY, json.dumps(sent))
        self.assertNotIn(CANARY, err.getvalue())
        self.assertIn("RuntimeError", err.getvalue(), "the log still says what crashed")


class HookBudget(GuardCase):
    """Review r1 #6a: one wall-clock budget covers the whole hook (parse,
    realpath I/O, scan, upstream, audit). When it is spent the answer is
    confirm, so the guard always replies before the host's 5 s deadline."""

    def setUp(self):
        super().setUp()
        self.cfg.budget_s = 0.4

    def assert_budget_confirm(self, r, t0, limit=1.0):
        self.assertEqual(r["action"], "confirm")
        self.assertIn("hook budget spent", r["message"])
        self.assertLess(time.monotonic() - t0, limit)

    def test_default_budget_leaves_room_under_the_host_deadline(self):
        self.assertLessEqual(guard.GuardConfig({}).budget_s, 4.0)
        self.assertGreater(guard.GuardConfig({}).budget_s, 3.0, "room for the 3 s client timeout")
        self.assertLessEqual(guard.HOOK_BUDGET_S + guard.AUDIT_GRACE_S, 4.5,
                             "a confirm's audit row still leaves 0.5 s to reply")
        for key in ("guard_budget_s", "budget_s", "guard_timeout_s", "hook_budget_s", "guard_budget"):
            with self.subTest(key):
                self.assertEqual(guard.GuardConfig({key: "30"}).budget_s, guard.HOOK_BUDGET_S,
                                 "the budget is not configurable: it must stay under the host's 5 s")

    def test_a_blocking_realpath_is_interrupted(self):
        from unittest import mock
        real = os.path.realpath

        def stuck(path, *a, **kw):
            time.sleep(5)  # a hung filesystem
            return real(path, *a, **kw)
        client = FakeClient()
        t0 = time.monotonic()
        with mock.patch("os.path.realpath", stuck):
            r = self.run_guard("multi_edit", {"edits": [{"path": "a.txt", "op": "append", "text": "x"}]}, client)
        self.assert_budget_confirm(r, t0)
        self.assertEqual(client.calls, [])

    def test_many_slow_paths_stop_at_the_budget(self):
        from unittest import mock
        real, seen = os.path.realpath, []

        def slow(path, *a, **kw):
            seen.append(path)
            time.sleep(0.1)
            return real(path, *a, **kw)
        t0 = time.monotonic()
        with mock.patch("os.path.realpath", slow):
            r = self.run_guard("multi_edit", {"edits": [{"path": f"f{i}.txt", "op": "append", "text": "x"}
                                                        for i in range(16)]}, FakeClient())
        self.assert_budget_confirm(r, t0)
        self.assertLess(len(seen), 16)

    def test_a_blocking_scan_is_interrupted(self):
        from unittest import mock

        def stuck(text):
            time.sleep(5)
            return []
        client = FakeClient()
        t0 = time.monotonic()
        with mock.patch.object(guard, "scan_secrets", stuck):
            r = self.run_guard("send_events", {"source": "v", "messages": [{"session": "s", "body": "hi"}]}, client)
        self.assert_budget_confirm(r, t0)
        self.assertEqual(client.calls, [])

    def test_the_client_gets_what_is_left_of_the_budget(self):
        for tool, inp in Sanitized.CALLS.items():
            with self.subTest(tool):
                client = FakeClient()
                t0 = time.monotonic()
                r = self.run_guard(tool, inp, client)
                self.assertEqual(r["action"], "continue")
                deadline = client.kwargs[0]["deadline"]
                self.assertGreater(deadline, t0)
                self.assertLessEqual(deadline, t0 + self.cfg.budget_s - guard.REPLY_MARGIN_S + 0.05)

    def test_an_answer_after_the_budget_confirms(self):
        class Late(FakeClient):
            def decide(self, *a, **kw):
                time.sleep(0.5)
                return super().decide(*a, **kw)
        for tool, inp in Sanitized.CALLS.items():
            with self.subTest(tool):
                t0 = time.monotonic()
                r = self.run_guard(tool, inp, Late())
                self.assert_budget_confirm(r, t0)

    def test_a_budget_spent_before_the_hook_runs_confirms_without_a_call(self):
        # A frame that waited in the inbound queue: the host's clock started
        # when it was sent, not when the guard got to it.
        for tool, inp in Sanitized.CALLS.items():
            with self.subTest(tool):
                client = FakeClient()
                params = {"kind": "before_tool_call", "tool_name": tool, "tool_runtime_name": tool,
                          "tool_input": inp, "cwd": str(self.ws)}
                t0 = time.monotonic()
                r = guard.handle(params, client, self.cfg, self.audit, self.logs.append, started=t0 - 10)
                self.assert_budget_confirm(r, t0)
                self.assertEqual(client.calls, [])
        self.assertEqual(self.audit.counters.get("guard.budget"), 3)

    def test_signal_state_is_restored(self):
        # A sentinel of our own: an earlier test cannot leave the "before"
        # state looking like the guard's own handler.
        import signal
        sentinel = lambda *a: None  # noqa: E731
        previous = signal.signal(signal.SIGALRM, sentinel)
        try:
            for tool, inp in Sanitized.CALLS.items():
                with self.subTest(tool):
                    self.assertEqual(self.run_guard(tool, inp, FakeClient())["action"], "continue")
                    self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
                    self.assertIs(signal.getsignal(signal.SIGALRM), sentinel)
        finally:
            signal.signal(signal.SIGALRM, previous)

    def test_the_extension_starts_the_clock_at_receipt(self):
        import jev_ext
        ext = jev_ext.Extension()
        ext.cfg = {"project_root": str(self.ws), "guard_confirm": "prompt"}
        ext.guard_cfg = guard.GuardConfig(ext.cfg)
        ext.client = FakeClient()
        ext.recompute_features()
        sent, orig = [], jev_ext.send
        jev_ext.send = sent.append
        try:
            jev_ext.dispatch(ext, {"jsonrpc": "2.0", "id": 1, "method": "hook.handle",
                                   "params": {"kind": "before_tool_call", "tool_name": "bash",
                                              "tool_runtime_name": "bash", "tool_input": {"command": "ls"}}},
                             received=time.monotonic() - 10)
        finally:
            jev_ext.send = orig
        self.assertEqual(sent[0]["result"]["action"], "confirm")
        self.assertIn("hook budget spent", sent[0]["result"]["message"])
        self.assertEqual(ext.client.calls, [])

    # ── mutation coverage for the budget rules ──

    def in_thread(self, fn):
        """Signal timers are main-thread only: run `fn` where they are not used."""
        import threading
        out = {}
        worker = threading.Thread(target=lambda: out.update(r=fn()))
        worker.start()
        worker.join(10)
        return out["r"]

    def without_a_timer(self, run):
        """Review r2 R2-3(a): where the hard timer cannot be armed, every
        guarded tool confirms at once (guard.budget), before any local work
        that could block: no realpath, no scan, no audit write, no call."""
        from unittest import mock
        touched = []

        def stuck(name):
            def blocked(*a, **kw):
                touched.append(name)
                time.sleep(5.2)
                return []
            return blocked
        for tool, inp in Sanitized.CALLS.items():
            with self.subTest(tool):
                self.audit = audit_mod.Audit(str(self.root / f"audit-{tool}.jsonl"))
                client = FakeClient()
                t0 = time.monotonic()
                with mock.patch("os.path.realpath", stuck("realpath")), \
                        mock.patch.object(guard, "scan_secrets", stuck("scan")), \
                        mock.patch.object(self.audit, "write", stuck("audit")):
                    r = run(lambda: self.run_guard(tool, inp, client))
                self.assertLess(time.monotonic() - t0, 0.5)
                self.assertEqual(r["action"], "confirm")
                self.assertIn("(deadline unavailable)", r["message"])
                self.assertEqual(client.calls, [])
                self.assertEqual(touched, [])
                self.assertEqual(self.audit.counters.get("guard.budget"), 1)
                self.assertEqual(self.audit.counters.get("guard.audit_skipped"), 1)

    def test_off_the_main_thread_every_tool_confirms_at_once(self):
        self.without_a_timer(self.in_thread)

    def test_without_interval_timers_every_tool_confirms_at_once(self):
        # A platform without signal.setitimer (Windows).
        import types
        from unittest import mock
        with mock.patch.object(guard, "signal", types.SimpleNamespace()):
            self.without_a_timer(lambda fn: fn())

    def test_with_an_interval_timer_already_armed_every_tool_confirms_at_once(self):
        # Someone else's timer is left exactly as it was.
        import signal
        theirs = lambda *a: None  # noqa: E731
        previous = signal.signal(signal.SIGALRM, theirs)
        signal.setitimer(signal.ITIMER_REAL, 100)
        try:
            self.without_a_timer(lambda fn: fn())
            self.assertGreater(signal.getitimer(signal.ITIMER_REAL)[0], 90)
            self.assertIs(signal.getsignal(signal.SIGALRM), theirs)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)

    def test_a_budget_alarm_that_cannot_arm_refuses_to_start(self):
        import signal
        import types
        from unittest import mock

        def enter():
            try:
                with guard.BudgetAlarm(time.monotonic() + 1):
                    return "entered"
            except guard.BudgetSpent as e:
                return guard.error_category(e)
        self.assertEqual(enter(), "entered")
        self.assertEqual(self.in_thread(enter), "deadline unavailable")
        with mock.patch.object(guard, "signal", types.SimpleNamespace()):
            self.assertEqual(enter(), "deadline unavailable")
        previous = signal.signal(signal.SIGALRM, lambda *a: None)
        signal.setitimer(signal.ITIMER_REAL, 100)
        try:
            self.assertEqual(enter(), "deadline unavailable")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)

    def test_local_work_into_the_reply_margin_confirms_without_a_call(self):
        # Past budget − margin but before the budget: no time left to ask.
        # The guard's clock is injected (guard.time is replaced for this
        # test only), so the slow local work moves the clock instead of
        # sleeping and the result does not depend on machine load.
        from types import SimpleNamespace
        from unittest import mock
        real = guard.summarize_call
        now = [1000.0]

        def slow(*a, **kw):
            now[0] += self.cfg.budget_s - guard.REPLY_MARGIN_S + 0.05
            return real(*a, **kw)
        self.assertGreaterEqual(guard.REPLY_MARGIN_S, 0.1)
        client = FakeClient()
        clock = SimpleNamespace(monotonic=lambda: now[0])
        with mock.patch.object(guard, "time", clock), mock.patch.object(guard, "summarize_call", slow):
            r = self.run_guard("bash", {"command": "ls"}, client)
        self.assertEqual(r["action"], "confirm")
        self.assertIn("hook budget spent", r["message"])
        self.assertEqual(client.calls, [])
        self.assertEqual(self.audit.counters.get("guard.budget"), 1)

    def test_local_work_into_the_reply_margin_confirms_on_the_wall_clock(self):
        # The same on the real clock, as a smoke test: a loose bound (under
        # the host's 5 s deadline), since the sleep itself is the slow part.
        from unittest import mock
        real = guard.summarize_call

        def slow(*a, **kw):
            time.sleep(self.cfg.budget_s - guard.REPLY_MARGIN_S + 0.05)
            return real(*a, **kw)
        client = FakeClient()
        t0 = time.monotonic()
        with mock.patch.object(guard, "summarize_call", slow):
            r = self.run_guard("bash", {"command": "ls"}, client)
        self.assert_budget_confirm(r, t0, limit=3.0)
        self.assertEqual(client.calls, [])

    def test_a_hung_audit_write_confirms_and_is_counted(self):
        from unittest import mock
        for tool, inp in Sanitized.CALLS.items():
            with self.subTest(tool):
                self.audit = audit_mod.Audit(str(self.root / f"audit-{tool}.jsonl"))
                t0 = time.monotonic()
                with mock.patch.object(self.audit, "write", lambda row: time.sleep(5)):
                    r = self.run_guard(tool, inp, FakeClient())
                self.assert_budget_confirm(r, t0, limit=self.cfg.budget_s + guard.AUDIT_GRACE_S + 0.3)
                self.assertEqual(self.audit.counters.get("guard.budget"), 1)
                self.assertEqual(self.audit.counters.get("guard.audit_skipped"), 1)
                self.assertNotIn("guard.continue", self.audit.counters)

    def test_a_late_confirm_still_gets_its_audit_row(self):
        class Late(FakeClient):
            def decide(self, *a, **kw):
                time.sleep(0.5)
                return super().decide(*a, **kw)
        for tool, inp in Sanitized.CALLS.items():
            with self.subTest(tool):
                self.audit_path = self.root / f"late-{tool}.jsonl"
                self.audit = audit_mod.Audit(str(self.audit_path))
                self.assertEqual(self.run_guard(tool, inp, Late())["action"], "confirm")
                rows = [json.loads(line) for line in self.audit_text().splitlines()]
                self.assertEqual([(row["action"], row.get("error")) for row in rows],
                                 [("confirm", "hook budget spent")])
                self.assertNotIn("guard.audit_skipped", self.audit.counters)

    def test_main_stamps_each_frame_when_it_is_read(self):
        import jev_ext
        from unittest import mock
        queued = ({"jsonrpc": "2.0", "id": 2, "method": "info.get"}, time.monotonic() - 7)
        frames = iter([{"jsonrpc": "2.0", "id": 1, "method": "info.get"}, None])
        reads, seen = [], []

        def read():
            reads.append(time.monotonic())
            return next(frames)

        def dispatch(ext, req, received=None):
            seen.append((req["id"], received))
            return True
        with mock.patch.object(jev_ext, "Extension", lambda: None), \
                mock.patch.object(jev_ext, "read_frame", read), \
                mock.patch.object(jev_ext, "dispatch", dispatch), \
                mock.patch.object(jev_ext, "_pending_inbound", [queued]), \
                mock.patch.object(jev_ext, "STDERR", jev_ext.StderrLog(write=len)):
            jev_ext.main()
        self.assertEqual(seen[0], (2, queued[1]), "a queued frame keeps its receipt time")
        self.assertEqual(seen[1][0], 1)
        self.assertIsInstance(seen[1][1], float)
        self.assertLessEqual(reads[0], seen[1][1])
        self.assertLess(seen[1][1], reads[0] + 0.05)

    def test_frames_queued_during_a_host_call_keep_their_receipt_time(self):
        import itertools
        import jev_ext
        from unittest import mock
        inbound = {"jsonrpc": "2.0", "id": 9, "method": "hook.handle", "params": {}}
        frames = iter([inbound, {"jsonrpc": "2.0", "id": "ext-500", "result": "ok"}])
        pending = []
        t0 = time.monotonic()
        with mock.patch.object(jev_ext, "_ids", itertools.count(500)), \
                mock.patch.object(jev_ext, "send", lambda frame: None), \
                mock.patch.object(jev_ext, "read_frame", lambda: next(frames)), \
                mock.patch.object(jev_ext, "_pending_inbound", pending):
            self.assertEqual(jev_ext.host_call("x.y", {}), "ok")
        self.assertEqual(len(pending), 1)
        frame, received = pending[0]
        self.assertIs(frame, inbound)
        self.assertIsInstance(received, float)
        self.assertLessEqual(t0, received)
        self.assertLess(received, time.monotonic())


class ClientDeadline(unittest.TestCase):
    """DecisionClient.decide honours the caller's absolute deadline."""

    def client(self):
        from jev.client import DecisionClient
        c = DecisionClient("test-key-not-real", timeout_s=3.0)
        c.posted = []

        def post(body, *, timeout_s):
            c.posted.append(timeout_s)
            return {"answers": {}, "usage": {"input_tokens": 1}}
        c._post = post
        return c

    def test_remaining_time_is_capped_by_the_deadline(self):
        c = self.client()
        c.decide({"x": 1}, {}, op="guard", deadline=time.monotonic() + 0.5)
        self.assertLessEqual(c.posted[0], 0.5)

    def test_without_a_deadline_the_client_timeout_applies(self):
        c = self.client()
        c.decide({"x": 1}, {}, op="guard")
        self.assertGreater(c.posted[0], 2.5)

    def test_a_passed_deadline_never_posts(self):
        c = self.client()
        with self.assertRaises(JevError):
            c.decide({"x": 1}, {}, op="guard", deadline=time.monotonic() - 0.1)
        self.assertEqual(c.posted, [])

    def test_a_nan_deadline_keeps_the_client_timeout(self):
        c = self.client()
        c.decide({"x": 1}, {}, op="guard", deadline=float("nan"))
        self.assertGreater(c.posted[0], 2.5)
        self.assertLessEqual(c.posted[0], 3.0)


# ── wiring ──────────────────────────────────────────────────────────────────

class Wiring(unittest.TestCase):
    def manifest(self):
        return json.loads((Path(ROOT) / ".synaps-plugin" / "plugin.json").read_text())

    def test_default_tool_list_covers_new_builtins(self):
        tools = guard.GuardConfig({}).tools
        self.assertTrue({"bash", "write", "edit", "read", "multi_edit", "send_events"} <= tools)

    def test_manifest_subscribes_and_defaults_match(self):
        ext = self.manifest()["extension"]
        hooked = {h.get("tool") for h in ext["hooks"] if h["hook"] == "before_tool_call"}
        for tool in guard.GuardConfig({}).tools:
            with self.subTest(tool):
                self.assertIn(tool, hooked, "a guarded tool without a hook entry is never seen")
        default = next(c["default"] for c in ext["config"] if c["key"] == "guard_tools")
        self.assertEqual({t.strip() for t in default.split(",")}, guard.GuardConfig({}).tools)

    def test_extension_routes_new_tools_to_the_guard(self):
        import jev_ext
        ext = jev_ext.Extension()
        ext.cfg = {"project_root": tempfile.gettempdir(), "guard_confirm": "prompt"}
        ext.guard_cfg = guard.GuardConfig(ext.cfg)
        ext.client = FakeClient({"leak_0": noul(0.9)})
        ext.recompute_features()
        self.assertTrue(ext.features["guard"])
        r = ext._hook({"kind": "before_tool_call", "tool_runtime_name": "send_events",
                       "tool_input": {"source": "worker-v", "messages": [{"session": "s", "body": "b"}]}})
        self.assertEqual(r["action"], "confirm")
        self.assertEqual(set(ext.client.calls[0][1]), {"leak_0"})
        ext.client = FakeClient()
        r = ext._hook({"kind": "before_tool_call", "tool_runtime_name": "multi_edit", "cwd": tempfile.gettempdir(),
                       "tool_input": {"edits": [{"path": "a", "op": "append", "text": "x"}]}})
        self.assertEqual(r["action"], "continue")
        self.assertEqual(set(ext.client.calls[0][1]), {"risk_0", "leak_0", "leaves_workspace_0"})



class MalformedAnswers(GuardCase):
    """A non-finite or out-of-range answer is malformed upstream output: it
    must confirm. (json.loads accepts NaN/Infinity, and NaN compares false
    against every threshold, so without a check it would continue.)"""

    BAD = {
        "risk NaN": {"risk": score(float("nan"), 0.95)},
        "risk +inf": {"risk": score(float("inf"), 0.95)},
        "risk below 0": {"risk": score(-1.0, 0.95)},
        "risk above 3": {"risk": score(4.0, 0.95)},
        "confidence NaN": {"risk": score(0.1, float("nan"))},
        "confidence above 1": {"risk": score(0.1, 1.5)},
        "secrets NaN": {"leak": noul(float("nan"))},
        "secrets below 0": {"leak": noul(-0.2)},
        "escape NaN": {"leaves_workspace": noul(float("nan"))},
        "escape above 1": {"leaves_workspace": noul(1.2)},
        "risk 10**400": {"risk": score(10 ** 400, 0.95)},
        "confidence 10**400": {"risk": score(0.1, 10 ** 400)},
        "secrets 10**400": {"leak": noul(10 ** 400)},
        "escape 10**400": {"leaves_workspace": noul(10 ** 400)},
    }

    def test_decide_rejects_malformed_numbers(self):
        for name, override in self.BAD.items():
            with self.subTest(name):
                with self.assertRaises(ValueError):
                    guard.decide({**SAFE, **override}, self.cfg)

    def test_bash_and_multi_edit_confirm_on_malformed_numbers(self):
        for name, override in self.BAD.items():
            with self.subTest(name):
                r = self.run_guard("bash", {"command": "ls"}, FakeClient(override))
                self.assertEqual(r["action"], "confirm")
                per_file = {f"{k}_1": v for k, v in override.items()}
                r = self.run_guard("multi_edit", {"edits": [{"path": "a", "op": "append", "text": "x"},
                                                            {"path": "b", "op": "append", "text": "x"}]},
                                   FakeClient(per_file))
                self.assertEqual(r["action"], "confirm")
                self.assertIn("could not evaluate", r["message"])

    def test_send_events_confirms_on_malformed_numbers(self):
        for p in (float("nan"), -0.1, 1.1, 10 ** 400):
            with self.subTest(repr(p)[:12]):
                r = self.run_guard("send_events", {"source": "worker-v", "messages": [{"session": "s", "body": "b"}]},
                                   FakeClient({"leak_0": noul(p)}))
                self.assertEqual(r["action"], "confirm")
                self.assertIn("(malformed answer)", r["message"])

    def test_an_overflowing_number_is_a_malformed_answer(self):
        # Review r2 R2-2: the fixed category, not "internal error".
        for name, override in self.BAD.items():
            with self.subTest(name):
                r = self.run_guard("bash", {"command": "ls"}, FakeClient(override))
                self.assertEqual(r["action"], "confirm")
                self.assertIn("(malformed answer)", r["message"])
        self.assertEqual(guard.error_category(OverflowError()), "malformed answer")
        self.assertEqual(guard.error_category(ZeroDivisionError()), "malformed answer")

    def test_an_index_or_lookup_failure_is_a_malformed_answer(self):
        # Review r2 R2-2: probabilities as a list made top_level raise
        # IndexError; it is the fixed category, not "internal error".
        bad = {**score(3, 0.99), "probabilities": [5, 0]}
        r = self.run_guard("bash", {"command": "ls"}, FakeClient({"risk": bad}))
        self.assertEqual(r["action"], "confirm")
        self.assertIn("(malformed answer)", r["message"])
        self.assertEqual(guard.error_category(IndexError()), "malformed answer")
        self.assertEqual(guard.error_category(LookupError()), "malformed answer")
        self.assertEqual(guard.error_category(KeyError("risk")), "missing answer")

    def test_float_rounding_at_the_edges_still_counts_as_valid(self):
        r, _ = guard.decide({"risk": score(0.0, 1.0 + 1e-12), "leak": noul(-1e-12),
                             "leaves_workspace": noul(0.0)}, self.cfg)
        self.assertEqual(r["action"], "continue")


if __name__ == "__main__":
    unittest.main()
