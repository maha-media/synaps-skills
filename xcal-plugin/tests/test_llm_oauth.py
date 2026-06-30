"""OAuth (Claude-subscription) auth tests for the LLM client.

Tests are hermetic: a fake auth.json is written to a tmp path and pointed at
via XCAL_AUTH_JSON. No network is ever invoked — the transport is mocked.
"""
import json
import time

import pytest

from src.research import config
from src.research.llm import LLM, LLMError, ANTHROPIC_OAUTH_BETA


SAMPLE_ACCESS = "sk-ant-oat01-FAKEACCESSTOKEN-deadbeef"
SAMPLE_REFRESH = "sk-ant-ort01-FAKEREFRESHTOKEN-cafef00d"
RESEARCH_SYS = "you are dexter, an equity research analyst"


def _write_auth(tmp_path, *, expires_offset_s: int, kind: str = "oauth"):
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({
        "anthropic": {
            "type": kind,
            "access": SAMPLE_ACCESS,
            "refresh": SAMPLE_REFRESH,
            "expires": int((time.time() + expires_offset_s) * 1000),
        }
    }), encoding="utf-8")
    return p


def _capturing_transport(captured, response=None):
    response = response or {"stop_reason": "end_turn",
                            "content": [{"type": "text", "text": "ok"}]}

    def t(payload, headers, *, timeout=60):
        captured["payload"] = payload
        captured["headers"] = headers
        return response
    return t


def test_oauth_request_shape(tmp_path, monkeypatch):
    auth = _write_auth(tmp_path, expires_offset_s=3600)
    monkeypatch.setenv("XCAL_AUTH_JSON", str(auth))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    cap = {}
    llm = LLM(model="m", api_key="", transport=_capturing_transport(cap))
    llm.message([{"role": "user", "content": "x"}], system=RESEARCH_SYS)

    h = cap["headers"]
    assert h.get("authorization") == f"Bearer {SAMPLE_ACCESS}"
    assert "x-api-key" not in h
    assert h.get("anthropic-beta") == ANTHROPIC_OAUTH_BETA
    assert h.get("anthropic-version") == "2023-06-01"

    sysblocks = cap["payload"]["system"]
    assert isinstance(sysblocks, list) and len(sysblocks) == 2
    assert sysblocks[0]["type"] == "text"
    assert sysblocks[0]["text"] == config.identity()
    assert sysblocks[1]["text"] == RESEARCH_SYS


def test_api_key_request_shape(tmp_path, monkeypatch):
    # Even with auth.json present, ANTHROPIC_API_KEY wins.
    auth = _write_auth(tmp_path, expires_offset_s=3600)
    monkeypatch.setenv("XCAL_AUTH_JSON", str(auth))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key-xyz")

    cap = {}
    # api_key="" forces resolve via config (which sees the env var).
    llm = LLM(model="m", api_key="", transport=_capturing_transport(cap))
    llm.message([{"role": "user", "content": "x"}], system=RESEARCH_SYS)

    h = cap["headers"]
    assert h.get("x-api-key") == "sk-test-key-xyz"
    assert "authorization" not in h
    assert "anthropic-beta" not in h
    # system is passed through unchanged (no identity injection).
    assert cap["payload"]["system"] == RESEARCH_SYS


def test_auth_mode_precedence(tmp_path, monkeypatch):
    auth = _write_auth(tmp_path, expires_offset_s=3600)
    monkeypatch.setenv("XCAL_AUTH_JSON", str(auth))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-precedence-wins")

    mode, secret = config.anthropic_credential()
    assert mode == "api_key"
    assert secret == "sk-precedence-wins"


def test_expired_oauth_errors_clearly(tmp_path, monkeypatch):
    auth = _write_auth(tmp_path, expires_offset_s=-3600)  # expired 1h ago
    monkeypatch.setenv("XCAL_AUTH_JSON", str(auth))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    llm = LLM(model="m", api_key="", transport=lambda *a, **k: {})
    with pytest.raises(LLMError) as ei:
        llm.message([{"role": "user", "content": "x"}])
    msg = str(ei.value)
    assert "expired" in msg.lower() or "refresh required" in msg.lower()
    # Tokens must NEVER appear in the error.
    assert SAMPLE_ACCESS not in msg
    assert SAMPLE_REFRESH not in msg


def test_identity_override(monkeypatch, tmp_path):
    monkeypatch.setenv("XCAL_IDENTITY", "You are NotClaude.")
    assert config.identity() == "You are NotClaude."

    auth = _write_auth(tmp_path, expires_offset_s=3600)
    monkeypatch.setenv("XCAL_AUTH_JSON", str(auth))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    cap = {}
    LLM(model="m", api_key="", transport=_capturing_transport(cap)).message(
        [{"role": "user", "content": "x"}], system="rs")
    assert cap["payload"]["system"][0]["text"] == "You are NotClaude."


def test_tokens_redacted(tmp_path, monkeypatch):
    """Any error string surfaced from the client must not contain raw tokens."""
    auth = _write_auth(tmp_path, expires_offset_s=3600)
    monkeypatch.setenv("XCAL_AUTH_JSON", str(auth))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    def boom(payload, headers, *, timeout=60):
        # Simulate the transport leaking the bearer token into an error.
        raise LLMError(
            f"HTTP 401: bad token Bearer {headers['authorization']}"
        )

    llm = LLM(model="m", api_key="", transport=boom)
    with pytest.raises(LLMError) as ei:
        llm.message([{"role": "user", "content": "x"}])
    msg = str(ei.value)
    assert SAMPLE_ACCESS not in msg
    assert "REDACTED" in msg


def test_default_identity_is_claude_code(monkeypatch):
    monkeypatch.delenv("XCAL_IDENTITY", raising=False)
    assert config.identity() == (
        "You are Claude Code, Anthropic's official CLI for Claude."
    )


def test_no_credential_at_all(tmp_path, monkeypatch):
    monkeypatch.setenv("XCAL_AUTH_JSON", str(tmp_path / "nope.json"))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="no LLM credential"):
        config.anthropic_credential()
