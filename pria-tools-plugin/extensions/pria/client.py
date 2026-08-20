"""Pria REST API client — stdlib urllib only, no pip deps.

Auth flow (legacy PriaClient):
  1. POST {base}/api/auth/api-key-signin  x-api-key: <pria_key>
     → { token, profile }  (token is a JWT)
  2. Cache the JWT; send as x-access-token on all subsequent calls.
  3. On 401 from any endpoint, re-exchange once, then fail cleanly.

Auth flow (GatewayClient — v2):
  POST {base}/internal/agent-tool-call
  Authorization: Bearer <machine_token>
  Body: { "subject": "<SUBJECT>", "args": { ... } }
  → { "success": true, "callId": "...", "result": <service return> }

Endpoints (GatewayClient subjects):
  SEARCH_KNOWLEDGE — args { query, limit?, minScore?, uploadIds?, vault? }
  SEARCH_HISTORY   — args { filters: { course_id?, before?, after? } }
                     NOTE: no free-text search or limit at the gateway layer —
                     see search_histories() docstring for the known gap.

API key / machine token is NEVER logged, printed, or included in error messages.
"""
import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE = "https://pria.praxislxp.com"
DEFAULT_TIMEOUT = 10.0
_REDACTED = "[REDACTED]"


def _redact_key(text: str, key: str) -> str:
    """Remove a secret value from a string."""
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


# ── GatewayClient (v2 Capability Gateway) ────────────────────────────────────

class GatewayClient:
    """Single-endpoint client for the v2 Capability Gateway.

    Authenticates with a machine token (Bearer).  Never exchanges keys or
    caches JWTs — the token is long-lived and opaque.

    Subject contract
    ----------------
    POST {base}/internal/agent-tool-call
    Headers:
        Authorization: Bearer <machine_token>
        Content-Type:  application/json
    Body:
        { "subject": "<SUBJECT>", "args": { ... } }
    200 OK:
        { "success": true, "callId": "...", "result": <service return> }
    Errors:
        401  → AuthError
        403  → APIError(403, decision)  (denied_subject | denied_allowlist)
        413  → APIError(413, message)
        429  → RateLimitError
        5xx  → APIError(status, decision/message)
    """

    def __init__(self, machine_token: str, base_url: str = DEFAULT_BASE,
                 timeout: float = DEFAULT_TIMEOUT, _opener=None):
        if not machine_token:
            raise ValueError("machine_token is required")
        self._token = machine_token
        self._base = base_url.rstrip("/")
        self._timeout = timeout
        # Injectable for tests — matches urllib.request.urlopen signature.
        self._opener = _opener or urllib.request.urlopen

    def _call(self, subject: str, args: dict) -> dict:
        """POST to /internal/agent-tool-call; return resp_json["result"]."""
        url = f"{self._base}/internal/agent-tool-call"
        payload = {"subject": subject, "args": args}
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        # Token deliberately not echoed in any log/error path.
        req.add_header("Authorization", f"Bearer {self._token}")
        try:
            resp = self._opener(req, timeout=self._timeout)
        except urllib.error.HTTPError as exc:
            status = exc.code
            body_bytes = _safe_read(exc)
            decision = _extract_decision(body_bytes)
            if status == 401:
                raise AuthError(f"Gateway auth failed (401): {decision}") from exc
            if status == 429:
                raise RateLimitError(f"Gateway rate limit exceeded (429): {decision}")
            raise APIError(status, decision) from exc
        except (urllib.error.URLError, OSError) as exc:
            raise APIError(0, f"network error: {exc}") from exc
        raw = _safe_read(resp)
        _close(resp)
        resp_json = _parse_json(raw)
        return resp_json.get("result") or {}

    # ── public methods (same signatures as PriaClient) ────────────────────────

    def search_content(self, query: str, limit: int = 10, min_score: float = 0.1,
                       selected_upload_ids=None) -> dict:
        """SEARCH_KNOWLEDGE via gateway.

        Maps to subject SEARCH_KNOWLEDGE with args:
            { query, limit, minScore, uploadIds? }
        Returns the gateway result dict directly (same shape as
        /api/user/files/search-content).
        """
        args: dict = {"query": query, "limit": limit, "minScore": min_score}
        if selected_upload_ids is not None:
            args["uploadIds"] = selected_upload_ids
        return self._call("SEARCH_KNOWLEDGE", args)

    def search_histories(self, search: str | None = None, limit: int = 20,
                         course_id: str | None = None,
                         before: str | None = None,
                         after: str | None = None) -> dict:
        """SEARCH_HISTORY via gateway.

        KNOWN GAP: the gateway's SEARCH_HISTORY subject accepts only
        structured filters (course_id, before, after) — there is NO
        free-text search parameter and NO limit at the gateway layer.
        The `search` and `limit` arguments accepted here are silently
        ignored; they cannot be forwarded.  Free-text history search
        will be re-enabled once the gateway adds a searchAgentHistory
        text-search enhancement (tracked as a future gateway feature).

        Only course_id / before / after are forwarded as filters.
        """
        filters: dict = {}
        if course_id is not None:
            filters["course_id"] = course_id
        if before is not None:
            filters["before"] = before
        if after is not None:
            filters["after"] = after
        return self._call("SEARCH_HISTORY", {"filters": filters})


# ── PriaClient (legacy — kept as rollback path) ───────────────────────────────

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
        # Injectable for tests — matches urllib.request.urlopen signature.
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
                # Token expired — re-exchange once then retry.
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

    # ── public endpoints ──────────────────────────────────────────────────────

    def search_content(self, query: str, limit: int = 10, min_score: float = 0.1,
                       selected_upload_ids=None) -> dict:
        """POST /api/user/files/search-content — vault RAG/KAG search."""
        payload: dict = {"query": query, "limit": limit, "minScore": min_score}
        if selected_upload_ids is not None:
            payload["selectedUploadIds"] = selected_upload_ids
        return self._post("/api/user/files/search-content", payload)

    def search_histories(self, search: str | None = None, limit: int = 20,
                         all_institutions: bool = False) -> dict:
        """POST /api/user/histories — conversation history search."""
        payload: dict = {"limit": limit, "allInstitutions": all_institutions}
        if search:
            payload["search"] = search
        return self._post("/api/user/histories", payload)


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


def _extract_decision(raw: bytes) -> str:
    """Extract decision or message from a gateway error response."""
    data = _parse_json(raw)
    return data.get("decision") or data.get("message") or raw.decode("utf-8", "replace")[:200]
