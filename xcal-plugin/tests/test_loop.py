"""Mocked end-to-end tests for the ReAct loop."""
import json
from pathlib import Path

import pytest

from src.research import loop as research_loop
from src.research.llm import LLM
from src.research.loop import LoopDeps, research_ticker
from src.research.router import Router


REPO = Path(__file__).resolve().parents[1]


@pytest.fixture
def seed_skills(tmp_path, monkeypatch):
    skills = tmp_path / "skills"
    (skills / "quarterly-check").mkdir(parents=True)
    src = REPO / "skills" / "quarterly-check" / "SKILL.md"
    (skills / "quarterly-check" / "SKILL.md").write_text(
        src.read_text(encoding="utf-8"), encoding="utf-8")
    monkeypatch.setenv("XCAL_SKILLS_DIR", str(skills))
    return skills


def _fake_lens_table():
    return {
        "fundamentals": {"call_id": "finlens:fundamentals#A",
                         "lens": "fundamentals", "ticker": "NVDA",
                         "status": "ok", "latency_ms": 5,
                         "payload": {"rev": 60.0}},
        "technicals": {"call_id": "finlens:technicals#B",
                       "lens": "technicals", "ticker": "NVDA",
                       "status": "ok", "latency_ms": 6,
                       "payload": {"trend": "up"}},
    }


def _scripted_llm(responses):
    """Return an LLM whose transport replays the given response list."""
    i = {"n": 0}

    def t(payload, headers, *, timeout=60):
        n = i["n"]
        if n >= len(responses):
            raise AssertionError("LLM called more times than scripted")
        i["n"] = n + 1
        return responses[n]
    return LLM(model="m", api_key="k", transport=t)


def _router_for(table):
    def call_lens(lens, ticker, **_):
        r = dict(table[lens])
        r.setdefault("ticker", ticker.upper())
        return r
    return Router(call_lens=call_lens)


def test_loop_full_flow_two_lenses_then_synthesis(seed_skills):
    """End-to-end mocked: skill loads, router dispatches 2 lenses, verdict
    finalizes with cited findings, axel.remember is invoked."""
    responses = [
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u1", "name": "finlens",
             "input": {"lens": "fundamentals", "ticker": "NVDA"}}]},
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u2", "name": "finlens",
             "input": {"lens": "technicals", "ticker": "NVDA"}}]},
        {"stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps({
            "findings": [
                {"claim": "Revenue 60", "kind": "numeric", "value": 60.0,
                 "citations": ["finlens:fundamentals#A"], "confidence": 0.9},
                {"claim": "Trend up", "kind": "qualitative",
                 "citations": ["finlens:technicals#B"], "confidence": 0.5},
            ],
            "synthesis": "NVDA constructive.",
        })}]},
    ]

    axel_calls = []

    def fake_remember(content, **kw):
        axel_calls.append((content, kw))
        return {"status": "ok", "memory_id": "mem_123", "output": "✅ Memory stored: mem_123", "error": None}

    deps = LoopDeps(
        llm=_scripted_llm(responses),
        router=_router_for(_fake_lens_table()),
        axel_remember=fake_remember,
        max_iters=8,
    )

    v = research_ticker("nvda", "is the setup risk-on?", deps=deps)

    assert v._finalized
    assert v.ticker == "NVDA"
    assert v.skill_used == "quarterly-check"
    assert len(v.lens_calls) == 2
    assert {lc.call_id for lc in v.lens_calls} == {
        "finlens:fundamentals#A", "finlens:technicals#B"}
    assert len(v.findings) == 2
    numeric = [f for f in v.findings if f.kind == "numeric"]
    assert numeric and all(f.citations for f in numeric)
    for f in numeric:
        for c in f.citations:
            assert c in {lc.call_id for lc in v.lens_calls}
    assert v.synthesis == "NVDA constructive."
    assert v.axel_memory_id == "mem_123"
    assert v.reflection["status"] in ("queued", "disabled")
    assert len(axel_calls) == 1
    assert axel_calls[0][1]["category"] == "cases"


def test_loop_drops_finding_with_missing_citation(seed_skills):
    """A numeric finding with NO citation must not crash finalize — the
    loop drops it, finalizes the remainder, and annotates the synthesis."""
    responses = [
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u1", "name": "finlens",
             "input": {"lens": "fundamentals", "ticker": "NVDA"}}]},
        {"stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps({
            "findings": [
                # legit
                {"claim": "Revenue 60", "kind": "numeric", "value": 60.0,
                 "citations": ["finlens:fundamentals#A"], "confidence": 0.9},
                # fabricated number (no citation)
                {"claim": "FCF 12B", "kind": "numeric", "value": 12.0,
                 "citations": [], "confidence": 0.9},
                # citing a call_id that doesn't exist
                {"claim": "Margin 75%", "kind": "numeric", "value": 0.75,
                 "citations": ["finlens:fundamentals#GHOST"], "confidence": 0.9},
            ],
            "synthesis": "draft",
        })}]},
    ]

    deps = LoopDeps(
        llm=_scripted_llm(responses),
        router=_router_for(_fake_lens_table()),
        axel_remember=lambda c, **kw: {"status": "ok", "output": "ok", "error": None},
        max_iters=4,
    )

    v = research_ticker("NVDA", "?", deps=deps)
    assert v._finalized
    # only the legit finding survives
    assert len(v.findings) == 1
    assert v.findings[0].claim == "Revenue 60"
    assert "dropped" in v.synthesis
    assert "2 finding" in v.synthesis


def test_loop_sets_axel_memory_id(seed_skills):
    """loop pulls memory_id from the adapter result (not the raw output blob)."""
    responses = [
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u1", "name": "finlens",
             "input": {"lens": "fundamentals", "ticker": "NVDA"}}]},
        {"stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps({
            "findings": [
                {"claim": "Rev 60", "kind": "numeric", "value": 60.0,
                 "citations": ["finlens:fundamentals#A"], "confidence": 0.9},
            ],
            "synthesis": "ok",
        })}]},
    ]

    def fake_remember(content, **kw):
        return {"status": "ok", "memory_id": "mem_deadbeef",
                "output": "✅ Memory stored: mem_deadbeef", "error": None}

    deps = LoopDeps(
        llm=_scripted_llm(responses),
        router=_router_for(_fake_lens_table()),
        axel_remember=fake_remember,
        max_iters=4,
    )
    v = research_ticker("NVDA", "?", deps=deps)
    assert v.axel_memory_id == "mem_deadbeef"


def test_loop_axel_failure_degrades(seed_skills):
    """axel error → verdict still finalizes, axel_memory_id=None, no crash."""
    responses = [
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u1", "name": "finlens",
             "input": {"lens": "fundamentals", "ticker": "NVDA"}}]},
        {"stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps({
            "findings": [
                {"claim": "Rev 60", "kind": "numeric", "value": 60.0,
                 "citations": ["finlens:fundamentals#A"], "confidence": 0.9},
            ],
            "synthesis": "ok",
        })}]},
    ]

    def fake_remember(content, **kw):
        return {"status": "error", "memory_id": None, "output": "",
                "error": "axel boom"}

    deps = LoopDeps(
        llm=_scripted_llm(responses),
        router=_router_for(_fake_lens_table()),
        axel_remember=fake_remember,
        max_iters=4,
    )
    v = research_ticker("NVDA", "?", deps=deps)
    assert v._finalized
    assert v.axel_memory_id is None
    assert len(v.findings) == 1
