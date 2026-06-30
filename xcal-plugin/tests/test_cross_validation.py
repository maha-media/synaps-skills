"""Tests for Multi-source Cross-Validation (heist target #4).

Proves:
- corroboration from a DIFFERENT lens → finalizes, is_cross_validated True, cross_validated:true in JSON
- corroboration from SAME lens → CrossValidationError
- corroboration citing unknown call_id → CitationError
- call_id in both citations and corroborations → CrossValidationError
- no corroborations → cross_validated False, finalizes (backward-compat)
"""
import json
import pytest

from src.research.verdict import (
    Verdict, Finding, LensCall, CitationError,
    CrossValidationError, is_cross_validated, verdict_to_json,
)


def _lc(call_id, lens="fundamentals", status="ok"):
    return LensCall(call_id=call_id, lens=lens, status=status, latency_ms=10)


def _base_verdict(findings, lens_calls):
    return Verdict(
        ticker="AAPL",
        question="Is revenue growing?",
        skill_used="quarterly-check",
        lens_calls=lens_calls,
        findings=findings,
    )


# ── happy path: cross-validated ──────────────────────────────────────────────

def test_corroboration_from_different_lens_finalizes():
    lcs = [
        _lc("finlens:fundamentals#abc", "fundamentals"),
        _lc("finlens:macro#xyz", "macro"),
    ]
    finding = Finding(
        claim="revenue=42b",
        kind="numeric",
        value=42.0,
        citations=("finlens:fundamentals#abc",),
        corroborations=("finlens:macro#xyz",),
        confidence=0.9,
    )
    v = _base_verdict([finding], lcs)
    v.finalize()  # must not raise


def test_is_cross_validated_true_for_different_lens():
    lcs = [
        _lc("finlens:fundamentals#abc", "fundamentals"),
        _lc("finlens:macro#xyz", "macro"),
    ]
    finding = Finding(
        claim="revenue=42b",
        kind="numeric",
        value=42.0,
        citations=("finlens:fundamentals#abc",),
        corroborations=("finlens:macro#xyz",),
        confidence=0.9,
    )
    assert is_cross_validated(finding, lcs) is True


def test_json_cross_validated_true():
    lcs = [
        _lc("finlens:fundamentals#abc", "fundamentals"),
        _lc("finlens:macro#xyz", "macro"),
    ]
    finding = Finding(
        claim="revenue=42b",
        kind="numeric",
        value=42.0,
        citations=("finlens:fundamentals#abc",),
        corroborations=("finlens:macro#xyz",),
        confidence=0.9,
    )
    v = _base_verdict([finding], lcs)
    v.finalize()
    payload = json.loads(verdict_to_json(v))
    f = payload["findings"][0]
    assert f["corroborations"] == ["finlens:macro#xyz"]
    assert f["cross_validated"] is True


# ── same-lens corroboration → CrossValidationError ───────────────────────────

def test_corroboration_from_same_lens_raises():
    lcs = [
        _lc("finlens:fundamentals#abc", "fundamentals"),
        _lc("finlens:fundamentals#def", "fundamentals"),
    ]
    finding = Finding(
        claim="revenue=42b",
        kind="numeric",
        value=42.0,
        citations=("finlens:fundamentals#abc",),
        corroborations=("finlens:fundamentals#def",),
        confidence=0.9,
    )
    v = _base_verdict([finding], lcs)
    with pytest.raises(CrossValidationError):
        v.finalize()


def test_is_cross_validated_false_for_same_lens():
    lcs = [
        _lc("finlens:fundamentals#abc", "fundamentals"),
        _lc("finlens:fundamentals#def", "fundamentals"),
    ]
    finding = Finding(
        claim="revenue=42b",
        kind="numeric",
        value=42.0,
        citations=("finlens:fundamentals#abc",),
        corroborations=("finlens:fundamentals#def",),
        confidence=0.9,
    )
    assert is_cross_validated(finding, lcs) is False


# ── unknown corroboration call_id → CitationError ────────────────────────────

def test_corroboration_unknown_call_id_raises_citation_error():
    lcs = [_lc("finlens:fundamentals#abc", "fundamentals")]
    finding = Finding(
        claim="revenue=42b",
        kind="numeric",
        value=42.0,
        citations=("finlens:fundamentals#abc",),
        corroborations=("ghost:made-up#999",),
        confidence=0.9,
    )
    v = _base_verdict([finding], lcs)
    with pytest.raises(CitationError):
        v.finalize()


# ── overlap: same call_id in citations AND corroborations ────────────────────

def test_call_id_in_both_citations_and_corroborations_raises():
    lcs = [_lc("finlens:fundamentals#abc", "fundamentals")]
    finding = Finding(
        claim="revenue=42b",
        kind="numeric",
        value=42.0,
        citations=("finlens:fundamentals#abc",),
        corroborations=("finlens:fundamentals#abc",),
        confidence=0.9,
    )
    v = _base_verdict([finding], lcs)
    with pytest.raises(CrossValidationError):
        v.finalize()


# ── backward-compat: no corroborations ───────────────────────────────────────

def test_no_corroborations_finalizes_and_cross_validated_false():
    lcs = [_lc("finlens:fundamentals#abc", "fundamentals")]
    finding = Finding(
        claim="revenue=42b",
        kind="numeric",
        value=42.0,
        citations=("finlens:fundamentals#abc",),
        confidence=0.9,
    )
    v = _base_verdict([finding], lcs)
    v.finalize()
    payload = json.loads(verdict_to_json(v))
    f = payload["findings"][0]
    assert f["corroborations"] == []
    assert f["cross_validated"] is False


def test_is_cross_validated_false_with_no_corroborations():
    lcs = [_lc("finlens:fundamentals#abc", "fundamentals")]
    finding = Finding(
        claim="revenue=42b",
        kind="numeric",
        value=42.0,
        citations=("finlens:fundamentals#abc",),
        confidence=0.9,
    )
    assert is_cross_validated(finding, lcs) is False


def test_qualitative_finding_no_corroborations_backward_compat():
    """Old-style qualitative finding with no corroborations field still works."""
    lcs = [_lc("finlens:fundamentals#abc", "fundamentals")]
    finding = Finding(
        claim="management tone is positive",
        kind="qualitative",
        confidence=0.7,
    )
    v = _base_verdict([finding], lcs)
    v.finalize()
    payload = json.loads(verdict_to_json(v))
    f = payload["findings"][0]
    assert f["corroborations"] == []
    assert f["cross_validated"] is False


# ── multiple corroborations, mixed lenses ────────────────────────────────────

def test_multiple_corroborations_one_same_lens_raises():
    """If ANY corroboration shares a lens with the primary citation, it must raise."""
    lcs = [
        _lc("finlens:fundamentals#abc", "fundamentals"),
        _lc("finlens:macro#xyz", "macro"),
        _lc("finlens:fundamentals#def", "fundamentals"),  # same lens as primary
    ]
    finding = Finding(
        claim="revenue=42b",
        kind="numeric",
        value=42.0,
        citations=("finlens:fundamentals#abc",),
        corroborations=("finlens:macro#xyz", "finlens:fundamentals#def"),
        confidence=0.9,
    )
    v = _base_verdict([finding], lcs)
    with pytest.raises(CrossValidationError):
        v.finalize()


def test_multiple_valid_cross_corroborations_finalize():
    """Multiple corroborations from distinct non-primary lenses → ok."""
    lcs = [
        _lc("finlens:fundamentals#abc", "fundamentals"),
        _lc("finlens:macro#xyz", "macro"),
        _lc("finlens:technical#ttt", "technical"),
    ]
    finding = Finding(
        claim="revenue=42b",
        kind="numeric",
        value=42.0,
        citations=("finlens:fundamentals#abc",),
        corroborations=("finlens:macro#xyz", "finlens:technical#ttt"),
        confidence=0.9,
    )
    v = _base_verdict([finding], lcs)
    v.finalize()
    assert is_cross_validated(finding, lcs) is True
