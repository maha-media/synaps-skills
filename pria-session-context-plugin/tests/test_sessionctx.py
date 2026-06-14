"""B2 — session-context loader + audit tagging."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.sessionctx import SessionContext, load_context  # noqa: E402
from pria.app import App  # noqa: E402

CONTEXT = {
    "account_id": "acct_123", "account_slug": "acme-school",
    "instance_id": "inst_456", "instance_slug": "tutor-bot-7",
    "user_id": "user_789", "linux_username": "alice_acme", "linux_uid": 12001,
    "vm_id": "vm_abc", "session_id": "sess_def",
    "roles": ["agent_operator", "workspace_editor"],
    "policy_profile_id": "pol_001",
    "issued_at": "2026-06-14T00:00:00Z", "expires_at": "2026-06-14T01:00:00Z",
}


class LoaderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.runtime = Path(self.tmp.name)
        sess_dir = self.runtime / "synaps" / "sessions" / "sess_def"
        sess_dir.mkdir(parents=True)
        (sess_dir / "context.json").write_text(json.dumps(CONTEXT))
        self._env = dict(os.environ)
        os.environ["XDG_RUNTIME_DIR"] = str(self.runtime)
        os.environ.pop("HOME", None)
        os.environ.pop("SYNAPS_BASE_DIR", None)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(self._env)))

    def test_loads_by_session_id(self):
        raw, path = load_context("sess_def")
        self.assertEqual(raw["account_id"], "acct_123")
        self.assertTrue(path.endswith("sess_def/context.json"))

    def test_missing_session_returns_none(self):
        raw, path = load_context("nope")
        self.assertIsNone(raw)
        self.assertIsNone(path)

    def test_tags_carry_all_ids(self):
        ctx = SessionContext()
        ctx.load("sess_def")
        tags = ctx.tags()
        self.assertEqual(tags["context"], "resolved")
        for f in ("account_id", "instance_id", "user_id", "vm_id", "session_id",
                  "linux_uid", "roles"):
            self.assertIn(f, tags)
        self.assertEqual(tags["linux_uid"], 12001)

    def test_missing_context_tags_marked_missing(self):
        ctx = SessionContext()
        ctx.load("nope")
        self.assertEqual(ctx.tags()["context"], "missing")
        self.assertEqual(ctx.tags()["session_id"], "nope")


class AuditTaggingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        sess_dir = base / "synaps" / "sessions" / "sess_def"
        sess_dir.mkdir(parents=True)
        (sess_dir / "context.json").write_text(json.dumps(CONTEXT))
        self._env = dict(os.environ)
        os.environ["XDG_RUNTIME_DIR"] = str(base)
        os.environ["SYNAPS_BASE_DIR"] = str(base / "synaps_base")
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(self._env)))
        self.base = base

    def _spool_lines(self):
        spool = self.base / "synaps_base" / "audit-spool" / "pria-session-context.jsonl"
        return [json.loads(l) for l in spool.read_text().splitlines()] if spool.exists() else []

    def test_session_start_emits_tagged_record(self):
        app = App("pria-session-context")
        app.initialize({"config": {}})
        app.handle_hook({"kind": "on_session_start", "session_id": "sess_def"})
        lines = self._spool_lines()
        self.assertTrue(lines)
        rec = lines[-1]
        self.assertEqual(rec["kind"], "session.started")
        self.assertEqual(rec["account_id"], "acct_123")
        self.assertEqual(rec["session_id"], "sess_def")
        self.assertEqual(rec["source"], "synaps-extension")

    def test_tool_call_records_are_tagged(self):
        app = App("pria-session-context")
        app.initialize({"config": {}})
        app.handle_hook({"kind": "on_session_start", "session_id": "sess_def"})
        app.handle_hook({"kind": "before_tool_call", "tool_name": "bash",
                         "tool_input": {"command": "ls"}})
        app.handle_hook({"kind": "after_tool_call", "tool_name": "bash",
                         "tool_input": {"command": "ls"}, "tool_output": "x"})
        kinds = [r["kind"] for r in self._spool_lines()]
        self.assertIn("tool.call.started", kinds)
        self.assertIn("tool.call.completed", kinds)
        for rec in self._spool_lines():
            self.assertEqual(rec["instance_id"], "inst_456")

    def test_session_end_clears_context(self):
        app = App("pria-session-context")
        app.initialize({"config": {}})
        app.handle_hook({"kind": "on_session_start", "session_id": "sess_def"})
        app.handle_hook({"kind": "on_session_end", "session_id": "sess_def"})
        self.assertFalse(app.ctx.resolved)


if __name__ == "__main__":
    unittest.main()
