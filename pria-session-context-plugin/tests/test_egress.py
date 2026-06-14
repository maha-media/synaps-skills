"""B6 — egress correlation (PARTIAL; HS-4)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.sessionctx import SessionContext  # noqa: E402
from pria.egress import EgressCorrelator, new_tool_call_id  # noqa: E402
from pria.app import App  # noqa: E402


def _ctx(raw):
    c = SessionContext()
    c.session_id = raw.get("session_id")
    c.raw = raw
    return c


CTX = {
    "account_id": "acct_123", "account_slug": "acme-school",
    "instance_id": "inst_456", "instance_slug": "tutor-bot-7",
    "user_id": "user_789", "linux_username": "alice_acme", "linux_uid": 12001,
    "vm_id": "vm_abc", "session_id": "sess_def", "roles": ["agent_operator"],
    "policy": {
        "version": 1, "default": "allow", "rules": [],
        "egress_correlation": {"header_field": "x_tool_call_id",
                               "tools": ["web_fetch"]},
    },
}


class CorrelatorTest(unittest.TestCase):
    def test_unique_ids(self):
        self.assertNotEqual(new_tool_call_id(), new_tool_call_id())

    def test_cooperating_tool_injects_field(self):
        ec = EgressCorrelator(_ctx(CTX))
        tid, modified = ec.correlate("web_fetch", {"url": "https://x"})
        self.assertIsNotNone(modified)
        self.assertEqual(modified["x_tool_call_id"], tid)
        self.assertEqual(modified["url"], "https://x")

    def test_native_tool_not_modified_hs4(self):
        ec = EgressCorrelator(_ctx(CTX))
        tid, modified = ec.correlate("bash", {"command": "curl https://x"})
        self.assertIsNotNone(tid)        # id still generated for audit join
        self.assertIsNone(modified)      # cannot rewrite native tool input/headers

    def test_default_no_cooperating_tools(self):
        ctx = _ctx({k: v for k, v in CTX.items() if k != "policy"})
        ec = EgressCorrelator(ctx)
        _, modified = ec.correlate("web_fetch", {"url": "x"})
        self.assertIsNone(modified)


class AppEgressTest(unittest.TestCase):
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
        return [json.loads(l) for l in p.read_text().splitlines()]

    def test_cooperating_tool_modified_with_correlation(self):
        app = App("pria-session-context")
        app.initialize({"config": {}})
        app.handle_hook({"kind": "on_session_start", "session_id": "sess_def"})
        out = app.handle_hook({"kind": "before_tool_call", "tool_name": "web_fetch",
                               "tool_input": {"url": "https://x"}})
        self.assertEqual(out["action"], "modify")
        self.assertIn("x_tool_call_id", out["input"])
        rec = [r for r in self._spool() if r["kind"] == "tool.call.started"][-1]
        self.assertTrue(rec["egress_correlated"])
        self.assertEqual(rec["tool_call_id"], out["input"]["x_tool_call_id"])

    def test_native_tool_records_limitation(self):
        app = App("pria-session-context")
        app.initialize({"config": {}})
        app.handle_hook({"kind": "on_session_start", "session_id": "sess_def"})
        out = app.handle_hook({"kind": "before_tool_call", "tool_name": "bash",
                               "tool_input": {"command": "ls"}})
        self.assertEqual(out["action"], "continue")
        rec = [r for r in self._spool() if r.get("tool_name") == "bash"][-1]
        self.assertFalse(rec["egress_correlated"])
        self.assertTrue(rec["egress_native_limited"])  # HS-4 marker
        self.assertIn("tool_call_id", rec)


if __name__ == "__main__":
    unittest.main()
