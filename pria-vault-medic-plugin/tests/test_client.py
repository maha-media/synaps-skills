"""Unit tests for PriaClient (vault medic variant) — JWT exchange, caching, re-auth, errors.

All HTTP is mocked — no live network calls.
"""
import json
import sys
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.client import PriaClient, AuthError, RateLimitError, APIError  # noqa: E402


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
        url="https://pria.praxislxp.com/fake",
        code=status,
        msg="error",
        hdrs={},  # type: ignore[arg-type]
        fp=BytesIO(body),
    )


class CallRecorder:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls: list[dict] = []

    def __call__(self, req, timeout=None):
        self.calls.append({
            "url": req.full_url,
            "method": req.get_method(),
            "headers": dict(req.headers),
            "body": req.data,
        })
        resp = self._responses.pop(0)
        if isinstance(resp, Exception):
            raise resp
        return resp


JWT = "eyJfake.jwt.token"
AUTH_OK = {"token": JWT, "profile": {"email": "test@example.com"}}

HEALTH_OK = {
    "success": True,
    "summary": {
        "totalCount": 5, "activeCount": 3, "usedCount": 0, "processingCount": 0,
        "errorCount": 2, "neverUsedCount": 4, "staleCount": 0, "unscannedCount": 1,
        "unoptimizedCount": 0, "unindexedCount": 0, "missingTerminalCount": 0,
        "staleBaseUrlCount": 0,
    },
    "grade": {
        "letter": "C", "score": 71,
        "factors": [
            {"key": "errorCount", "count": 2, "impact": 20, "label": "Files in error state"},
            {"key": "neverUsedCount", "count": 4, "impact": 8, "label": "Never retrieved in RAG (>7d old)"},
        ],
    },
}


class TestJWTExchange(unittest.TestCase):
    def test_exchange_sends_x_api_key_header(self):
        rec = CallRecorder([_json_resp(200, AUTH_OK)])
        client = PriaClient(api_key="pria_" + "a" * 40, _opener=rec)
        client._exchange()
        call = rec.calls[0]
        self.assertIn("/api/auth/api-key-signin", call["url"])
        self.assertIn("X-api-key", call["headers"])
        self.assertEqual(call["method"], "POST")

    def test_exchange_caches_jwt(self):
        rec = CallRecorder([_json_resp(200, AUTH_OK)])
        client = PriaClient(api_key="pria_" + "a" * 40, _opener=rec)
        client._jwt_or_exchange()
        client._jwt_or_exchange()
        self.assertEqual(len(rec.calls), 1)
        self.assertEqual(client._jwt, JWT)

    def test_exchange_401_raises_auth_error(self):
        rec = CallRecorder([_http_error(401, {"message": "Invalid API key"})])
        client = PriaClient(api_key="pria_" + "b" * 40, _opener=rec)
        with self.assertRaises(AuthError) as ctx:
            client._exchange()
        self.assertIn("401", str(ctx.exception))

    def test_exchange_missing_token_raises_auth_error(self):
        rec = CallRecorder([_json_resp(200, {"success": True})])
        client = PriaClient(api_key="pria_" + "d" * 40, _opener=rec)
        with self.assertRaises(AuthError) as ctx:
            client._exchange()
        self.assertIn("no token", str(ctx.exception))

    def test_api_key_not_in_exception_message(self):
        """API key must never appear in exception text."""
        secret = "pria_" + "e" * 40
        rec = CallRecorder([_http_error(401, {"message": "Invalid API key"})])
        client = PriaClient(api_key=secret, _opener=rec)
        try:
            client._exchange()
        except AuthError as exc:
            self.assertNotIn(secret, str(exc))


class TestReAuthOn401(unittest.TestCase):
    def test_reauth_once_on_endpoint_401(self):
        rec = CallRecorder([
            _json_resp(200, AUTH_OK),
            _http_error(401, {"message": "token expired"}),
            _json_resp(200, AUTH_OK),
            _json_resp(200, HEALTH_OK),
        ])
        client = PriaClient(api_key="pria_" + "f" * 40, _opener=rec)
        client._exchange()
        client._jwt = "stale_token"
        client.vault_health_summary()
        self.assertEqual(len(rec.calls), 4)

    def test_reauth_does_not_loop_on_second_401(self):
        rec = CallRecorder([
            _json_resp(200, AUTH_OK),
            _http_error(401, {"message": "expired"}),
            _json_resp(200, AUTH_OK),
            _http_error(401, {"message": "still bad"}),
        ])
        client = PriaClient(api_key="pria_" + "g" * 40, _opener=rec)
        client._exchange()
        client._jwt = "stale"
        with self.assertRaises(APIError) as ctx:
            client.vault_health_summary()
        self.assertEqual(ctx.exception.status, 401)


class TestRateLimit(unittest.TestCase):
    def test_429_raises_rate_limit_error(self):
        rec = CallRecorder([
            _json_resp(200, AUTH_OK),
            _http_error(429, {"message": "Too many requests"}),
        ])
        client = PriaClient(api_key="pria_" + "h" * 40, _opener=rec)
        client._exchange()
        with self.assertRaises(RateLimitError):
            client.vault_health_summary()


class TestNetworkError(unittest.TestCase):
    def test_url_error_raises_api_error(self):
        rec = CallRecorder([
            _json_resp(200, AUTH_OK),
            urllib.error.URLError("timed out"),
        ])
        client = PriaClient(api_key="pria_" + "i" * 40, _opener=rec)
        client._exchange()
        with self.assertRaises(APIError) as ctx:
            client.vault_health_summary()
        self.assertEqual(ctx.exception.status, 0)


class TestMissingApiKey(unittest.TestCase):
    def test_empty_key_raises_value_error(self):
        with self.assertRaises(ValueError):
            PriaClient(api_key="")


class TestVaultEndpoints(unittest.TestCase):
    def _client(self, responses):
        rec = CallRecorder(responses)
        client = PriaClient(api_key="pria_" + "z" * 40, _opener=rec)
        client._jwt = JWT  # skip exchange
        return client, rec

    def test_vault_health_summary_sends_correct_body(self):
        client, rec = self._client([_json_resp(200, HEALTH_OK)])
        client.vault_health_summary(vault="personal")
        body = json.loads(rec.calls[0]["body"].decode())
        self.assertEqual(body, {"vault": "personal"})
        self.assertIn("/api/user/uploads/vault-health-summary", rec.calls[0]["url"])

    def test_list_uploads_default_params(self):
        client, rec = self._client([_json_resp(200, {"data": []})])
        client.list_uploads()
        body = json.loads(rec.calls[0]["body"].decode())
        self.assertEqual(body["limit"], 100)
        self.assertEqual(body["offset"], 0)

    def test_requeue_upload_sends_upload_id(self):
        client, rec = self._client([_json_resp(200, {"success": True})])
        client.requeue_upload("abc123")
        body = json.loads(rec.calls[0]["body"].decode())
        self.assertEqual(body["uploadId"], "abc123")
        self.assertIn("re-queue-an-existing-file-for-ingestion", rec.calls[0]["url"])

    def test_reload_upload_sends_upload_id(self):
        client, rec = self._client([_json_resp(200, {"success": True})])
        client.reload_upload("abc123")
        body = json.loads(rec.calls[0]["body"].decode())
        self.assertEqual(body["uploadId"], "abc123")
        self.assertIn("reload-file-content", rec.calls[0]["url"])

    def test_reingest_upload_sends_upload_id_and_url(self):
        client, rec = self._client([_json_resp(200, {"success": True})])
        client.reingest_upload("abc123", "https://example.com/doc.pdf")
        body = json.loads(rec.calls[0]["body"].decode())
        self.assertEqual(body["uploadId"], "abc123")
        self.assertEqual(body["sourceUrl"], "https://example.com/doc.pdf")
        self.assertIn("re-ingest-file-from-source-url", rec.calls[0]["url"])


if __name__ == "__main__":
    unittest.main()
