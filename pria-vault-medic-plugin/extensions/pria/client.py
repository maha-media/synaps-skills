"""Pria REST API client — stdlib urllib only, no pip deps.

Auth flow:
  1. POST {base}/api/auth/api-key-signin  x-api-key: <pria_key>
     → { token, profile }  (token is a JWT)
  2. Cache the JWT; send as x-access-token on all subsequent calls.
  3. On 401 from any endpoint, re-exchange once, then fail cleanly.

Vault Medic endpoints:
  vault_health_summary   — POST /api/user/uploads/vault-health-summary
  list_uploads           — POST /api/user/uploads  (with optional status/limit filters)
  requeue_upload         — POST /api/user/uploads/re-queue-an-existing-file-for-ingestion
  reload_upload          — POST /api/user/uploads/reload-file-content
  reingest_upload        — POST /api/user/uploads/re-ingest-file-from-source-url

API key is NEVER logged, printed, or included in error messages.
"""
import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE = "https://pria.praxislxp.com"
DEFAULT_TIMEOUT = 15.0
_REDACTED = "[REDACTED]"


def _redact_key(text: str, key: str) -> str:
    if key and key in text:
        return text.replace(key, _REDACTED)
    return text


class AuthError(Exception):
    pass


class RateLimitError(Exception):
    pass


class APIError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(f"HTTP {status}: {message}")


class PriaClient:
    """Thin Pria REST client with JWT caching and one-shot re-auth on 401."""

    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE,
                 timeout: float = DEFAULT_TIMEOUT, _opener=None):
        if not api_key:
            raise ValueError("pria_api_key is required")
        self._key = api_key
        self._base = base_url.rstrip("/")
        self._timeout = timeout
        self._jwt: str | None = None
        self._opener = _opener or urllib.request.urlopen

    # ── auth ─────────────────────────────────────────────────────────────────

    def _exchange(self) -> str:
        """Exchange API key for JWT. Caches result in self._jwt."""
        url = f"{self._base}/api/auth/api-key-signin"
        req = urllib.request.Request(url, data=b"", method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("x-api-key", self._key)
        try:
            resp = self._opener(req, timeout=self._timeout)
        except urllib.error.HTTPError as exc:
            status = exc.code
            body = _safe_read(exc)
            msg = _extract_message(body)
            raise AuthError(f"API key exchange failed (HTTP {status}): {msg}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise AuthError(f"API key exchange network error: {exc}") from exc
        body = _safe_read(resp)
        _close(resp)
        data = _parse_json(body)
        token = data.get("token")
        if not token:
            raise AuthError("api-key-signin returned no token")
        self._jwt = token
        return token

    def _jwt_or_exchange(self) -> str:
        if self._jwt:
            return self._jwt
        return self._exchange()

    # ── request helpers ───────────────────────────────────────────────────────

    def _post(self, path: str, body: dict, *, retry_auth: bool = True) -> dict:
        """POST with JWT auth; re-exchanges once on 401."""
        jwt = self._jwt_or_exchange()
        url = f"{self._base}{path}"
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("x-access-token", jwt)
        try:
            resp = self._opener(req, timeout=self._timeout)
        except urllib.error.HTTPError as exc:
            status = exc.code
            body_bytes = _safe_read(exc)
            msg = _extract_message(body_bytes)
            if status == 401 and retry_auth:
                self._jwt = None
                return self._post(path, body, retry_auth=False)
            if status == 429:
                raise RateLimitError("Pria rate limit exceeded (429). Retry in a moment.")
            raise APIError(status, msg) from exc
        except (urllib.error.URLError, OSError) as exc:
            raise APIError(0, f"network error: {exc}") from exc
        raw = _safe_read(resp)
        _close(resp)
        return _parse_json(raw)

    def _get(self, path: str, *, retry_auth: bool = True) -> dict:
        """GET with JWT auth; re-exchanges once on 401."""
        jwt = self._jwt_or_exchange()
        url = f"{self._base}{path}"
        req = urllib.request.Request(url, method="GET")
        req.add_header("x-access-token", jwt)
        try:
            resp = self._opener(req, timeout=self._timeout)
        except urllib.error.HTTPError as exc:
            status = exc.code
            body_bytes = _safe_read(exc)
            msg = _extract_message(body_bytes)
            if status == 401 and retry_auth:
                self._jwt = None
                return self._get(path, retry_auth=False)
            if status == 429:
                raise RateLimitError("Pria rate limit exceeded (429). Retry in a moment.")
            raise APIError(status, msg) from exc
        except (urllib.error.URLError, OSError) as exc:
            raise APIError(0, f"network error: {exc}") from exc
        raw = _safe_read(resp)
        _close(resp)
        return _parse_json(raw)

    # ── vault medic endpoints ─────────────────────────────────────────────────

    def vault_health_summary(self, vault: str = "personal") -> dict:
        """POST /api/user/uploads/vault-health-summary — letter grade + factor counts."""
        return self._post("/api/user/uploads/vault-health-summary", {"vault": vault})

    def list_uploads(self, limit: int = 100, offset: int = 0,
                     status: str | None = None) -> dict:
        """POST /api/user/uploads — file list with ingestion metadata."""
        payload: dict = {"limit": limit, "offset": offset}
        if status:
            payload["status"] = status
        return self._post("/api/user/uploads", payload)

    def requeue_upload(self, upload_id: str) -> dict:
        """POST /api/user/uploads/re-queue-an-existing-file-for-ingestion — WRITE."""
        return self._post(
            "/api/user/uploads/re-queue-an-existing-file-for-ingestion",
            {"uploadId": upload_id},
        )

    def reload_upload(self, upload_id: str) -> dict:
        """POST /api/user/uploads/reload-file-content — WRITE."""
        return self._post(
            "/api/user/uploads/reload-file-content",
            {"uploadId": upload_id},
        )

    def reingest_upload(self, upload_id: str, source_url: str) -> dict:
        """POST /api/user/uploads/re-ingest-file-from-source-url — WRITE."""
        return self._post(
            "/api/user/uploads/re-ingest-file-from-source-url",
            {"uploadId": upload_id, "sourceUrl": source_url},
        )


# ── helpers ───────────────────────────────────────────────────────────────────

def _safe_read(resp) -> bytes:
    try:
        return resp.read()
    except Exception:
        return b""


def _close(resp) -> None:
    close = getattr(resp, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass


def _parse_json(raw: bytes) -> dict:
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}


def _extract_message(raw: bytes) -> str:
    data = _parse_json(raw)
    return data.get("message") or raw.decode("utf-8", "replace")[:200]
