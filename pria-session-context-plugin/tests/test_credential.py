"""B5 — credential-broker tool integration (no static secrets)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.sessionctx import SessionContext  # noqa: E402
from pria.credential import CredentialBroker, TOOL_NAME, TOOL_SPEC  # noqa: E402
from pria.app import App  # noqa: E402


class FakeResp:
    def __init__(self, status=200, body=b"{}"):
        self.status = status
        self._body = body

    def read(self):
        return self._body

    def close(self):
        pass


class FakeOpener:
    def __init__(self, status=200, body=None, fail=False):
        self.calls = []
        self.status = status
        self.body = body if body is not None else {
            "token": "xoxb-short-lived", "expires_at": "2026-06-14T00:15:00Z",
            "credential_id": "cred_1", "scope": "#general"}
        self.fail = fail

    def __call__(self, req, timeout=None):
        if self.fail:
            import urllib.error
            raise urllib.error.URLError("offline")
        self.calls.append({
            "url": req.full_url,
            "auth": req.get_header("Authorization"),
            "payload": json.loads(req.data.decode("utf-8")),
        })
        return FakeResp(self.status, json.dumps(self.body).encode("utf-8"))


def _ctx(raw):
    c = SessionContext()
    c.session_id = raw.get("session_id")
    c.raw = raw
    return c


CTX = {
    "account_id": "acct_123", "instance_id": "inst_456", "user_id": "user_789",
    "session_id": "sess_def", "credential_broker_url": "https://pria/broker",
    "ingest_token": "tok",
}


class BrokerTest(unittest.TestCase):
    def test_issue_returns_scoped_short_token(self):
        opener = FakeOpener()
        b = CredentialBroker(_ctx(CTX), {}, opener=opener)
        out = b.issue({"provider": "slack", "scope": "#general", "action": "post_message"})
        self.assertTrue(out["ok"])
        self.assertEqual(out["token"], "xoxb-short-lived")
        self.assertEqual(out["expires_at"], "2026-06-14T00:15:00Z")
        call = opener.calls[0]
        self.assertTrue(call["url"].endswith("/internal/credentials/issue"))
        self.assertEqual(call["auth"], "Bearer tok")
        # session binding propagated
        self.assertEqual(call["payload"]["account_id"], "acct_123")
        self.assertEqual(call["payload"]["session_id"], "sess_def")
        self.assertEqual(call["payload"]["provider"], "slack")

    def test_missing_provider_denied(self):
        b = CredentialBroker(_ctx(CTX), {}, opener=FakeOpener())
        out = b.issue({"action": "post_message"})
        self.assertFalse(out["ok"])

    def test_unconfigured_broker_denied(self):
        b = CredentialBroker(_ctx({"session_id": "s"}), {}, opener=FakeOpener())
        out = b.issue({"provider": "slack", "action": "x"})
        self.assertFalse(out["ok"])
        self.assertIn("not configured", out["error"])

    def test_offline_broker_denied_no_raise(self):
        b = CredentialBroker(_ctx(CTX), {}, opener=FakeOpener(fail=True))
        out = b.issue({"provider": "slack", "action": "x"})
        self.assertFalse(out["ok"])

    def test_no_static_secret_returned(self):
        # The tool result never includes a long-lived secret field.
        b = CredentialBroker(_ctx(CTX), {}, opener=FakeOpener())
        out = b.issue({"provider": "slack", "action": "post"})
        self.assertNotIn("secret", out)
        self.assertNotIn("api_key", out)


class AppToolTest(unittest.TestCase):
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

    def test_tool_registered_in_capabilities(self):
        app = App("pria-session-context")
        caps = app.initialize({"config": {}})
        names = [t["name"] for t in caps["capabilities"]["tools"]]
        self.assertIn(TOOL_NAME, names)

    def test_tool_call_issues_and_audits(self):
        app = App("pria-session-context")
        app.initialize({"config": {}})
        app.broker._opener = FakeOpener()
        app.handle_hook({"kind": "on_session_start", "session_id": "sess_def"})
        out = app.handle_tool_call({"name": TOOL_NAME,
                                    "input": {"provider": "slack", "action": "post_message",
                                              "scope": "#general"}})
        self.assertTrue(out["ok"])
        spool = self.base / "sb" / "audit-spool" / "pria-session-context.jsonl"
        kinds = [json.loads(l)["kind"] for l in spool.read_text().splitlines()]
        self.assertIn("credential.issued", kinds)
        issued = [json.loads(l) for l in spool.read_text().splitlines()
                  if json.loads(l)["kind"] == "credential.issued"][-1]
        self.assertEqual(issued["account_id"], "acct_123")
        self.assertEqual(issued["provider"], "slack")


if __name__ == "__main__":
    unittest.main()
