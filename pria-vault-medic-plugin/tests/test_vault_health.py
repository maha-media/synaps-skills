"""Unit tests for vault_health and vault_regrade — normalization and error paths.

All HTTP mocked. Verifies the normalized shape and factor extraction.
"""
import json
import os
import sys
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.tools import ToolHandler, TOOL_VAULT_HEALTH, TOOL_VAULT_REGRADE  # noqa: E402
from pria.client import PriaClient  # noqa: E402

JWT = "eyJfake.jwt"
AUTH_RESP = {"token": JWT}

HEALTH_RESP = {
    "success": True,
    "summary": {
        "totalCount": 5, "activeCount": 3, "usedCount": 0, "processingCount": 0,
        "errorCount": 2, "neverUsedCount": 4, "staleCount": 0, "unscannedCount": 1,
        "unoptimizedCount": 0, "unindexedCount": 0, "missingTerminalCount": 0,
        "staleBaseUrlCount": 0,
    },
    "grade": {
        "letter": "C",
        "score": 71,
        "factors": [
            {"key": "errorCount", "count": 2, "impact": 20, "label": "Files in error state"},
            {"key": "neverUsedCount", "count": 4, "impact": 8, "label": "Never retrieved in RAG (>7d old)"},
            {"key": "unscannedCount", "count": 1, "impact": 1, "label": "Never scored at ingest"},
        ],
    },
}


class FakeResp:
    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def close(self):
        pass


class CallRecorder:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def __call__(self, req, timeout=None):
        self.calls.append(req)
        resp = self._responses.pop(0)
        if isinstance(resp, Exception):
            raise resp
        return resp


def _make_handler(opener):
    h = ToolHandler({"pria_api_base": "https://pria"})
    h._client = PriaClient(api_key="pria_" + "a" * 40, base_url="https://pria", _opener=opener)
    h._client._jwt = JWT
    return h


def _http_error(status, data):
    return urllib.error.HTTPError(
        url="https://pria/", code=status, msg="err", hdrs={},
        fp=BytesIO(json.dumps(data).encode()),
    )


class TestVaultHealth(unittest.TestCase):
    def setUp(self):
        os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40

    def tearDown(self):
        os.environ.pop("PRIA_API_KEY", None)

    def test_normalized_shape(self):
        opener = CallRecorder([FakeResp(json.dumps(HEALTH_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_HEALTH, {})

        self.assertEqual(result["grade"], "C")
        self.assertEqual(result["score"], 71)
        self.assertIn("summary", result)
        self.assertIn("factors", result)
        self.assertIn("interpretation", result)

    def test_summary_fields_present(self):
        opener = CallRecorder([FakeResp(json.dumps(HEALTH_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_HEALTH, {})
        s = result["summary"]
        self.assertEqual(s["total_files"], 5)
        self.assertEqual(s["error_files"], 2)
        self.assertEqual(s["never_used_files"], 4)
        self.assertEqual(s["unscanned_files"], 1)

    def test_factors_normalized(self):
        opener = CallRecorder([FakeResp(json.dumps(HEALTH_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_HEALTH, {})
        self.assertEqual(len(result["factors"]), 3)
        f0 = result["factors"][0]
        self.assertEqual(f0["key"], "errorCount")
        self.assertEqual(f0["impact"], 20)

    def test_interpretation_present(self):
        opener = CallRecorder([FakeResp(json.dumps(HEALTH_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_HEALTH, {})
        self.assertIsInstance(result["interpretation"], str)
        self.assertGreater(len(result["interpretation"]), 0)

    def test_grade_a_gets_positive_interpretation(self):
        resp = {**HEALTH_RESP, "grade": {"letter": "A", "score": 100, "factors": []}}
        opener = CallRecorder([FakeResp(json.dumps(resp).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_HEALTH, {})
        self.assertEqual(result["grade"], "A")
        self.assertIn("healthy", result["interpretation"].lower())

    def test_auth_error_returns_structured_error(self):
        opener = CallRecorder([_http_error(401, {"message": "Unauthorized"})])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_HEALTH, {})
        self.assertIn("error", result)
        self.assertNotIn("grade", result)

    def test_rate_limit_returns_structured_error(self):
        opener = CallRecorder([_http_error(429, {"message": "Too many requests"})])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_HEALTH, {})
        self.assertIn("error", result)
        self.assertIn("rate_limit", result["error"])

    def test_no_api_key_returns_structured_error(self):
        os.environ.pop("PRIA_API_KEY", None)
        h = ToolHandler({"pria_api_base": "https://pria"})
        result = h.call(TOOL_VAULT_HEALTH, {})
        self.assertIn("error", result)
        self.assertIn("pria_api_key", result["error"])


class TestVaultRegrade(unittest.TestCase):
    def setUp(self):
        os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40

    def tearDown(self):
        os.environ.pop("PRIA_API_KEY", None)

    def test_regrade_without_previous_score(self):
        opener = CallRecorder([FakeResp(json.dumps(HEALTH_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_REGRADE, {})
        self.assertEqual(result["grade"], "C")
        self.assertNotIn("score_delta", result)

    def test_regrade_with_previous_score_adds_delta(self):
        opener = CallRecorder([FakeResp(json.dumps(HEALTH_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_REGRADE, {"previous_score": 60})
        self.assertIn("score_delta", result)
        self.assertEqual(result["score_delta"], 11)  # 71 - 60

    def test_regrade_delta_zero_message(self):
        opener = CallRecorder([FakeResp(json.dumps(HEALTH_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_REGRADE, {"previous_score": 71})
        self.assertEqual(result["score_delta"], 0)
        self.assertIn("unchanged", result["improvement_message"])

    def test_regrade_delta_negative_message(self):
        opener = CallRecorder([FakeResp(json.dumps(HEALTH_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_REGRADE, {"previous_score": 90})
        self.assertEqual(result["score_delta"], -19)
        self.assertIn("decreased", result["improvement_message"])


if __name__ == "__main__":
    unittest.main()
