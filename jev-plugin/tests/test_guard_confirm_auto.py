#!/usr/bin/env python3
"""guard_confirm: `auto` (the default) or `prompt`.

Under an allow-all approval policy a Jev guard CONFIRM must never reach the
user: the host turns a hook Confirm into an
interactive prompt, and the app's allow-all does not reach the host. Under
`auto` every confirm source is sorted into one of three classes:

  a. model-derived (decide()'s thresholds, the multi_edit summary, the
     send_events leak score): continue, counted guard.confirm_auto;
  b. evaluation failures (timeout, budget, transport, no timer, an
     unresolvable target): continue (guard.error_auto) only when every
     deterministic rule for the call has run and passed, else block;
  c. deterministic findings that confirm under `prompt` (shell text too
     large, a send_events secret pattern, rule 1 could not check, malformed
     input): block, with the same text.

`prompt` keeps the confirm everywhere, exactly as before. Offline: a fake
client stands in for Jev. Run:

    python3 -B -m unittest discover -s tests -p 'test_guard_confirm_auto.py' -v
"""
from __future__ import annotations

import io
import json
import time
import unittest
from unittest import mock

from test_guard_parity import CANARY, SAFE, FakeClient, GuardCase, noul, score  # noqa: F401 (sys.path set there)

import jev_ext  # noqa: E402
from jev import audit as audit_mod  # noqa: E402
from jev import guard, logs  # noqa: E402
from jev.client import JevError  # noqa: E402

AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE"
TRANSPORT = "decision transport or response failure"
RM_ROOT = "#!/bin/bash\nrm -rf /\n"

# decide()'s four confirm triggers, each alone (the rest of the answer is SAFE)
MODEL_TRIGGERS = {
    "risk at ask_at": {"risk": score(1.5, 0.9)},
    "confidence under min_conf": {"risk": score(0.2, 0.4)},
    "leak at secrets_at": {"leak": noul(0.5)},
    "escape at escape_at": {"leaves_workspace": noul(0.7)},
}


class ConfirmCase(GuardCase):
    def cfg_for(self, mode=None, **extra):
        """mode None: the key is absent."""
        cfg = {"project_root": str(self.ws), **extra}
        if mode is not None:
            cfg["guard_confirm"] = mode
        return guard.GuardConfig(cfg)

    def fresh(self, name):
        """A new audit (counters, explanations, rows) and log for one subtest."""
        self.audit_path = self.root / f"audit-{name.replace(' ', '-')}.jsonl"
        self.audit = audit_mod.Audit(str(self.audit_path))
        self.logs = []

    def rows(self):
        return [json.loads(x) for x in self.audit_text().splitlines() if x.strip()]

    def reasons(self):
        return [e["reason"] for e in self.audit.explanations()]

    def assert_no_confirm(self, r):
        """No confirm anywhere: the result, the counters, the explanations and the audit rows."""
        self.assertNotEqual(r.get("action"), "confirm", r)
        self.assertNotIn("message", r)
        self.assertNotIn("guard.confirm", self.audit.counters)
        self.assertNotIn("confirm", self.reasons())
        self.assertNotIn("confirm", [row.get("action") for row in self.rows()])
        self.assertNotIn("approve manually", json.dumps(r))

    def assert_auto_block(self, r):
        self.assertEqual(r["action"], "block", r)
        self.assertIn("blocked, not prompted (guard_confirm = auto)", r["reason"])
        self.assert_no_confirm(r)
        return r["reason"]

    def guard_at(self, tool, tool_input, client, cfg, *, started=None, cwd=...):
        params = {"kind": "before_tool_call", "tool_name": tool, "tool_runtime_name": tool,
                  "tool_input": tool_input, "session_id": "sess-1"}
        if cwd is not None:
            params["cwd"] = str(self.ws) if cwd is ... else cwd
        return guard.handle(params, client, cfg, self.audit, self.logs.append, started=started)

    def msgs(self, *bodies):
        return {"source": "worker-v", "messages": [{"session": f"s{i}", "body": b} for i, b in enumerate(bodies)]}

    def edits(self, *paths, text="new"):
        return {"edits": [{"path": p, "op": "replace", "anchor": "old", "text": text} for p in paths]}


# ── the config key ──────────────────────────────────────────────────────────

class ConfigKey(unittest.TestCase):
    def test_missing_and_unknown_values_are_auto(self):
        self.assertEqual(guard.GuardConfig({}).confirm, "auto")
        for value in (None, "", "auto", " AUTO ", "bogus", "prompts", "confirm", "off", "yes", 0, 1, True, [], {}):
            with self.subTest(value=value):
                self.assertEqual(guard.GuardConfig({"guard_confirm": value}).confirm, "auto")

    def test_prompt_is_the_only_other_mode(self):
        for value in ("prompt", " Prompt ", "PROMPT"):
            with self.subTest(value=value):
                self.assertEqual(guard.GuardConfig({"guard_confirm": value}).confirm, "prompt")
        self.assertEqual(guard.GUARD_CONFIRM_MODES, ("auto", "prompt"))

    def test_an_extension_without_plugin_config_is_auto(self):
        """B28: a replacement plugin drops its config dir; no config is auto."""
        self.assertEqual(jev_ext.Extension().guard_cfg.confirm, "auto")
        with mock.patch.object(jev_ext.Extension, "_initialize_key"), \
                mock.patch.object(jev_ext.Extension, "activate_relay"):
            for params, mode in (({}, "auto"), ({"config": {}}, "auto"), ({"config": None}, "auto"),
                                 ({"config": {"guard_confirm": "prompt"}}, "prompt"),
                                 ({"config": {"guard_confirm": "nonsense"}}, "auto")):
                with self.subTest(params=params):
                    ext = jev_ext.Extension()
                    ext.initialize(params)
                    self.assertEqual(ext.guard_cfg.confirm, mode)


# ── class a: model-derived confirms ────────────────────────────────────────

class ModelConfirm(ConfirmCase):
    def test_auto_each_decide_trigger_continues_and_is_counted(self):
        for name, overrides in MODEL_TRIGGERS.items():
            for mode in ("auto", None):
                with self.subTest(name, mode=mode):
                    self.fresh(f"{name}-{mode}")
                    client = FakeClient(overrides)
                    r = self.guard_at("bash", {"command": "ls"}, client, self.cfg_for(mode))
                    self.assertEqual(r, {"action": "continue"})
                    self.assertEqual(len(client.calls), 1, "Jev was asked")
                    self.assertEqual(self.audit.counters.get("guard.confirm_auto"), 1)
                    self.assert_no_confirm(r)
                    self.assertIn("confirm_auto", self.reasons())
                    row = self.rows()[-1]
                    self.assertEqual(row["action"], "confirm_auto")
                    self.assertTrue(row["why"].startswith("risk="), row)
                    self.assertIn("answers", row, "the row keeps what Jev answered")
                    self.assertEqual([x for x in self.logs if "confirm→continue" in x],
                                     [f"guard bash: confirm→continue (auto) {row['why']}"])

    def test_prompt_keeps_each_decide_trigger_a_confirm(self):
        for name, overrides in MODEL_TRIGGERS.items():
            with self.subTest(name):
                self.fresh(name)
                r = self.guard_at("bash", {"command": "ls"}, FakeClient(overrides), self.cfg_for("prompt"))
                self.assertEqual(r["action"], "confirm")
                self.assertTrue(r["message"].startswith("jev: risk="))
                self.assertEqual(self.audit.counters.get("guard.confirm"), 1)
                self.assertNotIn("guard.confirm_auto", self.audit.counters)
                self.assertEqual(self.rows()[-1]["action"], "confirm")

    def test_a_clear_answer_is_not_counted_as_auto(self):
        r = self.guard_at("bash", {"command": "ls"}, FakeClient(), self.cfg_for("auto"))
        self.assertEqual(r, {"action": "continue"})
        self.assertNotIn("guard.confirm_auto", self.audit.counters)
        self.assertEqual(self.rows()[-1]["action"], "continue")

    def test_a_jev_block_blocks_in_both_policies(self):
        for mode in ("auto", "prompt", None):
            with self.subTest(mode=mode):
                self.fresh(f"block-{mode}")
                cfg = self.cfg_for(mode, guard_block_at=2.8)
                r = self.guard_at("bash", {"command": "ls"}, FakeClient({"risk": score(3.0, 0.9)}), cfg)
                self.assertEqual(r["action"], "block")
                self.assertIn("jev: blocked.", r["reason"])
                self.assertNotIn("guard.confirm_auto", self.audit.counters)
                me = self.guard_at("multi_edit", self.edits("a.txt", "b.txt"),
                                   FakeClient({"risk_1": score(3.0, 0.9), "leak_0": noul(0.9)}), cfg)
                self.assertEqual(me["action"], "block", "block beats a confirm in both policies")

    def test_a_late_jev_block_still_blocks_under_auto(self):
        """The audit row of a block that cannot be written in time does not
        turn the block into an evaluation failure (which would continue)."""
        cfg = self.cfg_for("auto", guard_block_at=2.8)
        with mock.patch.object(guard, "_write_audit", side_effect=guard.BudgetSpent()):
            r = self.guard_at("bash", {"command": "ls"}, FakeClient({"risk": score(3.0, 0.9)}), cfg)
        self.assertEqual(r["action"], "block")

    def test_auto_multi_edit_summary_confirm_continues(self):
        client = FakeClient({"leak_1": noul(0.9)})
        r = self.guard_at("multi_edit", self.edits("a.txt", "creds.env"), client, self.cfg_for("auto"))
        self.assertEqual(r, {"action": "continue"})
        self.assertEqual(self.audit.counters.get("guard.confirm_auto"), 1)
        self.assert_no_confirm(r)
        row = self.rows()[-1]
        self.assertEqual(row["action"], "confirm_auto")
        self.assertIn("1 of 2 files tripped", row["why"])
        self.assertTrue(any(x.startswith("guard multi_edit: confirm→continue (auto) 1 of 2 files tripped")
                            for x in self.logs), self.logs)
        r = self.guard_at("multi_edit", self.edits("a.txt", "creds.env"), FakeClient({"leak_1": noul(0.9)}),
                          self.cfg_for("prompt"))
        self.assertEqual(r["action"], "confirm")
        self.assertIn("creds.env", r["message"])

    def test_auto_multi_edit_file_answer_failure_continues(self):
        r = self.guard_at("multi_edit", self.edits("a.txt", "b.txt"), FakeClient({"risk_1": {"type": "score"}}),
                          self.cfg_for("auto"))
        self.assertEqual(r, {"action": "continue"})
        self.assertEqual(self.audit.counters.get("guard.confirm_auto"), 1)
        self.assertEqual(self.audit.counters.get("guard.file_error"), 1)
        self.assert_no_confirm(r)

    def test_auto_send_events_leak_score_only_continues(self):
        client = FakeClient({"leak_1": noul(0.9)})
        r = self.guard_at("send_events", self.msgs("hello", "plain words"), client, self.cfg_for("auto"))
        self.assertEqual(r, {"action": "continue"})
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(self.audit.counters.get("guard.confirm_auto"), 1)
        self.assert_no_confirm(r)
        row = self.rows()[-1]
        self.assertEqual(row["action"], "confirm_auto")
        self.assertIn("messages[1] leak=0.90", row["why"])
        self.assertTrue(any(x.startswith("guard send_events: confirm→continue (auto)") for x in self.logs))
        r = self.guard_at("send_events", self.msgs("hello", "plain words"), FakeClient({"leak_1": noul(0.9)}),
                          self.cfg_for("prompt"))
        self.assertEqual(r["action"], "confirm")

    def test_allow_all_policy_model_confirm_reaches_no_prompt(self):
        """End to end through the extension, default config (no plugin
        config at all): a model confirm answers continue on the wire."""
        ext = jev_ext.Extension()
        ext.cfg = {"project_root": str(self.ws)}
        ext.guard_cfg = guard.GuardConfig(ext.cfg)
        ext.client = FakeClient({"risk": score(2.7, 0.7), "leaves_workspace": noul(0.97)})
        ext.audit = self.audit
        ext.recompute_features()
        sent, err = [], io.StringIO()
        log_path = self.root / "jev.log"
        orig_send, orig_stderr, orig_filelog = jev_ext.send, jev_ext.STDERR, jev_ext.FILELOG
        jev_ext.send = sent.append
        jev_ext.STDERR = jev_ext.StderrLog(write=lambda data: err.write(data.decode()) and len(data))
        jev_ext.FILELOG = logs.FileLog(log_path)
        try:
            jev_ext.dispatch(ext, {"jsonrpc": "2.0", "id": 3, "method": "hook.handle",
                                   "params": {"kind": "before_tool_call", "tool_name": "bash",
                                              "tool_runtime_name": "bash", "session_id": "sess-1",
                                              "tool_input": {"command": "git push origin main"}}},
                             received=time.monotonic())
        finally:
            jev_ext.send, jev_ext.STDERR, jev_ext.FILELOG = orig_send, orig_stderr, orig_filelog
        self.assertEqual(sent[0]["result"], {"action": "continue"})
        self.assertEqual(self.audit.counters.get("guard.confirm_auto"), 1)
        # a routine line: jev.log, not stderr (the host forwards only 128 KiB of it)
        self.assertIn("confirm→continue (auto)", log_path.read_text())
        self.assertNotIn("confirm→continue (auto)", err.getvalue())


# ── class b: evaluation failures ────────────────────────────────────────────

class EvaluationFailure(ConfirmCase):
    def test_auto_transport_error_after_a_clean_shell_rule_continues(self):
        cases = {
            "bash": ("bash", {"command": "ls -la"}),
            "write script": ("write", {"path": "run.sh", "content": "#!/bin/bash\necho hi\n"}),
            "read": ("read", {"path": "a.txt"}),
            "multi_edit": ("multi_edit", self.edits("a.txt", "run.sh", text="echo hi\n")),
            "send_events": ("send_events", self.msgs("hello")),
        }
        for name, (tool, tool_input) in cases.items():
            with self.subTest(name):
                self.fresh(name)
                client = FakeClient(error=JevError(TRANSPORT))
                r = self.guard_at(tool, tool_input, client, self.cfg_for("auto"))
                self.assertEqual(r, {"action": "continue"})
                self.assertEqual(len(client.calls), 1, "the local rules passed and Jev was asked")
                self.assertEqual(self.audit.counters.get("guard.error_auto"), 1)
                self.assertEqual(self.audit.counters.get("guard.error"), 1)
                self.assert_no_confirm(r)
                self.assertIn("error_auto", self.reasons())
                row = self.rows()[-1]
                self.assertEqual((row["action"], row["error"]), ("error_auto", "transport error"))
                self.assertTrue(any(f"guard {tool}: error after" in x and "continue (auto" in x
                                    for x in self.logs), self.logs)

    def test_prompt_keeps_the_error_confirm(self):
        r = self.guard_at("bash", {"command": "ls"}, FakeClient(error=JevError(TRANSPORT)), self.cfg_for("prompt"))
        self.assertEqual(r["action"], "confirm")
        self.assertIn("could not evaluate this bash call (transport error)", r["message"])
        self.assertNotIn("guard.error_auto", self.audit.counters)

    def test_auto_malformed_answer_continues(self):
        r = self.guard_at("bash", {"command": "ls"}, FakeClient({"risk": score(float("nan"), 0.9)}),
                          self.cfg_for("auto"))
        self.assertEqual(r, {"action": "continue"})
        self.assertEqual(self.audit.counters.get("guard.error_auto"), 1)

    def test_auto_budget_spent_before_the_shell_rule_blocks(self):
        client = FakeClient()
        # spent for the scan (deadline - REPLY_MARGIN_S), still inside the audit row's grace
        started = time.monotonic() - guard.HOOK_BUDGET_S + 0.05
        r = self.guard_at("bash", {"command": "ls"}, client, self.cfg_for("auto"), started=started)
        reason = self.assert_auto_block(r)
        self.assertIn("could not be checked; retry or split it", reason)
        self.assertIn("hook budget spent", reason)
        self.assertEqual(client.calls, [])
        self.assertNotIn("guard.error_auto", self.audit.counters)
        self.assertEqual(self.rows()[-1]["action"], "block")
        r = self.guard_at("bash", {"command": "ls"}, client, self.cfg_for("prompt"), started=time.monotonic() - 60)
        self.assertEqual(r["action"], "confirm")

    def test_auto_budget_spent_with_no_local_rule_to_run_continues(self):
        """A read has no deterministic rule: a spent budget is Jev-off for it."""
        client = FakeClient()
        r = self.guard_at("read", {"path": "a.txt"}, client, self.cfg_for("auto"), started=time.monotonic() - 60)
        self.assertEqual(r, {"action": "continue"})
        self.assertEqual(self.audit.counters.get("guard.error_auto"), 1)

    def test_auto_no_timer_blocks_a_shell_text_and_continues_a_read(self):
        with mock.patch.object(guard, "hard_timer_available", return_value=False):
            r = self.guard_at("bash", {"command": "ls"}, FakeClient(), self.cfg_for("auto"))
            self.assertIn("deadline unavailable", self.assert_auto_block(r))
            for tool, tool_input in (("multi_edit", self.edits("a.txt")), ("send_events", self.msgs("hi"))):
                with self.subTest(tool):
                    self.assertEqual(self.guard_at(tool, tool_input, FakeClient(), self.cfg_for("auto"))["action"],
                                     "block")
            self.fresh("read")
            r = self.guard_at("read", {"path": "a.txt"}, FakeClient(), self.cfg_for("auto"))
            self.assertEqual(r, {"action": "continue"})
            self.assertEqual(self.audit.counters.get("guard.error_auto"), 1)
            r = self.guard_at("read", {"path": "a.txt"}, FakeClient(), self.cfg_for("prompt"))
            self.assertEqual(r["action"], "confirm")

    def test_auto_unresolvable_target_continues_after_the_shell_rule(self):
        client = FakeClient()
        r = self.guard_at("multi_edit", self.edits("rel.txt"), client, self.cfg_for("auto"), cwd=None)
        self.assertEqual(r, {"action": "continue"})
        self.assertEqual(client.calls, [])
        self.assertEqual(self.audit.counters.get("guard.unresolved"), 1)
        self.assertEqual(self.audit.counters.get("guard.error_auto"), 1)
        self.assert_no_confirm(r)
        self.assertEqual(self.rows()[-1]["action"], "error_auto")
        r = self.guard_at("multi_edit", self.edits("rel.txt"), client, self.cfg_for("prompt"), cwd=None)
        self.assertEqual(r["action"], "confirm")

    def test_unresolvable_target_with_a_shell_finding_blocks_in_both_policies(self):
        for mode in ("auto", "prompt"):
            with self.subTest(mode=mode):
                r = self.guard_at("multi_edit", self.edits("run.sh", text=RM_ROOT), FakeClient(),
                                  self.cfg_for(mode), cwd=None)
                self.assertEqual(r["action"], "block")
                self.assertIn("shell-safety rule", r["reason"])

    def test_auto_crashed_guard_blocks_on_the_wire(self):
        ext = jev_ext.Extension()
        ext.cfg = {"project_root": str(self.ws)}
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
        result = sent[0]["result"]
        self.assertEqual(result["action"], "block")
        self.assertIn("internal error", result["reason"])
        self.assertIn("retry or split it", result["reason"])
        self.assertNotIn(CANARY, json.dumps(sent))


# ── order: the deterministic rules before anything slow ────────────────────

class SlowMultiEdit(ConfirmCase):
    def rm_root_edit(self):
        return {"edits": [{"path": "a.txt", "op": "replace", "anchor": "old", "text": "new"},
                          {"path": "run.sh", "op": "insert_after", "anchor": "x", "text": RM_ROOT}]}

    def test_a_budget_spending_summarize_with_rm_rf_root_blocks_in_both_policies(self):
        for mode in ("auto", "prompt", None):
            with self.subTest(mode=mode):
                client = FakeClient()
                with mock.patch.object(guard, "summarize_multi_edit", side_effect=guard.BudgetSpent()):
                    r = self.guard_at("multi_edit", self.rm_root_edit(), client, self.cfg_for(mode))
                self.assertEqual(r["action"], "block", r)
                self.assertIn("shell-safety rule", r["reason"])
                self.assertEqual(client.calls, [])

    def test_a_tiny_budget_with_rm_rf_root_blocks_under_auto(self):
        client = FakeClient()
        r = self.guard_at("multi_edit", self.rm_root_edit(), client, self.cfg_for("auto"),
                          started=time.monotonic() - 60)
        self.assertEqual(r["action"], "block")
        self.assertEqual(client.calls, [])
        self.assert_no_confirm(r)

    def test_the_shell_rule_runs_before_the_realpath_previews(self):
        order = []
        real_rule, real_summary = guard.shell_rule, guard.summarize_multi_edit

        def rule(*a, **kw):
            order.append("shell_rule")
            return real_rule(*a, **kw)

        def summary(*a, **kw):
            order.append("summarize")
            return real_summary(*a, **kw)
        with mock.patch.object(guard, "shell_rule", rule), mock.patch.object(guard, "summarize_multi_edit", summary):
            r = self.guard_at("multi_edit", self.edits("a.txt", "run.sh", text="echo hi\n"), FakeClient(),
                              self.cfg_for("auto"))
        self.assertEqual(r, {"action": "continue"})
        self.assertEqual(order, ["shell_rule", "summarize"])

    def test_a_budget_spending_summarize_on_a_clean_multi_edit(self):
        for mode, action in (("auto", "continue"), ("prompt", "confirm")):
            with self.subTest(mode=mode):
                self.fresh(mode)
                client = FakeClient()
                with mock.patch.object(guard, "summarize_multi_edit", side_effect=guard.BudgetSpent()):
                    r = self.guard_at("multi_edit", self.edits("a.txt", "run.sh", text="echo hi\n"), client,
                                      self.cfg_for(mode))
                self.assertEqual(r["action"], action)
                self.assertEqual(client.calls, [])
                if mode == "auto":
                    self.assertEqual(self.audit.counters.get("guard.error_auto"), 1)
                    self.assert_no_confirm(r)


# ── class c: deterministic findings ────────────────────────────────────────

class DeterministicFinding(ConfirmCase):
    def test_auto_send_events_secret_pattern_blocks(self):
        client = FakeClient()
        r = self.guard_at("send_events", self.msgs("hello", f"the key is {AWS_KEY} ok"), client, self.cfg_for("auto"))
        reason = self.assert_auto_block(r)
        self.assertIn("jev: send_events body matches a secret pattern:\nmessages[1]", reason)
        self.assertNotIn(AWS_KEY, json.dumps(r))
        self.assertEqual(client.calls, [])
        self.assertEqual(self.audit.counters.get("guard.secret_pattern"), 1)
        self.assertEqual(self.audit.counters.get("guard.block"), 1)
        self.assertEqual(self.rows()[-1]["action"], "block")
        r = self.guard_at("send_events", self.msgs("hello", f"the key is {AWS_KEY} ok"), client,
                          self.cfg_for("prompt"))
        self.assertEqual(r["action"], "confirm")
        self.assertTrue(r["message"].endswith("\napprove manually?"))

    def test_the_secret_scan_runs_before_the_previews(self):
        with mock.patch.object(guard, "send_events_previews", side_effect=guard.BudgetSpent(), create=True):
            r = self.guard_at("send_events", self.msgs(f"{AWS_KEY}"), FakeClient(), self.cfg_for("auto"))
        self.assertEqual(r["action"], "block")
        self.assertIn("secret pattern", r["reason"])

    def test_auto_budget_spent_during_the_secret_scan_blocks(self):
        with mock.patch.object(guard, "scan_secrets", side_effect=guard.BudgetSpent()):
            r = self.guard_at("send_events", self.msgs("hello"), FakeClient(), self.cfg_for("auto"))
        self.assertIn("could not be checked; retry or split it", self.assert_auto_block(r))

    def test_auto_shell_text_over_the_scan_bound_blocks(self):
        big = "echo hi\n" * (guard.SHELL_SCAN_MAX_BYTES // 8 + 1)
        client = FakeClient()
        r = self.guard_at("bash", {"command": big}, client, self.cfg_for("auto"))
        reason = self.assert_auto_block(r)
        self.assertIn("jev: this bash call's shell text is too large to check", reason)
        self.assertEqual(client.calls, [])
        self.assertEqual(self.audit.counters.get("guard.shell_too_large"), 1)
        self.assertEqual(self.audit.counters.get("guard.block"), 1)
        r = self.guard_at("bash", {"command": big}, client, self.cfg_for("prompt"))
        self.assertEqual(r["action"], "confirm")

    def test_auto_shell_text_over_the_scan_bound_blocks_with_no_model_guard(self):
        params = {"kind": "before_tool_call", "tool_name": "bash", "tool_runtime_name": "bash",
                  "tool_input": {"command": "echo hi\n" * (guard.SHELL_SCAN_MAX_BYTES // 8 + 1)},
                  "session_id": "sess-1"}
        r = guard.shell_rule_only(params, self.cfg_for("auto"), self.audit, self.logs.append)
        self.assert_auto_block(r)

    def test_auto_rule1_could_not_check_blocks(self):
        params = {"kind": "before_tool_call", "tool_name": "bash", "tool_runtime_name": "bash",
                  "tool_input": {"command": "ls"}, "session_id": "sess-1"}
        r = guard.rule1_check(params, self.cfg_for("auto", guard_rule1_scope="all"), self.audit, self.logs.append,
                              started=time.monotonic() - 60)
        reason = self.assert_auto_block(r)
        self.assertIn("jev: the rule-1 guard could not check this bash call (hook budget spent)", reason)
        self.assertEqual(self.audit.counters.get("guard.rule1.block"), 1)
        self.assertNotIn("guard.rule1.confirm", self.audit.counters)
        r = guard.rule1_check(params, self.cfg_for("prompt", guard_rule1_scope="all"), self.audit,
                              self.logs.append, started=time.monotonic() - 60)
        self.assertEqual(r["action"], "confirm")

    def test_auto_malformed_input_blocks(self):
        cases = {"multi_edit": {"edits": []}, "send_events": {"messages": []},
                 "multi_edit 17 files": self.edits(*[f"f{i}.txt" for i in range(17)])}
        for name, tool_input in cases.items():
            tool = name.split()[0]
            with self.subTest(name):
                self.fresh(name)
                client = FakeClient()
                r = self.guard_at(tool, tool_input, client, self.cfg_for("auto"))
                reason = self.assert_auto_block(r)
                self.assertIn(f"jev: malformed {tool} input (", reason)
                self.assertEqual(client.calls, [])
                self.assertEqual(self.audit.counters.get("guard.malformed"), 1)
                r = self.guard_at(tool, tool_input, client, self.cfg_for("prompt"))
                self.assertEqual(r["action"], "confirm")

    def test_shell_rule_confirm_mode_is_an_explicit_opt_in(self):
        """guard_shell_rule = confirm asks on a finding in both policies."""
        for mode in ("auto", "prompt"):
            with self.subTest(mode=mode):
                r = self.guard_at("bash", {"command": "rm -rf /"}, FakeClient(),
                                  self.cfg_for(mode, guard_shell_rule="confirm"))
                self.assertEqual(r["action"], "confirm")
                self.assertIn("shell-safety rule", r["message"])

    def test_shell_rule_findings_block_in_both_policies(self):
        for mode in ("auto", "prompt"):
            with self.subTest(mode=mode):
                r = self.guard_at("bash", {"command": "rm -rf /"}, FakeClient(), self.cfg_for(mode))
                self.assertEqual(r["action"], "block")


if __name__ == "__main__":
    unittest.main()
