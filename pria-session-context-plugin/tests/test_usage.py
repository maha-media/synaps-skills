"""AC-B2.1 — raw-usage → Pria usage-ingest transform (live under protocol v2).

Covers:
  * payload shape (spec §6.2 envelope + events[])
  * idempotency-key derivation (session_id + message_id|turn_id + type + hash)
  * raw-only invariant (NO `credits`/`credit_cost`)
  * session-context join from the context FILE (HS-2)
  * best-effort forward + spool-tolerance
  * `on_usage` dispatch in App; manifest declares on_usage under protocol v2
"""
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.sessionctx import SessionContext  # noqa: E402
from pria import usage as U  # noqa: E402
from pria.app import App  # noqa: E402


def _ctx(raw):
    c = SessionContext()
    c.session_id = raw.get("session_id")
    c.raw = raw
    return c


SAMPLE_HOOK = {
    "kind": "on_usage",
    "data": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-test",
        "session_id": "sess_abc",
        "message_id": "msg_123",
        "turn_id": "turn_abc",
        "usage": {
            "input_tokens": 1234,
            "output_tokens": 567,
            "cache_read_input_tokens": 1000,
            "cache_creation_input_tokens": 200,
            "cache_creation_5m": 200,
            "cache_creation_1h": 0,
        },
        "source": {"runtime": "synapscli", "event": "message_delta", "streaming": True},
        "occurred_at": "2026-06-14T00:00:00Z",
    },
}


class NormaliseTest(unittest.TestCase):
    def test_full_usage_preserved_as_ints(self):
        u = U.normalise_usage(SAMPLE_HOOK["data"]["usage"])
        self.assertEqual(u["input_tokens"], 1234)
        self.assertEqual(u["output_tokens"], 567)
        self.assertEqual(u["cache_read_input_tokens"], 1000)
        self.assertEqual(u["cache_creation_input_tokens"], 200)
        self.assertEqual(u["cache_creation_5m"], 200)
        self.assertEqual(u["cache_creation_1h"], 0)

    def test_missing_core_defaults_zero_optional_none(self):
        u = U.normalise_usage({"input_tokens": 10})
        self.assertEqual(u["input_tokens"], 10)
        self.assertEqual(u["output_tokens"], 0)
        self.assertEqual(u["cache_read_input_tokens"], 0)
        self.assertIsNone(u["cache_creation_5m"])
        self.assertIsNone(u["cache_creation_1h"])

    def test_non_int_coerced(self):
        u = U.normalise_usage({"input_tokens": "55", "output_tokens": "bad"})
        self.assertEqual(u["input_tokens"], 55)
        self.assertEqual(u["output_tokens"], 0)


class HookExtractTest(unittest.TestCase):
    def test_extract_from_data(self):
        r = U.usage_from_hook(SAMPLE_HOOK)
        self.assertEqual(r["provider"], "anthropic")
        self.assertEqual(r["model"], "claude-sonnet-4-test")
        self.assertEqual(r["session_id"], "sess_abc")
        self.assertEqual(r["message_id"], "msg_123")
        self.assertEqual(r["turn_id"], "turn_abc")
        self.assertEqual(r["source_event"], "message_delta")
        self.assertEqual(r["usage"]["input_tokens"], 1234)

    def test_extract_flattened_shape(self):
        flat = dict(SAMPLE_HOOK["data"])
        r = U.usage_from_hook({"kind": "on_usage", **flat})
        self.assertEqual(r["provider"], "anthropic")
        self.assertEqual(r["usage"]["output_tokens"], 567)

    def test_session_id_falls_back_to_event(self):
        ev = {"kind": "on_usage", "session_id": "sess_top", "data": {"usage": {}}}
        r = U.usage_from_hook(ev)
        self.assertEqual(r["session_id"], "sess_top")

    def test_occurred_at_defaulted_when_absent(self):
        r = U.usage_from_hook({"kind": "on_usage", "data": {"usage": {}}})
        self.assertTrue(r["occurred_at"].endswith("Z"))


class IdempotencyTest(unittest.TestCase):
    def test_key_is_stable_and_structured(self):
        u = U.normalise_usage(SAMPLE_HOOK["data"]["usage"])
        k1 = U.derive_idempotency_key("sess_abc", "msg_123", "turn_abc", U.EVENT_TYPE_LLM_TOKENS, u)
        k2 = U.derive_idempotency_key("sess_abc", "msg_123", "turn_abc", U.EVENT_TYPE_LLM_TOKENS, u)
        self.assertEqual(k1, k2)
        self.assertTrue(k1.startswith("synaps:sess_abc:msg_123:llm.tokens:"))

    def test_message_id_preferred_over_turn(self):
        u = U.normalise_usage({"input_tokens": 1})
        k = U.derive_idempotency_key("s", "msg_x", "turn_y", "llm.tokens", u)
        self.assertIn(":msg_x:", k)

    def test_turn_used_when_no_message(self):
        u = U.normalise_usage({"input_tokens": 1})
        k = U.derive_idempotency_key("s", None, "turn_y", "llm.tokens", u)
        self.assertIn(":turn_y:", k)

    def test_different_usage_yields_different_key(self):
        ka = U.derive_idempotency_key("s", "m", None, "llm.tokens", U.normalise_usage({"input_tokens": 1}))
        kb = U.derive_idempotency_key("s", "m", None, "llm.tokens", U.normalise_usage({"input_tokens": 2}))
        self.assertNotEqual(ka, kb)


class BatchTest(unittest.TestCase):
    CTX = {
        "account_id": "acct_123", "instance_id": "inst_456", "user_id": "user_789",
        "vm_id": "vm_001", "replica_id": "replica_0", "session_id": "sess_abc",
    }

    def test_envelope_attribution_from_context(self):
        batch = U.build_usage_batch(_ctx(self.CTX), [U.usage_from_hook(SAMPLE_HOOK)])
        self.assertEqual(batch["account_id"], "acct_123")
        self.assertEqual(batch["instance_id"], "inst_456")
        self.assertEqual(batch["user_id"], "user_789")
        self.assertEqual(batch["vm_id"], "vm_001")
        self.assertEqual(batch["replica_id"], "replica_0")
        self.assertEqual(batch["session_id"], "sess_abc")
        self.assertEqual(batch["source"], U.SOURCE_ON_USAGE)
        self.assertEqual(len(batch["events"]), 1)

    def test_event_shape(self):
        batch = U.build_usage_batch(_ctx(self.CTX), [U.usage_from_hook(SAMPLE_HOOK)])
        ev = batch["events"][0]
        self.assertEqual(ev["type"], "llm.tokens")
        self.assertEqual(ev["provider"], "anthropic")
        self.assertEqual(ev["model"], "claude-sonnet-4-test")
        self.assertEqual(ev["usage"]["input_tokens"], 1234)
        self.assertTrue(ev["idempotency_key"].startswith("synaps:sess_abc:msg_123:"))
        self.assertEqual(ev["metadata"]["message_id"], "msg_123")
        self.assertEqual(ev["metadata"]["turn_id"], "turn_abc")

    def test_raw_only_no_credits(self):
        batch = U.build_usage_batch(_ctx(self.CTX), [U.usage_from_hook(SAMPLE_HOOK)])
        for ev in batch["events"]:
            self.assertNotIn("credits", ev)
            self.assertNotIn("credit_cost", ev)
        # explicit guard does not raise on a clean batch
        U.assert_raw_only(batch)

    def test_assert_raw_only_rejects_credits(self):
        bad = {"events": [{"type": "llm.tokens", "credits": 0.1}]}
        with self.assertRaises(ValueError):
            U.assert_raw_only(bad)

    def test_missing_context_yields_null_attribution(self):
        batch = U.build_usage_batch(_ctx({}), [U.usage_from_hook(SAMPLE_HOOK)])
        self.assertIsNone(batch["account_id"])
        # event still well-formed
        self.assertEqual(batch["events"][0]["type"], "llm.tokens")


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
            raise urllib.error.URLError("offline")
        self.calls.append({
            "url": req.full_url,
            "auth": req.get_header("Authorization"),
            "payload": json.loads(req.data.decode("utf-8")),
        })
        return FakeResponse(self.status)


class ForwarderTest(unittest.TestCase):
    CTX = {
        "account_id": "acct_123", "instance_id": "inst_456", "user_id": "user_789",
        "vm_id": "vm_001", "session_id": "sess_abc",
        "usage_url": "https://pria/internal/agentic-vm/usage", "usage_token": "utok",
    }

    def test_posts_envelope_verbatim_with_bearer(self):
        opener = FakeOpener()
        fwd = U.UsageForwarder(_ctx(self.CTX), {}, opener=opener)
        batch = U.build_usage_batch(_ctx(self.CTX), [U.usage_from_hook(SAMPLE_HOOK)])
        self.assertTrue(fwd.forward(batch))
        self.assertEqual(len(opener.calls), 1)
        call = opener.calls[0]
        self.assertEqual(call["url"], "https://pria/internal/agentic-vm/usage")
        self.assertEqual(call["auth"], "Bearer utok")
        # Envelope posted verbatim — NOT wrapped in another {"events":[...]}.
        self.assertEqual(call["payload"]["account_id"], "acct_123")
        self.assertEqual(call["payload"]["events"][0]["type"], "llm.tokens")

    def test_falls_back_to_ingest_url(self):
        ctx = dict(self.CTX)
        del ctx["usage_url"]
        del ctx["usage_token"]
        ctx["ingest_url"] = "https://pria/agents/ingest/events"
        ctx["ingest_token"] = "itok"
        opener = FakeOpener()
        fwd = U.UsageForwarder(_ctx(ctx), {}, opener=opener)
        fwd.forward(U.build_usage_batch(_ctx(ctx), [U.usage_from_hook(SAMPLE_HOOK)]))
        self.assertEqual(opener.calls[0]["url"], "https://pria/agents/ingest/events")
        self.assertEqual(opener.calls[0]["auth"], "Bearer itok")

    def test_offline_keeps_buffer_no_raise(self):
        opener = FakeOpener(fail=True)
        fwd = U.UsageForwarder(_ctx(self.CTX), {}, opener=opener)
        batch = U.build_usage_batch(_ctx(self.CTX), [U.usage_from_hook(SAMPLE_HOOK)])
        self.assertFalse(fwd.forward(batch))  # offline -> not ok, but no raise
        self.assertEqual(len(fwd._buffer), 1)
        self.assertIsNotNone(fwd._last_error)
        fwd._opener = FakeOpener()
        self.assertTrue(fwd.flush())
        self.assertEqual(len(fwd._buffer), 0)

    def test_unconfigured_is_spool_only(self):
        fwd = U.UsageForwarder(_ctx({"session_id": "s"}), {})
        self.assertFalse(fwd.configured())
        fwd.forward(U.build_usage_batch(_ctx({"session_id": "s"}), [U.usage_from_hook(SAMPLE_HOOK)]))
        self.assertEqual(len(fwd._buffer), 0)  # dropped from in-proc buffer

    def test_credits_in_batch_rejected_before_post(self):
        opener = FakeOpener()
        fwd = U.UsageForwarder(_ctx(self.CTX), {}, opener=opener)
        with self.assertRaises(ValueError):
            fwd.forward({"account_id": "a", "events": [{"type": "llm.tokens", "credits": 1}]})
        self.assertEqual(len(opener.calls), 0)


class AppDispatchTest(unittest.TestCase):
    """The `on_usage` handler is declared in the manifest (protocol v2), joins
    the file-delivered session context, and forwards raw usage."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        sess = base / "synaps" / "sessions" / "sess_abc"
        sess.mkdir(parents=True)
        ctx = {
            "account_id": "acct_123", "instance_id": "inst_456", "user_id": "user_789",
            "vm_id": "vm_001", "session_id": "sess_abc",
            "usage_url": "https://pria/internal/agentic-vm/usage", "usage_token": "utok",
        }
        (sess / "context.json").write_text(json.dumps(ctx))
        self._env = dict(os.environ)
        os.environ["XDG_RUNTIME_DIR"] = str(base)
        os.environ["PRIA_AUDIT_QUIET"] = "1"
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(self._env)))

    def test_manifest_declares_on_usage_under_protocol_v2(self):
        manifest = json.loads(
            (Path(__file__).resolve().parents[1] / ".synaps-plugin" / "plugin.json").read_text()
        )
        self.assertEqual(manifest["extension"]["protocol_version"], 2)
        self.assertEqual(manifest["compatibility"]["extension_protocol"], "2")
        hooks = [h["hook"] for h in manifest["extension"]["hooks"]]
        self.assertIn("on_usage", hooks)
        # on_usage reuses privacy.llm_content — no new permission needed (HS-U5).
        self.assertIn("privacy.llm_content", manifest["extension"]["permissions"])

    def test_initialize_reports_protocol_v2(self):
        app = App("pria-session-context")
        result = app.initialize({"config": {}})
        self.assertEqual(result["protocol_version"], 2)

    def test_on_usage_dispatch_forwards_raw_usage(self):
        app = App("pria-session-context")
        app.initialize({"config": {}})
        opener = FakeOpener()
        app.usage._opener = opener  # inject mock control plane
        app.handle_hook({"kind": "on_session_start", "session_id": "sess_abc"})
        out = app.handle_hook(SAMPLE_HOOK)
        self.assertEqual(out["action"], "continue")
        self.assertEqual(len(opener.calls), 1)
        payload = opener.calls[0]["payload"]
        self.assertEqual(payload["account_id"], "acct_123")
        self.assertEqual(payload["source"], U.SOURCE_ON_USAGE)
        ev = payload["events"][0]
        self.assertEqual(ev["type"], "llm.tokens")
        self.assertNotIn("credits", ev)

    def test_on_usage_never_raises_when_forward_offline(self):
        app = App("pria-session-context")
        app.initialize({"config": {}})
        app.usage._opener = FakeOpener(fail=True)
        app.handle_hook({"kind": "on_session_start", "session_id": "sess_abc"})
        # offline forward must not raise out of the hot path
        out = app.handle_hook(SAMPLE_HOOK)
        self.assertEqual(out["action"], "continue")

    def test_unknown_hook_kind_still_continues(self):
        app = App("pria-session-context")
        app.initialize({"config": {}})
        self.assertEqual(app.handle_hook({"kind": "on_compaction"})["action"], "continue")


if __name__ == "__main__":
    unittest.main()
