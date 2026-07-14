"""Unit tests for list_traceable_answers and answer_confidence — normalisation
and error paths. All HTTP mocked.
"""
import json
import os
import sys
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.tools import ToolHandler, TOOL_LIST_TRACEABLE, TOOL_ANSWER_CONFIDENCE  # noqa: E402

JWT = "eyJfake.jwt"

MULTI_HISTORY_RESP = {
    "success": True,
    "data": [
        {
            "id": "h1",
            "created": "2025-07-10T08:00:00.000Z",
            "credits": 2,
            "cached": 100,
            "latencyMs": 850,
            "ragDurationMs": 200,
            "conversation_model": "gpt-4o",
            "hasRagSearch": True,
            "ragSearchCount": 3,
            "ragSearchMode": "KAG",
            "hasThinking": False,
            "thinkingCount": 0,
            "assistant": {"_id": "ast_x", "name": "Tutor Twin"},
            "in": {"input": "Explain photosynthesis."},
            "out": {"outputs": ["Photosynthesis converts light to energy."]},
        },
        {
            "id": "h2",
            "created": "2025-07-10T09:00:00.000Z",
            "credits": 5,
            "cached": 0,
            "latencyMs": 3200,
            "ragDurationMs": None,
            "conversation_model": "claude-3-7-sonnet",
            "hasRagSearch": False,
            "ragSearchCount": 0,
            "ragSearchMode": "",
            "hasThinking": True,
            "thinkingCount": 1,
            "assistant": None,
            "in": {"input": "What is entropy?"},
            "out": {"outputs": ["Entropy is a measure of disorder."]},
        },
    ],
}

RAG_FOR_CONFIDENCE = {
    "success": True,
    "ragSearch": [
        {
            "uploadId": "up_a",
            "originalname": "Biology.pdf",
            "chunkIndex": 1,
            "score": 0.88,
            "length": 200,
            "mode": "KAG",
            "chunkText": "Chlorophyll absorbs sunlight...",
            "confidential": False,
        },
        {
            "uploadId": "up_b",
            "originalname": "Secret.pdf",
            "chunkIndex": 5,
            "score": 0.65,
            "length": 800,
            "mode": "KAG",
            "chunkText": "Confidential rate info(rest is confidential)",
            "confidential": True,
        },
        {
            "uploadId": "up_a",
            "originalname": "Biology.pdf",
            "chunkIndex": 2,
            "score": 0.77,
            "length": 150,
            "mode": "KAG",
            "chunkText": "ATP is the energy currency...",
            "confidential": False,
        },
    ],
}

FILES_ISSUES = {
    "success": True,
    "files": [
        {"_id": "up_b", "name": "Secret.pdf", "issue": "missing_file"},
    ],
}


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


def _make_handler(opener):
    from pria.client import PriaClient
    h = ToolHandler({"pria_api_base": "https://pria"})
    os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40
    h._client = PriaClient(
        api_key="pria_" + "a" * 40, base_url="https://pria", _opener=opener,
    )
    h._client._jwt = JWT
    return h


# ── list_traceable_answers ────────────────────────────────────────────────────

class TestListTraceable(unittest.TestCase):
    def setUp(self):
        os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40

    def tearDown(self):
        os.environ.pop("PRIA_API_KEY", None)

    def test_returns_results_and_count(self):
        opener = CallRecorder([FakeResp(json.dumps(MULTI_HISTORY_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_LIST_TRACEABLE, {"limit": 10})
        self.assertIn("results", result)
        self.assertEqual(result["count"], 2)

    def test_observability_flags_present(self):
        opener = CallRecorder([FakeResp(json.dumps(MULTI_HISTORY_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_LIST_TRACEABLE, {})
        r0 = result["results"][0]
        self.assertTrue(r0["has_rag_search"])
        self.assertEqual(r0["rag_search_count"], 3)
        self.assertEqual(r0["rag_search_mode"], "KAG")
        self.assertFalse(r0["has_thinking"])
        self.assertEqual(r0["assistant_name"], "Tutor Twin")
        self.assertEqual(r0["latency_ms"], 850)
        self.assertEqual(r0["rag_duration_ms"], 200)
        self.assertEqual(r0["cached_tokens"], 100)

    def test_second_row_thinking_flags(self):
        opener = CallRecorder([FakeResp(json.dumps(MULTI_HISTORY_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_LIST_TRACEABLE, {})
        r1 = result["results"][1]
        self.assertFalse(r1["has_rag_search"])
        self.assertTrue(r1["has_thinking"])
        self.assertEqual(r1["thinking_count"], 1)
        self.assertEqual(r1["assistant_name"], "")  # null assistant

    def test_default_limit_is_20(self):
        opener = CallRecorder([FakeResp(json.dumps(MULTI_HISTORY_RESP).encode())])
        h = _make_handler(opener)
        h.call(TOOL_LIST_TRACEABLE, {})
        body = json.loads(opener.calls[0].data.decode())
        self.assertEqual(body["limit"], 20)

    def test_search_passed_to_api(self):
        opener = CallRecorder([FakeResp(json.dumps(MULTI_HISTORY_RESP).encode())])
        h = _make_handler(opener)
        h.call(TOOL_LIST_TRACEABLE, {"search": "photosynthesis"})
        body = json.loads(opener.calls[0].data.decode())
        self.assertEqual(body["search"], "photosynthesis")

    def test_all_institutions_flag(self):
        opener = CallRecorder([FakeResp(json.dumps(MULTI_HISTORY_RESP).encode())])
        h = _make_handler(opener)
        h.call(TOOL_LIST_TRACEABLE, {"all_institutions": True})
        body = json.loads(opener.calls[0].data.decode())
        self.assertTrue(body["allInstitutions"])

    def test_limit_clamped_to_100(self):
        opener = CallRecorder([FakeResp(json.dumps(MULTI_HISTORY_RESP).encode())])
        h = _make_handler(opener)
        h.call(TOOL_LIST_TRACEABLE, {"limit": 9999})
        body = json.loads(opener.calls[0].data.decode())
        self.assertEqual(body["limit"], 100)

    def test_429_returns_rate_limit_error(self):
        opener = CallRecorder([_http_error(429, {"message": "Too many"})])
        h = _make_handler(opener)
        result = h.call(TOOL_LIST_TRACEABLE, {})
        self.assertIn("error", result)
        self.assertIn("rate_limit", result["error"])

    def test_network_error_returns_structured_error(self):
        opener = CallRecorder([urllib.error.URLError("offline")])
        h = _make_handler(opener)
        result = h.call(TOOL_LIST_TRACEABLE, {})
        self.assertIn("error", result)

    def test_no_api_key_returns_error(self):
        os.environ.pop("PRIA_API_KEY", None)
        h = ToolHandler({"pria_api_base": "https://pria"})
        result = h.call(TOOL_LIST_TRACEABLE, {})
        self.assertIn("error", result)


# ── answer_confidence ─────────────────────────────────────────────────────────

class TestAnswerConfidence(unittest.TestCase):
    def setUp(self):
        os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40

    def tearDown(self):
        os.environ.pop("PRIA_API_KEY", None)

    def _history_with_rag(self, has_rag=True, hist_id="h1"):
        return {
            "success": True,
            "data": [MULTI_HISTORY_RESP["data"][0 if has_rag else 1]],
        }

    def test_confidence_shape_with_rag(self):
        opener = CallRecorder([
            FakeResp(json.dumps(self._history_with_rag()).encode()),
            FakeResp(json.dumps(RAG_FOR_CONFIDENCE).encode()),
            FakeResp(json.dumps(FILES_ISSUES).encode()),
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_ANSWER_CONFIDENCE, {"history_id": "h1"})

        self.assertNotIn("error", result)
        self.assertEqual(result["history_id"], "h1")
        self.assertTrue(result["has_rag_search"])
        self.assertEqual(result["source_count"], 2)  # up_a and up_b
        self.assertEqual(result["chunk_count"], 3)
        self.assertEqual(result["confidential_chunks"], 1)
        self.assertEqual(result["unhealthy_sources"], 1)  # up_b is missing_file
        # avg of 0.88, 0.65, 0.77
        expected_avg = round((0.88 + 0.65 + 0.77) / 3, 4)
        self.assertAlmostEqual(result["avg_score"], expected_avg, places=3)
        self.assertAlmostEqual(result["max_score"], 0.88, places=3)
        self.assertAlmostEqual(result["min_score"], 0.65, places=3)

    def test_no_rag_returns_note(self):
        no_rag_resp = {
            "success": True,
            "data": [MULTI_HISTORY_RESP["data"][1]],  # has_rag_search=False
        }
        opener = CallRecorder([FakeResp(json.dumps(no_rag_resp).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_ANSWER_CONFIDENCE, {"history_id": "h2"})

        self.assertFalse(result["has_rag_search"])
        self.assertEqual(result["source_count"], 0)
        self.assertIn("note", result)
        self.assertIn("no RAG/KAG retrieval", result["note"])
        # should only have made 1 HTTP call (no lazy fetch)
        self.assertEqual(len(opener.calls), 1)

    def test_not_found_returns_error(self):
        opener = CallRecorder([
            FakeResp(json.dumps({"success": True, "data": []}).encode()),
        ])
        h = _make_handler(opener)
        result = h.call(TOOL_ANSWER_CONFIDENCE, {"history_id": "missing"})
        self.assertIn("error", result)


if __name__ == "__main__":
    unittest.main()
