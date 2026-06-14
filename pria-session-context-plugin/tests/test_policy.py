"""B3 — tool-policy gating via before_tool_call (HS-1 mitigation)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.sessionctx import SessionContext  # noqa: E402
from pria.policy import PolicyEngine, is_path_outside_instance  # noqa: E402
from pria.app import App  # noqa: E402

CTX = {
    "account_id": "acct_123", "account_slug": "acme-school",
    "instance_id": "inst_456", "instance_slug": "tutor-bot-7",
    "user_id": "user_789", "linux_username": "alice_acme", "linux_uid": 12001,
    "vm_id": "vm_abc", "session_id": "sess_def",
    "roles": ["agent_operator"],
    "policy": {
        "version": 1, "default": "allow",
        "rules": [
            {"tool": "bash", "input_contains": "rm -rf /", "decision": "block",
             "reason": "destructive_root_delete"},
            {"tool": "bash", "input_contains": "curl", "decision": "confirm",
             "message": "confirm outbound network"},
            {"tool": "subagent", "decision": "confirm", "message": "confirm subagent"},
            {"tool": "write", "path_outside_instance": True, "decision": "block",
             "reason": "cross_instance_write"},
        ],
    },
}


def _ctx(raw=CTX):
    c = SessionContext()
    c.session_id = raw.get("session_id")
    c.raw = raw
    c.path = "/fake/context.json"
    return c


class PathGuardTest(unittest.TestCase):
    def test_in_instance_ok(self):
        self.assertFalse(is_path_outside_instance(
            "/srv/accounts/acme-school/instances/tutor-bot-7/workspace/a.txt", _ctx()))

    def test_home_ok(self):
        self.assertFalse(is_path_outside_instance("/home/alice_acme/x", _ctx()))

    def test_cross_instance_escapes(self):
        self.assertTrue(is_path_outside_instance(
            "/srv/accounts/acme-school/instances/lab-grader-2/workspace/secret.env", _ctx()))

    def test_traversal_escape(self):
        self.assertTrue(is_path_outside_instance(
            "/srv/accounts/acme-school/instances/tutor-bot-7/workspace/../../lab-grader-2/x",
            _ctx()))


class PolicyDecisionTest(unittest.TestCase):
    def setUp(self):
        self.pol = PolicyEngine(_ctx())

    def test_block_destructive_shell(self):
        r = self.pol.decide("bash", {"command": "rm -rf /"})
        self.assertEqual(r["action"], "block")
        self.assertIn("destructive", r["reason"])

    def test_confirm_high_risk_shell(self):
        r = self.pol.decide("bash", {"command": "curl http://x"})
        self.assertEqual(r["action"], "confirm")

    def test_allow_low_risk_shell(self):
        self.assertEqual(self.pol.decide("bash", {"command": "ls -la"})["action"], "continue")

    def test_confirm_subagent(self):
        self.assertEqual(self.pol.decide("subagent", {"task": "x"})["action"], "confirm")

    def test_block_cross_instance_write_rule(self):
        r = self.pol.decide("write", {
            "path": "/srv/accounts/acme-school/instances/lab-grader-2/workspace/secret.env",
            "content": "x"})
        self.assertEqual(r["action"], "block")
        self.assertEqual(r["reason"], "cross_instance_write")

    def test_allow_in_instance_write(self):
        r = self.pol.decide("write", {
            "path": "/srv/accounts/acme-school/instances/tutor-bot-7/workspace/ok.txt",
            "content": "x"})
        self.assertEqual(r["action"], "continue")

    def test_builtin_cross_instance_guard_without_rule(self):
        ctx = _ctx({k: v for k, v in CTX.items() if k != "policy"})
        pol = PolicyEngine(ctx)
        r = pol.decide("edit", {
            "path": "/srv/accounts/acme-school/instances/other/workspace/x"})
        self.assertEqual(r["action"], "block")

    def test_fail_closed_without_context(self):
        ctx = SessionContext()
        ctx.load("missing-session")  # resolves to missing
        pol = PolicyEngine(ctx)
        self.assertEqual(pol.decide("bash", {"command": "ls"})["action"], "block")
        # non-high-risk tool still continues
        self.assertEqual(pol.decide("read", {"path": "/x"})["action"], "continue")

    def test_default_deny(self):
        ctx = _ctx({**{k: v for k, v in CTX.items() if k != "policy"},
                    "policy": {"version": 1, "default": "deny", "rules": []}})
        pol = PolicyEngine(ctx)
        self.assertEqual(pol.decide("read", {"path": "/x"})["action"], "block")
        # credential tool exempt from default-deny
        self.assertEqual(pol.decide("request_credential", {})["action"], "continue")


class AppGatingAuditTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        sess = base / "synaps" / "sessions" / "sess_def"
        sess.mkdir(parents=True)
        (sess / "context.json").write_text(json.dumps(CTX))
        self._env = dict(os.environ)
        os.environ["XDG_RUNTIME_DIR"] = str(base)
        os.environ["SYNAPS_BASE_DIR"] = str(base / "sb")
        os.environ["PRIA_AUDIT_QUIET"] = "1"
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(self._env)))
        self.base = base

    def _spool(self):
        p = self.base / "sb" / "audit-spool" / "pria-session-context.jsonl"
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []

    def test_blocked_write_audited_and_tagged(self):
        app = App("pria-session-context")
        app.initialize({"config": {}})
        app.handle_hook({"kind": "on_session_start", "session_id": "sess_def"})
        out = app.handle_hook({"kind": "before_tool_call", "tool_name": "write",
                               "tool_input": {
                                   "path": "/srv/accounts/acme-school/instances/lab-grader-2/workspace/x",
                                   "content": "y"}})
        self.assertEqual(out["action"], "block")
        blocked = [r for r in self._spool() if r["kind"] == "tool.call.blocked"]
        self.assertTrue(blocked)
        self.assertEqual(blocked[-1]["account_id"], "acct_123")
        self.assertEqual(blocked[-1]["decision"], "block")


if __name__ == "__main__":
    unittest.main()
