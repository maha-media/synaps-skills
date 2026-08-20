"""Unit tests for PriaClient (black-box variant) — JWT exchange, caching,
re-auth on 401, GET support, errors.

All HTTP mocked — no live network calls.
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

JWT = "eyJfake.jwt.token"
AUTH_OK = {"token": JWT, "profile": {"email": "test@example.com"}}


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
        url="https://pria/fake", code=status, msg="error",
        hdrs={},  # type: ignore[arg-type]
        fp=BytesIO(body),
    )


class CallRecorder:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls: list = []

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


# ── JWT exchange tests ────────────────────────────────────────────────────────

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
        client._jwt_or_exchange()  # must NOT hit network
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
        client = PriaClient(api_key="pria_" + "c" * 40, _opener=rec)
        with self.assertRaises(AuthError):
            client._exchange()

    def test_api_key_not_in_exception_message(self):
        secret = "pria_" + "e" * 40
        rec = CallRecorder([_http_error(401, {"message": "Invalid API key"})])
        client = PriaClient(api_key=secret, _opener=rec)
        try:
            client._exchange()
        except AuthError as exc:
            self.assertNotIn(secret, str(exc))

    def test_empty_key_raises_value_error(self):
        with self.assertRaises(ValueError):
            PriaClient(api_key="")


# ── GET support ───────────────────────────────────────────────────────────────

class TestGetMethod(unittest.TestCase):
    def test_get_sends_correct_method(self):
        rec = CallRecorder([
            _json_resp(200, AUTH_OK),
            _json_resp(200, {"success": True, "ragSearch": []}),
        ])
        client = PriaClient(api_key="pria_" + "a" * 40, _opener=rec)
        client._exchange()
        client._get("/api/user/history/abc123/ragSearch")
        self.assertEqual(rec.calls[1]["method"], "GET")
        self.assertIn("/api/user/history/abc123/ragSearch", rec.calls[1]["url"])
        self.assertIn("X-access-token", rec.calls[1]["headers"])

    def test_get_reauth_on_401(self):
        rec = CallRecorder([
            _json_resp(200, AUTH_OK),              # initial exchange
            _http_error(401, {"message": "expired"}),  # data 401
            _json_resp(200, AUTH_OK),              # re-exchange
            _json_resp(200, {"success": True, "thinking": []}),  # retry
        ])
        client = PriaClient(api_key="pria_" + "a" * 40, _opener=rec)
        client._exchange()
        client._jwt = "stale"
        client._get("/api/user/history/abc/thinking")
        self.assertEqual(len(rec.calls), 4)

    def test_get_429_raises_rate_limit(self):
        rec = CallRecorder([
            _json_resp(200, AUTH_OK),
            _http_error(429, {"message": "Too many"}),
        ])
        client = PriaClient(api_key="pria_" + "a" * 40, _opener=rec)
        client._exchange()
        with self.assertRaises(RateLimitError):
            client._get("/api/user/history/x/ragSearch")


# ── re-auth on POST 401 ───────────────────────────────────────────────────────

class TestReAuthOn401(unittest.TestCase):
    def test_reauth_once_on_endpoint_401(self):
        rec = CallRecorder([
            _json_resp(200, AUTH_OK),
            _http_error(401, {"message": "token expired"}),
            _json_resp(200, AUTH_OK),
            _json_resp(200, {"success": True, "data": []}),
        ])
        client = PriaClient(api_key="pria_" + "f" * 40, _opener=rec)
        client._exchange()
        client._jwt = "stale_token"
        client._post("/api/user/histories", {"limit": 1})
        self.assertEqual(len(rec.calls), 4)

    def test_second_401_raises_api_error(self):
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
            client._post("/api/user/histories", {"limit": 1})
        self.assertEqual(ctx.exception.status, 401)


if __name__ == "__main__":
    unittest.main()
