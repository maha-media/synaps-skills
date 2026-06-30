"""tests/test_search_trend.py — unit tests for SearchTrendLens.

No network calls — pytrends is either monkeypatched absent or replaced with
an injected fake fetcher function.

Tests:
  - pytrends-absent path: analyze() returns None gracefully, no crash
  - data present via injected fake fetcher: attention flag in meta
  - spike flag set when recent week is a spike
  - score is near-zero (within ±0.05)
  - confidence is low (≤ 0.25)
  - contract is always valid when output is not None
  - lens can be instantiated without pytrends (import-level safety)
"""
from __future__ import annotations

import pytest

from finlens.lenses.search_trend import (
    SearchTrendLens,
    _MAX_SCORE,
    _MAX_CONF,
    _attention_level,
    _spike_flag,
    _trend_slope,
    _label_attention,
    _SPIKE_MULTIPLIER,
    _SPIKE_ABS_MIN,
)
from finlens.contract import LensOutput


# ── Fake fetchers ──────────────────────────────────────────────────────────────

def _no_data_fetcher(ticker: str):
    """Simulates pytrends returning nothing (empty / None)."""
    return None


def _error_fetcher(ticker: str):
    """Simulates pytrends raising an exception."""
    raise RuntimeError("simulated pytrends network error")


def _flat_fetcher(ticker: str) -> list[int]:
    """12 weeks of flat ~30/100 interest — no spike, moderate attention."""
    return [30] * 12


def _spike_fetcher(ticker: str) -> list[int]:
    """12 weeks with a spike in the last 2 weeks: most at 20, recent at 80."""
    return [20, 22, 18, 21, 20, 19, 22, 20, 21, 20, 80, 85]


def _rising_fetcher(ticker: str) -> list[int]:
    """12 weeks of steadily rising interest."""
    return list(range(20, 20 + 12 * 5, 5))  # 20,25,30,...,75


def _falling_fetcher(ticker: str) -> list[int]:
    """12 weeks of steadily falling interest."""
    return list(range(80, 80 - 12 * 5, -5))  # 80,75,...,25


def _high_attention_fetcher(ticker: str) -> list[int]:
    """Consistently very high attention (≥75)."""
    return [80] * 12


# ── Tests: graceful None when pytrends absent or no data ─────────────────────

class TestSearchTrendGracefulNone:
    """Lens must return None gracefully in all failure modes."""

    def test_no_data_returns_none(self):
        lens = SearchTrendLens(fetch_fn=_no_data_fetcher)
        assert lens.analyze("AAPL") is None

    def test_error_fetcher_returns_none(self):
        lens = SearchTrendLens(fetch_fn=_error_fetcher)
        assert lens.analyze("AAPL") is None

    def test_empty_list_returns_none(self):
        lens = SearchTrendLens(fetch_fn=lambda t: [])
        assert lens.analyze("AAPL") is None


class TestSearchTrendPytrendsAbsentMonkeypatch:
    """Simulate the pytrends-absent code path by patching the module-level flag."""

    def test_absent_pytrends_returns_none(self, monkeypatch):
        import finlens.lenses.search_trend as st_mod
        # Patch the module so _fetch_trends always returns None (simulating absent dep)
        monkeypatch.setattr(st_mod, "_PYTRENDS_OK", False)
        # With fetch_fn=None the lens falls back to _fetch_trends
        # which checks _PYTRENDS_OK at call time and returns None
        lens = SearchTrendLens()  # uses real _fetch_trends
        result = lens.analyze("AAPL")
        # Should be None because _PYTRENDS_OK is False
        assert result is None

    def test_import_succeeds_without_pytrends(self):
        """Module must be importable even if pytrends is broken/absent."""
        # We already imported it above — this just confirms no ImportError was raised.
        import finlens.lenses.search_trend  # noqa: F401 — import assertion


# ── Tests: real output with injected fake data ────────────────────────────────

class TestSearchTrendFlatData:
    """Flat moderate attention: no spike, near-zero score."""

    def setup_method(self):
        self.lens = SearchTrendLens(fetch_fn=_flat_fetcher)

    def test_returns_lens_output(self):
        out = self.lens.analyze("AAPL")
        assert isinstance(out, LensOutput)

    def test_score_near_zero(self):
        out = self.lens.analyze("AAPL")
        assert out is not None
        assert abs(out.score) <= _MAX_SCORE, f"score {out.score} exceeds ±{_MAX_SCORE}"

    def test_confidence_low(self):
        out = self.lens.analyze("AAPL")
        assert out is not None
        assert out.confidence <= _MAX_CONF

    def test_no_spike(self):
        out = self.lens.analyze("AAPL")
        assert out is not None
        assert out.meta["spike_flag"] is False

    def test_attention_tier_in_meta(self):
        out = self.lens.analyze("AAPL")
        assert out is not None
        assert "attention_tier" in out.meta
        assert out.meta["attention_tier"] in ("low", "moderate", "elevated", "very high")

    def test_attention_level_in_meta(self):
        out = self.lens.analyze("AAPL")
        assert out is not None
        assert "attention_level" in out.meta
        assert 0 <= out.meta["attention_level"] <= 100

    def test_lens_name(self):
        out = self.lens.analyze("AAPL")
        assert out is not None
        assert out.lens == "search_trend"

    def test_ticker_uppercased(self):
        out = self.lens.analyze("aapl")
        assert out is not None
        assert out.ticker == "AAPL"


class TestSearchTrendSpikeData:
    """Spike scenario: spike_flag=True, evidence mentions spike."""

    def setup_method(self):
        self.lens = SearchTrendLens(fetch_fn=_spike_fetcher)

    def test_spike_flag_true(self):
        out = self.lens.analyze("TSLA")
        assert out is not None
        assert out.meta["spike_flag"] is True

    def test_evidence_mentions_spike(self):
        out = self.lens.analyze("TSLA")
        assert out is not None
        evidence_text = " ".join(out.evidence).lower()
        assert "spike" in evidence_text or "spiking" in evidence_text, (
            f"Expected 'spike' in evidence. Got: {out.evidence}"
        )

    def test_confidence_slightly_higher_than_flat(self):
        """Spike adds a small confidence bump."""
        flat_lens  = SearchTrendLens(fetch_fn=_flat_fetcher)
        spike_lens = SearchTrendLens(fetch_fn=_spike_fetcher)
        out_flat  = flat_lens.analyze("X")
        out_spike = spike_lens.analyze("X")
        assert out_flat is not None and out_spike is not None
        assert out_spike.confidence >= out_flat.confidence

    def test_attention_regime_in_evidence(self):
        """Evidence must flag the attention/volatility regime."""
        out = self.lens.analyze("TSLA")
        assert out is not None
        ev = " ".join(out.evidence).lower()
        assert any(word in ev for word in ("volatility", "attention", "regime", "spike")), (
            f"expected volatility/attention/regime flag in evidence. Got: {out.evidence}"
        )


class TestSearchTrendRisingTrend:
    """Rising trend → slope=+1, tiny positive score nudge."""

    def test_slope_positive(self):
        lens = SearchTrendLens(fetch_fn=_rising_fetcher)
        out = lens.analyze("NVDA")
        assert out is not None
        assert out.meta["trend_slope"] == 1

    def test_score_slightly_positive(self):
        lens = SearchTrendLens(fetch_fn=_rising_fetcher)
        out = lens.analyze("NVDA")
        assert out is not None
        assert out.score >= 0  # rising → tiny non-negative nudge


class TestSearchTrendFallingTrend:
    """Falling trend → slope=-1, tiny negative score nudge."""

    def test_slope_negative(self):
        lens = SearchTrendLens(fetch_fn=_falling_fetcher)
        out = lens.analyze("META")
        assert out is not None
        assert out.meta["trend_slope"] == -1

    def test_score_slightly_negative(self):
        lens = SearchTrendLens(fetch_fn=_falling_fetcher)
        out = lens.analyze("META")
        assert out is not None
        assert out.score <= 0  # falling → tiny non-positive nudge


class TestSearchTrendHighAttention:
    """Very high attention tier."""

    def test_very_high_tier(self):
        lens = SearchTrendLens(fetch_fn=_high_attention_fetcher)
        out = lens.analyze("AMZN")
        assert out is not None
        assert out.meta["attention_tier"] == "very high"


# ── Tests: contract validity ───────────────────────────────────────────────────

class TestSearchTrendContract:
    """Output always passes contract validation."""

    def test_contract_valid_flat(self):
        lens = SearchTrendLens(fetch_fn=_flat_fetcher)
        out = lens.analyze("AAPL")
        assert out is not None
        out.validate()

    def test_contract_valid_spike(self):
        lens = SearchTrendLens(fetch_fn=_spike_fetcher)
        out = lens.analyze("TSLA")
        assert out is not None
        out.validate()

    def test_contract_valid_rising(self):
        lens = SearchTrendLens(fetch_fn=_rising_fetcher)
        out = lens.analyze("NVDA")
        assert out is not None
        out.validate()


# ── Tests: unit helpers ────────────────────────────────────────────────────────

class TestHelpers:
    """Unit tests for the pure helper functions."""

    def test_attention_level_all_same(self):
        assert _attention_level([50] * 12) == pytest.approx(50.0)

    def test_attention_level_uses_tail(self):
        # First 8 weeks low, last 4 weeks high
        vals = [10] * 8 + [90] * 4
        assert _attention_level(vals, n=4) == pytest.approx(90.0)

    def test_spike_flag_detects_spike(self):
        # Rolling mean ~20; last week = 80 (4x mean, well above abs threshold)
        vals = [20] * 10 + [80, 85]
        assert _spike_flag(vals) is True

    def test_spike_flag_no_spike(self):
        vals = [30] * 12
        assert _spike_flag(vals) is False

    def test_spike_flag_below_abs_threshold(self):
        # 1.5x mean but below absolute threshold of 40
        vals = [20] * 10 + [31, 32]
        # 31 > 1.5*20=30 ✓ but 31 < 40 ✗ → no spike
        assert _spike_flag(vals) is False

    def test_trend_slope_rising(self):
        vals = list(range(10, 70, 5))  # 10,15,...,65
        assert _trend_slope(vals) == 1

    def test_trend_slope_falling(self):
        vals = list(range(60, 0, -5))  # 60,55,...,5
        assert _trend_slope(vals) == -1

    def test_trend_slope_flat(self):
        vals = [40] * 12
        assert _trend_slope(vals) == 0

    def test_label_attention_tiers(self):
        assert _label_attention(80) == "very high"
        assert _label_attention(60) == "elevated"
        assert _label_attention(30) == "moderate"
        assert _label_attention(10) == "low"
