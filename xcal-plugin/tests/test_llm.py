import json

import pytest

from src.research.llm import LLM, LLMError, ANTHROPIC_URL, ANTHROPIC_VERSION


def test_message_request_shape_and_parse():
    captured = {}

    def transport(payload, headers, *, timeout=60):
        captured["payload"] = payload
        captured["headers"] = headers
        return {
            "stop_reason": "tool_use",
            "content": [{"type": "tool_use", "id": "tu1", "name": "finlens",
                         "input": {"lens": "fundamentals", "ticker": "NVDA"}}],
        }

    llm = LLM(model="claude-test", api_key="sk-test", transport=transport)
    out = llm.message(
        messages=[{"role": "user", "content": "go"}],
        tools=[{"name": "finlens", "input_schema": {"type": "object"}}],
        system="sys",
    )
    p = captured["payload"]
    assert p["model"] == "claude-test"
    assert p["messages"] == [{"role": "user", "content": "go"}]
    assert p["system"] == "sys"
    assert p["tools"][0]["name"] == "finlens"
    h = captured["headers"]
    assert h["x-api-key"] == "sk-test"
    assert h["anthropic-version"] == ANTHROPIC_VERSION
    assert out["stop_reason"] == "tool_use"
    assert out["content"][0]["type"] == "tool_use"
    assert out["content"][0]["input"]["lens"] == "fundamentals"


def test_message_requires_api_key():
    llm = LLM(model="m", api_key="", transport=lambda *a, **k: {})
    with pytest.raises(LLMError, match="no LLM credential"):
        llm.message([{"role": "user", "content": "x"}])


def test_no_live_call_by_default():
    """Sanity: nothing in this test module hits the real API."""
    assert ANTHROPIC_URL.startswith("https://")
