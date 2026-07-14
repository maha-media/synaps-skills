"""Unit tests for search_knowledge — response normalization and error paths.

All HTTP mocked. Verifies the normalized { results, count } shape and that
citations survive from the API response.
"""
import json
import os
import sys
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.tools import ToolHandler, TOOL_SEARCH_KNOWLEDGE  # noqa: E402

JWT = "eyJfake.jwt"
AUTH_RESP = {"token": JWT, "profile": {"email": "u@x.com", "accountType": "admin"}}

# Sample /api/user/files/search-content response
SEARCH_CONTENT_RESP = {
    "success": True,
    "query": "quantum gravity",
    "results": [
        {
            "uploadId": "up1",
            "chunkId": "ck1",
            "chunkIndex": 3,
            "snippet": "Quantum gravity is the field of physics that seeks...",
            "content": "Quantum gravity is the field of physics that seeks to unify QM and GR.",
            "matchedEntities": ["quantum gravity", "general relativity"],
            "trace": [{"list": "dense", "rank": 1}],
            "score": 0.87,
            "source": "fused",
            "upload": {
                "_id": "up1",
                "originalname": "physics-notes.pdf",
                "filesize": 102400,
                "mimetype": "application/pdf",
                "file_title": "Physics Notes",
                "institution": None,
                "account_shared": False,
                "is_private": False,
                "confidential": False,
            },
        },
        {
            "uploadId": "up2",
            "chunkId": "ck2",
            "chunkIndex": 7,
            "snippet": "Loop quantum gravity (LQG) proposes...",
            "content": "Loop quantum gravity (LQG) proposes a discrete spacetime.",
            "matchedEntities": [],
            "trace": [],
            "score": 0.71,
            "source": "rag",
            "upload": {
                "_id": "up2",
                "originalname": "lqg-paper.pdf",
                "filesize": 204800,
                "mimetype": "application/pdf",
                "file_title": None,   # fall back to originalname
                "institution": "inst_1",
                "account_shared": True,
                "is_private": False,
                "confidential": False,
            },
        },
    ],
    "totalScanned": 50,
    "uploadCount": 12,
    "tookMs": 83,
}


class FakeResp:
    def __init__(self, body: bytes):
        self.status = 200
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


def _make_handler(opener, config=None):
    h = ToolHandler(config or {"pria_api_base": "https://pria"})
    h._client = None
    os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40
    # Pre-warm the client with the given opener
    from pria.client import PriaClient
    h._client = PriaClient(
        api_key="pria_" + "a" * 40,
        base_url="https://pria",
        _opener=opener,
    )
    h._client._jwt = JWT  # skip exchange
    return h


class TestSearchKnowledgeNormalization(unittest.TestCase):
    def setUp(self):
        os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40

    def tearDown(self):
        os.environ.pop("PRIA_API_KEY", None)

    def test_normalized_shape(self):
        opener = CallRecorder([FakeResp(json.dumps(SEARCH_CONTENT_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_SEARCH_KNOWLEDGE, {"query": "quantum gravity", "max_results": 5})

        self.assertIn("results", result)
        self.assertIn("count", result)
        self.assertEqual(result["count"], 2)

        r0 = result["results"][0]
        self.assertEqual(r0["text"], "Quantum gravity is the field of physics that seeks...")
        self.assertAlmostEqual(r0["score"], 0.87)
        self.assertEqual(r0["source"], "fused")
        self.assertEqual(r0["citation"], "Physics Notes")
        self.assertEqual(r0["upload_id"], "up1")
        self.assertEqual(r0["matched_entities"], ["quantum gravity", "general relativity"])

    def test_citation_falls_back_to_originalname(self):
        opener = CallRecorder([FakeResp(json.dumps(SEARCH_CONTENT_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_SEARCH_KNOWLEDGE, {"query": "lqg"})
        r1 = result["results"][1]
        # file_title is None → should fall back to originalname
        self.assertEqual(r1["citation"], "lqg-paper.pdf")

    def test_default_max_results_is_10(self):
        opener = CallRecorder([FakeResp(json.dumps(SEARCH_CONTENT_RESP).encode())])
        h = _make_handler(opener)
        h.call(TOOL_SEARCH_KNOWLEDGE, {"query": "test"})
        body = json.loads(opener.calls[0].data.decode())
        self.assertEqual(body["limit"], 10)

    def test_max_results_clamped_to_100(self):
        opener = CallRecorder([FakeResp(json.dumps(SEARCH_CONTENT_RESP).encode())])
        h = _make_handler(opener)
        h.call(TOOL_SEARCH_KNOWLEDGE, {"query": "test", "max_results": 9999})
        body = json.loads(opener.calls[0].data.decode())
        self.assertEqual(body["limit"], 100)

    def test_empty_query_returns_error(self):
        opener = CallRecorder([])
        h = _make_handler(opener)
        result = h.call(TOOL_SEARCH_KNOWLEDGE, {"query": "  "})
        self.assertIn("error", result)
        self.assertEqual(len(opener.calls), 0)

    def test_401_returns_structured_error(self):
        opener = CallRecorder([_http_error(401, {"message": "Authentication Required"})])
        h = _make_handler(opener)
        # Disable re-auth by pre-exhausting the opener
        result = h.call(TOOL_SEARCH_KNOWLEDGE, {"query": "test"})
        self.assertIn("error", result)
        self.assertNotIn("results", result)

    def test_429_returns_rate_limit_error(self):
        opener = CallRecorder([_http_error(429, {"message": "Too many requests"})])
        h = _make_handler(opener)
        result = h.call(TOOL_SEARCH_KNOWLEDGE, {"query": "test"})
        self.assertIn("error", result)
        self.assertIn("rate_limit", result["error"])

    def test_network_error_returns_structured_error(self):
        opener = CallRecorder([urllib.error.URLError("timed out")])
        h = _make_handler(opener)
        result = h.call(TOOL_SEARCH_KNOWLEDGE, {"query": "test"})
        self.assertIn("error", result)

    def test_no_api_key_returns_structured_error(self):
        os.environ.pop("PRIA_API_KEY", None)
        h = ToolHandler({"pria_api_base": "https://pria"})
        result = h.call(TOOL_SEARCH_KNOWLEDGE, {"query": "test"})
        self.assertIn("error", result)
        self.assertIn("pria_api_key", result["error"])


if __name__ == "__main__":
    unittest.main()
