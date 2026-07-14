"""Unit tests for vault_repair — dry_run safety, verb dispatch, error paths.

KEY SAFETY GUARANTEE: dry_run=True (the default) must NEVER make a mutating
network call. These tests assert that directly on the call recorder.
"""
import json
import os
import sys
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.tools import ToolHandler, TOOL_VAULT_REPAIR  # noqa: E402
from pria.client import PriaClient  # noqa: E402

JWT = "eyJfake.jwt"


class FakeResp:
    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def close(self):
        pass


class CallRecorder:
    def __init__(self, responses=None):
        self._responses = list(responses or [])
        self.calls = []

    def __call__(self, req, timeout=None):
        self.calls.append(req)
        resp = self._responses.pop(0)
        if isinstance(resp, Exception):
            raise resp
        return resp


def _make_handler(opener=None):
    recorder = opener or CallRecorder()
    h = ToolHandler({"pria_api_base": "https://pria"})
    h._client = PriaClient(api_key="pria_" + "a" * 40, base_url="https://pria",
                            _opener=recorder)
    h._client._jwt = JWT
    return h, recorder


def _http_error(status, data):
    return urllib.error.HTTPError(
        url="https://pria/", code=status, msg="err", hdrs={},
        fp=BytesIO(json.dumps(data).encode()),
    )


class TestDryRunSafety(unittest.TestCase):
    """Core safety: dry_run=True must NEVER make a mutating HTTP call."""

    def setUp(self):
        os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40

    def tearDown(self):
        os.environ.pop("PRIA_API_KEY", None)

    def test_dry_run_default_true_makes_no_call(self):
        h, rec = _make_handler()
        result = h.call(TOOL_VAULT_REPAIR, {
            "upload_id": "abc123",
            "verb": "requeue",
            # no dry_run specified — should default to True
        })
        # MUST NOT have made any network calls
        self.assertEqual(len(rec.calls), 0, "dry_run=True default made a network call!")
        self.assertTrue(result.get("dry_run"))

    def test_dry_run_explicit_true_makes_no_call(self):
        h, rec = _make_handler()
        result = h.call(TOOL_VAULT_REPAIR, {
            "upload_id": "abc123",
            "verb": "reload",
            "dry_run": True,
        })
        self.assertEqual(len(rec.calls), 0, "dry_run=True made a network call!")
        self.assertTrue(result.get("dry_run"))

    def test_dry_run_result_shape(self):
        h, rec = _make_handler()
        result = h.call(TOOL_VAULT_REPAIR, {
            "upload_id": "abc123",
            "verb": "requeue",
            "dry_run": True,
        })
        self.assertIn("upload_id", result)
        self.assertIn("verb", result)
        self.assertIn("action", result)
        self.assertIn("message", result)
        self.assertEqual(result["upload_id"], "abc123")
        self.assertEqual(result["verb"], "requeue")
        self.assertIn("Dry run", result["message"])

    def test_dry_run_all_three_verbs(self):
        for verb in ("requeue", "reload"):
            h, rec = _make_handler()
            result = h.call(TOOL_VAULT_REPAIR, {
                "upload_id": "xyz",
                "verb": verb,
                "dry_run": True,
            })
            self.assertEqual(len(rec.calls), 0, f"dry_run verb={verb} made a call")
            self.assertTrue(result.get("dry_run"), f"dry_run=True not reflected for verb={verb}")

    def test_dry_run_reingest_makes_no_call(self):
        h, rec = _make_handler()
        result = h.call(TOOL_VAULT_REPAIR, {
            "upload_id": "xyz",
            "verb": "reingest",
            "source_url": "https://example.com/doc.pdf",
            "dry_run": True,
        })
        self.assertEqual(len(rec.calls), 0, "reingest dry_run made a network call!")
        self.assertTrue(result.get("dry_run"))


class TestLiveRepair(unittest.TestCase):
    """dry_run=False should call the correct endpoint and return normalized result."""

    def setUp(self):
        os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40

    def tearDown(self):
        os.environ.pop("PRIA_API_KEY", None)

    def test_requeue_calls_correct_endpoint(self):
        rec = CallRecorder([FakeResp(json.dumps({"success": True, "message": "queued"}).encode())])
        h, _ = _make_handler(rec)
        result = h.call(TOOL_VAULT_REPAIR, {
            "upload_id": "abc123",
            "verb": "requeue",
            "dry_run": False,
        })
        self.assertEqual(len(rec.calls), 1)
        self.assertIn("re-queue-an-existing-file-for-ingestion", rec.calls[0].full_url)
        self.assertFalse(result["dry_run"])
        self.assertTrue(result["success"])

    def test_reload_calls_correct_endpoint(self):
        rec = CallRecorder([FakeResp(json.dumps({"success": True}).encode())])
        h, _ = _make_handler(rec)
        result = h.call(TOOL_VAULT_REPAIR, {
            "upload_id": "abc123",
            "verb": "reload",
            "dry_run": False,
        })
        self.assertIn("reload-file-content", rec.calls[0].full_url)

    def test_reingest_calls_correct_endpoint(self):
        rec = CallRecorder([FakeResp(json.dumps({"success": True}).encode())])
        h, _ = _make_handler(rec)
        result = h.call(TOOL_VAULT_REPAIR, {
            "upload_id": "abc123",
            "verb": "reingest",
            "source_url": "https://example.com/doc.pdf",
            "dry_run": False,
        })
        self.assertIn("re-ingest-file-from-source-url", rec.calls[0].full_url)
        body = json.loads(rec.calls[0].data.decode())
        self.assertEqual(body["sourceUrl"], "https://example.com/doc.pdf")

    def test_live_repair_api_error_returns_structured_error(self):
        rec = CallRecorder([_http_error(500, {"message": "Internal error"})])
        h, _ = _make_handler(rec)
        result = h.call(TOOL_VAULT_REPAIR, {
            "upload_id": "abc123",
            "verb": "requeue",
            "dry_run": False,
        })
        self.assertIn("error", result)
        self.assertNotIn("success", result)


class TestValidation(unittest.TestCase):
    def setUp(self):
        os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40

    def tearDown(self):
        os.environ.pop("PRIA_API_KEY", None)

    def test_missing_upload_id_returns_error(self):
        h, rec = _make_handler()
        result = h.call(TOOL_VAULT_REPAIR, {"verb": "requeue"})
        self.assertIn("error", result)
        self.assertEqual(len(rec.calls), 0)

    def test_invalid_verb_returns_error(self):
        h, rec = _make_handler()
        result = h.call(TOOL_VAULT_REPAIR, {"upload_id": "abc", "verb": "delete_all"})
        self.assertIn("error", result)
        self.assertEqual(len(rec.calls), 0)

    def test_reingest_missing_source_url_returns_error(self):
        h, rec = _make_handler()
        result = h.call(TOOL_VAULT_REPAIR, {
            "upload_id": "abc",
            "verb": "reingest",
            # no source_url
            "dry_run": True,
        })
        self.assertIn("error", result)
        # Should still make no call
        self.assertEqual(len(rec.calls), 0)

    def test_no_api_key_returns_error_only_on_live_call(self):
        """dry_run=True should not need API key (no network call)."""
        os.environ.pop("PRIA_API_KEY", None)
        h = ToolHandler({"pria_api_base": "https://pria"})
        result = h.call(TOOL_VAULT_REPAIR, {
            "upload_id": "abc",
            "verb": "requeue",
            "dry_run": True,
        })
        # dry_run should succeed even with no API key
        self.assertNotIn("error", result)
        self.assertTrue(result.get("dry_run"))

    def test_no_api_key_live_call_returns_error(self):
        """dry_run=False requires API key."""
        os.environ.pop("PRIA_API_KEY", None)
        h = ToolHandler({"pria_api_base": "https://pria"})
        result = h.call(TOOL_VAULT_REPAIR, {
            "upload_id": "abc",
            "verb": "requeue",
            "dry_run": False,
        })
        self.assertIn("error", result)


if __name__ == "__main__":
    unittest.main()
