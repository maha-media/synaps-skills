"""Unit tests for GatewayClient and _get_client() env-based dispatch.

All HTTP mocked — no live network calls.
"""
import json
import os
import sys
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.client import GatewayClient, AuthError, RateLimitError, APIError  # noqa: E402
from pria.tools import ToolHandler  # noqa: E402


# ── fake HTTP helpers ─────────────────────────────────────────────────────────

class FakeResp:
    def __init__(self, status: int, body: bytes):
        self.status = status
        self._body = body

    def read(self) -> bytes:
        return self._body

    def close(self) -> None:
        pass


def _json_resp(status: int, data: dict) -> FakeResp:
    return FakeResp(status, json.dumps(data).encode())


def _http_error(status: int, data: dict) -> urllib.error.HTTPError:
    body = json.dumps(data).encode()
    return urllib.error.HTTPError(
        url="http://localhost:3080/fake",
        code=status,
        msg="error",
        hdrs={},  # type: ignore[arg-type]
        fp=BytesIO(body),
    )


class CallRecorder:
    """Records all urllib calls and replays a sequence of responses/errors."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls: list = []

    def __call__(self, req, timeout=None):
        self.calls.append(req)
        resp = self._responses.pop(0)
        if isinstance(resp, Exception):
            raise resp
        return resp


TOKEN = "v2_machine_token_abc123"
GW_BASE = "http://localhost:3080"

SEARCH_KNOWLEDGE_RESULT = {
    "results": [{"snippet": "hello", "score": 0.9, "source": "rag",
                 "upload": {"_id": "u1", "file_title": "Doc A"}}],
    "totalScanned": 5,
    "uploadCount": 2,
}

SEARCH_HISTORY_RESULT = {
    "data": [
        {
            "id": "h1",
            "created": "2025-07-01T00:00:00Z",
            "in": {"input": "hello"},
            "out": {"outputs": ["world"]},
            "assistant": {"name": "Pria"},
            "conversation_model": "gpt-4o",
        }
    ]
}


def _gw_ok(result: dict) -> FakeResp:
    return _json_resp(200, {"success": True, "callId": "cid1", "result": result})


# ── GatewayClient._call contract ──────────────────────────────────────────────

class TestGatewayCallContract(unittest.TestCase):
    def test_posts_to_agent_tool_call_endpoint(self):
        rec = CallRecorder([_gw_ok(SEARCH_KNOWLEDGE_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        client._call("SEARCH_KNOWLEDGE", {"query": "test"})
        self.assertEqual(len(rec.calls), 1)
        self.assertIn("/internal/agent-tool-call", rec.calls[0].full_url)

    def test_sends_bearer_authorization_header(self):
        rec = CallRecorder([_gw_ok(SEARCH_KNOWLEDGE_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        client._call("SEARCH_KNOWLEDGE", {"query": "test"})
        # urllib capitalises first char
        auth = rec.calls[0].get_header("Authorization")
        self.assertEqual(auth, f"Bearer {TOKEN}")

    def test_body_contains_subject_and_args(self):
        rec = CallRecorder([_gw_ok(SEARCH_KNOWLEDGE_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        client._call("SEARCH_KNOWLEDGE", {"query": "foo", "limit": 5})
        body = json.loads(rec.calls[0].data.decode())
        self.assertEqual(body["subject"], "SEARCH_KNOWLEDGE")
        self.assertEqual(body["args"]["query"], "foo")
        self.assertEqual(body["args"]["limit"], 5)

    def test_returns_result_field_from_response(self):
        rec = CallRecorder([_gw_ok(SEARCH_KNOWLEDGE_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        result = client._call("SEARCH_KNOWLEDGE", {"query": "x"})
        self.assertIn("results", result)
        self.assertIn("totalScanned", result)

    def test_uses_post_method(self):
        rec = CallRecorder([_gw_ok(SEARCH_KNOWLEDGE_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        client._call("SEARCH_KNOWLEDGE", {"query": "x"})
        self.assertEqual(rec.calls[0].get_method(), "POST")


# ── GatewayClient error handling ──────────────────────────────────────────────

class TestGatewayErrors(unittest.TestCase):
    def test_401_raises_auth_error(self):
        rec = CallRecorder([_http_error(401, {"decision": "invalid_token"})])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        with self.assertRaises(AuthError):
            client._call("SEARCH_KNOWLEDGE", {"query": "x"})

    def test_429_raises_rate_limit_error(self):
        rec = CallRecorder([_http_error(429, {"decision": "rate_limited"})])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        with self.assertRaises(RateLimitError):
            client._call("SEARCH_KNOWLEDGE", {"query": "x"})

    def test_403_raises_api_error_with_decision(self):
        rec = CallRecorder([_http_error(403, {"decision": "denied_subject"})])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        with self.assertRaises(APIError) as ctx:
            client._call("SEARCH_KNOWLEDGE", {"query": "x"})
        self.assertEqual(ctx.exception.status, 403)
        self.assertIn("denied_subject", str(ctx.exception))

    def test_403_denied_allowlist_raises_api_error(self):
        rec = CallRecorder([_http_error(403, {"decision": "denied_allowlist"})])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        with self.assertRaises(APIError) as ctx:
            client._call("SEARCH_KNOWLEDGE", {"query": "x"})
        self.assertIn("denied_allowlist", str(ctx.exception))

    def test_500_raises_api_error(self):
        rec = CallRecorder([_http_error(500, {"decision": "handler_error", "error_kind": "db_timeout"})])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        with self.assertRaises(APIError) as ctx:
            client._call("SEARCH_KNOWLEDGE", {"query": "x"})
        self.assertEqual(ctx.exception.status, 500)

    def test_network_error_raises_api_error_status_0(self):
        rec = CallRecorder([urllib.error.URLError("connection refused")])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        with self.assertRaises(APIError) as ctx:
            client._call("SEARCH_KNOWLEDGE", {"query": "x"})
        self.assertEqual(ctx.exception.status, 0)

    def test_token_not_in_exception_message(self):
        rec = CallRecorder([_http_error(401, {"decision": "invalid_token"})])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        try:
            client._call("SEARCH_KNOWLEDGE", {"query": "x"})
        except AuthError as exc:
            self.assertNotIn(TOKEN, str(exc))

    def test_missing_token_raises_value_error(self):
        with self.assertRaises(ValueError):
            GatewayClient(machine_token="")


# ── GatewayClient search_content ─────────────────────────────────────────────

class TestGatewaySearchContent(unittest.TestCase):
    def test_sends_search_knowledge_subject(self):
        rec = CallRecorder([_gw_ok(SEARCH_KNOWLEDGE_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        client.search_content(query="foo", limit=5)
        body = json.loads(rec.calls[0].data.decode())
        self.assertEqual(body["subject"], "SEARCH_KNOWLEDGE")

    def test_args_include_query_limit_min_score(self):
        rec = CallRecorder([_gw_ok(SEARCH_KNOWLEDGE_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        client.search_content(query="bar", limit=7, min_score=0.3)
        args = json.loads(rec.calls[0].data.decode())["args"]
        self.assertEqual(args["query"], "bar")
        self.assertEqual(args["limit"], 7)
        self.assertAlmostEqual(args["minScore"], 0.3)

    def test_upload_ids_forwarded_when_provided(self):
        rec = CallRecorder([_gw_ok(SEARCH_KNOWLEDGE_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        client.search_content(query="x", selected_upload_ids=["u1", "u2"])
        args = json.loads(rec.calls[0].data.decode())["args"]
        self.assertEqual(args["uploadIds"], ["u1", "u2"])

    def test_upload_ids_omitted_when_none(self):
        rec = CallRecorder([_gw_ok(SEARCH_KNOWLEDGE_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        client.search_content(query="x")
        args = json.loads(rec.calls[0].data.decode())["args"]
        self.assertNotIn("uploadIds", args)


# ── GatewayClient search_histories ───────────────────────────────────────────

class TestGatewaySearchHistories(unittest.TestCase):
    def test_sends_search_history_subject(self):
        rec = CallRecorder([_gw_ok(SEARCH_HISTORY_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        client.search_histories()
        body = json.loads(rec.calls[0].data.decode())
        self.assertEqual(body["subject"], "SEARCH_HISTORY")

    def test_body_contains_filters_key(self):
        rec = CallRecorder([_gw_ok(SEARCH_HISTORY_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        client.search_histories()
        body = json.loads(rec.calls[0].data.decode())
        self.assertIn("filters", body["args"])

    def test_course_id_forwarded_when_provided(self):
        rec = CallRecorder([_gw_ok(SEARCH_HISTORY_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        client.search_histories(course_id="course_abc")
        filters = json.loads(rec.calls[0].data.decode())["args"]["filters"]
        self.assertEqual(filters["course_id"], "course_abc")

    def test_before_after_forwarded_when_provided(self):
        rec = CallRecorder([_gw_ok(SEARCH_HISTORY_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        client.search_histories(before="2025-08-01", after="2025-07-01")
        filters = json.loads(rec.calls[0].data.decode())["args"]["filters"]
        self.assertEqual(filters["before"], "2025-08-01")
        self.assertEqual(filters["after"], "2025-07-01")

    def test_search_text_NOT_forwarded(self):
        """Known gap: free-text `search` is ignored — not sent to gateway."""
        rec = CallRecorder([_gw_ok(SEARCH_HISTORY_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        client.search_histories(search="some free text", limit=50)
        body = json.loads(rec.calls[0].data.decode())
        # search and limit must NOT appear in args
        args = body["args"]
        self.assertNotIn("search", args)
        self.assertNotIn("limit", args)
        # filters also must not contain search
        self.assertNotIn("search", args.get("filters", {}))

    def test_empty_filters_when_no_args(self):
        rec = CallRecorder([_gw_ok(SEARCH_HISTORY_RESULT)])
        client = GatewayClient(machine_token=TOKEN, base_url=GW_BASE, _opener=rec)
        client.search_histories()
        filters = json.loads(rec.calls[0].data.decode())["args"]["filters"]
        self.assertEqual(filters, {})


# ── _get_client() dispatch ────────────────────────────────────────────────────

class TestGetClientDispatch(unittest.TestCase):
    def setUp(self):
        os.environ.pop("PRIA_AGENT_TOOL_TOKEN", None)
        os.environ.pop("PRIA_API_KEY", None)

    def tearDown(self):
        os.environ.pop("PRIA_AGENT_TOOL_TOKEN", None)
        os.environ.pop("PRIA_API_KEY", None)

    def test_machine_token_returns_gateway_client(self):
        os.environ["PRIA_AGENT_TOOL_TOKEN"] = TOKEN
        h = ToolHandler({"pria_api_base": GW_BASE})
        client, err = h._get_client()
        self.assertIsNone(err)
        self.assertIsInstance(client, GatewayClient)

    def test_api_key_only_returns_pria_client(self):
        from pria.client import PriaClient
        os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40
        h = ToolHandler({"pria_api_base": GW_BASE})
        client, err = h._get_client()
        self.assertIsNone(err)
        self.assertIsInstance(client, PriaClient)

    def test_machine_token_preferred_over_api_key(self):
        os.environ["PRIA_AGENT_TOOL_TOKEN"] = TOKEN
        os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40
        h = ToolHandler({"pria_api_base": GW_BASE})
        client, err = h._get_client()
        self.assertIsNone(err)
        self.assertIsInstance(client, GatewayClient)

    def test_neither_set_returns_error_mentioning_token(self):
        h = ToolHandler({"pria_api_base": GW_BASE})
        client, err = h._get_client()
        self.assertIsNone(client)
        self.assertIsNotNone(err)
        self.assertIn("PRIA_AGENT_TOOL_TOKEN", err.get("detail", "") + err.get("error", ""))

    def test_client_cached_on_second_call(self):
        os.environ["PRIA_AGENT_TOOL_TOKEN"] = TOKEN
        h = ToolHandler({"pria_api_base": GW_BASE})
        c1, _ = h._get_client()
        c2, _ = h._get_client()
        self.assertIs(c1, c2)


if __name__ == "__main__":
    unittest.main()
