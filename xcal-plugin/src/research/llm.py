"""llm — minimal Anthropic messages client (urllib, zero new deps).

Just enough for a ReAct tool-use loop. One method: `message(messages, tools,
system)` → a normalized response dict:

    {
      "stop_reason": "tool_use" | "end_turn" | str,
      "content": [
          {"type": "text", "text": "..."} |
          {"type": "tool_use", "id": "...", "name": "...", "input": {...}}
      ],
      "raw": <full provider response>,
    }

Live calls are gated behind config.live_llm(); tests inject a transport.
"""
from __future__ import annotations
import json
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from . import config

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20"

# Synaps OAuth refresh endpoint + client_id (see jawz-refresh-auth tool).
# Refresh is implemented but only invoked explicitly; it never fires inside
# the default test run because tests either set future expiry or assert the
# explicit "expired" error path.
OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"


def _redact(s: str) -> str:
    """Strip Anthropic token-like substrings from any log/error string."""
    import re
    return re.sub(r"sk-ant-[A-Za-z0-9_\-]+", "sk-ant-***REDACTED***", s)


class LLMError(RuntimeError):
    """Wraps any transport / API failure."""


def _default_transport(payload: dict, headers: dict, *, timeout: int = 60) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(ANTHROPIC_URL, data=body, headers=headers,
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:  # noqa: BLE001
            pass
        raise LLMError(_redact(f"HTTP {e.code}: {detail}")) from e
    except urllib.error.URLError as e:
        raise LLMError(_redact(f"network error: {e}")) from e


def _fixture_transport(path: str) -> Callable[..., dict]:
    """Replay a list of pre-recorded provider responses from a JSON file.
    The file contains either a list of response dicts (each consumed once,
    in order) or a single response dict (returned every call)."""
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        responses = [data]
    elif isinstance(data, list):
        responses = list(data)
    else:
        raise LLMError(f"bad fixture: {path}")
    idx = {"i": 0}

    def _t(payload, headers, *, timeout=60):
        i = idx["i"]
        if i >= len(responses):
            raise LLMError("fixture exhausted")
        idx["i"] = i + 1
        return responses[i]
    return _t


@dataclass
class LLM:
    model: str = field(default_factory=config.dexter_model)
    # When set, forces api-key mode with this key. When empty, the client
    # auto-selects via config.anthropic_credential() (api-key > oauth).
    api_key: str = field(default_factory=config.anthropic_api_key)
    max_tokens: int = 4096
    # Injectable for tests. Signature: (payload, headers, *, timeout=...) -> dict
    transport: Callable[..., dict] = field(default=_default_transport)

    def __post_init__(self) -> None:
        # Test fixture: if XCAL_LLM_FIXTURE points at a JSON file containing
        # a list of pre-recorded provider responses, replay them in order.
        # This is the *only* mocking hook in production code — it is inert
        # unless the env var is set (CI/tests). Live runs are unaffected.
        import os as _os
        path = _os.environ.get("XCAL_LLM_FIXTURE", "")
        if path and self.transport is _default_transport:
            self.transport = _fixture_transport(path)
            if not self.api_key:
                self.api_key = "test-fixture-key"

    def _resolve_credential(self) -> tuple[str, str]:
        """Return (mode, secret). Honors explicit self.api_key override; else
        delegates to config.anthropic_credential() for env/auth.json lookup."""
        if self.api_key:
            return ("api_key", self.api_key)
        try:
            return config.anthropic_credential()
        except RuntimeError as e:
            # Redaction is defensive — config.* never embeds secrets, but
            # belt-and-braces in case future callers do.
            raise LLMError(_redact(str(e))) from e

    def message(self, messages: list[dict], *,
                tools: Optional[list[dict]] = None,
                system: Optional[str] = None,
                timeout: int = 60) -> dict:
        mode, secret = self._resolve_credential()
        payload: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": messages,
        }
        if mode == "oauth":
            # OAuth-beta REQUIRES the identity block at system[0]. Research
            # system prompt (if any) comes after.
            blocks = [{"type": "text", "text": config.identity()}]
            if system:
                blocks.append({"type": "text", "text": system})
            payload["system"] = blocks
            headers = {
                "authorization": f"Bearer {secret}",
                "anthropic-beta": ANTHROPIC_OAUTH_BETA,
                "anthropic-version": ANTHROPIC_VERSION,
                "content-type": "application/json",
            }
        else:  # api_key
            if system:
                payload["system"] = system
            headers = {
                "x-api-key": secret,
                "anthropic-version": ANTHROPIC_VERSION,
                "content-type": "application/json",
            }
        if tools:
            payload["tools"] = tools
        try:
            raw = self.transport(payload, headers, timeout=timeout)
        except LLMError as e:
            raise LLMError(_redact(str(e))) from e
        return {
            "stop_reason": raw.get("stop_reason", ""),
            "content": list(raw.get("content", [])),
            "raw": raw,
        }


def refresh_oauth_token(auth_path: Optional[str] = None, *,
                        transport: Optional[Callable[..., dict]] = None) -> dict:
    """Refresh the OAuth tokens in auth.json using the refresh_token grant.

    Endpoint + client_id replicated from Synaps' jawz-refresh-auth tool.
    Writes the rotated {access, refresh, expires} back atomically. Returns
    the new credential dict. Pure-network — never invoked by default tests
    (callers must opt in)."""
    import json as _json
    import os as _os
    import time as _time
    import urllib.parse as _up

    path = Path(auth_path) if auth_path else config.auth_json_path()
    data = _json.loads(Path(path).read_text(encoding="utf-8"))
    anth = (data or {}).get("anthropic") or {}
    refresh = anth.get("refresh") or ""
    if not refresh:
        raise LLMError("cannot refresh: no refresh token in auth.json")

    body = _up.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": OAUTH_CLIENT_ID,
    }).encode("utf-8")
    headers = {"content-type": "application/x-www-form-urlencoded"}

    if transport is None:
        def transport(payload_bytes, hdrs, *, timeout=30):  # noqa: E306
            req = urllib.request.Request(OAUTH_TOKEN_URL, data=payload_bytes,
                                         headers=hdrs, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", errors="replace")[:500]
                raise LLMError(_redact(f"refresh HTTP {e.code}: {detail}")) from e

    resp = transport(body, headers, timeout=30)
    access = resp.get("access_token") or ""
    new_refresh = resp.get("refresh_token") or refresh
    expires_in = int(resp.get("expires_in") or 3600)
    if not access:
        raise LLMError("refresh response missing access_token")

    anth["access"] = access
    anth["refresh"] = new_refresh
    anth["expires"] = int((_time.time() + expires_in) * 1000)
    data["anthropic"] = anth

    tmp = Path(str(path) + ".tmp")
    tmp.write_text(_json.dumps(data, indent=2), encoding="utf-8")
    _os.replace(tmp, path)
    return anth
