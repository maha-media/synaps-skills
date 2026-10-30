#!/usr/bin/env python3
"""Every op's outbound request, as actually built, through the app-equivalent
scan (the mirrored lib.rs check of test_guard_redact). relay_redact is THE
outbound redactor of every op on both transports (relay and direct): state
values, caller questions and every key built from caller or tool text. A
request it cannot make clean is Jev-off for that call (fail closed, no
retry, counted `<op>.unclean`); nothing unredacted is sent. A fake app
stands in for the Pria desktop; nothing goes to the network.

    TMPDIR=/var/tmp PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest test_ops_redact -v   (from tests/)
"""
from __future__ import annotations

import json
import os
import re
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "extensions"))
import jev_test_home  # noqa: F401,E402  (keeps the suite out of the real Allow-once store and Pria dir)
sys.path.insert(0, HERE)

from jev import audit as audit_mod, commands, compress, context, discovery, guard  # noqa: E402
from jev import relay_redact as rr, reports, router, tools, verify  # noqa: E402
from jev.client import DecisionClient  # noqa: E402
from test_guard_redact import JWT, PEM, PEM_BODY, Q_SECRETS, answer_all, app_views, findings  # noqa: E402
from test_relay import RelayCase, refuse  # noqa: E402

# The brief's inputs: the live false positives and real credentials.
SK_ANT = "sk-ant-fixture0123456789abcdefABCDEF"
PEM_LINE = "-----BEGIN PRIVATE KEY----- " + PEM_BODY + " -----END PRIVATE KEY-----"
MAX_TOKENS = '"max_tokens": 4096'
BUDGET = "token_budget: 5"
AUTH = "--auth x"
SIG = "https://h.example/p?sig=abc"
A = f"config {{{MAX_TOKENS}}} {BUDGET} run {AUTH} fetch {SIG}"
B = f"key {SK_ANT} {PEM_LINE} jwt {JWT}"
LINE = A + " " + B  # one line: for fields that refuse control characters
TEXT = "\n".join((f"config {{{MAX_TOKENS}, \"temperature\": 0}}", BUDGET, f"run tool {AUTH} --verbose",
                  f"fetch {SIG}&x=1", f"key {SK_ANT}", PEM, f"jwt {JWT}", "done"))
# No decoded string or key of a request may hold any of these.
FRAGMENTS = (SK_ANT[7:19], PEM_BODY[:11], JWT.split(".")[0], JWT.split(".")[2], "sig=abc", AUTH, BUDGET, MAX_TOKENS)
OPS = ("guard", "router", "triage", "discovery", "reports", "compress", "context", "jev_decide", "jev_select",
       "jev_verify", "jev_evidence", "jev_diagnose")
UNCLEAN_COUNTERS = ("router", "triage", "discovery", "reports", "compress", "context", "decide", "select",
                    "verification", "evidence", "diagnose")
PLACEHOLDERS = (rr.REDACTED, rr.REDACTED_PRIVATE_KEY)


def answer(questions: dict) -> dict:
    """Generic well-typed answers (choices at low confidence: no advice)."""
    out = answer_all({k: q for k, q in questions.items() if q.get("type") != "choice"})
    for k, q in questions.items():
        if q.get("type") == "choice":
            last = list(q["criteria"])[-1]
            out[k] = {"type": "choice", "choice": last, "confidence": 0.5, "probabilities": {last: 0.5}}
    return out


def strings(v):
    """Every decoded string and key."""
    if isinstance(v, dict):
        for k, x in v.items():
            yield k
            yield from strings(x)
    elif isinstance(v, list):
        for x in v:
            yield from strings(x)
    elif isinstance(v, str):
        yield v


def blank(v):
    """The request with every caller/tool string empty: only fixed keys and templates remain."""
    if isinstance(v, dict):
        return {k: blank(x) for k, x in v.items()}
    if isinstance(v, list):
        return [blank(x) for x in v]
    return "" if isinstance(v, str) else v


def cut_placeholder(s: str) -> bool:
    return any(s.endswith(p[:i]) for p in PLACEHOLDERS for i in range(1, len(p)))


class Drive:
    """One call of every op, each building exactly one request from the brief's inputs."""

    def calls(self):
        after = {"kind": "after_tool_call", "session_id": "sess-1"}
        catalog = {"generation": 1, "truncated": False, "tools": [
            {"id": "alpha", "summary": A, "tags": [], "source_class": "builtin", "schema_digest": "abc"},
            {"id": "beta", "summary": B, "tags": [], "source_class": "plugin", "schema_digest": "d"}]}
        report = {"handle_id": "sa_1", "status": "completed", "output": TEXT, "model": "m",
                  "terminal_cause": {"reason": "done"}, "authorization": {"allowed": True}, "collected": False}
        checks = [{"id": "unit", "description": A, "required": False},
                  {"id": "lint", "description": B, "required": False}]
        pressure = {"kind": context.KIND, "message": TEXT, "session_id": "sess-1",
                    "data": {"content_block_count": 1, "has_tool_use": False,
                             "context_management": {"enabled": True, "band": "pressure", "phase": "execute"}}}

        def hook(params):
            return lambda ext: ext.hook(params)

        def tool(name, inp):
            def run(ext):
                try:
                    return ext.tool_call({"name": name, "input": inp})
                except tools.ToolError as e:
                    return e
            return run

        def ctx(ext):
            ext.hook({"kind": "before_message", "message": TEXT, "session_id": "sess-1"})
            return ext.hook(pressure)

        return {
            "guard": hook({"kind": "before_tool_call", "tool_name": "bash", "tool_runtime_name": "bash",
                           "tool_input": {"command": "echo " + LINE}, "session_id": "sess-1", "cwd": str(self.ws)}),
            "router": hook({"kind": "before_tool_call", "tool_name": "subagent_start",
                            "tool_runtime_name": "subagent_start", "session_id": "sess-1",
                            "tool_input": {"task": TEXT, "system_prompt": LINE}}),
            "triage": hook(dict(after, tool_name="bash", tool_input={"command": "./deploy.sh"},
                                tool_output="Command failed (exit 2):\n" + TEXT + "\nmake: *** [all] Error 2\n")),
            "discovery": hook(dict(after, tool_name="search_tools", tool_input={"query": LINE},
                                   tool_output=json.dumps(catalog))),
            "reports": hook(dict(after, tool_name="subagent_collect", tool_input={"handle_id": "sa_1"},
                                 tool_output=json.dumps(report))),
            "compress": hook(dict(after, tool_name="bash", tool_input={"command": "ls"},
                                  tool_output="routine progress\n" * 600 + TEXT + "\n")),
            "context": ctx,
            "jev_decide": tool("jev_decide", {
                "state": {"note": TEXT, "config": {"max_tokens": 4096, "api_key": SK_ANT}},
                "questions": {"risky": {"type": "noul", "instructions": "Is `note` risky? " + LINE},
                              "pick": {"type": "choice", "instructions": "Pick one for `config`.",
                                       "criteria": {"a": A, "b": B}}}}),
            "jev_select": tool("jev_select", {"context": TEXT, "decisions": [
                {"instruction": "Pick for " + A,
                 "candidates": [{"id": "a", "description": A}, {"id": "b", "description": B}]}]}),
            "jev_verify": tool("jev_verify", {"task": TEXT, "changes": [A, B], "checks": checks}),
            "jev_evidence": tool("jev_evidence", {"task": TEXT, "candidates": [
                {"id": "e1", "kind": "file", "source": A, "summary": B, "required": False},
                {"id": "e2", "kind": "other", "source": "notes", "summary": TEXT, "required": False}]}),
            "jev_diagnose": tool("jev_diagnose", {"task": TEXT, "evidence": TEXT, "checks": checks,
                                                  "hypotheses": [{"id": "h1", "description": A},
                                                                 {"id": "h2", "description": B}]}),
        }

    def ext(self, **cfg):
        return self.extension(compress=True, discovery=True, reports=True, verification=True, evidence=True,
                              diagnosis=True, router_models="small=acme/s1,medium=acme/m1", **cfg)

    def assert_clean(self, name, line, args):
        for view in app_views(line, args):
            self.assertEqual(findings(view), [], (name, view[:300]))
        for s in strings(args):
            for fragment in FRAGMENTS:
                self.assertNotIn(fragment, s, name)
        for fragment in FRAGMENTS[:-1]:
            self.assertNotIn(fragment, line, name)
        self.assertIsNone(re.search(r"max_tokens\W*4096", line), name)
        self.assertIn(rr.REDACTED, line, name)  # the input was sent, redacted, not dropped
        self.assertIn(rr.REDACTED_PRIVATE_KEY if name != "jev_decide" else rr.REDACTED, line, name)

    def assert_templates_clean(self, name, args):
        # jev_decide/jev_select: the whole state (its keys too) is the caller's
        state = "" if name in ("jev_decide", "jev_select") else blank(args["state"])
        for view in rr.views(state, args["questions"]):
            self.assertEqual(findings(view), [], (name, view[:300]))

    def assert_audit_clean(self):
        text = self.audit_path.read_text() if self.audit_path.exists() else ""
        for fragment in FRAGMENTS:
            self.assertNotIn(fragment, text)
        self.assertIsNone(re.search(r"max_tokens\W*4096", text))
        return text


class Relay(Drive, RelayCase):
    def app(self):
        box = {}

        def reply(req):
            line = box["server"].lines[-1].decode("ascii")
            if any(findings(view) for view in app_views(line, req["args"])):
                return refuse("secret_in_state")(req)
            return {"id": req["id"], "ok": True,
                    "result": {"model": "jev-fixture", "answers": answer(req["args"]["questions"])}}
        box["server"] = server = self.serve(reply=reply)
        return server

    def test_every_op_request_as_built_is_clean_in_every_view_the_app_scans(self):
        server = self.app()
        ext = self.ext(transport="relay")
        calls = self.calls()
        self.assertEqual(tuple(calls), OPS)
        for name, run in calls.items():
            with self.subTest(op=name):
                before = len(server.requests)
                result = run(ext)
                self.assertNotIsInstance(result, tools.ToolError, name)
                self.assertEqual(len(server.requests), before + 1, (name, ext.audit.counters))
                self.assert_clean(name, server.lines[-1].decode("ascii"), server.requests[-1]["args"])
                self.assert_templates_clean(name, server.requests[-1]["args"])
        c = ext.audit.counters
        self.assertNotIn("relay.secret_in_state", c)
        self.assertEqual([k for k in c if k.endswith(".unclean")], [])
        self.assertEqual(c.get("relay.ok"), len(OPS))
        self.assertIn(rr.REDACTED, self.assert_audit_clean())  # the guard's row: the redacted form only

    def test_fixed_keys_and_templates_are_clean_with_empty_input(self):
        class Capture:
            model = "m"

            def __init__(self):
                self.calls = []

            def decide(self, state, questions, *, op="decide", deadline=None):
                self.calls.append((state, questions))
                return {"answers": {}}

        cap = Capture()
        commands.probe(cap)
        commands._test_decision(cap)
        templates = cap.calls + [
            ({}, router.questions({}, router.RouterConfig({"router_models": "small=acme/s1,medium=acme/m1"}))),
            ({}, compress.questions()),
            ({}, discovery.question([f"option_{i}" for i in range(16)])),
            ({}, {context.QUESTION: {"type": "choice", "criteria": context.CRITERIA,
                                     "instructions": context.INSTRUCTIONS}}),
            ({}, {q: {"type": "choice", "criteria": c, "instructions": ""} for q, c in reports.CRITERIA.items()}),
            ({}, guard.QUESTIONS), ({}, guard.multi_edit_questions(guard.MULTI_EDIT_MAX_FILES)),
            ({}, guard.send_events_questions(16)),
            ({}, {"0": {"type": "choice", "instructions": "", "criteria": {"": "", tools.ABSTAIN: ""}}})]
        for state, questions in templates:
            for view in rr.views(state, questions):
                self.assertEqual(findings(view), [], view[:300])

    def test_unclean_is_jev_off_for_the_call_counted_and_nothing_is_sent(self):
        server = self.app()
        ext = self.ext(transport="relay")
        out = {}
        with mock.patch.object(rr, "redact_request", side_effect=rr.Unclean("fixture")):
            for name, run in self.calls().items():
                if name != "guard":  # the guard's own path: test_guard_redact
                    out[name] = run(ext)
        server.idle()
        self.assertEqual(server.connections, 0)
        c = ext.audit.counters
        for op in UNCLEAN_COUNTERS:
            self.assertEqual(c.get(f"{op}.unclean"), 1, (op, c))
            self.assertGreaterEqual(c.get(f"{op}.skip", 0), 1, op)
        for name in ("jev_decide", "jev_select"):
            self.assertIsInstance(out[name], tools.ToolError, name)
            self.assertIn(tools.UNCLEAN, str(out[name]))
            self.assertNotIn(SK_ANT[7:19], str(out[name]))
        for name in ("jev_verify", "jev_evidence"):
            self.assertEqual(json.loads(out[name]["content"])["fallback_reason"], verify.UNCLEAN, name)
        self.assertEqual(json.loads(out["jev_diagnose"]["content"])["fallback_reason"], "unclean")
        for name in ("router", "triage", "discovery", "reports", "compress", "context"):
            self.assertEqual(out[name], {"action": "continue"}, name)
        reasons = [r["reason"] for r in ext.audit.explanations()]
        self.assertIn("unclean", reasons)
        self.assertIn("unclean", audit_mod.GLOSS)
        self.assertTrue(all(r in audit_mod.GLOSS for r in reasons))
        for component in (ext.router, ext.triage, ext.discovery, ext.reports):
            self.assertEqual(len(component.cache), 0)
        self.assert_audit_clean()

    def test_a_finding_in_a_caller_criteria_key_or_candidate_id_is_unclean(self):
        server = self.app()
        ext = self.ext(transport="relay")
        for name, inp in (
                ("jev_decide", {"state": {"a": 1}, "questions": {"pick": {
                    "type": "choice", "instructions": "Pick.", "criteria": {"api_key=" + "Q" * 20: "x", "b": "y"}}}}),
                ("jev_select", {"context": "pick", "decisions": [{"instruction": "pick one", "candidates": [
                    {"id": "token=" + "Q" * 20, "description": "A"}, {"id": "b", "description": "B"}]}]})):
            with self.subTest(name=name), self.assertRaises(tools.ToolError) as cm:
                ext.tool_call({"name": name, "input": inp})
            self.assertIn(tools.UNCLEAN, str(cm.exception))
            self.assertNotIn("Q" * 20, str(cm.exception))
        c = ext.audit.counters
        self.assertEqual((c.get("decide.unclean"), c.get("select.unclean")), (1, 1))
        server.idle()
        self.assertEqual(server.connections, 0)

    def test_a_caller_question_key_with_a_finding_is_sent_renamed_and_answered_under_its_own(self):
        server = self.app()
        ext = self.ext(transport="relay")
        out = json.loads(ext.tool_call({"name": "jev_decide", "input": {
            "state": {"note": "x"}, "questions": {"touches_secrets": {"type": "noul", "instructions": "Leak?"},
                                                  "q0": {"type": "noul", "instructions": "Other?"}}}})["content"])
        server.idle()
        args = server.requests[-1]["args"]
        self.assertEqual(sorted(args["questions"]), ["q0", "q1"])
        self.assertEqual(args["questions"]["q1"]["instructions"], "Leak?")
        self.assertEqual(sorted(out["answers"]), ["q0", "touches_secrets"])
        for view in app_views(server.lines[-1].decode("ascii"), args):
            self.assertEqual(findings(view), [], view)


class Direct(Drive, RelayCase):
    def test_every_op_request_as_built_is_clean_on_the_direct_transport_too(self):
        sent = []

        def fake(client, state, questions, *, op="decide", deadline=None):
            sent.append((state, questions))
            return {"model": "jev-fixture", "answers": answer(questions)}

        ext = self.ext(transport="direct", api_key="apikey_" + "k" * 30)
        self.assertIsInstance(ext.client, DecisionClient)
        with mock.patch.object(DecisionClient, "decide", new=fake):
            for name, run in self.calls().items():
                with self.subTest(op=name):
                    before = len(sent)
                    self.assertNotIsInstance(run(ext), tools.ToolError, name)
                    self.assertEqual(len(sent), before + 1, (name, ext.audit.counters))
                    args = {"state": sent[-1][0], "questions": sent[-1][1]}
                    self.assert_clean(name, json.dumps(args), args)
                    self.assert_templates_clean(name, args)
        self.assertEqual([k for k in ext.audit.counters if k.endswith(".unclean")], [])
        self.assertIn(rr.REDACTED, self.assert_audit_clean())


class BoundedText(unittest.TestCase):
    """context.bounded_text: redacted first, then cut (never inside a
    placeholder, never a credential cut to a fragment the app misses)."""

    def test_redact_then_cut(self):
        head = context.TRUNCATED.split("{")[0]
        for secret in Q_SECRETS:
            for limit in (200, 400):
                for k in range(limit - 70, limit + 1):
                    text = "a" * k + " " + secret + " tail"
                    with self.subTest(secret=secret[:10], limit=limit, k=k):
                        out = context.bounded_text(text, limit)
                        self.assertNotIn("Q", out)
                        self.assertEqual(findings(out), [], out[-60:])  # the notice included
                        kept, sep, _ = out.partition(head)
                        redacted = rr.redact_string(text, None)
                        self.assertEqual(bool(sep), len(redacted) > limit)
                        if not sep:
                            self.assertEqual(out, redacted)
                        self.assertLessEqual(len(kept), limit)
                        self.assertFalse(cut_placeholder(kept), kept[-30:])
        self.assertEqual(context.bounded_text("short " + SK_ANT, 400), "short " + rr.REDACTED)


if __name__ == "__main__":
    unittest.main()
