#!/usr/bin/env python3
"""The ops redaction fix-forward: seven items, each with its own tests.

1. Order: the deterministic rules (the shell-safety rule, the send_events
   secret scan) run before the previews and the redaction, so a slow preview
   on a small budget never turns their block into a budget-spent confirm, and
   under guard_confirm = auto nothing prompts.
2. A credential straddling redact_string's read window (limit +
   CLIP_MARGIN) leaves no fragment: the window's trailing run is dropped.
3. Plugin-only rules (no app finding, the old triage redactor caught them):
   a value after a hyphenated name (`api-key`, `access-key`, `private-key`)
   and a NAME rule value on the next line.
4. clip never drops the whole text for a run of open lead-ins at the cut.
5. jev_decide / jev_select say when the caller's whole state was wiped.
6. diagnose explains `unclean` (once).
7. compress skips Jev for an output over the redaction cap.

The 28b re-check backlog (commit 3):

8. The next-line plugin rule redacts the first value on the line after a
   bare key name unless that line is code-shaped (a YAML key, a call, a
   keyword): the re-check's leak cases are redacted, the code on the line
   after a key name stays visible to the guard model (commit 4).
9. One read budget per guard call, charged what each pass really scans
   (the decoded text and every escaped view) before it scans: the previews
   read at most guard.PREVIEW_READ_CHARS characters, the state (paths,
   cwd, the body checks) the rest of the call's budget; past it a preview
   or a state string is the placeholder (commit 4).
10. clip's tail check covers all three views (the notice after a lead-in
    placeholder is no value in the escaped views either).
11. state_redacted / context_redacted are documented where callers read.

The c4 re-check backlog (commit 5):

12. A guard state that redaction left all placeholders (past the call's
    read budget) is not sent: no model call, the deterministic rules'
    result stands (`guard.state_wiped_skip`), as for a state too large for
    the relay.
13. A write/edit/read `path` that is not a string is malformed input: it
    never reaches the state (a dict or list path made the uncharged
    skeleton check scale with it).
Common commands (curl, wget, git, ssh, cat, scp, rsync, nc) join item 8's
keywords.

Offline: fake clients stand in for Jev. Run (from tests/):

    TMPDIR=/var/tmp PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest test_ops_fix -v
"""
from __future__ import annotations

import json
import os
import sys
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "extensions"))
import jev_test_home  # noqa: F401,E402  (keeps the suite out of the real Allow-once store and Pria dir)
sys.path.insert(0, HERE)

from jev import audit as audit_mod, compress, context, diagnose, guard, tools  # noqa: E402
from jev import relay_redact as rr  # noqa: E402
from test_guard_confirm_auto import AWS_KEY, RM_ROOT, ConfirmCase, FakeClient  # noqa: E402
from test_guard_redact import findings  # noqa: E402

HEX = "0123456789abcdef0123456789abcdef"
NOTICE = context.TRUNCATED.split("{")[0]


def app_clean(text: str) -> bool:
    """No finding in the text, nor in any view the app scans of it as a state string."""
    return not findings(text) and not any(findings(v) for v in rr.views({"text": text}, {}))


class Cap:
    """A fake client: records what it is sent, answers every question."""

    def __init__(self):
        self.sent = []

    def decide(self, state, questions, *, op="decide", deadline=None):
        self.sent.append((op, state, questions))
        answers = {}
        for k, q in questions.items():
            if q["type"] == "choice":
                first = next(iter(q["criteria"]))
                answers[k] = {"type": "choice", "choice": first, "confidence": 0.99}
            else:
                answers[k] = {"type": "noul", "noul": 0.5}
        return {"model": "jev-fixture", "answers": answers}


# ── 1. order ─────────────────────────────────────────────────────────────────

class Order(ConfirmCase):
    """Item 1. The base (fix/jev-guard-confirm-auto) already runs the shell
    rule and the send_events scan first; these press it with real slow
    previews on a shrunk hook budget."""

    def slow_clip(self, calls):
        def clip(*a, **kw):
            calls.append(1)
            time.sleep(0.2)
            return "x"
        return clip

    def small(self, mode):
        cfg = self.cfg_for(mode)
        cfg.budget_s = 0.5
        return cfg

    def sixty_four_edits(self, shell=True):
        edits = [{"path": f"f{i % 15}.txt", "op": "replace", "anchor": "old", "text": "new text " * 30}
                 for i in range(63)]
        edits.append({"path": "deploy.sh", "op": "insert_after", "anchor": "x",
                      "text": RM_ROOT if shell else "#!/bin/bash\necho hi\n"})
        self.assertEqual(len(edits), guard.MULTI_EDIT_MAX_EDITS)
        return {"edits": edits}

    def test_a_64_edit_multi_edit_with_slow_previews_and_a_root_rm_blocks_on_a_small_budget(self):
        for mode in ("auto", "prompt"):
            with self.subTest(mode=mode):
                self.fresh(mode)
                client, calls = FakeClient(), []
                with mock.patch.object(rr, "clip", side_effect=self.slow_clip(calls)):
                    r = self.guard_at("multi_edit", self.sixty_four_edits(), client, self.small(mode))
                self.assertEqual(r["action"], "block", r)
                self.assertIn("shell-safety rule", r["reason"])
                self.assertEqual(calls, [])  # no preview was built
                self.assertEqual(client.calls, [])
                self.assert_no_confirm(r)

    def test_slow_previews_on_a_clean_64_edit_multi_edit(self):
        for mode, action in (("auto", "continue"), ("prompt", "confirm")):
            with self.subTest(mode=mode):
                self.fresh(mode)
                client, calls = FakeClient(), []
                with mock.patch.object(rr, "clip", side_effect=self.slow_clip(calls)):
                    r = self.guard_at("multi_edit", self.sixty_four_edits(shell=False), client, self.small(mode))
                self.assertEqual(r["action"], action, r)
                self.assertTrue(calls)
                self.assertEqual(client.calls, [])
                self.assertEqual(self.audit.counters.get("guard.budget"), 1)
                if mode == "auto":
                    self.assertEqual(self.audit.counters.get("guard.error_auto"), 1)
                    self.assert_no_confirm(r)

    def test_send_events_slow_previews_and_a_secret_pattern(self):
        bodies = ["hello there " * 30] * 7 + [f"the key is {AWS_KEY} ok"]
        for mode, action in (("auto", "block"), ("prompt", "confirm")):
            with self.subTest(mode=mode):
                self.fresh(mode)
                client, calls = FakeClient(), []
                with mock.patch.object(rr, "clip", side_effect=self.slow_clip(calls)):
                    r = self.guard_at("send_events", self.msgs(*bodies), client, self.small(mode))
                self.assertEqual(r["action"], action, r)
                self.assertIn("secret pattern", r.get("reason", r.get("message", "")))
                self.assertEqual(calls, [])
                self.assertEqual(client.calls, [])
                self.assertEqual(self.audit.counters.get("guard.secret_pattern"), 1)
                if mode == "auto":
                    self.assert_no_confirm(r)

    def test_auto_slow_or_unclean_redaction_continues_and_nothing_prompts(self):
        for label, patch in (
                ("slow previews", mock.patch.object(rr, "clip", side_effect=self.slow_clip([]))),
                ("unclean", mock.patch.object(rr, "redact_state", side_effect=rr.Unclean("fixture")))):
            with self.subTest(label=label):
                self.fresh(label)
                client = FakeClient()
                with patch:
                    r = self.guard_at("send_events", self.msgs("hello there " * 30, "status ok"), client,
                                      self.small("auto"))
                self.assertEqual(r, {"action": "continue"})
                self.assertEqual(client.calls, [])
                self.assertEqual(self.audit.counters.get("guard.error_auto"), 1)
                self.assert_no_confirm(r)


# ── 2. a credential straddling the read window ───────────────────────────────

W = 2000 + rr.CLIP_MARGIN  # summarize_call("bash")'s read window
URL_HEAD = "https://admin:hunter2"
JWT_HP = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbkBjb3JwLmV4YW1wbGUiLCJyb2xlIjoicm9vdCJ9."
SK_KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"


def straddles():
    """The 28b probes: a long value before (it shrinks to a placeholder) and
    a credential cut by the window below its rule's minimum."""
    url = ("curl -H 'X-Auth-Token: " + "A" * (W - 25 - len(URL_HEAD)) + "' " + URL_HEAD
           + "secretpw@db.example/x")
    jwt = "export TOKEN=" + "B" * (W - 13 - 8 - len(JWT_HP) - 5) + " ; echo " + JWT_HP + "SIGNATUREPARTLONG123"
    key = "export TOKEN=" + "C" * (W - 13 - 1 - 18) + " " + SK_KEY
    return {"url password, no @": (url, URL_HEAD[-7:]), "jwt, short signature": (jwt, JWT_HP.split(".")[0]),
            "sk-ant prefix plus 11": (key, SK_KEY[:12])}


class Straddle(unittest.TestCase):
    def test_the_28b_window_cases_leave_no_fragment(self):
        for label, (cmd, fragment) in straddles().items():
            with self.subTest(label=label):
                self.assertIn(fragment, cmd[:W])  # the window holds the fragment
                self.assertNotIn(fragment, rr.redact_string(cmd, 2000))
                sent = guard.summarize_call("bash", {"command": cmd})
                self.assertNotIn(fragment, sent["command"])
                self.assertLessEqual(len(sent["command"]), 2000)
                self.assertTrue(sent["command"].startswith(cmd[:13]), sent["command"][:40])
                state = rr.redact_state({"call": sent, "cwd": "/w"}, guard.QUESTIONS)
                self.assertNotIn(fragment, json.dumps(state))
                self.assertTrue(app_clean(sent["command"]))

    def test_a_window_that_is_one_run_past_the_widen_is_the_placeholder(self):
        run = "Q" * (W + rr.READ_WIDEN + 10)
        self.assertEqual(rr.redact_string(run, 2000), rr.REDACTED)
        self.assertEqual(rr.redact_string(run, 5), "")
        self.assertEqual(rr.redact_string(run + " tail", 2000), rr.REDACTED)

    def test_a_run_that_ends_within_the_widen_is_read_to_its_end(self):
        # an ordinary whitespace-free blob (base64, a minified line) keeps its preview
        for text in ("Q" * (W + 10), "Q" * (W + 10) + " tail", "Q" * (W + rr.READ_WIDEN - 1) + " t"):
            with self.subTest(n=len(text)):
                self.assertEqual(rr.redact_string(text, 2000), "Q" * 2000)
        self.assertEqual(guard.summarize_call("write", {"path": "x", "content": "A" * 10_000})["content_preview"],
                         "A" * 400)

    def test_a_straddle_that_runs_past_the_widen_is_cut_back(self):
        for label, (cmd, fragment) in straddles().items():
            longer = cmd[:W] + "Z" * (rr.READ_WIDEN + 10) + cmd[W:]
            with self.subTest(label=label):
                out = rr.redact_string(longer, 2000)
                self.assertNotIn(fragment, out)
                self.assertTrue(out.startswith(cmd[:13]), out[:40])
                self.assertTrue(app_clean(out))

    def test_a_window_that_ends_at_a_space_or_ends_the_text_is_kept(self):
        text = "word " * 2000
        self.assertEqual(rr.redact_string(text, 2000), text[:2000])
        short = "x" * 100
        self.assertEqual(rr.redact_string(short, 2000), short)

    def test_a_newline_at_the_window_edge_is_no_boundary(self):
        # in the escaped views a newline is two characters of the same run
        cmd = "curl -H 'X-Auth-Token: " + "A" * (W - 25 - len(URL_HEAD)) + "' " + URL_HEAD + "\nsecret@db/x"
        self.assertNotIn("hunter2", rr.redact_string(cmd, 2000))


# ── 3. plugin-only rules ─────────────────────────────────────────────────────

PLUGIN_CASES = (
    f"api-key: {HEX}",
    f"API-KEY: {HEX}",
    f"Api-Key={HEX}",
    f"curl -H 'api-key: {HEX}' https://x.example/v1",
    f"my-api-key = {HEX}",
    f"access-key: {HEX}",
    f"access_key={HEX}",
    f"ACCESS-KEY={HEX}",
    f"private-key={HEX}",
    f"private_key: {HEX}",
    f"token:\n  {HEX}",
    f"password:\n\t{HEX}",
    f"api-key:\n  {HEX}",
    f"secret:\r\n  {HEX}",
    f"credentials:\n\n    {HEX}",
)


class PluginRules(unittest.TestCase):
    def test_each_value_is_redacted_with_the_plain_placeholder(self):
        for case in PLUGIN_CASES:
            with self.subTest(case=case):
                for out in (rr.redact_string(case, None), rr.redact_string(case), rr.redact_string(case, 200)):
                    self.assertNotIn(HEX, out)
                    self.assertIn(rr.REDACTED, out)
                    self.assertNotIn(rr.REDACTED_PRIVATE_KEY, out)
                    self.assertTrue(app_clean(out), out)

    def test_each_value_is_not_sent_by_jev_decide(self):
        for case in PLUGIN_CASES:
            for state in (case, {"note": case}):
                with self.subTest(case=case, state=type(state).__name__):
                    cap = Cap()
                    tools.call_decide({"state": state, "questions": {
                        "q": {"type": "noul", "instructions": "Is `note` safe?"}}}, cap, audit_mod.Audit(None))
                    self.assertEqual(len(cap.sent), 1)
                    self.assertNotIn(HEX, json.dumps(cap.sent[0][1]))
                    self.assertIn(rr.REDACTED, json.dumps(cap.sent[0][1]))

    def test_the_guard_state_too(self):
        for case in PLUGIN_CASES:
            with self.subTest(case=case):
                state = rr.redact_state({"call": guard.summarize_call("bash", {"command": case})}, guard.QUESTIONS)
                self.assertNotIn(HEX, json.dumps(state))

    def test_no_name_no_lead_in_is_left_alone(self):
        for text in ("the api-key is set", "access-key rotation done", "token\n  value", "a private-key file",
                     "x-api-keys", "tokens 5"):
            with self.subTest(text=text):
                self.assertEqual(rr.redact_string(text, None), text)

    def test_the_plugin_rules_are_linear(self):
        for unit in ("api-", "a-", "token-", "-", "api-key-"):
            text = unit * 20000
            t0 = time.monotonic()
            rr.redact_string(text, None)
            self.assertLess(time.monotonic() - t0, 2.0, unit)


# ── 4. clip keeps a clean prefix ─────────────────────────────────────────────

HEAD = "Real task summary: all tests pass and the feature is done. "
COOKIE = "'Cookie: "


class ClipFallback(unittest.TestCase):
    def messages(self):
        aligned = HEAD + "y" * (6000 - len(HEAD) - 12 * len(COOKIE)) + COOKIE * 12 + "z" * 50
        spaced = HEAD + "x " * 2950 + COOKIE * 12
        many = HEAD + "w " * 2000 + COOKIE * 400
        return {"aligned": aligned, "spaced": spaced, "many": many}

    def test_twelve_open_cookie_lead_ins_at_the_cut_keep_the_head(self):
        for label, msg in self.messages().items():
            with self.subTest(label=label):
                out = context.bounded_text(msg, context.MAX_TEXT)
                kept, sep, _ = out.partition(NOTICE)
                self.assertTrue(sep)
                self.assertTrue(kept.startswith(HEAD), kept[:80])
                self.assertLessEqual(len(kept), context.MAX_TEXT)
                self.assertTrue(app_clean(out), out[-80:])
                self.assertTrue(app_clean(kept))

    def test_clip_with_a_tail_is_not_empty_and_clean_with_it(self):
        for label, msg in self.messages().items():
            with self.subTest(label=label):
                tail = context.TRUNCATED.format(len(msg))
                kept = rr.clip(msg, 6000, tail=tail)
                self.assertTrue(kept.startswith(HEAD))
                self.assertLessEqual(len(kept), 6000)
                self.assertTrue(app_clean(kept + tail))

    def test_a_limit_too_small_for_a_placeholder_is_empty_not_unclean(self):
        msg = COOKIE * 12
        kept = rr.clip(msg, 10, tail=context.TRUNCATED.format(len(msg)))
        self.assertTrue(app_clean(kept + context.TRUNCATED.format(len(msg))))
        self.assertLessEqual(len(kept), 10)


# ── 5. the caller is told its whole state was wiped ──────────────────────────

WIPED = "api" + "key_" + "A1b2C3d4E5f6G7h8"  # the whole state is one key: sent as the placeholder


class WipedState(unittest.TestCase):
    def decide(self, state):
        cap = Cap()
        out = json.loads(tools.call_decide({"state": state, "questions": {
            "q": {"type": "noul", "instructions": "Is `state` safe?"}}}, cap, audit_mod.Audit(None))["content"])
        return cap, out

    def select(self, context_text):
        cap = Cap()
        out = json.loads(tools.call_select({"context": context_text, "decisions": [
            {"instruction": "Pick one", "candidates": [{"id": "a", "description": "A"},
                                                       {"id": "b", "description": "B"}]}]},
            cap, audit_mod.Audit(None))["content"])
        return cap, out

    def test_jev_decide_says_state_redacted(self):
        cap, out = self.decide(WIPED)
        self.assertEqual(cap.sent[0][1], rr.REDACTED)
        self.assertIs(out.get("state_redacted"), True)
        self.assertIn("q", out["answers"])

    def test_jev_decide_partly_redacted_or_clean_state_has_no_field(self):
        for state in ("note token=abcdefgh123", "plain", {"a": WIPED}, rr.REDACTED):
            with self.subTest(state=str(state)[:20]):
                _, out = self.decide(state)
                self.assertNotIn("state_redacted", out)

    def test_jev_select_says_context_redacted(self):
        cap, out = self.select(WIPED)
        self.assertEqual(cap.sent[0][1], rr.REDACTED)
        self.assertIs(out.get("context_redacted"), True)
        self.assertTrue(out["advisory"])
        self.assertEqual(out["decisions"][0]["id"], "a")

    def test_jev_select_partly_redacted_or_clean_context_has_no_field(self):
        for text in ("note token=abcdefgh123", "plain", rr.REDACTED):
            with self.subTest(text=text):
                _, out = self.select(text)
                self.assertNotIn("context_redacted", out)


# ── 6. diagnose explains unclean ─────────────────────────────────────────────

class DiagnoseUnclean(unittest.TestCase):
    def test_unclean_is_explained_once(self):
        audit = audit_mod.Audit(None)
        client = Cap()
        data = {"task": "t", "evidence": "e", "hypotheses": [{"id": "h1", "description": "A"}],
                "checks": [{"id": "c1", "description": "B", "required": False}]}
        with mock.patch.object(rr, "redact_request", side_effect=rr.Unclean("fixture")):
            out = json.loads(diagnose.call_diagnose(data, client, audit, enabled=True)["content"])
        self.assertEqual(out["fallback_reason"], "unclean")
        self.assertEqual(client.sent, [])
        rows = [(e["op"], e["reason"]) for e in audit.explanations()]
        self.assertEqual(rows.count(("diagnose", "unclean")), 1, rows)
        self.assertEqual((audit.counters.get("diagnose.unclean"), audit.counters.get("diagnose.skip")), (1, 1))


# ── 7. compress: a size cap on the outbound redaction ────────────────────────

class CompressCap(unittest.TestCase):
    def run_compress(self, raw, mode="jev"):
        audit = audit_mod.Audit(None)
        client = Cap()
        logs = []
        r = compress.handle({"tool_runtime_name": "bash", "tool_output": raw}, "goal", client,
                            compress.CompressConfig({"compress_mode": mode}), audit, logs.append)
        return r, client, audit

    def test_jev_mode_skips_an_output_over_the_cap_without_redacting_it(self):
        raw = "routine progress\n" * (200 * 1024 // 17)
        self.assertGreater(len(raw.encode()), compress.MAX_JEV_REDACT)
        self.assertLessEqual(len(raw.encode()), compress.MAX_RAW)
        with mock.patch.object(rr, "redact_string", side_effect=AssertionError("redacted")):
            r, client, audit = self.run_compress(raw)
        self.assertEqual(r, {"action": "continue"})
        self.assertEqual(client.sent, [])
        self.assertEqual(audit.counters.get("compress.skip"), 1)
        self.assertIn(("compress", "noeconomiccandidate"), [(e["op"], e["reason"]) for e in audit.explanations()])

    def test_jev_mode_under_the_cap_still_asks(self):
        raw = "routine progress\n" * (100 * 1024 // 17)
        self.assertLessEqual(len(raw.encode()), compress.MAX_JEV_REDACT)
        _, client, _ = self.run_compress(raw)
        self.assertEqual(len(client.sent), 1)

    def test_deterministic_mode_is_not_capped(self):
        raw = "routine progress\n" * (200 * 1024 // 17)
        r, client, audit = self.run_compress(raw, mode="deterministic")
        self.assertEqual(client.sent, [])
        self.assertNotEqual(r, {"action": "continue"})


# ── 8. the next-line rule: redacted unless the line is code-shaped ───────────

# The line after a bare key name is code or YAML as often as a value: its
# first value is redacted unless it is code-shaped (a YAML key, a call, a
# keyword). The re-check's code probes and these stay visible to the model.
NEXT_LINE_CODE = (
    ("if token:\n    exec(base64.b64decode(PAYLOAD))\n", "exec(base64.b64decode(PAYLOAD))"),
    ("class TokenStore:\n    def __init__(self):\n        pass\n", "def __init__(self):"),
    ("for secret in secrets:\n    print(secret)\n", "print(secret)"),
    ("valueFrom:\n  secretKeyRef:\n    name: mysecret\n", "name: mysecret"),
    ("TOKEN=\nrm -rf /tmp/x\n", "rm -rf /tmp/x"),
    ("api_key:\n  subprocess.check_output(cmd)", "subprocess.check_output(cmd)"),
    ("if token:\n    return None\n", "return None"),
    ("if not token:\n    raise SystemExit(1)\n", "raise SystemExit(1)"),
    ("with lock as token_store:\n    import hmac\n", "import hmac"),
    ("let token =\n  fetchToken(url);\n", "fetchToken(url);"),
    ("TOKEN=\n$(cat /etc/hostname)\n", "$(cat /etc/hostname)"),
    ("TOKEN=\n  Client::new(cfg);\n", "Client::new(cfg);"),
    ("secrets:\n  - name: db\n", "- name: db"),
    ('"token":\n  "name": 1\n', '"name": 1'),
    ("token:\n  # rotated\n  else:\n", "# rotated\n  else:"),
    ("if [ -z \"$PASSWORD\" ]; then PASSWORD=\n  fi; done\n", "fi; done"),
    ("TOKEN=\ncurl -sS https://api.example.com/v1/me\n", "curl -sS https://api.example.com/v1/me"),
    ("api_key:\n  git push origin main\n", "git push origin main"),
)
# The re-check's leak cases (probe_ruleb.py), values built from pieces:
# (text, the secret). Each is redacted now: no 6-character fragment is left.
TOK, PWD = "tok" + "en", "pass" + "word"
SHAPED = "a1B2" + "c3D4" + "e5F6" + "g7H8"
LOWER = "mfrgg" + "zdfmz" + "twqylk"  # 16, lower case only
HEXLC = "deadbeef" + "cafebabe" + "feedface"  # 24, hex letters only
DIGITS = "8392017465" + "83920174"  # 18, digits only
UPPER = "JBSWYDPE" + "HPKPXPAB"  # 16, upper case only
SHORT, SHORT8, SHORT11 = "hun" + "ter2", "Xk9#" + "pQ2z", "Xk9#pQ2z" + "Lm1"
NEXT_LINE_LEAKS = (
    (f"{TOK}:\n  {LOWER}\n", LOWER),
    (f"{PWD}:\n  {HEXLC}\n", HEXLC),
    (f"{PWD}:\n  {DIGITS}\n", DIGITS),
    (f"{TOK}:\n  {UPPER}\n", UPPER),
    (f"{PWD}:\n  {SHORT}\n", SHORT),
    (f"{PWD}:\n  {SHORT8}\n", SHORT8),
    (f"{PWD}:\n  {SHORT11}\n", SHORT11),
    (f"{TOK}:\n  '{LOWER}'\n", LOWER),
    (f"{PWD}:\n  \"correct horse {SHAPED}\"\n", SHAPED),
    (f"{TOK}:\n  \"{SHAPED[:12]} {SHAPED[12:]}xyz\"\n", SHAPED[12:] + "xyz"),
    (f"{PWD}:\n  Pa55(w0rd)Xyz12\n", "Pa55(w0rd)Xyz12"),
    (f"{PWD}:\n  Tr0ub4dor&3xyzabc\n", "Tr0ub4dor&3xyzabc"),
    (f"{TOK}:\n  {SHAPED} (prod)\n", SHAPED),
    (f"{TOK}:\n  {SHAPED}(x)\n", SHAPED),
    (f"export API_{TOK.upper()}=\n{LOWER}\n", LOWER),
    (f"{PWD.upper()}=\n{SHORT}\n", SHORT),
    # missed before commit 3 as well
    (f"{TOK}:\n  - {SHAPED}\n", SHAPED),
    (f"{TOK}: |\n  {SHAPED}\n", SHAPED),
    (f"{TOK}: >-\n  {SHAPED}\n", SHAPED),
    (f"{TOK}:\n  # rotated\n  {SHAPED}\n", SHAPED),
    (f"{TOK}:\n\u00a0\u00a0{SHAPED}\n", SHAPED),
    (f"{TOK}:\r{SHAPED}\n", SHAPED),
    (f"{TOK}:\u2028{SHAPED}\n", SHAPED),
    (f"{TOK}:\x0b{SHAPED}\n", SHAPED),
    (f"{PWD}:\n  Xy;9k2LmP0qRsT77\n", "Xy;9k2LmP0qRsT77"),
    (f"export API_{TOK.upper()}=\\\n{LOWER}\n", LOWER),
    (f"{PWD}:\n  do-not-share-Zq81\n", "do-not-share-Zq81"),  # a keyword only as a whole token
    (f"{TOK}:\n  iffy{DIGITS}\n", DIGITS),
)
# Redacted, that value only (an unquoted value ends at the next whitespace).
NEXT_LINE_SECRETS = (
    ("password:\n  hunter2hunter2", "hunter2hunter2"),
    ("client_secret:\n    AbCdEfGhIjKlMnOpQr", "AbCdEfGhIjKlMnOpQr"),
    ('token:\n  "Zx81mQ0pLk3vB7wq"', "Zx81mQ0pLk3vB7wq"),
    ("aws_session_token:\n  ASIAQWERTYUIOPAS", "ASIAQWERTYUIOPAS"),
    ("token:\n  abcdefghijklmnopqrst", "abcdefghijklmnopqrst"),  # one character class
    ("token:\n  0123456789012345", "0123456789012345"),  # one character class
    ("password:\n  Ab1cD2", "Ab1cD2"),  # under 12 characters
) + tuple((case, HEX) for case in PLUGIN_CASES if "\n" in case)


def leaves_a_fragment(out: str, secret: str) -> bool:
    k = min(6, len(secret))
    return any(secret[i:i + k] in out for i in range(len(secret) - k + 1))


class NextLineRule(unittest.TestCase):
    def outs(self, text):
        """The text as redact_string gives it, as a guard write preview (and
        that preview in the redacted guard state) and as a jev_decide state."""
        call = guard.summarize_call("write", {"path": "/w/x.py", "content": text})
        state = rr.redact_state({"call": call, "cwd": "/w"}, guard.QUESTIONS)
        sent, _, _ = rr.redact_request({"note": text}, {"q": {"type": "noul", "instructions": "Is `note` safe?"}},
                                       caller=True)
        return {"no limit": rr.redact_string(text, None), "default": rr.redact_string(text),
                "200": rr.redact_string(text, 200), "preview": call["content_preview"],
                "guard state": state["call"]["content_preview"], "decide": sent["note"]}

    def test_code_shaped_lines_stay_visible(self):
        for text, code in NEXT_LINE_CODE:
            for where, out in self.outs(text).items():
                with self.subTest(code=code, where=where):
                    self.assertIn(code, out)
                    self.assertTrue(app_clean(out), out)

    def test_common_commands_are_keywords(self):
        for word in ("curl", "wget", "git", "ssh", "cat", "scp", "rsync", "nc"):
            self.assertIn(word, rr.KEYWORDS)
            for where, out in self.outs(f"{TOK}:\n  {word} -v host\n").items():
                with self.subTest(word=word, where=where):
                    self.assertIn(f"{word} -v host", out)
                    self.assertTrue(app_clean(out), out)

    def test_the_recheck_leak_cases_are_redacted(self):
        for text, secret in NEXT_LINE_LEAKS:
            for where, out in self.outs(text).items():
                with self.subTest(text=text, where=where):
                    self.assertFalse(leaves_a_fragment(out, secret), out)
                    self.assertIn(rr.REDACTED, out)
                    self.assertTrue(app_clean(out), out)

    def test_a_next_line_value_is_redacted(self):
        for text, value in NEXT_LINE_SECRETS:
            for where, out in self.outs(text).items():
                with self.subTest(text=text, where=where):
                    self.assertNotIn(value, out)
                    self.assertIn(rr.REDACTED, out)
                    self.assertTrue(app_clean(out), out)

    def test_only_that_value_is_redacted(self):
        for text, value, kept in (
                (f"token:\n  {HEX} # rotated monthly\nnext_step: deploy\n", HEX, " # rotated monthly\nnext_step: deploy"),
                ("secret:\n  p@ss-w0rd-long;echo ok", "p@ss-w0rd-long;echo", " ok"),
                ("secret:\n  correct horse battery staple", "correct", " horse battery staple"),
                # code in none of the shapes is redacted too (the deterministic rules read the raw text)
                ("if token:\n    self.authenticated = True\n", "self.authenticated", " = True"),
                ("TOKEN=\n./exfiltrate.sh --quiet\n", "./exfiltrate.sh", " --quiet"),
                ("token:\n  Base64Decoder.decode (blob)", "Base64Decoder.decode", " (blob)")):
            for where, out in self.outs(text).items():
                with self.subTest(text=text, where=where):
                    self.assertNotIn(value, out)
                    self.assertIn(kept, out)

    def test_the_rule_is_linear(self):
        for text in ("token:\n" * 30000, "token:\n  " + "Ab1" * 100000, ("token:\n  " + "Ab1" * 4 + "(") * 2000,
                     "token-" * 20000 + ":\n" + "Ab1" * 20000, "#token:\n" * 20000, "token:\n#c\n" * 20000,
                     "token: |\n" * 20000, "token:" + " " * 60000 + "\n" * 60000 + "x",
                     "token:\n  \"" + "a" * 100000, "token:\n  - " * 20000):
            with self.subTest(n=len(text), head=text[:12]):
                t0 = time.monotonic()
                rr.redact_string(text, None)
                self.assertLess(time.monotonic() - t0, 2.0)


# ── 9. one shared read budget per guard call ─────────────────────────────────

# The re-check's probe_timing.py inputs (128 previews, a 64-edit multi_edit's
# anchors and texts, of the first took 2.77 s of the 3.85 s hook budget) and
# the c3 re-check's escaped ones: a pass scans the decoded text and its
# escaped views, where an emoji is 12 characters (ASCII view), a CJK
# character 6 and a control character 6 (in both views).
EMOJI, CJK, CTRL = "\U0001F600", "\u4e2d", "\x01"
TIMING_PROBES = {
    "dense name run, no space": ("password=a;") * 1800 + " x",
    "dense name run, short": ("password=a;") * 380 + " x",
    "dense name, spaced": ("password=a ") * 2000,
    "dense next-line": ("token:\nab ") * 3000,
    "jwt-ish run": ("eyJabcdefghij.") * 1800 + " x",
    "url-ish run": "a://u:p@" * 2600 + " x",
    "base64-ish, one space": "A" * 20000 + " " + "B" * 40000,
    "emoji": EMOJI * 20000 + " x",
    "cjk": CJK * 20000 + " x",
    "control": CTRL * 20000 + " x",
}
ESCAPED = ("emoji", "cjk", "control")


def chars_read(fn, *args, **kw):
    """fn's result and the characters relay_redact scanned on the way: the
    text of every find() call (a pass's decoded string, each escaped view of
    it, each body redact_state checks), counted apart from any ReadBudget,
    so a scan the budget refused is not counted."""
    with mock.patch.object(rr, "find", wraps=rr.find) as m:
        out = fn(*args, **kw)
    return out, sum(len(c.args[0]) for c in m.call_args_list)


def dense_paths(root="/w"):
    """The c3 re-check's dense next-line paths (probe_budget2.py): 64 paths of
    up to 4096 characters, 16 files, each under four spellings."""
    seg = ((TOK + ":\n") * 40)[:250]
    body = "/".join([seg] * 15)[:4096 - 40 - len(root)]
    return [f"{v}d{f:02d}/{body}" for f in range(16) for v in (f"{root}/", f"{root}/./", f"{root}//", f"{root}/././")]


def call_bound(state, questions):
    """GUARD_READ_CHARS, and the skeleton check redact_state makes uncharged
    once the call's budget is spent (every state string the placeholder)."""
    skeleton = rr._map(state, lambda s: rr.REDACTED)
    return guard.GUARD_READ_CHARS + sum(len(v) for v in rr.views(skeleton, questions))


class CallReadBudget(unittest.TestCase):
    def sixty_four(self, anchor, text, files=15, paths=None):
        edits = [{"path": paths[i] if paths else f"/w/f{i % files}.txt", "op": "replace", "anchor": anchor,
                  "text": text} for i in range(64)]
        self.assertEqual(len(edits), guard.MULTI_EDIT_MAX_EDITS)
        return {"edits": edits}

    def previews(self, call):
        """Grouped by file (first-appearance order): edit order for one file."""
        return [p[f] for e in call["files"] for p in e["previews"] for f in ("anchor_preview", "text_preview")]

    def multi_edit_call(self, tool_input):
        """summarize_multi_edit and redact_state on one call budget, as
        handle_multi_edit runs them."""
        budget = rr.ReadBudget(guard.GUARD_READ_CHARS)
        call = guard.summarize_multi_edit(tool_input, "/w", budget=budget)
        state_in = {"call": call, "cwd": "/w"}
        questions = guard.multi_edit_questions(len(call["files"]))
        return call, state_in, questions, rr.redact_state(state_in, questions, budget=budget), budget

    def send_events_call(self, bodies):
        """send_events_previews and redact_state on one call budget, as
        handle_send_events runs them."""
        budget = rr.ReadBudget(guard.GUARD_READ_CHARS)
        previews = guard.send_events_previews(bodies, [len(b) for b in bodies], budget=budget)
        state_in = {"call": {"tool": "send_events", "messages": previews}}
        questions = guard.send_events_questions(len(bodies))
        return previews, state_in, questions, rr.redact_state(state_in, questions, budget=budget), budget

    def assert_state_clean(self, state):
        for v in rr.views(state, {}):
            self.assertFalse(findings(v))

    def test_a_pass_is_charged_every_view_it_scans(self):
        for label in ("dense next-line", "emoji", "cjk", "control"):
            for s in (TIMING_PROBES[label], "word " * 2000, 'tab\tquote" ' * 500):
                for limit in (None, 200, 4096):
                    with self.subTest(label=label, head=s[:6], limit=limit):
                        budget = rr.ReadBudget(10 ** 9)
                        _, n = chars_read(rr.redact_string, s[:30000], limit, budget=budget)
                        self.assertEqual(budget.read, n)
        budget = rr.ReadBudget(10 ** 9)  # one clean emoji pass: decoded, the ASCII view, the compact view
        self.assertEqual(rr.redact_string(EMOJI * 1000, None, budget=budget), EMOJI * 1000)
        self.assertEqual(budget.read, 1000 + (12 * 1000 + 4) + (1000 + 4))

    def test_a_scan_is_charged_before_it_runs(self):
        s = EMOJI * 1000
        for room in (0, 999, 1000, 1000 + 12003, 1000 + 12004 + 1003):
            with self.subTest(room=room):
                budget = rr.ReadBudget(room)
                out, n = chars_read(rr.redact_string, s, None, budget=budget)
                self.assertEqual(out, rr.REDACTED)
                self.assertLessEqual(n, room)
                self.assertEqual(budget.read, n)
        self.assertEqual(rr.redact_string(s, None, budget=rr.ReadBudget(14008)), s)

    def test_the_previews_take_their_share_and_the_state_the_rest(self):
        call = rr.ReadBudget(1000)
        previews = rr.ReadBudget(600, within=call)
        previews.take(500)
        self.assertEqual((previews.left, previews.read, call.left, call.read), (100, 500, 500, 500))
        with self.assertRaises(rr._Spent):
            previews.take(101)
        call.take(450)
        with self.assertRaises(rr._Spent):
            previews.take(60)  # its share has room, the call has 50 left
        self.assertEqual((previews.left, call.left), (100, 50))

    def test_the_timing_probes_read_at_most_one_call_budget(self):
        for label, s in TIMING_PROBES.items():
            with self.subTest(label=label):
                (call, state_in, questions, state, budget), n = chars_read(self.multi_edit_call, self.sixty_four(s, s))
                self.assertLessEqual(n, call_bound(state_in, questions))
                self.assertLessEqual(budget.read, guard.GUARD_READ_CHARS)
                previews = self.previews(call)
                self.assertEqual(len(previews), 128)
                for p in previews:
                    self.assertLessEqual(len(p), guard.PREVIEW_CHARS)
                    self.assertTrue(app_clean(p), p)
                self.assert_state_clean(state)

    def test_the_worst_inputs_read_at_most_one_call_budget(self):
        dense = TIMING_PROBES["dense next-line"]
        cases = {f"{label} multi_edit": self.sixty_four(TIMING_PROBES[label], TIMING_PROBES[label])
                 for label in ESCAPED}
        cases["emoji previews, dense paths"] = self.sixty_four(TIMING_PROBES["emoji"], TIMING_PROBES["emoji"],
                                                               paths=dense_paths())
        cases["dense previews, dense paths"] = self.sixty_four(dense, dense, paths=dense_paths())
        for label, tool_input in cases.items():
            with self.subTest(label=label):
                (call, state_in, questions, state, budget), n = chars_read(self.multi_edit_call, tool_input)
                self.assertLessEqual(n, call_bound(state_in, questions))
                self.assertLessEqual(budget.read, guard.GUARD_READ_CHARS)
                self.assert_state_clean(state)
        for label in ESCAPED:
            with self.subTest(label=f"{label} send_events"):
                bodies = [TIMING_PROBES[label]] * guard.SEND_EVENTS_MAX_MESSAGES
                (previews, state_in, questions, state, budget), n = chars_read(self.send_events_call, bodies)
                self.assertLessEqual(n, call_bound(state_in, questions))
                self.assert_state_clean(state)

    def test_past_the_budget_a_state_string_is_the_placeholder(self):
        _, _, _, state, _ = self.multi_edit_call(self.sixty_four("old", "new", paths=dense_paths()))
        paths = [e["path"] for e in state["call"]["files"]] + [a for e in state["call"]["files"] for a in e["aliases"]]
        self.assertIn(rr.REDACTED, paths)
        self.assertEqual(rr.redact_state({"p": "abc", "q": ["x"]}, {}, budget=rr.ReadBudget(0)),
                         {"p": rr.REDACTED, "q": [rr.REDACTED]})
        # the strings fit, the body checks do not: every string is the placeholder
        state_in = {"a": "x" * 100, "n": 3}
        self.assertEqual(rr.redact_state(state_in, {}, budget=rr.ReadBudget(300)), {"a": rr.REDACTED, "n": 3})
        self.assertEqual(rr.redact_state(state_in, {}, budget=rr.ReadBudget(10_000)), state_in)

    def test_the_budget_is_spent_in_order_and_the_rest_is_the_placeholder(self):
        s = TIMING_PROBES["dense name run, no space"]
        _, alone = chars_read(rr.clip, s, guard.PREVIEW_CHARS)
        self.assertGreater(128 * alone, 4 * guard.PREVIEW_READ_CHARS)  # unbudgeted, the probe reads ~7.4 M
        previews = self.previews(guard.summarize_multi_edit(self.sixty_four(s, s, files=1), "/w"))
        self.assertTrue(previews[0].startswith("password=" + rr.REDACTED), previews[0][:40])
        self.assertEqual(previews[-1], rr.REDACTED)
        spent = previews.index(rr.REDACTED)
        self.assertGreater(spent, 8)
        self.assertEqual(previews[spent:], [rr.REDACTED] * (128 - spent))

    def test_an_ordinary_64_edit_multi_edit_keeps_every_preview(self):
        anchor, text = "def old_name(self):\n" * 3, "new text " * 600
        (call, state_in, questions, state, budget), n = chars_read(self.multi_edit_call, self.sixty_four(anchor, text))
        self.assertEqual(n, budget.read)
        for e in call["files"]:
            for p in e["previews"]:
                self.assertEqual((p["anchor_preview"], p["text_preview"]), (anchor, text[:guard.PREVIEW_CHARS]))
        self.assertEqual(state["call"], call)
        code = ("    total = compute(a, b)  # sum of parts\n" * 200)[:6000]  # 6000 ASCII characters each
        word = "word " * 1200
        for big in (code, word):
            with self.subTest(head=big[:8]):
                (call, state_in, questions, state, budget), n = chars_read(self.multi_edit_call,
                                                                           self.sixty_four(big, big))
                self.assertEqual(n, budget.read)
                self.assertLessEqual(budget.read, guard.GUARD_READ_CHARS)
                self.assertNotIn(rr.REDACTED, self.previews(call))
                self.assertEqual(state["call"], call)  # every preview and path kept

    def test_send_events_previews_share_the_budget(self):
        s = TIMING_PROBES["dense name run, no space"]
        bodies = [s] * guard.SEND_EVENTS_MAX_MESSAGES
        previews, n = chars_read(guard.send_events_previews, bodies, [len(b) for b in bodies])
        self.assertLessEqual(n, guard.PREVIEW_READ_CHARS)
        self.assertEqual(previews[-1]["body_preview"], rr.REDACTED)
        self.assertNotEqual(previews[0]["body_preview"], rr.REDACTED)

    def test_one_preview_calls_are_unchanged(self):
        cmd = "echo " + "word " * 6000
        self.assertEqual(guard.summarize_call("bash", {"command": cmd})["command"], cmd[:2000])
        self.assertEqual(guard.summarize_call("write", {"path": "x", "content": "A" * 10_000})["content_preview"],
                         "A" * 400)

    def test_read_budget_counts_what_clip_reads(self):
        budget = rr.ReadBudget(10_000)
        text = "word " * 2000
        out, n = chars_read(rr.clip, text, 200, budget=budget)
        self.assertEqual(out, text[:200])
        self.assertEqual((budget.read, budget.left), (n, 10_000 - n))
        outs = [rr.clip(text, 200, budget=budget) for _ in range(3)]
        self.assertEqual(outs[-1], rr.REDACTED)  # spent: read no further
        self.assertLessEqual(budget.read, 10_000)
        self.assertEqual(rr.clip("short", 200, budget=budget), "short")  # 5 + 9 for its view: there is room
        self.assertEqual(rr.clip(text, 5, budget=rr.ReadBudget(0)), "")  # no room for the placeholder
        tail = context.TRUNCATED.format(9)
        self.assertEqual(rr.clip("a b token: x " * 10, 40, tail, budget=rr.ReadBudget(200)), "")  # no room to check


class CallReadBudgetWiring(ConfirmCase):
    """The handlers run the previews and redact_state on one call budget."""

    def test_multi_edit_and_send_events(self):
        emo = TIMING_PROBES["emoji"]
        # ordinary paths: dense ones leave the state all placeholders, and
        # such a state is not sent (WipedStateSkip)
        paths = [str(self.ws / f"f{i % 15}.txt") for i in range(64)]
        edits = {"edits": [{"path": paths[i], "op": "replace", "anchor": emo, "text": emo} for i in range(64)]}
        for tool, tool_input in (("multi_edit", edits),
                                 ("send_events", self.msgs(*[emo] * guard.SEND_EVENTS_MAX_MESSAGES))):
            with self.subTest(tool=tool):
                self.fresh(tool)
                client = FakeClient()
                with mock.patch.object(rr, "redact_state", wraps=rr.redact_state) as rs:
                    r, n = chars_read(self.guard_at, tool, tool_input, client, self.cfg_for("auto"))
                self.assertEqual(len(client.calls), 1, r)
                (state_in, questions), kw = rs.call_args
                self.assertLessEqual(n, call_bound(state_in, questions))
                budget = kw["budget"]
                self.assertEqual(budget.left + budget.read, guard.GUARD_READ_CHARS)
                for v in rr.views(client.calls[0][0], {}):
                    self.assertFalse(findings(v))


# ── 10. clip's tail check covers all three views ─────────────────────────────

class ClipTail(unittest.TestCase):
    def test_a_lead_in_placeholder_at_the_cut_is_clean_with_the_notice(self):
        tail = context.TRUNCATED.format(9999)
        for lead in ("password:", "token:", "password=", "Cookie:"):
            text = "a b c " + lead + " xyzw " + "d " * 50
            limit = len(rr.redact_string("a b c " + lead + " xyzw", None))
            with self.subTest(lead=lead):
                kept = rr.clip(text, limit, tail=tail)
                self.assertTrue(kept.startswith("a b") and "a b c ".startswith(kept), kept)  # cut back, not emptied
                self.assertLessEqual(len(kept), limit)
                self.assertTrue(rr._clean(kept + tail), kept)
                self.assertTrue(app_clean(kept + tail))
                state, _, _ = rr.redact_request({"t": kept + tail}, {"x": {"type": "noul", "instructions": "i"}})
                self.assertEqual(state["t"], kept + tail)  # the notice is sent whole

    def test_the_context_report_keeps_its_notice(self):
        for lead in ("password:", "token:", "password=", "Cookie:", "--password"):
            text = "a " * 3000 + lead + " " + "c" * 10 + " " + "d " * 4000
            out = context.bounded_text(text, text.index(lead) + len(lead) + 1)
            with self.subTest(lead=lead):
                state, _, _ = rr.redact_request({"assistant_final_text": out},
                                                {"x": {"type": "noul", "instructions": "i"}})
                self.assertEqual(state["assistant_final_text"], out)
                self.assertIn(NOTICE, out)


# ── 11. the wiped-state flags are documented ─────────────────────────────────

class WipedFlagDocs(unittest.TestCase):
    def test_the_flags_are_documented_where_callers_read(self):
        self.assertIn("`state_redacted: true`", tools.DECIDE_SPEC["description"])
        self.assertIn("`context_redacted: true`", tools.SELECT_SPEC["description"])
        with open(os.path.join(ROOT, "skills", "jev-decide", "SKILL.md"), encoding="utf-8") as f:
            skill = f.read()
        for flag in ("state_redacted", "context_redacted"):
            self.assertIn(f"`{flag}: true`", skill)

    def test_the_flags_say_the_whole_state_was_replaced(self):
        """The flag is set when the string was wholly a secret too, not only
        when it could not be made clean (c3 re-check finding 6)."""
        with open(os.path.join(ROOT, "skills", "jev-decide", "SKILL.md"), encoding="utf-8") as f:
            skill = " ".join(f.read().split())
        with open(os.path.join(ROOT, "extensions", "jev", "tools.py"), encoding="utf-8") as f:
            source = f.read()
        self.assertIn("the whole state was replaced by the placeholder", tools.DECIDE_SPEC["description"])
        self.assertIn("the whole context was replaced by the placeholder", tools.SELECT_SPEC["description"])
        for what in ("state", "context"):
            self.assertIn(f"the whole {what} was replaced by the placeholder", skill)
            self.assertIn(f"the whole {what} was replaced by the placeholder", source)
        for text in (skill, source):
            self.assertNotIn("could not be made clean", text)

    def test_the_readme_says_what_the_next_line_rule_covers(self):
        with open(os.path.join(ROOT, "README.md"), encoding="utf-8") as f:
            readme = " ".join(f.read().split())
        for phrase in ("an unquoted value ends at the next whitespace", "a quoted value is redacted to its closing quote",
                       "Not covered", "GUARD_READ_CHARS", "PREVIEW_READ_CHARS"):
            self.assertIn(phrase, readme)
        self.assertNotIn("well under 1 s", readme)


# ── 12. a state with nothing left is not sent ────────────────────────────────

class WipedStateSkip(ConfirmCase):
    """A guard state that redaction left all placeholders (the dense-path
    state past the call's read budget) holds nothing for the model: no
    model call, the deterministic rules' result stands, as for a state too
    large for the relay (c4 re-check finding 5)."""

    def dense_edits(self, text="new"):
        return {"edits": [{"path": p, "op": "replace", "anchor": "old", "text": text}
                          for p in dense_paths(str(self.ws))]}

    def assert_skipped(self, r, client):
        self.assertEqual(r, {"action": "continue"})
        self.assertEqual(client.calls, [])
        self.assertEqual(self.audit.counters.get("guard.state_wiped_skip"), 1)
        for name in ("guard.relay_off", "guard.confirm_auto", "guard.error", "guard.continue", "guard.block"):
            self.assertNotIn(name, self.audit.counters)
        self.assertEqual(self.reasons(), ["continue"])
        self.assertEqual(self.rows(), [])  # no audit row, as for a state too large for the relay
        self.assert_no_confirm(r)

    def test_wiped_means_every_state_string_is_the_placeholder(self):
        red = rr.REDACTED
        for state in ({"call": {"tool": red, "files": [{"file": 0, "path": red, "edits": 4}]}, "cwd": red},
                      {"a": red, "n": 3, "b": [red, True, None]}, red):
            with self.subTest(state=state):
                self.assertTrue(rr.wiped(state))
        for state in ({"call": {"tool": "read", "path": red}, "cwd": red}, {"a": red, "b": [red, "x"]},
                      {}, {"n": 3}, [], "x", {"a": red, "key": rr.REDACTED_PRIVATE_KEY}):
            with self.subTest(state=state):
                self.assertFalse(rr.wiped(state))

    def test_a_dense_path_multi_edit_asks_nothing_and_continues(self):
        for mode in ("auto", "prompt"):
            with self.subTest(mode=mode):
                self.fresh(mode)
                client = FakeClient()
                with mock.patch.object(rr, "redact_state", wraps=rr.redact_state) as rs:
                    r = self.guard_at("multi_edit", self.dense_edits(), client, self.cfg_for(mode))
                self.assertEqual(rs.call_count, 1)  # the deterministic rules passed, the state was built
                self.assert_skipped(r, client)

    def test_the_deterministic_rules_still_decide_first(self):
        edits = self.dense_edits()
        edits["edits"][0]["text"] = RM_ROOT
        self.fresh("rm")
        client = FakeClient()
        with mock.patch.object(rr, "redact_state", wraps=rr.redact_state) as rs:
            r = self.guard_at("multi_edit", edits, client, self.cfg_for("auto"))
        self.assertEqual(r["action"], "block", r)
        self.assertIn("shell-safety rule", r["reason"])
        self.assertEqual((rs.call_count, client.calls), (0, []))
        self.assertNotIn("guard.state_wiped_skip", self.audit.counters)

    def test_every_handler_skips_a_wiped_state(self):
        def skeleton(state, questions, **_budget):
            return rr._map(state, lambda s: rr.REDACTED)
        calls = (("bash", {"command": "ls -la"}), ("write", {"path": str(self.ws / "a.txt"), "content": "x"}),
                 ("read", {"path": str(self.ws / "a.txt")}), ("multi_edit", self.edits(str(self.ws / "a.txt"))),
                 ("send_events", self.msgs("status ok")))
        for tool, tool_input in calls:
            for mode in ("auto", "prompt"):
                with self.subTest(tool=tool, mode=mode):
                    self.fresh(f"{tool}-{mode}")
                    client = FakeClient()
                    with mock.patch.object(rr, "redact_state", side_effect=skeleton):
                        r = self.guard_at(tool, tool_input, client, self.cfg_for(mode))
                    self.assert_skipped(r, client)

    def test_a_state_with_text_left_is_asked(self):
        self.fresh("partial")
        client = FakeClient()
        r = self.guard_at("read", {"path": AWS_KEY}, client, self.cfg_for("auto"))
        self.assertEqual(r, {"action": "continue"})
        self.assertEqual(len(client.calls), 1)
        self.assertNotIn(AWS_KEY, json.dumps(client.calls[0][0]))
        self.assertEqual(client.calls[0][0]["call"]["tool"], "read")
        self.assertNotIn("guard.state_wiped_skip", self.audit.counters)


# ── 13. a write/edit/read path that is not a string is malformed ─────────────

class NonStringPath(ConfirmCase):
    """A list or dict `path` became one state string per item, and the
    skeleton check redact_state makes uncharged scaled with it (c4 re-check
    finding 2: a 100 000-key dict took 3.71 s). It is malformed input,
    found before any redaction."""

    def test_a_non_string_path_is_malformed_and_reads_nothing(self):
        paths = {"dict": {f"/w/k{i}": "v" for i in range(20_000)}, "list": ["/w/a"] * 20_000,
                 "number": 7, "null": None}
        extras = {"write": {"content": "x"}, "edit": {"old_string": "a", "new_string": "b"}, "read": {}}
        for tool, extra in extras.items():
            for kind, path in paths.items():
                for mode in ("auto", "prompt"):
                    with self.subTest(tool=tool, path=kind, mode=mode):
                        self.fresh(f"{tool}-{kind}-{mode}")
                        client = FakeClient()
                        r, n = chars_read(self.guard_at, tool, {"path": path, **extra}, client, self.cfg_for(mode))
                        self.assertLessEqual(n, guard.GUARD_READ_CHARS)
                        self.assertEqual(n, 0)  # found before any redaction
                        self.assertEqual(client.calls, [])
                        self.assertEqual(self.audit.counters.get("guard.malformed"), 1)
                        want = f"malformed {tool} input (path is not a string)"
                        if mode == "auto":
                            self.assertIn(want, self.assert_auto_block(r))
                        else:
                            self.assertEqual(r["action"], "confirm", r)
                            self.assertIn(want, r["message"])

    def test_a_missing_or_string_path_is_unchanged(self):
        self.assertEqual(guard.summarize_call("read", {}), {"tool": "read", "path": ""})
        self.assertEqual(guard.summarize_call("read", {"path": "/w/a"}), {"tool": "read", "path": "/w/a"})
        self.assertEqual(guard.summarize_call("edit", {"path": "/w/a", "old_string": "x"})["path"], "/w/a")
        for tool in ("write", "edit", "read"):
            with self.subTest(tool=tool), self.assertRaises(guard.MalformedInput):
                guard.summarize_call(tool, {"path": ["/w/a"]})


if __name__ == "__main__":
    unittest.main()
