"""tests/test_fundamentals.py — FundamentalsLens fixture-based unit tests."""
from __future__ import annotations

import pytest

from finlens.data.base import DataSource, DataUnavailable, CAP_FUNDAMENTALS
from finlens.lenses.fundamentals import FundamentalsLens


# ---------------------------------------------------------------------------
# FakeDataSource
# ---------------------------------------------------------------------------

class FakeDataSource(DataSource):
    name = "fake"
    capabilities = {CAP_FUNDAMENTALS}

    def __init__(self, payload):
        self._payload = payload

    def fundamentals(self, ticker):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


FRESHNESS = "2025-01-15T00:00:00Z"

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def lens_cheap_growing_profitable():
    """Low valuation + positive growth + healthy margins + low leverage → bullish."""
    data = {
        "pe": 12.0,          # cheap (threshold: cheap=10, fair=20)
        "ps": 1.5,           # cheap
        "peg": 0.8,          # cheap
        "pb": 1.5,           # cheap
        "revenue_growth": 0.20,    # +20% → bullish
        "earnings_growth": 0.25,   # +25% → bullish
        "op_margin": 0.25,         # healthy
        "net_margin": 0.18,        # healthy
        "debt_to_equity": 0.3,     # low leverage
        "free_cashflow": 1_000_000_000,
        "market_cap": 50_000_000_000,
        "freshness": FRESHNESS,
    }
    return FundamentalsLens(FakeDataSource(data))


@pytest.fixture
def lens_expensive_shrinking_leveraged():
    """High valuation + negative growth + high leverage → bearish."""
    data = {
        "pe": 60.0,          # expensive
        "ps": 10.0,          # expensive
        "peg": 3.5,          # expensive
        "revenue_growth": -0.15,   # shrinking
        "earnings_growth": -0.20,  # shrinking
        "op_margin": -0.05,        # loss-making
        "net_margin": -0.08,       # loss-making
        "debt_to_equity": 5.0,     # high leverage
        "freshness": FRESHNESS,
    }
    return FundamentalsLens(FakeDataSource(data))


@pytest.fixture
def lens_partial_data():
    """Only a few fields present → should still produce output, lower confidence."""
    data = {
        "pe": 15.0,           # mildly cheap/fair
        "revenue_growth": 0.10,
        "freshness": FRESHNESS,
    }
    return FundamentalsLens(FakeDataSource(data))


@pytest.fixture
def lens_empty_data():
    """No meaningful fields → should return None."""
    return FundamentalsLens(FakeDataSource({"freshness": FRESHNESS}))


@pytest.fixture
def lens_all_none_fields():
    """All key fields explicitly None → should return None."""
    data = {k: None for k in
            ("pe", "ps", "peg", "pb", "revenue_growth", "earnings_growth",
             "op_margin", "net_margin", "debt_to_equity")}
    data["freshness"] = FRESHNESS
    return FundamentalsLens(FakeDataSource(data))


@pytest.fixture
def lens_data_unavailable():
    return FundamentalsLens(FakeDataSource(DataUnavailable("no data")))


@pytest.fixture
def lens_high_growth_only():
    """Only growth fields present → should be bullish based on growth alone."""
    data = {
        "revenue_growth": 0.40,
        "earnings_growth": 0.35,
        "freshness": FRESHNESS,
    }
    return FundamentalsLens(FakeDataSource(data))


@pytest.fixture
def lens_negative_growth_only():
    """Only negative growth → bearish."""
    data = {
        "revenue_growth": -0.30,
        "earnings_growth": -0.25,
        "freshness": FRESHNESS,
    }
    return FundamentalsLens(FakeDataSource(data))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestCheapGrowingProfitable:
    def test_returns_output(self, lens_cheap_growing_profitable):
        assert lens_cheap_growing_profitable.analyze("AAPL") is not None

    def test_signal_bullish(self, lens_cheap_growing_profitable):
        r = lens_cheap_growing_profitable.analyze("AAPL")
        assert r.signal == "bullish"

    def test_score_positive(self, lens_cheap_growing_profitable):
        r = lens_cheap_growing_profitable.analyze("AAPL")
        assert r.score > 0

    def test_score_moderate(self, lens_cheap_growing_profitable):
        """Fundamentals are principled — score should be meaningful but not extreme."""
        r = lens_cheap_growing_profitable.analyze("AAPL")
        assert 0.05 < r.score <= 1.0

    def test_confidence_high(self, lens_cheap_growing_profitable):
        """Many fields present → high confidence."""
        r = lens_cheap_growing_profitable.analyze("AAPL")
        assert r.confidence >= 0.5

    def test_evidence_present(self, lens_cheap_growing_profitable):
        r = lens_cheap_growing_profitable.analyze("AAPL")
        assert len(r.evidence) >= 1

    def test_evidence_has_metrics(self, lens_cheap_growing_profitable):
        r = lens_cheap_growing_profitable.analyze("AAPL")
        ev = r.evidence[0]
        # Should contain at least some metric labels
        assert any(label in ev for label in ("PE", "PS", "RevGrowth", "OpMargin"))

    def test_meta_present(self, lens_cheap_growing_profitable):
        r = lens_cheap_growing_profitable.analyze("AAPL")
        assert "valuation_score" in r.meta
        assert "growth_score" in r.meta
        assert r.meta["valuation_score"] > 0
        assert r.meta["growth_score"] > 0

    def test_lens_name(self, lens_cheap_growing_profitable):
        r = lens_cheap_growing_profitable.analyze("AAPL")
        assert r.lens == "fundamentals"

    def test_freshness(self, lens_cheap_growing_profitable):
        r = lens_cheap_growing_profitable.analyze("AAPL")
        assert r.data_freshness == FRESHNESS


class TestExpensiveShrinkingLeveraged:
    def test_signal_bearish(self, lens_expensive_shrinking_leveraged):
        r = lens_expensive_shrinking_leveraged.analyze("MSFT")
        assert r.signal == "bearish"

    def test_score_negative(self, lens_expensive_shrinking_leveraged):
        r = lens_expensive_shrinking_leveraged.analyze("MSFT")
        assert r.score < 0

    def test_meta_negative_dimensions(self, lens_expensive_shrinking_leveraged):
        r = lens_expensive_shrinking_leveraged.analyze("MSFT")
        assert r.meta["valuation_score"] < 0
        assert r.meta["growth_score"] < 0


class TestPartialData:
    def test_returns_output_with_partial_fields(self, lens_partial_data):
        r = lens_partial_data.analyze("NVDA")
        assert r is not None

    def test_lower_confidence_with_fewer_fields(self, lens_partial_data, lens_cheap_growing_profitable):
        r_partial = lens_partial_data.analyze("NVDA")
        r_full    = lens_cheap_growing_profitable.analyze("AAPL")
        assert r_partial.confidence < r_full.confidence

    def test_fields_present_count(self, lens_partial_data):
        r = lens_partial_data.analyze("NVDA")
        # Only pe + revenue_growth → 2 fields
        assert r.meta["fields_present"] == 2


class TestEmptyData:
    def test_empty_returns_none(self, lens_empty_data):
        assert lens_empty_data.analyze("AAPL") is None

    def test_all_none_returns_none(self, lens_all_none_fields):
        assert lens_all_none_fields.analyze("AAPL") is None

    def test_data_unavailable_returns_none(self, lens_data_unavailable):
        assert lens_data_unavailable.analyze("AAPL") is None


class TestGrowthOnly:
    def test_high_growth_bullish(self, lens_high_growth_only):
        r = lens_high_growth_only.analyze("XYZ")
        assert r is not None
        assert r.signal == "bullish"
        assert r.score > 0

    def test_negative_growth_bearish(self, lens_negative_growth_only):
        r = lens_negative_growth_only.analyze("XYZ")
        assert r is not None
        assert r.signal == "bearish"
        assert r.score < 0


class TestContractCompliance:
    def test_score_in_range(self, lens_cheap_growing_profitable):
        r = lens_cheap_growing_profitable.analyze("AAPL")
        assert -1.0 <= r.score <= 1.0

    def test_confidence_in_range(self, lens_cheap_growing_profitable):
        r = lens_cheap_growing_profitable.analyze("AAPL")
        assert 0.0 <= r.confidence <= 1.0

    def test_signal_score_coherent_bullish(self, lens_cheap_growing_profitable):
        r = lens_cheap_growing_profitable.analyze("AAPL")
        if r.signal == "bullish":
            assert r.score > 0

    def test_signal_score_coherent_bearish(self, lens_expensive_shrinking_leveraged):
        r = lens_expensive_shrinking_leveraged.analyze("MSFT")
        if r.signal == "bearish":
            assert r.score < 0

    def test_evidence_is_list(self, lens_cheap_growing_profitable):
        r = lens_cheap_growing_profitable.analyze("AAPL")
        assert isinstance(r.evidence, list)
