"""Unit tests for trace_answer — full provenance assembly with mock HTTP.

Covers:
  - TracePacket shape from a history row + RAG segments response
  - Confidentiality placeholder preserved exactly (never expanded)
  - Reasoning telemetry mapping when include_reasoning=True
  - has_rag_search=False path (no lazy fetch attempted)
  - Source-health annotation on segments
  - Partial failure: RAG fetch error surfaces as warning, not crash
  - Error paths: no api key, auth failure, 429, 404 (empty data)
"""
import json
import os
import sys
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.tools import ToolHandler, TOOL_TRACE_ANSWER  # noqa: E402

JWT = "eyJfake.jwt"

# ── sample API responses ──────────────────────────────────────────────────────

HISTORY_WITH_RAG = {
    "success": True,
    "data": [
        {
            "id": "hist_001",
            "created": "2025-07-10T09:00:00.000Z",
            "credits": 3,
            "cached": 50,
            "latencyMs": 1200,
            "ragDurationMs": 320,
            "conversation_model": "claude-3-5-sonnet",
            "hasRagSearch": True,
            "ragSearchCount": 2,
            "ragSearchMode": "RAG",
            "hasThinking": False,
            "thinkingCount": 0,
            "assistant": {"_id": "ast_a1", "name": "Policy Twin"},
            "in": {"input": "What is the travel reimbursement limit?"},
            "out": {"outputs": ["The limit is $500 per trip per the 2025 policy."]},
        }
    ],
}

RAG_SEGMENTS_RESP = {
    "success": True,
    "ragSearch": [
        {
            "uploadId": "up_001",
            "originalname": "Travel Policy 2025.pdf",
            "chunkIndex": 4,
            "score": 0.91,
            "length": 312,
            "mode": "RAG",
            "chunkText": "Employees may claim up to $500 per trip for travel expenses...",
            "confidential": False,
        },
        {
            "uploadId": "up_002",
            "originalname": "HR Handbook.pdf",
            "chunkIndex": 11,
            "score": 0.73,
            "length": 580,
            "mode": "RAG",
            # Pria pre-redacted this chunk
            "chunkText": "Executive compensation rates(rest is confidential)",
            "confidential": True,
        },
    ],
}

FILES_WITH_ISSUES_RESP = {
    "success": True,
    "files": [
        {"_id": "up_002", "name": "HR Handbook.pdf", "issue": "unindexed"},
    ],
}

HISTORY_WITH_THINKING = {
    "success": True,
    "data": [
        {
            "id": "hist_002",
            "created": "2025-07-10T10:00:00.000Z",
            "credits": 5,
            "cached": 0,
            "latencyMs": 3400,
            "ragDurationMs": None,
            "conversation_model": "claude-3-7-sonnet",
            "hasRagSearch": False,
            "ragSearchCount": 0,
            "ragSearchMode": "",
            "hasThinking": True,
            "thinkingCount": 2,
            "assistant": None,
            "in": {"input": "Explain the trolley problem."},
            "out": {"outputs": ["The trolley problem is a thought experiment..."]},
        }
    ],
}

THINKING_RESP = {
    "success": True,
    "thinking": [
        {
            "id": "round-0",
            "round": 0,
            "text": "Let me think about this carefully...",
            "signature": "sig_abc",
            "model": "claude-3-7-sonnet",
            "durationMs": 1100,
        },
        {
            "id": "round-1",
            "round": 1,
            "text": "The core ethical tension is utilitarian vs deontological...",
            "signature": "sig_def",
            "model": "claude-3-7-sonnet",
            "durationMs": 900,
        },
    ],
}

HISTORY_NO_RAG = {
    "success": True,
    "data": [
        {
            "id": "hist_003",
            "created": "2025-07-10T11:00:00.000Z",
            "credits": 1,
            "cached": 0,
            "latencyMs": 600,
            "ragDurationMs": None,
            "conversation_model": "gpt-4o",
            "hasRagSearch": False,
            "ragSearchCount": 0,
            "ragSearchMode": "",
            "hasThinking": False,
            "thinkingCount": 0,
            "assistant": {"_id": "ast_b2", "name": "General Assistant"},
            "in": {"input": "What is 2+2?"},
            "out": {"outputs": ["4"]},
        }
    ],
}

# ── helpers ───────────────────────────────────────────────────────────────────

class FakeResp:
    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def close(self):
        pass


def _http_error(status, data):
    return urllib.error.HTTPError(
        url="https://pria/", code=status, msg="err", hdrs={},
        fp=BytesIO(json.dumps(data).encode()),
    )


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


def _make_handler(opener, env_key=True):
    from pria.client import PriaClient
    h = ToolHandler({"pria_api_base": "https://pria"})
    if env_key:
        os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40
    h._client = PriaClient(
        api_key="pria_" + "a" * 40,
        base_url="https://pria",
        _opener=opener,
    )
    h._client._jwt = JWT
    return h


# ── trace_answer tests ────────────────────────────────────────────────────────

class TestTraceAnswerShape(unittest.TestCase):
    def setUp(self):
        os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40

    def tearDown(self):
        os.environ.pop("PRIA_API_KEY", None)

    def test_full_trace_packet_shape(self):
        opener = CallRecorder([
            FakeResp(json.dumps(HISTORY_WITH_RAG).encode()),     # list_histories
            FakeResp(json.dumps(RAG_SEGMENTS_RESP).encode()),    # get_rag_search
            FakeResp(json.dumps(FILES_WITH_ISSUES_RESP).encode()),  # files_with_issues
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_TRACE_ANSWER, {"history_id": "hist_001"})

        self.assertNotIn("error", result)
        self.assertEqual(result["history_id"], "hist_001")
        # twin
        self.assertEqual(result["twin"]["assistant_name"], "Policy Twin")
        self.assertEqual(result["twin"]["assistant_id"], "ast_a1")
        self.assertEqual(result["twin"]["model"], "claude-3-5-sonnet")
        # turn
        self.assertEqual(result["turn"]["latency_ms"], 1200)
        self.assertEqual(result["turn"]["rag_duration_ms"], 320)
        self.assertEqual(result["turn"]["credits"], 3)
        # retrieval
        ret = result["retrieval"]
        self.assertTrue(ret["has_rag_search"])
        self.assertEqual(ret["rag_search_mode"], "RAG")
        self.assertEqual(ret["rag_search_count"], 2)
        self.assertEqual(len(ret["segments"]), 2)
        self.assertEqual(ret["confidential_segment_count"], 1)
        self.assertEqual(ret["unhealthy_source_count"], 1)
        # reasoning
        self.assertFalse(result["reasoning"]["has_thinking"])
        self.assertIsNone(result["reasoning"]["rounds"])  # include_reasoning=False

    def test_first_segment_fields(self):
        opener = CallRecorder([
            FakeResp(json.dumps(HISTORY_WITH_RAG).encode()),
            FakeResp(json.dumps(RAG_SEGMENTS_RESP).encode()),
            FakeResp(json.dumps(FILES_WITH_ISSUES_RESP).encode()),
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_TRACE_ANSWER, {"history_id": "hist_001"})
        seg0 = result["retrieval"]["segments"][0]

        self.assertEqual(seg0["upload_id"], "up_001")
        self.assertEqual(seg0["filename"], "Travel Policy 2025.pdf")
        self.assertEqual(seg0["chunk_index"], 4)
        self.assertAlmostEqual(seg0["score"], 0.91)
        self.assertEqual(seg0["mode"], "RAG")
        self.assertFalse(seg0["confidential"])
        self.assertEqual(seg0["source_health"], "ok")
        self.assertIn("$500", seg0["chunk_text"])

    def test_confidential_placeholder_preserved(self):
        """The redacted chunk text must never be expanded — preserve it exactly."""
        opener = CallRecorder([
            FakeResp(json.dumps(HISTORY_WITH_RAG).encode()),
            FakeResp(json.dumps(RAG_SEGMENTS_RESP).encode()),
            FakeResp(json.dumps(FILES_WITH_ISSUES_RESP).encode()),
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_TRACE_ANSWER, {"history_id": "hist_001"})
        seg1 = result["retrieval"]["segments"][1]

        self.assertTrue(seg1["confidential"])
        self.assertIn("(rest is confidential)", seg1["chunk_text"])
        # Must NOT contain anything beyond what Pria provided
        self.assertEqual(seg1["chunk_text"],
                         "Executive compensation rates(rest is confidential)")

    def test_confidential_flag_from_boolean_field(self):
        """confidential=True field alone should mark the segment regardless of text."""
        opener = CallRecorder([
            FakeResp(json.dumps(HISTORY_WITH_RAG).encode()),
            FakeResp(json.dumps({
                "success": True,
                "ragSearch": [{
                    "uploadId": "up_x",
                    "originalname": "secret.pdf",
                    "chunkIndex": 0,
                    "score": 0.8,
                    "length": 100,
                    "mode": "RAG",
                    "chunkText": "Short preview only.",
                    "confidential": True,
                }]
            }).encode()),
            FakeResp(json.dumps({"success": True, "files": []}).encode()),
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_TRACE_ANSWER, {"history_id": "hist_001"})
        seg = result["retrieval"]["segments"][0]
        self.assertTrue(seg["confidential"])

    def test_source_health_annotated_unhealthy(self):
        opener = CallRecorder([
            FakeResp(json.dumps(HISTORY_WITH_RAG).encode()),
            FakeResp(json.dumps(RAG_SEGMENTS_RESP).encode()),
            FakeResp(json.dumps(FILES_WITH_ISSUES_RESP).encode()),
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_TRACE_ANSWER, {"history_id": "hist_001"})
        seg1 = result["retrieval"]["segments"][1]
        # up_002 is in files-with-issues as "unindexed"
        self.assertEqual(seg1["source_health"], "unindexed")

    def test_source_health_ok_when_not_in_issues(self):
        opener = CallRecorder([
            FakeResp(json.dumps(HISTORY_WITH_RAG).encode()),
            FakeResp(json.dumps(RAG_SEGMENTS_RESP).encode()),
            FakeResp(json.dumps(FILES_WITH_ISSUES_RESP).encode()),
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_TRACE_ANSWER, {"history_id": "hist_001"})
        seg0 = result["retrieval"]["segments"][0]
        # up_001 not in issues
        self.assertEqual(seg0["source_health"], "ok")

    def test_no_rag_search_skips_lazy_fetch(self):
        """If has_rag_search is False, no GET /ragSearch call should be made."""
        opener = CallRecorder([
            FakeResp(json.dumps(HISTORY_NO_RAG).encode()),
            # No further calls expected
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_TRACE_ANSWER, {"history_id": "hist_003"})
        # Only one HTTP call (list_histories)
        self.assertEqual(len(opener.calls), 1)
        self.assertEqual(result["retrieval"]["segments"], [])
        self.assertFalse(result["retrieval"]["has_rag_search"])

    def test_include_reasoning_fetches_thinking(self):
        opener = CallRecorder([
            FakeResp(json.dumps(HISTORY_WITH_THINKING).encode()),
            # no RAG fetch (hasRagSearch=False)
            FakeResp(json.dumps(THINKING_RESP).encode()),
            # no health check (no segments)
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_TRACE_ANSWER,
                        {"history_id": "hist_002", "include_reasoning": True})

        self.assertTrue(result["reasoning"]["included"])
        self.assertTrue(result["reasoning"]["has_thinking"])
        rounds = result["reasoning"]["rounds"]
        self.assertEqual(len(rounds), 2)
        self.assertEqual(rounds[0]["id"], "round-0")
        self.assertEqual(rounds[0]["round"], 0)
        self.assertEqual(rounds[0]["duration_ms"], 1100)
        self.assertIn("think", rounds[0]["text"])
        self.assertEqual(rounds[1]["model"], "claude-3-7-sonnet")

    def test_include_reasoning_false_omits_rounds(self):
        opener = CallRecorder([
            FakeResp(json.dumps(HISTORY_WITH_THINKING).encode()),
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_TRACE_ANSWER,
                        {"history_id": "hist_002", "include_reasoning": False})
        self.assertIsNone(result["reasoning"]["rounds"])
        # Should not have fetched thinking
        self.assertEqual(len(opener.calls), 1)

    def test_empty_history_returns_not_found_error(self):
        opener = CallRecorder([
            FakeResp(json.dumps({"success": True, "data": []}).encode()),
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_TRACE_ANSWER, {"history_id": "hist_missing"})
        self.assertIn("error", result)
        self.assertIn("not_found", result["error"])

    def test_rag_fetch_error_surfaces_as_warning(self):
        """A 500 on the RAG fetch should not crash the tool — surfaces as a warning."""
        opener = CallRecorder([
            FakeResp(json.dumps(HISTORY_WITH_RAG).encode()),
            _http_error(500, {"message": "Internal Server Error"}),
            # health check still runs (no segments to check, but attempt is made)
            FakeResp(json.dumps({"success": True, "files": []}).encode()),
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_TRACE_ANSWER, {"history_id": "hist_001"})

        self.assertNotIn("error", result)
        self.assertIn("warnings", result)
        self.assertTrue(any("rag_fetch" in w for w in result["warnings"]))
        # segments should be empty (fetch failed)
        self.assertEqual(result["retrieval"]["segments"], [])

    def test_auth_failure_returns_error(self):
        opener = CallRecorder([
            _http_error(401, {"message": "Authentication Required"}),
            # re-exchange attempt
            _http_error(401, {"message": "Invalid key"}),
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_TRACE_ANSWER, {"history_id": "hist_001"})
        self.assertIn("error", result)

    def test_429_returns_rate_limit_error(self):
        opener = CallRecorder([
            _http_error(429, {"message": "Too many requests"}),
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_TRACE_ANSWER, {"history_id": "hist_001"})
        self.assertIn("error", result)
        self.assertIn("rate_limit", result["error"])

    def test_network_error_returns_structured_error(self):
        opener = CallRecorder([
            urllib.error.URLError("connection refused"),
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_TRACE_ANSWER, {"history_id": "hist_001"})
        self.assertIn("error", result)

    def test_no_api_key_returns_structured_error(self):
        os.environ.pop("PRIA_API_KEY", None)
        h = ToolHandler({"pria_api_base": "https://pria"})
        result = h.call(TOOL_TRACE_ANSWER, {})
        self.assertIn("error", result)
        self.assertIn("pria_api_key", result["error"])

    def test_most_recent_when_no_history_id(self):
        """Omitting history_id should not include historyId in the POST body."""
        opener = CallRecorder([
            FakeResp(json.dumps(HISTORY_NO_RAG).encode()),
        ])
        h = _make_handler(opener)
        h.call(TOOL_TRACE_ANSWER, {})
        body = json.loads(opener.calls[0].data.decode())
        self.assertNotIn("historyId", body)


if __name__ == "__main__":
    unittest.main()
