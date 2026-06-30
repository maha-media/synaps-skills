"""Heist #2 — Dialectic / forced-verdict activation.

Tests that loop.py correctly lifts the forced-verdict structure the model
produces (stance, recommendations, mirror_test, inversion, red_flags,
per-finding info_richness + corroborations) and populates them on the
Verdict, with graceful degradation when the model produces illegal combos.

Uses the same FIXTURE transport pattern as test_loop.py / test_acceptance.py.
"""
from __future__ import annotations
import json
from pathlib import Path

import pytest

from src.research.llm import LLM
from src.research.loop import LoopDeps, research_ticker
from src.research.router import Router
from src.research.verdict import verdict_to_json


REPO = Path(__file__).resolve().parents[1]


# ── shared test fixtures ────────────────────────────────────────────────────

@pytest.fixture
def seed_skills(tmp_path, monkeypatch):
    skills = tmp_path / "skills"
    (skills / "quarterly-check").mkdir(parents=True)
    src = REPO / "skills" / "quarterly-check" / "SKILL.md"
    (skills / "quarterly-check" / "SKILL.md").write_text(
        src.read_text(encoding="utf-8"), encoding="utf-8")
    monkeypatch.setenv("XCAL_SKILLS_DIR", str(skills))
    return skills


def _scripted_llm(responses):
    i = {"n": 0}

    def t(payload, headers, *, timeout=60):
        n = i["n"]
        if n >= len(responses):
            raise AssertionError(f"LLM called {n+1} times but only {len(responses)} responses scripted")
        i["n"] = n + 1
        return responses[n]

    return LLM(model="fixture", api_key="fixture", transport=t)


def _fake_lens_table():
    return {
        "fundamentals": {
            "call_id": "finlens:fundamentals#F1",
            "lens": "fundamentals", "ticker": "AAPL",
            "status": "ok", "latency_ms": 5,
            "payload": {"rev": 100.0, "fcf_margin": 0.28},
        },
        "technicals": {
            "call_id": "finlens:technicals#T1",
            "lens": "technicals", "ticker": "AAPL",
            "status": "ok", "latency_ms": 4,
            "payload": {"trend": "up", "rsi": 58.0},
        },
        "sentiment": {
            "call_id": "finlens:sentiment#S1",
            "lens": "sentiment", "ticker": "AAPL",
            "status": "ok", "latency_ms": 3,
            "payload": {"score": 0.72},
        },
    }


def _router_for(table):
    def call_lens(lens, ticker, **_):
        r = dict(table[lens])
        r.setdefault("ticker", ticker.upper())
        return r
    return Router(call_lens=call_lens)


def _fake_remember(content, **kw):
    return {"status": "ok", "memory_id": "mem-dialectic", "output": "ok", "error": None}


# ── test 1: full forced-verdict JSON ────────────────────────────────────────

def test_full_forced_verdict_populates_all_fields(seed_skills):
    """A fixtured final response containing full forced-verdict JSON (stance=pass
    + <=5-sentence mirror_test + tiered recs + inversion + findings with
    info_richness/corroborations) → research_ticker returns a Verdict with all
    fields populated, finalizes, and serializes."""
    table = _fake_lens_table()
    fund_id = table["fundamentals"]["call_id"]   # "finlens:fundamentals#F1"
    tech_id = table["technicals"]["call_id"]     # "finlens:technicals#T1"
    sent_id = table["sentiment"]["call_id"]      # "finlens:sentiment#S1"

    final_json = {
        "findings": [
            {
                "claim": "Revenue 100B",
                "kind": "numeric",
                "value": 100.0,
                "confidence": 0.9,
                "citations": [fund_id],
                "info_richness": "A",
                "corroborations": [sent_id],  # sentiment is a different lens than fundamentals
            },
            {
                "claim": "RSI elevated at 58",
                "kind": "numeric",
                "value": 58.0,
                "confidence": 0.7,
                "citations": [tech_id],
                "info_richness": "B",
                "corroborations": [],
            },
            {
                "claim": "Sentiment backdrop positive",
                "kind": "qualitative",
                "confidence": 0.5,
                "citations": [],
                "info_richness": "C",
            },
        ],
        "synthesis": "AAPL shows strong fundamentals with elevated technicals.",
        "stance": "pass",
        "mirror_test": "Revenue is growing. Margins are healthy. Buybacks are active. Valuation is reasonable. Risk/reward favours longs.",
        "inversion": "If FCF margin compresses by 10pp the thesis breaks.",
        "red_flags": [],
        "recommendations": [
            {
                "tier": "aggressive",
                "action": "Build 15% position",
                "price_low": 170.0,
                "price_high": 200.0,
                "citations": [fund_id],
            },
            {
                "tier": "conservative",
                "action": "Hold existing position",
                "price_low": None,
                "price_high": None,
                "citations": [],
            },
        ],
    }

    responses = [
        # 1: call fundamentals
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u1", "name": "finlens",
             "input": {"lens": "fundamentals", "ticker": "AAPL"}}]},
        # 2: call technicals
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u2", "name": "finlens",
             "input": {"lens": "technicals", "ticker": "AAPL"}}]},
        # 3: call sentiment (for cross-validation corroboration)
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u3", "name": "finlens",
             "input": {"lens": "sentiment", "ticker": "AAPL"}}]},
        # 4: final synthesis with full forced-verdict JSON
        {"stop_reason": "end_turn", "content": [
            {"type": "text", "text": json.dumps(final_json)}]},
    ]

    deps = LoopDeps(
        llm=_scripted_llm(responses),
        router=_router_for(table),
        axel_remember=_fake_remember,
        max_iters=8,
    )

    v = research_ticker("AAPL", "Is AAPL a buy?", deps=deps)

    # Must finalize and serialize
    assert v._finalized, "verdict must be finalized"
    j = verdict_to_json(v)
    blob = json.loads(j)

    # Stance
    assert v.stance == "pass"
    assert blob["stance"] == "pass"

    # mirror_test
    assert v.mirror_test is not None
    assert "Revenue is growing" in v.mirror_test
    assert blob["mirror_test"] == v.mirror_test

    # inversion
    assert v.inversion is not None
    assert "FCF margin" in v.inversion
    assert blob["inversion"] == v.inversion

    # red_flags
    assert v.red_flags == ()
    assert blob["red_flags"] == []

    # recommendations
    assert len(v.recommendations) == 2
    assert blob["recommendations"][0]["tier"] == "aggressive"
    assert blob["recommendations"][0]["price_low"] == 170.0
    assert blob["recommendations"][0]["citations"] == [fund_id]
    assert blob["recommendations"][1]["tier"] == "conservative"

    # findings with info_richness and corroborations
    findings_by_claim = {f.claim: f for f in v.findings}
    assert "Revenue 100B" in findings_by_claim
    rev = findings_by_claim["Revenue 100B"]
    assert rev.info_richness == "A"
    assert sent_id in rev.corroborations

    rsi = findings_by_claim["RSI elevated at 58"]
    assert rsi.info_richness == "B"
    assert rsi.corroborations == ()

    sent_f = findings_by_claim["Sentiment backdrop positive"]
    assert sent_f.info_richness == "C"

    # JSON findings carry info_richness and corroborations
    f0 = next(f for f in blob["findings"] if f["claim"] == "Revenue 100B")
    assert f0["info_richness"] == "A"
    assert sent_id in f0["corroborations"]
    assert f0["cross_validated"] is True  # corroboration from different lens


# ── test 2: backward-compatibility (findings+synthesis only) ────────────────

def test_backward_compat_findings_synthesis_only(seed_skills):
    """A fixtured response with ONLY {findings, synthesis} → Verdict has
    stance=None, recommendations=[], mirror_test=None etc., works exactly
    as before."""
    table = _fake_lens_table()
    fund_id = table["fundamentals"]["call_id"]

    final_json = {
        "findings": [
            {
                "claim": "Revenue 100B",
                "kind": "numeric",
                "value": 100.0,
                "confidence": 0.9,
                "citations": [fund_id],
            },
        ],
        "synthesis": "Old-style synthesis only.",
    }

    responses = [
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u1", "name": "finlens",
             "input": {"lens": "fundamentals", "ticker": "AAPL"}}]},
        {"stop_reason": "end_turn", "content": [
            {"type": "text", "text": json.dumps(final_json)}]},
    ]

    deps = LoopDeps(
        llm=_scripted_llm(responses),
        router=_router_for(table),
        axel_remember=_fake_remember,
        max_iters=4,
    )

    v = research_ticker("AAPL", "Is AAPL a buy?", deps=deps)

    assert v._finalized
    # Forced-verdict fields must stay at defaults
    assert v.stance is None
    assert v.recommendations == []
    assert v.mirror_test is None
    assert v.inversion is None
    assert v.red_flags == ()
    # Existing fields still work
    assert len(v.findings) == 1
    assert v.findings[0].claim == "Revenue 100B"
    assert v.synthesis == "Old-style synthesis only."
    # Serialize still works
    blob = json.loads(verdict_to_json(v))
    assert blob["stance"] is None
    assert blob["recommendations"] == []
    assert blob["mirror_test"] is None


# ── test 3: repair — pass + red_flags → downgrade to grey_zone ──────────────

def test_veto_repair_pass_with_red_flags_downgraded(seed_skills):
    """A fixtured response with stance='pass' but red_flags set → loop
    downgrades to grey_zone (no crash), note appended to synthesis."""
    table = _fake_lens_table()
    fund_id = table["fundamentals"]["call_id"]

    final_json = {
        "findings": [
            {
                "claim": "Revenue 100B",
                "kind": "numeric",
                "value": 100.0,
                "confidence": 0.9,
                "citations": [fund_id],
            },
        ],
        "synthesis": "AAPL looks good.",
        "stance": "pass",
        "mirror_test": "One. Two. Three. Four. Five.",  # valid mirror_test
        "red_flags": ["Debt/equity above threshold", "Insider selling spike"],
        "recommendations": [],
    }

    responses = [
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u1", "name": "finlens",
             "input": {"lens": "fundamentals", "ticker": "AAPL"}}]},
        {"stop_reason": "end_turn", "content": [
            {"type": "text", "text": json.dumps(final_json)}]},
    ]

    deps = LoopDeps(
        llm=_scripted_llm(responses),
        router=_router_for(table),
        axel_remember=_fake_remember,
        max_iters=4,
    )

    v = research_ticker("AAPL", "Is AAPL a buy?", deps=deps)

    assert v._finalized, "verdict must still finalize"
    # Stance must be downgraded — not "pass"
    assert v.stance == "grey_zone", f"expected grey_zone, got {v.stance!r}"
    # Note must be in synthesis
    assert "downgraded" in v.synthesis.lower() or "grey_zone" in v.synthesis
    # red_flags are still present
    assert len(v.red_flags) == 2
    # Serialize without crashing
    blob = json.loads(verdict_to_json(v))
    assert blob["stance"] == "grey_zone"


# ── test 4: repair — pass + 6-sentence mirror_test → downgraded ─────────────

def test_mirror_test_repair_six_sentences_downgraded(seed_skills):
    """stance='pass' with a 6-sentence mirror_test → loop degrades gracefully
    (no crash), stance downgraded to grey_zone, note appended."""
    table = _fake_lens_table()
    fund_id = table["fundamentals"]["call_id"]

    # 6 terminal punctuation marks — violates <=5 rule
    bad_mirror = "One. Two. Three. Four. Five. Six."

    final_json = {
        "findings": [
            {
                "claim": "Revenue 100B",
                "kind": "numeric",
                "value": 100.0,
                "confidence": 0.9,
                "citations": [fund_id],
            },
        ],
        "synthesis": "AAPL seems solid.",
        "stance": "pass",
        "mirror_test": bad_mirror,
        "red_flags": [],
        "recommendations": [],
    }

    responses = [
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u1", "name": "finlens",
             "input": {"lens": "fundamentals", "ticker": "AAPL"}}]},
        {"stop_reason": "end_turn", "content": [
            {"type": "text", "text": json.dumps(final_json)}]},
    ]

    deps = LoopDeps(
        llm=_scripted_llm(responses),
        router=_router_for(table),
        axel_remember=_fake_remember,
        max_iters=4,
    )

    v = research_ticker("AAPL", "Is AAPL a buy?", deps=deps)

    assert v._finalized, "verdict must finalize even with bad mirror_test"
    assert v.stance == "grey_zone", f"expected grey_zone, got {v.stance!r}"
    # Degradation note in synthesis
    assert "downgraded" in v.synthesis.lower() or "grey_zone" in v.synthesis
    # Findings still present
    assert len(v.findings) == 1
    # Serialize clean
    blob = json.loads(verdict_to_json(v))
    assert blob["stance"] == "grey_zone"


# ── test 5: per-finding info_richness validation ─────────────────────────────

def test_invalid_info_richness_becomes_none(seed_skills):
    """info_richness not in A/B/C → silently set to None."""
    table = _fake_lens_table()
    fund_id = table["fundamentals"]["call_id"]

    final_json = {
        "findings": [
            {
                "claim": "Revenue 100B",
                "kind": "numeric",
                "value": 100.0,
                "confidence": 0.9,
                "citations": [fund_id],
                "info_richness": "Z",  # invalid
            },
        ],
        "synthesis": "ok",
    }

    responses = [
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u1", "name": "finlens",
             "input": {"lens": "fundamentals", "ticker": "AAPL"}}]},
        {"stop_reason": "end_turn", "content": [
            {"type": "text", "text": json.dumps(final_json)}]},
    ]

    deps = LoopDeps(
        llm=_scripted_llm(responses),
        router=_router_for(table),
        axel_remember=_fake_remember,
        max_iters=4,
    )

    v = research_ticker("AAPL", "?", deps=deps)

    assert v._finalized
    assert v.findings[0].info_richness is None


# ── test 6: invalid tier in recommendation → skipped ─────────────────────────

def test_invalid_recommendation_tier_skipped(seed_skills):
    """Recommendations with unknown tier are silently skipped."""
    table = _fake_lens_table()
    fund_id = table["fundamentals"]["call_id"]

    final_json = {
        "findings": [
            {"claim": "ok", "kind": "qualitative", "confidence": 0.5, "citations": []},
        ],
        "synthesis": "ok",
        "stance": "grey_zone",
        "recommendations": [
            {"tier": "YOLO", "action": "bet it all", "citations": []},  # bad tier
            {"tier": "steady", "action": "hold 10%", "citations": []},  # good
        ],
    }

    responses = [
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u1", "name": "finlens",
             "input": {"lens": "fundamentals", "ticker": "AAPL"}}]},
        {"stop_reason": "end_turn", "content": [
            {"type": "text", "text": json.dumps(final_json)}]},
    ]

    deps = LoopDeps(
        llm=_scripted_llm(responses),
        router=_router_for(table),
        axel_remember=_fake_remember,
        max_iters=4,
    )

    v = research_ticker("AAPL", "?", deps=deps)

    assert v._finalized
    # Only the valid tier survives
    assert len(v.recommendations) == 1
    assert v.recommendations[0].tier == "steady"


# ── test 7: invalid stance string → treated as None ──────────────────────────

def test_invalid_stance_becomes_none(seed_skills):
    """A stance value outside the allowed set is treated as None."""
    table = _fake_lens_table()
    final_json = {
        "findings": [
            {"claim": "ok", "kind": "qualitative", "confidence": 0.5, "citations": []},
        ],
        "synthesis": "ok",
        "stance": "maybe",  # not a valid stance
    }

    responses = [
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u1", "name": "finlens",
             "input": {"lens": "fundamentals", "ticker": "AAPL"}}]},
        {"stop_reason": "end_turn", "content": [
            {"type": "text", "text": json.dumps(final_json)}]},
    ]

    deps = LoopDeps(
        llm=_scripted_llm(responses),
        router=_router_for(table),
        axel_remember=_fake_remember,
        max_iters=4,
    )

    v = research_ticker("AAPL", "?", deps=deps)

    assert v._finalized
    assert v.stance is None
