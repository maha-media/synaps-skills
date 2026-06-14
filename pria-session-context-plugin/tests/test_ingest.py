"""B4 — multi-sink audit: local spool + Pria ingest POST (offline-tolerant)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.sessionctx import SessionContext  # noqa: E402
from pria.ingest import IngestSink  # noqa: E402
from pria.app import App  # noqa: E402


class FakeResponse:
    def __init__(self, status=200):
        self.status = status

    def close(self):
        pass


class FakeOpener:
    def __init__(self, status=200, fail=False):
        self.calls = []
        self.status = status
        self.fail = fail

    def __call__(self, req, timeout=None):
        if self.fail:
            import urllib.error
            raise urllib.error.URLError("offline")
        body = req.data.decode("utf-8")
        self.calls.append({
            "url": req.full_url,
            "auth": req.get_header("Authorization"),
            "payload": json.loads(body),
        })
        return FakeResponse(self.status)


def _ctx(raw):
    c = SessionContext()
    c.session_id = raw.get("session_id")
    c.raw = raw
    return c


class IngestSinkTest(unittest.TestCase):
    def test_posts_with_bearer_from_context(self):
        ctx = _ctx({"session_id": "s1", "ingest_url": "https://pria/agents/ingest/events",
                    "ingest_token": "tok-abc"})
        opener = FakeOpener()
        sink = IngestSink(ctx, {}, opener=opener)
        sink.enqueue({"kind": "tool.call.blocked"})
        self.assertEqual(len(opener.calls), 1)
        call = opener.calls[0]
        self.assertEqual(call["url"], "https://pria/agents/ingest/events")
        self.assertEqual(call["auth"], "Bearer tok-abc")
        self.assertEqual(call["payload"]["events"][0]["kind"], "tool.call.blocked")

    def test_config_fallback(self):
        ctx = _ctx({"session_id": "s1"})
        opener = FakeOpener()
        sink = IngestSink(ctx, {"ingest_url": "https://c/e", "ingest_token": "ct"},
                          opener=opener)
        sink.enqueue({"kind": "x"})
        self.assertEqual(opener.calls[0]["url"], "https://c/e")
        self.assertEqual(opener.calls[0]["auth"], "Bearer ct")

    def test_offline_keeps_buffer_no_raise(self):
        ctx = _ctx({"session_id": "s1", "ingest_url": "https://pria/e", "ingest_token": "t"})
        opener = FakeOpener(fail=True)
        sink = IngestSink(ctx, {}, opener=opener)
        sink.enqueue({"kind": "x"})  # must not raise
        self.assertEqual(len(sink._buffer), 1)
        self.assertIsNotNone(sink._last_error)
        # When it comes back online, a flush drains.
        sink._opener = FakeOpener()
        self.assertTrue(sink.flush())
        self.assertEqual(len(sink._buffer), 0)

    def test_unconfigured_is_spool_only(self):
        ctx = _ctx({"session_id": "s1"})
        sink = IngestSink(ctx, {})
        self.assertFalse(sink.configured())
        sink.enqueue({"kind": "x"})  # no endpoint -> drop network buffer, no raise
        self.assertEqual(len(sink._buffer), 0)

    def test_non_2xx_is_error(self):
        ctx = _ctx({"session_id": "s1", "ingest_url": "https://pria/e", "ingest_token": "t"})
        sink = IngestSink(ctx, {}, opener=FakeOpener(status=500))
        sink.enqueue({"kind": "x"})
        self.assertEqual(len(sink._buffer), 1)  # buffered for retry


class EndToEndMultiSinkTest(unittest.TestCase):
    """Denied tool call produces BOTH a spool line AND an ingested event."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        sess = base / "synaps" / "sessions" / "sess_def"
        sess.mkdir(parents=True)
        ctx = {
            "account_id": "acct_123", "account_slug": "acme-school",
            "instance_id": "inst_456", "instance_slug": "tutor-bot-7",
            "user_id": "user_789", "linux_username": "alice_acme", "linux_uid": 12001,
            "vm_id": "vm_abc", "session_id": "sess_def", "roles": ["agent_operator"],
            "ingest_url": "https://pria/agents/ingest/events", "ingest_token": "tok",
            "policy": {"version": 1, "default": "allow", "rules": [
                {"tool": "bash", "input_contains": "rm -rf /", "decision": "block",
                 "reason": "destructive"}]},
        }
        (sess / "context.json").write_text(json.dumps(ctx))
        self._env = dict(os.environ)
        os.environ["XDG_RUNTIME_DIR"] = str(base)
        os.environ["SYNAPS_BASE_DIR"] = str(base / "sb")
        os.environ["PRIA_AUDIT_QUIET"] = "1"
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(self._env)))
        self.base = base

    def test_denied_tool_spooled_and_ingested(self):
        app = App("pria-session-context")
        app.initialize({"config": {}})
        opener = FakeOpener()
        app.audit._ingest._opener = opener  # inject mock control plane
        app.handle_hook({"kind": "on_session_start", "session_id": "sess_def"})
        out = app.handle_hook({"kind": "before_tool_call", "tool_name": "bash",
                               "tool_input": {"command": "rm -rf /"}})
        self.assertEqual(out["action"], "block")
        # spool
        spool = self.base / "sb" / "audit-spool" / "pria-session-context.jsonl"
        spool_kinds = [json.loads(l)["kind"] for l in spool.read_text().splitlines()]
        self.assertIn("tool.call.blocked", spool_kinds)
        # ingest
        ingested = [e["kind"] for c in opener.calls for e in c["payload"]["events"]]
        self.assertIn("tool.call.blocked", ingested)
        self.assertTrue(all(c["auth"] == "Bearer tok" for c in opener.calls))


if __name__ == "__main__":
    unittest.main()
