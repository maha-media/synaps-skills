"""router — the meta-tool dispatch.

Exposes ONE logical tool to the LLM: `finlens(lens, ticker)`. The LLM does
the ReAct planning; the router just validates + dispatches into the
finlens_call adapter, recording every call_id so the loop can populate
Verdict.lens_calls.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .adapters import finlens_call

VALID_LENSES = ("insider", "fundamentals", "technicals",
                "sentiment", "news", "search_trend")

TOOL_NAME = "finlens"


def _fixture_call_lens(path: str) -> Callable[..., dict]:
    """Return a stand-in for finlens_call.call_lens that reads canned results
    from a JSON file: { "<lens>": { ...full result dict... }, ... }. Each
    call assigns a fresh call_id if the fixture didn't provide one."""
    import json as _json
    import uuid as _uuid
    with open(path, "r", encoding="utf-8") as fh:
        table = _json.load(fh)

    def _call(lens, ticker, **_):
        base = dict(table.get(lens) or {})
        base.setdefault("call_id", f"finlens:{lens}#{_uuid.uuid4().hex[:12]}")
        base.setdefault("lens", lens)
        base.setdefault("ticker", str(ticker).upper())
        base.setdefault("status", "ok")
        base.setdefault("latency_ms", 0)
        base.setdefault("error", None)
        base.setdefault("payload", None)
        return base
    return _call


def tool_schema() -> dict[str, Any]:
    """Anthropic tool-use JSON schema for the single finlens meta-tool."""
    return {
        "name": TOOL_NAME,
        "description": (
            "Run one finlens lens on one ticker and return its structured "
            "payload. Use this for every numeric claim you intend to make — "
            "the lens result carries a call_id you MUST cite."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "lens": {
                    "type": "string",
                    "enum": list(VALID_LENSES),
                    "description": "Which finlens lens to run.",
                },
                "ticker": {
                    "type": "string",
                    "description": "Ticker symbol, e.g. 'NVDA'.",
                },
            },
            "required": ["lens", "ticker"],
        },
    }


class RouterError(ValueError):
    """Raised for invalid tool inputs (unknown lens, missing fields)."""


@dataclass
class Router:
    """Stateful per-run dispatcher. Holds the list of call_ids it has issued
    so the loop can rebuild Verdict.lens_calls without re-walking history."""
    # Injectable for tests; default is the real subprocess adapter (or a
    # fixture if XCAL_FINLENS_FIXTURE is set in the environment).
    call_lens: Callable[..., dict[str, Any]] = field(
        default=finlens_call.call_lens)
    results: list[dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        import os as _os
        path = _os.environ.get("XCAL_FINLENS_FIXTURE", "")
        if path and self.call_lens is finlens_call.call_lens:
            self.call_lens = _fixture_call_lens(path)

    def dispatch(self, tool_input: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(tool_input, dict):
            raise RouterError("tool input must be a dict")
        lens = tool_input.get("lens")
        ticker = tool_input.get("ticker")
        if not isinstance(lens, str) or lens not in VALID_LENSES:
            raise RouterError(f"unknown lens: {lens!r} (valid: {VALID_LENSES})")
        if not isinstance(ticker, str) or not ticker.strip():
            raise RouterError("ticker must be a non-empty string")
        result = self.call_lens(lens, ticker.strip().upper())
        if not isinstance(result, dict) or "call_id" not in result:
            raise RouterError("adapter returned malformed result")
        self.results.append(result)
        return result

    def call_ids(self) -> list[str]:
        return [r["call_id"] for r in self.results]

    def find(self, call_id: str) -> Optional[dict[str, Any]]:
        for r in self.results:
            if r.get("call_id") == call_id:
                return r
        return None
