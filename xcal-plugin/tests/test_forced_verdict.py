"""Tests for Forced Verdict feature: stance, recommendations, mirror_test."""
import json
import pytest

from src.research.verdict import (
    Verdict, Finding, LensCall, Recommendation,
    CitationError, MirrorTestError, FinalizationError,
    verdict_to_json,
)


def _lc(call_id="finlens:fundamentals"):
    return LensCall(call_id=call_id, lens="fundamentals", status="ok", latency_ms=10)


def _base_verdict(**kwargs):
    return Verdict(
        ticker="AAPL",
        question="Is it a buy?",
        skill_used="quarterly-check",
        lens_calls=[_lc()],
        **kwargs,
    )


# ── happy path ──────────────────────────────────────────────────────────────

def test_pass_verdict_with_valid_mirror_test_finalizes():
    rec = Recommendation(
        tier="aggressive",
        action="build 20% position",
        price_low=170.0,
        price_high=190.0,
        citations=("finlens:fundamentals",),
    )
    v = _base_verdict(
        stance="pass",
        mirror_test="Margins are expanding. Revenue is growing. Buybacks are accelerating. Valuation is reasonable. Risk/reward is favourable.",
        recommendations=[rec],
    )
    v.finalize()  # must not raise
    payload = json.loads(verdict_to_json(v))
    assert payload["stance"] == "pass"
    assert payload["mirror_test"].startswith("Margins")
    assert len(payload["recommendations"]) == 1
    assert payload["recommendations"][0]["tier"] == "aggressive"
    assert payload["recommendations"][0]["citations"] == ["finlens:fundamentals"]


def test_fail_stance_no_mirror_test_required():
    v = _base_verdict(stance="fail", mirror_test=None)
    v.finalize()  # no MirrorTestError for non-pass
    payload = json.loads(verdict_to_json(v))
    assert payload["stance"] == "fail"


def test_grey_zone_stance_no_mirror_test_required():
    v = _base_verdict(stance="grey_zone")
    v.finalize()
    payload = json.loads(verdict_to_json(v))
    assert payload["stance"] == "grey_zone"


# ── mirror_test gate ─────────────────────────────────────────────────────────

def test_pass_stance_empty_mirror_test_raises():
    v = _base_verdict(stance="pass", mirror_test="")
    with pytest.raises(MirrorTestError):
        v.finalize()


def test_pass_stance_none_mirror_test_raises():
    v = _base_verdict(stance="pass", mirror_test=None)
    with pytest.raises(MirrorTestError):
        v.finalize()


def test_pass_stance_six_sentence_mirror_test_raises():
    # 6 terminal punctuation marks
    mt = "One. Two. Three. Four. Five. Six."
    v = _base_verdict(stance="pass", mirror_test=mt)
    with pytest.raises(MirrorTestError):
        v.finalize()


def test_pass_stance_five_sentence_mirror_test_ok():
    mt = "One. Two. Three. Four. Five."
    v = _base_verdict(stance="pass", mirror_test=mt)
    v.finalize()  # exactly 5 — must pass


# ── recommendation citation guard ───────────────────────────────────────────

def test_recommendation_with_price_low_no_citations_raises():
    rec = Recommendation(tier="steady", action="nibble", price_low=150.0, citations=())
    v = _base_verdict(
        stance="pass",
        mirror_test="Good. Really good. Very good. Quite good. Solid.",
        recommendations=[rec],
    )
    with pytest.raises(CitationError):
        v.finalize()


def test_recommendation_with_price_high_no_citations_raises():
    rec = Recommendation(tier="conservative", action="wait", price_high=200.0, citations=())
    v = _base_verdict(
        stance="pass",
        mirror_test="Good. Really good. Very good. Quite good. Solid.",
        recommendations=[rec],
    )
    with pytest.raises(CitationError):
        v.finalize()


def test_recommendation_cites_unknown_call_id_raises():
    rec = Recommendation(
        tier="aggressive",
        action="build 20% position",
        price_low=170.0,
        citations=("ghost:made-up-id",),
    )
    v = _base_verdict(
        stance="pass",
        mirror_test="Good. Really good. Very good. Quite good. Solid.",
        recommendations=[rec],
    )
    with pytest.raises(CitationError):
        v.finalize()


def test_recommendation_without_price_no_citations_ok():
    # No price targets → no citation required
    rec = Recommendation(tier="conservative", action="avoid", citations=())
    v = _base_verdict(recommendations=[rec])
    v.finalize()  # must not raise
    payload = json.loads(verdict_to_json(v))
    assert payload["recommendations"][0]["action"] == "avoid"
    assert payload["recommendations"][0]["citations"] == []


# ── backward compatibility ───────────────────────────────────────────────────

def test_backward_compat_stance_none_finalizes():
    """Old-style Verdict with no new fields still works end-to-end."""
    v = Verdict(
        ticker="MSFT",
        question="Growth?",
        skill_used="quarterly-check",
        lens_calls=[_lc()],
        findings=[Finding(
            claim="rev=42", kind="numeric", value=42.0,
            citations=("finlens:fundamentals",), confidence=0.9,
        )],
        synthesis="Looks fine.",
    )
    v.finalize()
    payload = json.loads(verdict_to_json(v))
    assert payload["stance"] is None
    assert payload["recommendations"] == []
    assert payload["mirror_test"] is None
    assert payload["ticker"] == "MSFT"
