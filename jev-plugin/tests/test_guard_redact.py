#!/usr/bin/env python3
"""The guard's state is redacted the way the Pria relay checks it (J1 guard
redaction). The app (fleet-api jev.rs `check`) refuses the whole call when
pria_redact's rules find anything in the request; relay_redact mirrors those
rules (pria-apps crates/pria-redact/src/lib.rs) and replaces each matched
value with exactly `<redacted>`, which the app takes as no finding. The
deterministic rules keep the raw text. Every secret here is a fixture, and
every command is TEXT given to the guard, never executed.

    TMPDIR=/var/tmp PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest test_guard_redact -v   (from tests/)
"""
from __future__ import annotations

import json
import os
import random
import sys
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "extensions"))
import jev_test_home  # noqa: F401,E402  (keeps the suite out of the real Allow-once store and Pria dir)
sys.path.insert(0, HERE)

from jev import audit as audit_mod, guard, relay_redact as rr  # noqa: E402
from test_relay import RelayCase, refuse  # noqa: E402
from test_rule1_guard import HEAD, WORKER  # noqa: E402

# The verbatim lib.rs patterns: the mirrored matcher every check below uses
# (relay_redact itself runs linear rewrites of two of them).
VERBATIM = [rr._rx(p) for p in rr.LIB_RS_RULES]
VERBATIM_OPEN = [rr._rx(p) for p in rr.LIB_RS_OPEN_RULES]

BEARER = "fixtureBearer0123456789"
SK = "sk-fixture0123456789abcdef"
KEY = "fixtureApiKey0123456789"
PEM_BODY = "MIIEfixture" + "A" * 40
PEM = "-----BEGIN RSA PRIVATE KEY-----\n" + PEM_BODY + "\n-----END RSA PRIVATE KEY-----"
GHP = "ghp_" + "Fx7q" * 9
AKIA = "AKIAFIXTURE012345678"
JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.fixtureSig0123"
PW = "fixturePass0123"

# Ordinary key/value text the app refuses today (the live false positives).
FALSE_POSITIVES = (
    ('"max_tokens": 4096', '"max_tokens": <redacted>'),
    ("input_tokens: 12", "input_tokens: <redacted>"),
    ("token_budget: 5", "token_budget: <redacted>"),
    ("--auth x", "--auth <redacted>"),
    ("https://h.example/p?sig=abc", "https://h.example/p?sig=<redacted>"),
    ("CREDENTIALS: none", "CREDENTIALS: <redacted>"),
)
REAL = (  # (text, the secret, the redacted text)
    ("Authorization: Bearer " + BEARER, BEARER, "Authorization: <redacted>"),
    ("OPENAI=" + SK, SK, "OPENAI=<redacted>"),
    ("api_key=" + KEY + " run", KEY, "api_key=<redacted> run"),
    ("x " + PEM + "\nrest", PEM_BODY, "x <redacted private key> \nrest"),
    ("push " + GHP, GHP, "push <redacted>"),
    ("id " + AKIA, AKIA, "id <redacted>"),
    ("jwt " + JWT, JWT, "jwt <redacted>"),
    ("https://deploy:" + PW + "@git.example.com/x.git", PW, "https://deploy:<redacted>@git.example.com/x.git"),
)
PLAIN = ("src/auth/token.rs", "cat src/auth/token.rs", "ls -la", "git status", "cargo test -p pria-redact",
         "max tokens 4096", "grep -rn tokenize src/")


def findings(text: str) -> list:
    return rr.find(text, VERBATIM)


def app_views(line: str, args: dict) -> list[str]:
    """What the app's check scans for one request line: the line itself, the
    raw body as sent, the compact re-serialized JSON (sorted and in order)
    and every decoded string and key of state and questions."""
    state, questions = args["state"], args["questions"]
    compact = {"separators": (",", ":")}
    body = {"state": state, "questions": questions}
    texts = [line,
             '{"state":' + json.dumps(state, **compact) + ',"questions":' + json.dumps(questions, **compact) + "}",
             json.dumps(body, ensure_ascii=False, sort_keys=True, **compact),
             json.dumps(body, ensure_ascii=False, **compact)]

    def walk(v):
        if isinstance(v, dict):
            for k, x in v.items():
                texts.append(k)
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, str):
            texts.append(v)
    walk(body)
    return texts


def answer_all(questions: dict) -> dict:
    """Low-risk answers to whatever the guard asked."""
    risk = {"type": "score", "score": 0.1, "confidence": 0.95, "legend": {str(i): f"L{i}" for i in range(4)},
            "probabilities": {"0": 1.0, "1": 0.0, "2": 0.0, "3": 0.0}}
    return {k: dict(risk) if q.get("type") == "score" else {"type": "noul", "noul": 0.02}
            for k, q in questions.items()}


class Redactor(unittest.TestCase):
    def test_false_positives_are_app_findings_and_become_redacted_values(self):
        for text, want in FALSE_POSITIVES:
            with self.subTest(text=text):
                self.assertTrue(findings(text), "the app refuses this text today")
                self.assertEqual(rr.redact_string(text), want)
                self.assertEqual(findings(want), [])

    def test_real_secrets_become_redacted_values(self):
        for text, secret, want in REAL:
            with self.subTest(text=text):
                self.assertTrue(findings(text))
                out = rr.redact_string(text)
                self.assertEqual(out, want)
                self.assertNotIn(secret, out)
                self.assertEqual(findings(out), [])

    def test_paths_and_plain_commands_are_unchanged(self):
        for text in PLAIN:
            with self.subTest(text=text):
                self.assertEqual(findings(text), [])
                self.assertEqual(rr.redact_string(text), text)
        state = {"call": {"tool": "read", "path": "src/auth/token.rs"}, "cwd": "/w"}
        self.assertEqual(rr.redact_state(state, guard.QUESTIONS), state)

    def test_a_redacted_state_leaves_nothing_the_mirrored_rules_flag_in_any_view(self):
        command = "\n".join([t for t, _ in FALSE_POSITIVES] + [t for t, _, _ in REAL]
                            + ['echo "PASSWORD=\\"' + PW + '\\"" é', "export TOKEN='" + KEY,
                               "password:\t" + PW, "\u00e9TOKEN=" + KEY, '{"api_key":"' + KEY + '"}'])
        state = {"call": {"tool": "bash", "command": command}, "cwd": "/w/token=" + KEY}
        before = json.dumps(state)
        out = rr.redact_state(state, guard.QUESTIONS)
        self.assertEqual(json.dumps(state), before, "the input is not changed in place")
        line = json.dumps({"id": 1, "verb": "jev.decide", "args": {"state": out, "questions": guard.QUESTIONS}},
                          separators=(",", ":"))
        for view in app_views(line, {"state": out, "questions": guard.QUESTIONS}):
            self.assertEqual(findings(view), [], view)
        for secret in (BEARER, SK, KEY, PEM_BODY, GHP, AKIA, JWT, PW):
            self.assertNotIn(secret, line)
        self.assertIn("<redacted>", out["call"]["command"])
        self.assertEqual(out["call"]["tool"], "bash")

    def test_the_guard_questions_hold_no_finding(self):
        # a question key naming a secret ("touches_secrets":{) is itself a
        # finding: every guard call was refused for its questions alone
        for questions in (guard.QUESTIONS, guard.multi_edit_questions(guard.MULTI_EDIT_MAX_FILES),
                          guard.send_events_questions(guard.SEND_EVENTS_MAX_MESSAGES)):
            line = json.dumps({"state": {}, "questions": questions}, separators=(",", ":"))
            for view in app_views(line, {"state": {}, "questions": questions}):
                self.assertEqual(findings(view), [])
            self.assertEqual(rr.redact_state({}, questions), {})

    def test_a_finding_no_state_string_can_remove_raises_unclean(self):
        with self.assertRaises(rr.Unclean):
            rr.redact_state({"a": "x"}, {"TOKEN_x": {"type": "noul", "instructions": "y"}})
        with self.assertRaises(rr.Unclean):
            rr.redact_state({"api_key": 5}, {"q": {"type": "noul", "instructions": "y"}})
        # a key naming a secret is no finding by itself: its string value is
        self.assertEqual(rr.redact_state({"api_key": "x"}, {}), {"api_key": "<redacted>"})
        # not a ValueError: the guard's error category is "internal error", not a malformed answer
        self.assertFalse(issubclass(rr.Unclean, ValueError))

    def test_linear_rewrites_agree_with_the_verbatim_patterns(self):
        self.assertNotEqual([r.pattern for r in rr.RULES], [r.pattern for r in VERBATIM])
        pieces = ["token", "TOKEN", "_", "a", "Z", "9", "=", ":", ":=", " ", "\t", "\n", '"', "'", "\\", '\\"', ";",
                  "&", "|", "-", "--", "--password", "--auth", "pass", "x", "http", "://", "@", "/", "?", "sig=",
                  "key", "é", "\u017f", "\u212a", "secret", "api_key", "API-KEY", "credentials", "1", "+", ".",
                  "<redacted>", "bearer ", "Authorization", "cookie", "sk-", "ghp_", "AKIA", "eyJ", "abcdefgh",
                  "-----BEGIN ", "PRIVATE KEY", "-----END ", "-----", " BLOCK", "\u00a0", "\x1c", "ı", "İ"]
        rnd = random.Random(7)
        for _ in range(3000):
            s = "".join(rnd.choice(pieces) for _ in range(rnd.randint(1, 30)))
            self.assertEqual(rr.find(s), rr.find(s, VERBATIM), repr(s))
            self.assertEqual(rr.open_quoted_secret(s), rr.open_quoted_secret(s, VERBATIM_OPEN), repr(s))

    def test_long_strings_stay_fast_and_come_out_clean(self):
        for s in ("TOKENTOKEN" * 409, "a" * 2000 + "://" + "b" * 2000, "token=" * 682, "--password '" * 300):
            with self.subTest(s=s[:12]):
                t0 = time.perf_counter()
                out = rr.redact_state({"call": {"tool": "read", "path": s}, "cwd": "/w"}, guard.QUESTIONS)
                self.assertLess(time.perf_counter() - t0, 1.0)
                for view in rr.views(out, guard.QUESTIONS):
                    self.assertEqual(rr.find(view), [])


class GuardRelay(RelayCase):
    """Through the hook, with a fake app that runs the mirrored check."""

    def app(self):
        box = {}

        def reply(req):
            line = box["server"].lines[-1].decode("ascii")
            if any(findings(view) for view in app_views(line, req["args"])):
                return refuse("secret_in_state")(req)
            return {"id": req["id"], "ok": True,
                    "result": {"model": "jev-fixture", "answers": answer_all(req["args"]["questions"])}}
        box["server"] = server = self.serve(reply=reply)
        return server

    def sent(self, server, n=1):
        server.idle()
        self.assertEqual(len(server.requests), n)
        line = server.lines[-1].decode("ascii")
        args = server.requests[-1]["args"]
        for view in app_views(line, args):
            self.assertEqual(findings(view), [], view)
        return line, args

    def assert_answered(self, ext, n=1):
        self.assertNotIn("relay.secret_in_state", ext.audit.counters)
        self.assertNotIn("guard.relay_off", ext.audit.counters)
        self.assertEqual(ext.audit.counters.get("relay.ok"), n)

    def test_bash_secrets_never_reach_the_relay_line(self):
        server = self.app()
        ext = self.extension(transport="relay")
        cases = (('curl -sS -H "Authorization: Bearer ' + BEARER + '" https://api.example.com/v1/me', BEARER,
                  "<redacted>"),
                 ("OPENAI=" + SK + " python3 run.py", SK, "OPENAI=<redacted>"),
                 ("export api_key=" + KEY + " && ./deploy.sh", KEY, "api_key=<redacted>"),
                 ("echo '" + PEM + "' | wc -c", PEM_BODY, "<redacted private key>"))
        for n, (command, secret, placeholder) in enumerate(cases, 1):
            with self.subTest(secret=secret[:12]):
                self.assertEqual(self.hook(ext, "bash", {"command": command}), {"action": "continue"})
                line, args = self.sent(server, n)
                self.assertNotIn(secret, line)
                self.assertNotIn(secret, args["state"]["call"]["command"])
                self.assertIn(placeholder, args["state"]["call"]["command"])
        self.assert_answered(ext, len(cases))

    def test_ordinary_key_value_text_is_answered_not_refused(self):
        server = self.app()
        ext = self.extension(transport="relay")
        self.assertEqual(self.hook(ext), {"action": "continue"})  # ls -la: the questions alone were refused
        command = ("jq '.usage' out.json # \"max_tokens\": 4096, input_tokens: 12, token_budget: 5\n"
                   "./tool --auth x 'https://h.example/p?sig=abc' # CREDENTIALS: none\ncat src/auth/token.rs")
        self.assertEqual(self.hook(ext, "bash", {"command": command}), {"action": "continue"})
        _, args = self.sent(server, 2)
        sent = args["state"]["call"]["command"]
        for _, want in FALSE_POSITIVES[:4] + FALSE_POSITIVES[5:]:
            self.assertIn(want, sent)
        self.assertIn("?sig=<redacted>", sent)
        self.assertIn("cat src/auth/token.rs", sent)
        self.assertEqual(set(args["questions"]), {"risk", "leak", "leaves_workspace"})
        self.assert_answered(ext, 2)

    def test_write_edit_and_read_states_are_redacted(self):
        server = self.app()
        ext = self.extension(transport="relay")
        calls = (("write", {"path": str(self.ws / "settings.txt"), "content": "API_KEY=" + KEY + "\nDEBUG=1\n"}),
                 ("edit", {"path": str(self.ws / "settings.txt"), "old_string": "password: old",
                           "new_string": "password: " + PW}),
                 ("read", {"path": "/tmp/TOKEN=" + KEY + "/notes.txt"}))
        for n, (tool, tool_input) in enumerate(calls, 1):
            with self.subTest(tool=tool):
                self.assertEqual(self.hook(ext, tool, tool_input), {"action": "continue"})
                line, args = self.sent(server, n)
                self.assertNotIn(KEY, line)
                self.assertNotIn(PW, line)
                self.assertIn("<redacted>", json.dumps(args["state"]))
        self.assert_answered(ext, len(calls))

    def test_multi_edit_state_is_redacted(self):
        server = self.app()
        ext = self.extension(transport="relay")
        edits = {"edits": [{"path": str(self.ws / "a.txt"), "op": "append", "text": "export TOKEN=" + KEY + "\n"},
                           {"path": str(self.ws / "b.txt"), "op": "append", "text": "max_tokens: 4096\n"}]}
        self.assertEqual(self.hook(ext, "multi_edit", edits), {"action": "continue"})
        line, args = self.sent(server)
        self.assertNotIn(KEY, line)
        previews = [f["previews"][0]["text_preview"] for f in args["state"]["call"]["files"]]
        self.assertEqual(previews, ["export TOKEN=<redacted> \n", "max_tokens: <redacted> \n"])
        self.assertEqual([f["path"] for f in args["state"]["call"]["files"]], [e["path"] for e in edits["edits"]])
        self.assertIn("leak_1", args["questions"])
        self.assert_answered(ext)

    def test_send_events_state_is_redacted(self):
        server = self.app()
        ext = self.extension(transport="relay")
        events = {"source": "worker-v", "messages": [{"session": "s", "body": "usage: max_tokens: 4096"}]}
        self.assertEqual(self.hook(ext, "send_events", events), {"action": "continue"})
        _, args = self.sent(server)
        self.assertEqual(args["state"]["call"]["messages"][0]["body_preview"], "usage: max_tokens: <redacted>")
        self.assertEqual(set(args["questions"]), {"leak_0"})
        self.assert_answered(ext)

    def test_the_audit_row_stores_the_redacted_state(self):
        server = self.app()
        ext = self.extension(transport="relay")
        command = 'curl -H "Authorization: Bearer ' + BEARER + '" "https://x.example/?api_key=' + KEY + '"'
        self.assertEqual(self.hook(ext, "bash", {"command": command}), {"action": "continue"})
        _, args = self.sent(server)
        text = self.audit_path.read_text()
        rows = [json.loads(line) for line in text.splitlines()]
        guard_rows = [r for r in rows if r.get("op") == "guard"]
        self.assertEqual(len(guard_rows), 1)
        self.assertEqual(guard_rows[0]["state"], args["state"])
        self.assertNotIn(BEARER, text)
        self.assertNotIn(KEY, text)

    def test_the_deterministic_rules_still_decide_on_the_raw_text(self):
        server = self.app()
        ext = self.extension(transport="relay")
        heredoc = "cat > f.env <<'EOF'\nAPI_KEY=" + KEY + "\nEOF"
        result = self.hook(ext, "bash", {"command": heredoc}, session=WORKER)
        self.assertEqual(result["action"], "block", result)
        self.assertTrue(result["reason"].startswith(HEAD), result["reason"])
        result = self.hook(ext, "bash", {"command": 'set -euo pipefail\nTOKEN=' + KEY + '\nrm -rf "$OUT"/*\n'})
        self.assertEqual(result["action"], "block", result)
        events = {"source": "worker-v", "messages": [{"session": "s", "body": "token " + GHP}]}
        self.assertEqual(self.hook(ext, "send_events", events)["action"], "confirm")
        server.idle()
        self.assertEqual(server.connections, 0)

    def test_a_state_that_stays_unclean_confirms_without_a_request(self):
        server = self.app()
        ext = self.extension(transport="relay")
        with mock.patch.object(guard.relay_redact, "redact_state", side_effect=rr.Unclean("fixture")):
            result = self.hook(ext)
        self.assertEqual(result["action"], "confirm", result)
        self.assertEqual(ext.audit.counters.get("guard.error"), 1)
        server.idle()
        self.assertEqual(server.connections, 0)

    # ── 28b backlog 1: the redaction is bounded by the hook budget ──────────

    def late(self, ext, tool, tool_input, left):
        """A hook whose frame arrived so long ago that `left` seconds of the budget remain."""
        params = {"kind": "before_tool_call", "tool_name": tool, "tool_runtime_name": tool, "tool_input": tool_input,
                  "session_id": "sess-1", "cwd": str(self.ws)}
        return ext.hook(params, received=time.monotonic() - ext.guard_cfg.budget_s + left)

    def test_a_slow_redaction_is_cut_off_by_the_hook_budget(self):
        # redact_state ran outside any BudgetAlarm; inside one now, SIGALRM
        # interrupts it (a sleep here, a long regex match alike) and the call
        # confirms ("hook budget spent") with nothing sent
        server = self.app()
        ext = self.extension(transport="relay")

        def slow(state, questions, **_budget):
            time.sleep(5)
            return state
        calls = (("bash", {"command": "ls -la"}),
                 ("multi_edit", {"edits": [{"path": str(self.ws / "a.txt"), "op": "append", "text": "x\n"}]}),
                 ("send_events", {"source": "worker-v", "messages": [{"session": "s", "body": "status ok"}]}))
        with mock.patch.object(guard.relay_redact, "redact_state", side_effect=slow) as redact:
            for n, (tool, tool_input) in enumerate(calls, 1):
                with self.subTest(tool=tool):
                    t0 = time.monotonic()
                    result = self.late(ext, tool, tool_input, left=0.5)
                    self.assertLess(time.monotonic() - t0, 1.5)
                    self.assertEqual(result["action"], "confirm", result)
                    self.assertIn("hook budget spent", result["message"])
                    self.assertEqual(ext.audit.counters.get("guard.budget"), n)
                    self.assertEqual(redact.call_count, n)
        server.idle()
        self.assertEqual(server.connections, 0)

    def test_the_28b_multi_edit_redacts_well_inside_the_budget_and_clean(self):
        # 64 edits with 4 KB `eyJ-… token:` paths took 1.7-3 s to redact (the
        # verbatim JWT rule is quadratic in Python); its linear rewrite keeps
        # the whole hook short, and the request clean
        server = self.app()
        ext = self.extension(transport="relay")
        stem = str(self.ws) + "/"
        edits = []
        for f in range(guard.MULTI_EDIT_MAX_FILES):
            name = f"{f:02d}" + ("eyJ-" * 1024)[:guard.MAX_PATH_BYTES - len(stem) - 16] + " token:"
            for alias in ("", "./", "d/../", "e/../"):
                edits.append({"path": stem + alias + name, "op": "append", "text": "x\n"})
        self.assertEqual(len(edits), 64)
        t0 = time.monotonic()
        self.assertEqual(self.hook(ext, "multi_edit", {"edits": edits}), {"action": "continue"})
        # well inside the hook budget even on a loaded machine (the verbatim rule: ~4 s at load 7)
        self.assertLess(time.monotonic() - t0, guard.HOOK_BUDGET_S / 2)
        # 320 KB of paths was over the relay line (too_large, Jev off); their
        # redaction now runs past the call's read budget (GUARD_READ_CHARS),
        # so every state string is the placeholder: nothing is left for the
        # model, so nothing is sent (Jev off for this call, as before)
        server.idle()
        self.assertEqual(len(server.requests), 0)
        self.assertEqual(ext.audit.counters.get("guard.state_wiped_skip"), 1)
        self.assertNotIn("guard.relay_off", ext.audit.counters)
        questions = guard.multi_edit_questions(guard.MULTI_EDIT_MAX_FILES)
        t0 = time.perf_counter()
        state = rr.redact_state({"call": guard.summarize_multi_edit({"edits": edits}, str(self.ws)),
                                 "cwd": str(self.ws)}, questions)
        self.assertLess(time.perf_counter() - t0, guard.HOOK_BUDGET_S / 2)
        for view in rr.views(state, questions):  # the linear rules (agreeing with lib.rs, above)
            self.assertEqual(rr.find(view), [])

    def test_the_linear_jwt_rule_agrees_with_the_verbatim_one(self):
        fast, slow = rr._rx(rr._fast(rr.LIB_RS_RULES[3])), VERBATIM[3]
        self.assertNotEqual(fast.pattern, slow.pattern)
        pieces = ["eyJ", "eyJ", "-", "_", ".", "..", "a", "Z9", "abcdefgh", "-eyJ", " ", "é", "x.", "\u212a", "/"]
        rnd = random.Random(11)
        for _ in range(4000):
            s = "".join(rnd.choice(pieces) for _ in range(rnd.randint(1, 24)))
            self.assertEqual([m.span("v") for m in fast.finditer(s)], [m.span() for m in slow.finditer(s)], repr(s))
        t0 = time.perf_counter()
        self.assertEqual(fast.findall("eyJ-" * 16000), [])
        self.assertLess(time.perf_counter() - t0, 0.5)


# ── 28b backlog 2: every guard preview is redacted first, then cut ─────────

# Each credential's own characters are Q (the padding never is): any Q in a
# preview is a fragment.
Q_SECRETS = ("sk-ant-" + "Q" * 40, "Authorization: Bearer " + "Q" * 24, "api_key=" + "Q" * 24,
             "eyJ" + "Q" * 12 + "." + "Q" * 12 + "." + "Q" * 12, "--password " + "Q" * 16,
             "https://u:" + "Q" * 16 + "@h.example/x",
             "-----BEGIN RSA PRIVATE KEY-----\n" + "Q" * 60 + "\n-----END RSA PRIVATE KEY-----")


def multi_edit_preview(field):
    def render(text):
        call = guard.summarize_multi_edit({"edits": [{"path": "/w/f", "op": "replace", "anchor": text,
                                                      "text": text}]}, "/w")
        return call["files"][0]["previews"][0][field]
    return render


PREVIEWS = (  # (name, limit, the preview of one text)
    ("bash command", 2000, lambda t: guard.summarize_call("bash", {"command": t})["command"]),
    ("write content", 400, lambda t: guard.summarize_call("write", {"path": "/w/f", "content": t})["content_preview"]),
    ("edit old", 200, lambda t: guard.summarize_call("edit", {"path": "/w/f", "old_string": t,
                                                               "new_string": "x"})["old_preview"]),
    ("edit new", 200, lambda t: guard.summarize_call("edit", {"path": "/w/f", "old_string": "x",
                                                               "new_string": t})["new_preview"]),
    ("other input", 600, lambda t: guard.summarize_call("grep", {"pattern": t})["input"]),
    ("multi_edit anchor", guard.PREVIEW_CHARS, multi_edit_preview("anchor_preview")),
    ("multi_edit text", guard.PREVIEW_CHARS, multi_edit_preview("text_preview")),
    ("send_events body", guard.BODY_PREVIEW_CHARS, lambda t: guard.summarize_send_events(
        {"source": "worker-v", "messages": [{"session": "s", "body": t}]})[0][0]["body_preview"]),
)


class RedactThenCut(unittest.TestCase):
    """The previews were cut, then redacted: a credential cut below its
    rule's minimum (a Bearer value under 8 characters, a URL password cut
    before its `@`) went out as a fragment."""

    def test_no_preview_holds_a_credential_fragment_or_a_cut_placeholder(self):
        for name, limit, render in PREVIEWS:
            for secret in Q_SECRETS:
                with self.subTest(preview=name, secret=secret[:12]):
                    # the cut falls everywhere in, before and after the credential
                    for k in range(limit - 70, limit + 1):
                        out = render("a" * k + " " + secret + " tail")
                        self.assertLessEqual(len(out), limit)
                        self.assertNotIn("Q", out, k)
                        self.assertEqual(findings(out), [], k)
                        for p in (rr.REDACTED, rr.REDACTED_PRIVATE_KEY):
                            self.assertFalse(any(out.endswith(p[:i]) for i in range(1, len(p))), (k, out[-24:]))
                        if k == limit - 70:  # room for the whole placeholder: it is kept
                            self.assertTrue(rr.REDACTED in out or rr.REDACTED_PRIVATE_KEY in out, out[-40:])

    def test_the_old_cut_left_fragments_the_app_does_not_flag(self):
        # what cut-then-redact sent: the fragment is no finding, so it stayed
        for text in ("a" * 1985 + " Bearer " + "Q" * 12, "a" * 1980 + " https://u:" + "Q" * 16 + "@h.x/"):
            old = rr.redact_string(text[:2000])
            self.assertIn("Q", old)
            new = guard.summarize_call("bash", {"command": text})["command"]
            self.assertNotIn("Q", new)


class AskCap(RelayCase):
    """Above guard.RELAY_ASKS_PER_MIN asks in a session's last 60 s the guard
    continues on its local rules without asking (the app answers 60)."""

    def setUp(self):
        super().setUp()
        self.now = [1000.0]
        self.server = self.serve(reply=lambda req: {"id": req["id"], "ok": True, "result": {
            "model": "jev-fixture", "answers": answer_all(req["args"]["questions"])}})
        self.ext = self.extension(transport="relay")
        self.ext.guard_cfg.asks = guard.AskWindow(cap=2, clock=lambda: self.now[0])

    def requests(self):
        self.server.idle()
        return len(self.server.requests)

    def test_the_default_cap_leaves_room_under_the_app_limit(self):
        self.assertEqual(guard.RELAY_ASKS_PER_MIN, 50)
        self.assertEqual(guard.GuardConfig({}).asks.cap, 50)

    def test_over_the_cap_continues_without_a_relay_call(self):
        for _ in range(3):
            self.assertEqual(self.hook(self.ext), {"action": "continue"})
        self.assertEqual(self.requests(), 2)
        self.assertEqual(self.ext.audit.counters.get("guard.sampled_out"), 1)
        self.assertEqual(self.ext.audit.explanations()[-1]["reason"], "continue")
        self.assertEqual(self.hook(self.ext, session="sess-2"), {"action": "continue"})  # its own window
        self.assertEqual(self.requests(), 3)
        edits = {"edits": [{"path": str(self.ws / "a.txt"), "op": "append", "text": "x\n"}]}
        self.assertEqual(self.hook(self.ext, "multi_edit", edits), {"action": "continue"})
        events = {"source": "worker-v", "messages": [{"session": "s", "body": "status ok"}]}
        self.assertEqual(self.hook(self.ext, "send_events", events), {"action": "continue"})
        self.assertEqual(self.requests(), 3)
        self.assertEqual(self.ext.audit.counters.get("guard.sampled_out"), 3)
        self.now[0] += 60.0  # the window slides: sess-1 asks again
        self.assertEqual(self.hook(self.ext), {"action": "continue"})
        self.assertEqual(self.requests(), 4)
        self.assertEqual(self.ext.audit.counters.get("guard.continue"), 4)

    def test_the_local_rules_still_run_above_the_cap(self):
        for _ in range(2):
            self.hook(self.ext)
        result = self.hook(self.ext, "bash", {"command": 'set -euo pipefail\nrm -rf "$OUT"/*\n'})
        self.assertEqual(result["action"], "block", result)
        events = {"source": "worker-v", "messages": [{"session": "s", "body": "token " + GHP}]}
        self.assertEqual(self.hook(self.ext, "send_events", events)["action"], "confirm")
        self.assertEqual(self.requests(), 2)
        self.assertNotIn("guard.sampled_out", self.ext.audit.counters)

    def test_the_direct_transport_is_never_capped(self):
        calls = []

        class Direct:
            def decide(self, state, questions, *, op="decide", deadline=None):
                calls.append(op)
                return {"model": "jev-fixture", "answers": answer_all(questions)}
        cfg = guard.GuardConfig({"project_root": str(self.ws)})
        cfg.asks = guard.AskWindow(cap=0)
        audit = audit_mod.Audit(None)
        params = {"tool_name": "bash", "tool_runtime_name": "bash", "tool_input": {"command": "ls"},
                  "session_id": "sess-1", "cwd": str(self.ws)}
        self.assertEqual(guard.handle(params, Direct(), cfg, audit, lambda msg: None), {"action": "continue"})
        self.assertEqual(calls, ["guard"])
        self.assertNotIn("guard.sampled_out", audit.counters)

    def test_ask_window_per_session_shared_unattributed_sliding_and_bounded(self):
        now = [0.0]
        w = guard.AskWindow(cap=2, clock=lambda: now[0])
        self.assertEqual([w.take("a"), w.take("a"), w.take("a"), w.take("b")], [True, True, False, True])
        # no, blank or invalid session ids share one window, as at the app
        self.assertEqual([w.take(None), w.take(" "), w.take("x" * 300)], [True, True, False])
        now[0] = 59.9
        self.assertFalse(w.take("a"))
        now[0] = 60.0
        self.assertTrue(w.take("a"))
        for i in range(guard.RELAY_ASK_SESSIONS + 5):
            w.take(f"s{i}")
        self.assertLessEqual(len(w._seen), guard.RELAY_ASK_SESSIONS)


if __name__ == "__main__":
    unittest.main()
