"""Tests for src/research/shadow.py — offline/deterministic."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import pytest

from src.research.shadow import VerdictRecord, record_verdict, load_journal, score_journal
from src.research.verdict import Verdict, Finding


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_verdict(
    ticker="NVDA",
    question="Is NVDA a buy?",
    stance=None,
    findings=None,
    mirror_test=None,
    red_flags=(),
    skill_used="quarterly-check",
    axel_memory_id=None,
):
    v = Verdict(ticker=ticker, question=question, skill_used=skill_used)
    v.findings = findings or []
    v.stance = stance
    v.mirror_test = mirror_test
    v.red_flags = tuple(red_flags)
    v.axel_memory_id = axel_memory_id
    v._finalized = True  # skip invariant checks for unit test fixtures
    return v


def _make_finding(confidence=0.8):
    return Finding(claim="Revenue up", kind="qualitative", confidence=confidence)


# ── record_verdict ─────────────────────────────────────────────────────────

def test_record_verdict_writes_parseable_jsonl(tmp_path):
    jpath = tmp_path / "verdicts.jsonl"
    v = _make_verdict(ticker="AAPL", question="Buy AAPL?", stance="pass",
                      findings=[_make_finding(0.9), _make_finding(0.7)],
                      mirror_test="Thesis holds.", red_flags=(),
                      axel_memory_id="mem-abc")

    rec = record_verdict(v, price_at_verdict=180.0, journal_path=jpath)

    assert jpath.exists()
    lines = [l for l in jpath.read_text().splitlines() if l.strip()]
    assert len(lines) == 1

    obj = json.loads(lines[0])
    assert obj["ticker"] == "AAPL"
    assert obj["stance"] == "pass"
    assert abs(obj["confidence"] - 0.8) < 1e-9   # mean(0.9, 0.7) = 0.8
    assert obj["n_findings"] == 2
    assert obj["n_red_flags"] == 0
    assert obj["mirror_test_present"] is True
    assert obj["price_at_verdict"] == 180.0
    assert obj["skill_used"] == "quarterly-check"
    assert obj["status"] == "open"
    assert obj["memory_id"] == "mem-abc"
    assert "ts" in obj

    # returned record matches
    assert rec.ticker == "AAPL"
    assert rec.confidence == pytest.approx(0.8)


def test_record_verdict_no_findings_confidence_zero(tmp_path):
    jpath = tmp_path / "verdicts.jsonl"
    v = _make_verdict(ticker="MSFT")
    rec = record_verdict(v, journal_path=jpath)
    assert rec.confidence == 0.0


def test_record_verdict_appends_multiple(tmp_path):
    jpath = tmp_path / "verdicts.jsonl"
    v1 = _make_verdict(ticker="AAPL")
    v2 = _make_verdict(ticker="TSLA")
    record_verdict(v1, journal_path=jpath)
    record_verdict(v2, journal_path=jpath)
    lines = [l for l in jpath.read_text().splitlines() if l.strip()]
    assert len(lines) == 2


# ── load_journal ──────────────────────────────────────────────────────────────

def test_load_journal_round_trips(tmp_path):
    jpath = tmp_path / "verdicts.jsonl"
    v = _make_verdict(ticker="NVDA", stance="fail",
                      findings=[_make_finding(0.6)])
    record_verdict(v, price_at_verdict=500.0, journal_path=jpath)

    records = load_journal(jpath)
    assert len(records) == 1
    r = records[0]
    assert r.ticker == "NVDA"
    assert r.stance == "fail"
    assert r.price_at_verdict == 500.0
    assert r.confidence == pytest.approx(0.6)


def test_load_journal_skips_malformed_line(tmp_path):
    jpath = tmp_path / "verdicts.jsonl"
    # write one good line then one malformed line
    v = _make_verdict(ticker="GOOG")
    record_verdict(v, journal_path=jpath)
    with jpath.open("a") as f:
        f.write("THIS IS NOT JSON\n")

    records = load_journal(jpath)
    assert len(records) == 1
    assert records[0].ticker == "GOOG"


def test_load_journal_missing_file_returns_empty(tmp_path):
    records = load_journal(tmp_path / "nonexistent.jsonl")
    assert records == []


# ── score_journal ─────────────────────────────────────────────────────────────

def _make_record(ticker, stance, price_at, status="open"):
    return VerdictRecord(
        ticker=ticker,
        question="q",
        stance=stance,
        confidence=0.7,
        n_findings=2,
        n_red_flags=0,
        mirror_test_present=False,
        price_at_verdict=price_at,
        ts="2025-01-01T00:00:00+00:00",
        skill_used="quarterly-check",
        status=status,
    )


def test_score_journal_directional_accuracy():
    """
    Records:
      fail  AAPL  @ 100  → now 80   (dropped 20%) → CORRECT (fail + underperf)
      fail  MSFT  @ 100  → now 120  (rose 20%)     → WRONG   (fail + overperf)
      pass  NVDA  @ 100  → now 130  (rose 30%)     → CORRECT (pass + overperf)
      grey_zone TSLA @ 100 → now 90 → excluded from accuracy

    Expected: 2 correct out of 3 calls → accuracy = 2/3
    """
    records = [
        _make_record("AAPL", "fail",      100.0),
        _make_record("MSFT", "fail",      100.0),
        _make_record("NVDA", "pass",      100.0),
        _make_record("TSLA", "grey_zone", 100.0),
    ]
    prices = {"AAPL": 80.0, "MSFT": 120.0, "NVDA": 130.0, "TSLA": 90.0}
    price_fn = lambda t: prices.get(t)

    result = score_journal(records, price_fn, market_return=0.0)

    assert result["n_scored"] == 4
    assert result["n_calls"] == 3   # fail×2 + pass×1
    assert result["directional_accuracy"] == pytest.approx(2 / 3)

    by = result["by_stance"]
    # fail bucket: avg return = (-0.20 + 0.20) / 2 = 0.0; correct = 1
    assert by["fail"]["count"] == 2
    assert by["fail"]["avg_return"] == pytest.approx(0.0)
    assert by["fail"]["correct"] == 1

    # pass bucket: avg return = 0.30; correct = 1
    assert by["pass"]["count"] == 1
    assert by["pass"]["avg_return"] == pytest.approx(0.30)
    assert by["pass"]["correct"] == 1

    # grey_zone bucket present, counted, not in n_calls
    assert by["grey_zone"]["count"] == 1


def test_score_journal_excludes_no_price_at_verdict():
    """Records with price_at_verdict=None must be excluded from scoring."""
    records = [
        VerdictRecord(
            ticker="AAPL", question="q", stance="pass", confidence=0.5,
            n_findings=1, n_red_flags=0, mirror_test_present=False,
            price_at_verdict=None,
            ts="2025-01-01T00:00:00+00:00", skill_used="quarterly-check",
        ),
    ]
    result = score_journal(records, lambda t: 200.0)
    assert result["n_scored"] == 0
    assert result["n_calls"] == 0


def test_score_journal_unpriceable_ticker_skipped():
    """current_price_fn returning None means ticker is skipped."""
    records = [_make_record("XYZ", "pass", 100.0)]
    result = score_journal(records, lambda t: None)
    assert result["n_scored"] == 0


def test_score_journal_above_market_return():
    """With market_return=0.10 a pass that only grew 5% is WRONG."""
    records = [_make_record("NVDA", "pass", 100.0)]
    prices = {"NVDA": 105.0}
    result = score_journal(records, lambda t: prices.get(t), market_return=0.10)
    assert result["directional_accuracy"] == pytest.approx(0.0)


# ── best-effort: unwritable path returns record without raising ───────────────

def test_record_verdict_unwritable_path_no_raise():
    v = _make_verdict(ticker="FAIL")
    # Pass a path under a nonexistent read-only tree
    bad_path = Path("/root/no_permission_dir_xcal_test/verdicts.jsonl")
    # Should NOT raise, should return a valid record
    rec = record_verdict(v, journal_path=bad_path)
    assert isinstance(rec, VerdictRecord)
    assert rec.ticker == "FAIL"
