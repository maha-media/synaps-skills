"""tests/test_technicals.py — TechnicalsLens fixture-based unit tests.

Price series are carefully constructed so we can predict sign of each sub-signal:
  - Trending-up series: price above SMA50/200, near 52wk high, recent gains.
  - Trending-down series: price below SMA50/200, far from 52wk high, recent losses.
  - Short series: < 50 bars → must return None.
"""
from __future__ import annotations

import math

import pytest

from finlens.data.base import DataSource, DataUnavailable, CAP_PRICES
from finlens.lenses.technicals import TechnicalsLens


# ---------------------------------------------------------------------------
# FakeDataSource
# ---------------------------------------------------------------------------

class FakeDataSource(DataSource):
    name = "fake"
    capabilities = {CAP_PRICES}

    def __init__(self, payload):
        self._payload = payload

    def prices(self, ticker, period="6mo"):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


FRESHNESS = "2025-01-15T00:00:00Z"


# ---------------------------------------------------------------------------
# Price series builders
# ---------------------------------------------------------------------------

def _trending_up_series(n: int = 252, start: float = 100.0, daily_return: float = 0.003):
    """Steady upward trend — price continuously increases."""
    closes = [start * (1 + daily_return) ** i for i in range(n)]
    # highs slightly above closes, lows slightly below
    highs   = [c * 1.005 for c in closes]
    lows    = [c * 0.995 for c in closes]
    volumes = [1_000_000.0] * n
    return closes, highs, lows, volumes


def _trending_down_series(n: int = 252, start: float = 200.0, daily_return: float = -0.003):
    """Steady downtrend."""
    closes = [max(1.0, start * (1 + daily_return) ** i) for i in range(n)]
    highs   = [c * 1.005 for c in closes]
    lows    = [c * 0.995 for c in closes]
    volumes = [1_000_000.0] * n
    return closes, highs, lows, volumes


def _flat_series(n: int = 252, price: float = 100.0):
    """Completely flat — price doesn't move."""
    closes  = [price] * n
    highs   = [price * 1.001] * n
    lows    = [price * 0.999] * n
    volumes = [1_000_000.0] * n
    return closes, highs, lows, volumes


def _unusual_volume_series(n: int = 252, base_vol: float = 1_000_000.0, spike_mult: float = 3.0):
    """Flat price but last 5 bars have unusually high volume."""
    closes  = [100.0] * n
    highs   = [100.5] * n
    lows    = [99.5] * n
    volumes = [base_vol] * n
    for i in range(n - 5, n):
        volumes[i] = base_vol * spike_mult
    return closes, highs, lows, volumes


def _make_prices_dict(closes, highs, lows, volumes):
    dates = [f"2024-{(i // 30) % 12 + 1:02d}-{(i % 28) + 1:02d}" for i in range(len(closes))]
    return {
        "ticker": "TEST",
        "period": "6mo",
        "closes":  closes,
        "volumes": volumes,
        "highs":   highs,
        "lows":    lows,
        "dates":   dates,
        "freshness": FRESHNESS,
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def lens_trending_up():
    c, h, l, v = _trending_up_series(252)
    return TechnicalsLens(FakeDataSource(_make_prices_dict(c, h, l, v)))


@pytest.fixture
def lens_trending_down():
    c, h, l, v = _trending_down_series(252)
    return TechnicalsLens(FakeDataSource(_make_prices_dict(c, h, l, v)))


@pytest.fixture
def lens_flat_price():
    c, h, l, v = _flat_series(252)
    return TechnicalsLens(FakeDataSource(_make_prices_dict(c, h, l, v)))


@pytest.fixture
def lens_too_few_bars():
    """Only 30 bars — below hard minimum of 50 → must return None."""
    c, h, l, v = _trending_up_series(30)
    return TechnicalsLens(FakeDataSource(_make_prices_dict(c, h, l, v)))


@pytest.fixture
def lens_exactly_50_bars():
    """Exactly 50 bars — at hard minimum → should produce output (not None)."""
    c, h, l, v = _trending_up_series(50)
    return TechnicalsLens(FakeDataSource(_make_prices_dict(c, h, l, v)))


@pytest.fixture
def lens_unusual_volume():
    """Flat price with big volume spike in last 5 bars."""
    c, h, l, v = _unusual_volume_series(252, spike_mult=3.0)
    return TechnicalsLens(FakeDataSource(_make_prices_dict(c, h, l, v)))


@pytest.fixture
def lens_data_unavailable():
    return TechnicalsLens(FakeDataSource(DataUnavailable("no data")))


@pytest.fixture
def lens_empty_payload():
    return TechnicalsLens(FakeDataSource({}))


@pytest.fixture
def lens_no_closes():
    return TechnicalsLens(FakeDataSource({"closes": [], "freshness": FRESHNESS}))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestTrendingUp:
    def test_returns_output(self, lens_trending_up):
        assert lens_trending_up.analyze("AAPL") is not None

    def test_signal_bullish(self, lens_trending_up):
        r = lens_trending_up.analyze("AAPL")
        assert r.signal == "bullish"

    def test_score_positive(self, lens_trending_up):
        r = lens_trending_up.analyze("AAPL")
        assert r.score > 0

    def test_meta_sma50_present(self, lens_trending_up):
        r = lens_trending_up.analyze("AAPL")
        assert r.meta["sma50"] is not None

    def test_meta_sma200_present(self, lens_trending_up):
        r = lens_trending_up.analyze("AAPL")
        assert r.meta["sma200"] is not None

    def test_sma50_below_current_price(self, lens_trending_up):
        """In a steady uptrend, current price > SMA50 (avg of last 50 bars)."""
        r = lens_trending_up.analyze("AAPL")
        c, _, _, _ = _trending_up_series(252)
        sma50 = sum(c[-50:]) / 50
        assert c[-1] > sma50  # sanity on fixture
        assert r.meta["component_scores"]["sma50"] > 0

    def test_confidence_high_with_200_bars(self, lens_trending_up):
        r = lens_trending_up.analyze("AAPL")
        assert r.confidence >= 0.7

    def test_evidence_has_sma_reference(self, lens_trending_up):
        r = lens_trending_up.analyze("AAPL")
        assert len(r.evidence) >= 1
        ev = r.evidence[0]
        assert "DMA" in ev or "52wk" in ev

    def test_lens_name(self, lens_trending_up):
        assert lens_trending_up.analyze("AAPL").lens == "technicals"

    def test_freshness(self, lens_trending_up):
        assert lens_trending_up.analyze("AAPL").data_freshness == FRESHNESS


class TestTrendingDown:
    def test_signal_bearish(self, lens_trending_down):
        r = lens_trending_down.analyze("MSFT")
        assert r.signal == "bearish"

    def test_score_negative(self, lens_trending_down):
        r = lens_trending_down.analyze("MSFT")
        assert r.score < 0

    def test_high52_far_below_peak(self, lens_trending_down):
        """In a downtrend, current price is far below 52wk high."""
        r = lens_trending_down.analyze("MSFT")
        assert r.meta["component_scores"].get("high52", 0) < 0

    def test_sma_components_negative(self, lens_trending_down):
        r = lens_trending_down.analyze("MSFT")
        comps = r.meta["component_scores"]
        # At least one momentum-based component should be negative
        neg_comps = [v for v in comps.values() if v < 0]
        assert len(neg_comps) >= 1


class TestFlatPrice:
    def test_returns_output(self, lens_flat_price):
        r = lens_flat_price.analyze("XYZ")
        assert r is not None

    def test_score_near_zero(self, lens_flat_price):
        """Flat price → no momentum → score should be near zero."""
        r = lens_flat_price.analyze("XYZ")
        # Flat series: price = SMA50 = SMA200 = 52wk high → 52wk ratio=1.0 (near high)
        # So high52 signal will be positive (~0.8); sma signals near 0; mom near 0
        # Net result: slightly positive due to high52, but modest
        assert -0.5 < r.score < 0.8   # just a sanity bound

    def test_confidence_high(self, lens_flat_price):
        r = lens_flat_price.analyze("XYZ")
        assert r.confidence > 0.5


class TestMinimumBars:
    def test_too_few_bars_returns_none(self, lens_too_few_bars):
        assert lens_too_few_bars.analyze("AAPL") is None

    def test_exactly_50_bars_returns_output(self, lens_exactly_50_bars):
        r = lens_exactly_50_bars.analyze("AAPL")
        assert r is not None

    def test_exactly_50_bars_no_sma200(self, lens_exactly_50_bars):
        """With only 50 bars, SMA200 cannot be computed."""
        r = lens_exactly_50_bars.analyze("AAPL")
        assert r.meta["sma200"] is None


class TestUnusualVolume:
    def test_returns_output(self, lens_unusual_volume):
        r = lens_unusual_volume.analyze("AAPL")
        assert r is not None

    def test_vol_ratio_detected(self, lens_unusual_volume):
        """3x volume spike should be detected."""
        r = lens_unusual_volume.analyze("AAPL")
        assert r.meta["vol_ratio"] is not None
        assert r.meta["vol_ratio"] >= 1.5   # above unusual threshold

    def test_evidence_mentions_volume(self, lens_unusual_volume):
        r = lens_unusual_volume.analyze("AAPL")
        ev = r.evidence[0] if r.evidence else ""
        assert "vol" in ev.lower()


class TestEdgeCases:
    def test_data_unavailable_returns_none(self, lens_data_unavailable):
        assert lens_data_unavailable.analyze("AAPL") is None

    def test_empty_payload_returns_none(self, lens_empty_payload):
        assert lens_empty_payload.analyze("AAPL") is None

    def test_no_closes_returns_none(self, lens_no_closes):
        assert lens_no_closes.analyze("AAPL") is None

    def test_bullish_score_gt_bearish(self, lens_trending_up, lens_trending_down):
        """Trending up should always score higher than trending down."""
        r_up   = lens_trending_up.analyze("TEST")
        r_down = lens_trending_down.analyze("TEST")
        assert r_up.score > r_down.score


class TestContractCompliance:
    def test_score_in_range(self, lens_trending_up):
        r = lens_trending_up.analyze("AAPL")
        assert -1.0 <= r.score <= 1.0

    def test_confidence_in_range(self, lens_trending_up):
        r = lens_trending_up.analyze("AAPL")
        assert 0.0 <= r.confidence <= 1.0

    def test_signal_score_coherent(self, lens_trending_up):
        r = lens_trending_up.analyze("AAPL")
        if r.signal == "bullish":
            assert r.score > 0
        elif r.signal == "bearish":
            assert r.score < 0

    def test_evidence_is_list(self, lens_trending_up):
        r = lens_trending_up.analyze("AAPL")
        assert isinstance(r.evidence, list)

    def test_meta_is_dict(self, lens_trending_up):
        r = lens_trending_up.analyze("AAPL")
        assert isinstance(r.meta, dict)

    def test_bars_in_meta(self, lens_trending_up):
        r = lens_trending_up.analyze("AAPL")
        assert r.meta["bars"] == 252
