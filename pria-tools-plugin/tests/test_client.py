"""Unit tests for PriaClient — JWT exchange, caching, re-auth on 401, errors.

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
    """Records all urllib calls and replays a sequence of responses/errors."""

    def __init__(self, responses):
        # responses: list of FakeResp | urllib.error.HTTPError | Exception
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


# ── tests ─────────────────────────────────────────────────────────────────────

JWT = "eyJfake.jwt.token"
AUTH_OK = {"token": JWT, "profile": {"email": "test@example.com", "accountType": "admin"}}


class TestJWTExchange(unittest.TestCase):
    def test_exchange_sends_x_api_key_header(self):
        rec = CallRecorder([_json_resp(200, AUTH_OK)])
        client = PriaClient(api_key="pria_" + "a" * 40, _opener=rec)
        client._exchange()
        call = rec.calls[0]
        self.assertIn("/api/auth/api-key-signin", call["url"])
        # urllib capitalises the first char of custom headers
        self.assertIn("X-api-key", call["headers"])
        self.assertEqual(call["method"], "POST")

    def test_exchange_caches_jwt(self):
        rec = CallRecorder([_json_resp(200, AUTH_OK)])
        client = PriaClient(api_key="pria_" + "a" * 40, _opener=rec)
        client._jwt_or_exchange()
        client._jwt_or_exchange()  # second call must NOT hit network
        self.assertEqual(len(rec.calls), 1)
        self.assertEqual(client._jwt, JWT)

    def test_exchange_401_raises_auth_error(self):
        rec = CallRecorder([_http_error(401, {"message": "Invalid API key"})])
        client = PriaClient(api_key="pria_" + "b" * 40, _opener=rec)
        with self.assertRaises(AuthError) as ctx:
            client._exchange()
        self.assertIn("401", str(ctx.exception))

    def test_exchange_network_error_raises_auth_error(self):
        import urllib.error
        rec = CallRecorder([urllib.error.URLError("connection refused")])
        client = PriaClient(api_key="pria_" + "c" * 40, _opener=rec)
        with self.assertRaises(AuthError):
            client._exchange()

    def test_exchange_missing_token_raises_auth_error(self):
        rec = CallRecorder([_json_resp(200, {"success": True})])  # no token field
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
        """A 401 from a data endpoint triggers re-exchange then retries."""
        rec = CallRecorder([
            _json_resp(200, AUTH_OK),                        # initial exchange
            _http_error(401, {"message": "token expired"}),  # data 401
            _json_resp(200, AUTH_OK),                        # re-exchange
            _json_resp(200, {"success": True, "results": [], "totalScanned": 0}),  # retry
        ])
        client = PriaClient(api_key="pria_" + "f" * 40, _opener=rec)
        client._exchange()  # warm up jwt
        client._jwt = "stale_token"
        client._post("/api/user/files/search-content", {"query": "test"})
        # should have made 4 calls total
        self.assertEqual(len(rec.calls), 4)

    def test_reauth_does_not_loop_on_second_401(self):
        """Second consecutive 401 after re-exchange raises APIError cleanly."""
        rec = CallRecorder([
            _json_resp(200, AUTH_OK),                        # initial exchange
            _http_error(401, {"message": "expired"}),        # data 401
            _json_resp(200, AUTH_OK),                        # re-exchange
            _http_error(401, {"message": "still bad"}),      # second 401
        ])
        client = PriaClient(api_key="pria_" + "g" * 40, _opener=rec)
        client._exchange()
        client._jwt = "stale"
        with self.assertRaises(APIError) as ctx:
            client._post("/api/user/files/search-content", {"query": "x"})
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
            client._post("/api/user/files/search-content", {"query": "x"})


class TestNetworkError(unittest.TestCase):
    def test_url_error_raises_api_error(self):
        import urllib.error
        rec = CallRecorder([
            _json_resp(200, AUTH_OK),
            urllib.error.URLError("timed out"),
        ])
        client = PriaClient(api_key="pria_" + "i" * 40, _opener=rec)
        client._exchange()
        with self.assertRaises(APIError) as ctx:
            client._post("/api/user/files/search-content", {"query": "x"})
        self.assertEqual(ctx.exception.status, 0)


class TestMissingApiKey(unittest.TestCase):
    def test_empty_key_raises_value_error(self):
        with self.assertRaises(ValueError):
            PriaClient(api_key="")


if __name__ == "__main__":
    unittest.main()
