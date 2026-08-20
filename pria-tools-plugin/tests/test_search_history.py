"""Unit tests for search_history — response normalization and error paths.

All HTTP mocked.
"""
import json
import os
import sys
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.tools import ToolHandler, TOOL_SEARCH_HISTORY  # noqa: E402

JWT = "eyJfake.jwt"

HISTORY_RESP = {
    "success": True,
    "data": [
        {
            "id": "688b024f7db6fe6e921399e3",
            "created": "2025-07-01T12:00:00.000Z",
            "credits": 1,
            "usage": 150,
            "institution": "60d5ec49f1b2c80015a4d1a1",
            "user": "60d5ec49f1b2c80015a4d1a2",
            "favorite": False,
            "forgotten": False,
            "conversation_model": "gpt-4o",
            "success": True,
            "in": {"input": "How do I deploy a Flask app?"},
            "out": {"outputs": ["You can deploy a Flask app using Gunicorn and Nginx..."]},
            "assistant": {"_id": "ass1", "name": "Pria Tutor"},
        },
        {
            "id": "688b024f7db6fe6e921399e4",
            "created": "2025-07-01T13:00:00.000Z",
            "credits": 2,
            "usage": 300,
            "institution": None,
            "user": "60d5ec49f1b2c80015a4d1a2",
            "favorite": True,
            "forgotten": False,
            "conversation_model": "claude-3-5-sonnet",
            "success": True,
            "in": {"input": "What is the difference between WSGI and ASGI?"},
            "out": {"outputs": ["WSGI is synchronous...", "ASGI supports async..."]},
            "assistant": None,
        },
    ],
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


def _make_handler(opener):
    from pria.client import PriaClient
    h = ToolHandler({"pria_api_base": "https://pria"})
    h._client = PriaClient(
        api_key="pria_" + "a" * 40,
        base_url="https://pria",
        _opener=opener,
    )
    h._client._jwt = JWT
    return h


class TestSearchHistoryNormalization(unittest.TestCase):
    def setUp(self):
        os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40

    def tearDown(self):
        os.environ.pop("PRIA_API_KEY", None)

    def test_normalized_shape(self):
        opener = CallRecorder([FakeResp(json.dumps(HISTORY_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_SEARCH_HISTORY, {"query": "deploy", "limit": 5})

        self.assertIn("results", result)
        self.assertIn("count", result)
        self.assertEqual(result["count"], 2)

    def test_first_record_fields(self):
        opener = CallRecorder([FakeResp(json.dumps(HISTORY_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_SEARCH_HISTORY, {"query": "deploy"})
        r0 = result["results"][0]

        self.assertEqual(r0["id"], "688b024f7db6fe6e921399e3")
        self.assertEqual(r0["user_input"], "How do I deploy a Flask app?")
        self.assertIn("Gunicorn", r0["ai_output"])
        self.assertEqual(r0["assistant_name"], "Pria Tutor")
        self.assertEqual(r0["model"], "gpt-4o")
        self.assertEqual(r0["created"], "2025-07-01T12:00:00.000Z")

    def test_multiple_outputs_joined(self):
        opener = CallRecorder([FakeResp(json.dumps(HISTORY_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_SEARCH_HISTORY, {"query": "wsgi"})
        r1 = result["results"][1]
        # Two output strings should be joined
        self.assertIn("WSGI", r1["ai_output"])
        self.assertIn("ASGI", r1["ai_output"])

    def test_null_assistant_returns_empty_name(self):
        opener = CallRecorder([FakeResp(json.dumps(HISTORY_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_SEARCH_HISTORY, {"query": "asgi"})
        self.assertEqual(result["results"][1]["assistant_name"], "")

    def test_request_body_includes_search_and_limit(self):
        opener = CallRecorder([FakeResp(json.dumps(HISTORY_RESP).encode())])
        h = _make_handler(opener)
        h.call(TOOL_SEARCH_HISTORY, {"query": "deploy", "limit": 7})
        body = json.loads(opener.calls[0].data.decode())
        self.assertEqual(body["search"], "deploy")
        self.assertEqual(body["limit"], 7)

    def test_default_limit_is_20(self):
        opener = CallRecorder([FakeResp(json.dumps(HISTORY_RESP).encode())])
        h = _make_handler(opener)
        h.call(TOOL_SEARCH_HISTORY, {"query": "test"})
        body = json.loads(opener.calls[0].data.decode())
        self.assertEqual(body["limit"], 20)

    def test_empty_query_returns_error(self):
        opener = CallRecorder([])
        h = _make_handler(opener)
        result = h.call(TOOL_SEARCH_HISTORY, {"query": ""})
        self.assertIn("error", result)
        self.assertEqual(len(opener.calls), 0)

    def test_429_returns_rate_limit_error(self):
        opener = CallRecorder([_http_error(429, {"message": "Too many"})])
        h = _make_handler(opener)
        result = h.call(TOOL_SEARCH_HISTORY, {"query": "test"})
        self.assertIn("error", result)
        self.assertIn("rate_limit", result["error"])

    def test_network_error_returns_structured_error(self):
        opener = CallRecorder([urllib.error.URLError("offline")])
        h = _make_handler(opener)
        result = h.call(TOOL_SEARCH_HISTORY, {"query": "test"})
        self.assertIn("error", result)

    def test_non_200_returns_structured_error(self):
        opener = CallRecorder([_http_error(500, {"message": "Internal Server Error"})])
        h = _make_handler(opener)
        result = h.call(TOOL_SEARCH_HISTORY, {"query": "test"})
        self.assertIn("error", result)


if __name__ == "__main__":
    unittest.main()
