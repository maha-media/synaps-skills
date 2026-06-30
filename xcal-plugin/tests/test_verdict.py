import json
import pytest
from src.research.verdict import (
    Verdict, Finding, LensCall, CitationError, verdict_to_json,
)


def _lc(call_id="finlens:fundamentals"):
    return LensCall(call_id=call_id, lens="fundamentals", status="ok", latency_ms=10)


def test_verdict_citation_guard_rejects_uncited_numeric():
    v = Verdict(ticker="NVDA", question="q", skill_used="quarterly-check",
                lens_calls=[_lc()])
    v.findings.append(Finding(claim="rev=42", kind="numeric", value=42.0,
                              citations=(), confidence=0.9))
    with pytest.raises(CitationError):
        v.finalize()


def test_verdict_citation_guard_accepts_cited_numeric():
    v = Verdict(ticker="NVDA", question="q", skill_used="quarterly-check",
                lens_calls=[_lc()])
    v.findings.append(Finding(claim="rev=42", kind="numeric", value=42.0,
                              citations=("finlens:fundamentals",), confidence=0.9))
    v.finalize()  # no raise


def test_verdict_text_finding_no_citation_ok():
    v = Verdict(ticker="NVDA", question="q", skill_used="quarterly-check",
                lens_calls=[_lc()])
    v.findings.append(Finding(claim="trend up", kind="qualitative", value=None,
                              citations=(), confidence=0.5))
    v.finalize()


def test_json_requires_finalize():
    v = Verdict(ticker="NVDA", question="q", skill_used="quarterly-check",
                lens_calls=[_lc()])
    v.findings.append(Finding(claim="ok", kind="qualitative", value=None,
                              citations=(), confidence=0.5))
    with pytest.raises(Exception):
        verdict_to_json(v)
    v.finalize()
    payload = verdict_to_json(v)
    parsed = json.loads(payload)
    assert parsed["ticker"] == "NVDA"
    assert parsed["findings"][0]["claim"] == "ok"
