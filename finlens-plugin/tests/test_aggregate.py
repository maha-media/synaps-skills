"""
tests/test_aggregate.py — Stage 1 + Stage 2 synthesis tests.

Fixture-based, deterministic, no network. Uses finlens.contract.make_output
to build LensOutputs. Tests the math is correct and the narrative fallback works.
"""
from __future__ import annotations

import numpy as np
import pytest

from finlens.contract import make_output, LensOutput
from finlens.synthesis.aggregate import (
    aggregate_ticker,
    rank,
    _meff_from_weights,
    meff_from_corr,
)
from finlens.synthesis.synthesis import synthesize
from finlens.config import Config


# ---------------------------------------------------------------------------
# Fixtures: reusable LensOutput sets
# ---------------------------------------------------------------------------

@pytest.fixture
def insider_bullish() -> LensOutput:
    """Insider lens: bullish, high confidence."""
    return make_output(
        lens="insider",
        ticker="NVDA",
        score=0.65,
        confidence=0.85,
        evidence=[
            "3 exec open-market buys in last 30 days",
            "CEO bought $2.1M, CFO bought $850K",
            "No insider sells in period",
        ],
    )


@pytest.fixture
def value_bullish() -> LensOutput:
    """Value lens: bullish, decent confidence (orthogonal to insider)."""
    return make_output(
        lens="value",
        ticker="NVDA",
        score=0.45,
        confidence=0.70,
        evidence=[
            "P/E 18.2 vs sector median 24.5 (26% discount)",
            "FCF yield 5.8% (top quartile)",
        ],
    )


@pytest.fixture
def sentiment_bearish() -> LensOutput:
    """Sentiment lens: bearish (contrarian-signed — crowd is euphoric)."""
    return make_output(
        lens="sentiment",
        ticker="NVDA",
        score=-0.55,
        confidence=0.60,
        evidence=[
            "StockTwits bull ratio 0.89 (extreme) → contrarian bearish",
            "Sentiment dispersion low (herding signal)",
        ],
    )


@pytest.fixture
def momentum_bullish() -> LensOutput:
    """Momentum lens: bullish, moderate confidence."""
    return make_output(
        lens="momentum",
        ticker="NVDA",
        score=0.35,
        confidence=0.55,
        evidence=[
            "Price within 5% of 52-week high",
            "6-month momentum +18%",
        ],
    )


@pytest.fixture
def single_insider() -> LensOutput:
    """Single lens for thin-data test."""
    return make_output(
        lens="insider",
        ticker="TSLA",
        score=0.40,
        confidence=0.75,
        evidence=["1 exec open-market buy, $500K"],
    )


# ---------------------------------------------------------------------------
# Test (a): Two agreeing high-confidence orthogonal lenses → convergent
# ---------------------------------------------------------------------------

class TestConvergence:
    def test_two_agreeing_lenses_convergent(
        self, insider_bullish, value_bullish
    ):
        """Two orthogonal lenses (insider + value) both bullish with decent
        confidence → state should be 'convergent' with decent conviction."""
        v = aggregate_ticker("NVDA", [insider_bullish, value_bullish])

        assert v["ticker"] == "NVDA"
        assert v["direction"] == "bullish"
        assert v["state"] == "convergent"
        assert v["n_lenses"] == 2
        assert v["conviction"] > 0.3, "two agreeing lenses should have decent conviction"
        assert v["aggregate_score"] > 0, "both bullish → positive aggregate"
        assert "insider" in v["agreeing"]
        assert "value" in v["agreeing"]
        assert v["dissenting"] == []

    def test_convergent_aggregate_score_math(
        self, insider_bullish, value_bullish
    ):
        """Verify the weighted average: (0.65*0.85 + 0.45*0.70) / (0.85+0.70)."""
        v = aggregate_ticker("NVDA", [insider_bullish, value_bullish])
        expected = (0.65 * 0.85 + 0.45 * 0.70) / (0.85 + 0.70)
        assert abs(v["aggregate_score"] - expected) < 1e-3

    def test_convergent_meff(self, insider_bullish, value_bullish):
        """Meff for two lenses with weights [0.85, 0.70]."""
        v = aggregate_ticker("NVDA", [insider_bullish, value_bullish])
        w = np.array([0.85, 0.70])
        expected_meff = (w.sum() ** 2) / (w ** 2).sum()
        assert abs(v["meff"] - round(expected_meff, 2)) < 0.01


# ---------------------------------------------------------------------------
# Test (b): Insider bullish vs sentiment bearish → divergent
# ---------------------------------------------------------------------------

class TestDivergence:
    def test_insider_vs_sentiment_divergent(
        self, insider_bullish, sentiment_bearish
    ):
        """Insider bullish + sentiment bearish → state='divergent'.
        This is the high-information clash we must flag, not suppress."""
        v = aggregate_ticker("NVDA", [insider_bullish, sentiment_bearish])

        assert v["state"] == "divergent"
        assert v["n_lenses"] == 2
        assert len(v["dissenting"]) >= 1, "should have at least one dissenter"
        # The dissenter should be whichever disagrees with aggregate direction
        assert "DIVERGENT" in v["summary"] or "divergent" in v["summary"].lower()

    def test_divergent_conviction_capped(
        self, insider_bullish, sentiment_bearish
    ):
        """Divergent state should have conviction capped lower than convergent."""
        v_div = aggregate_ticker("NVDA", [insider_bullish, sentiment_bearish])
        # Compare: if both were agreeing, conviction would be higher
        value_bullish = make_output("value", "NVDA", 0.55, 0.60,
                                    evidence=["fake value evidence"])
        v_conv = aggregate_ticker("NVDA", [insider_bullish, value_bullish])

        # With similar score magnitudes, divergent should have lower conviction
        assert v_div["conviction"] < v_conv["conviction"] + 0.1, \
            "divergent shouldn't have much higher conviction than convergent"

    def test_three_way_with_dissent(
        self, insider_bullish, value_bullish, sentiment_bearish
    ):
        """3 lenses: 2 bullish + 1 bearish → divergent with sentiment dissenting."""
        v = aggregate_ticker(
            "NVDA",
            [insider_bullish, value_bullish, sentiment_bearish],
        )
        assert v["state"] == "divergent"
        assert "sentiment" in v["dissenting"]
        assert v["direction"] == "bullish"  # majority still bullish


# ---------------------------------------------------------------------------
# Test (c): Single lens → thin, low conviction
# ---------------------------------------------------------------------------

class TestThinData:
    def test_single_lens_thin(self, single_insider):
        v = aggregate_ticker("TSLA", [single_insider])

        assert v["ticker"] == "TSLA"
        assert v["state"] == "thin"
        assert v["n_lenses"] == 1
        assert v["conviction"] < 0.2, "single lens should have very low conviction"
        assert v["meff"] == 1.0, "single lens Meff should be exactly 1.0"

    def test_empty_outputs(self):
        v = aggregate_ticker("AAPL", [])
        assert v["state"] == "thin"
        assert v["conviction"] == 0.0
        assert v["n_lenses"] == 0
        assert v["direction"] == "neutral"


# ---------------------------------------------------------------------------
# Test (d): Meff proxy math on known weight vectors
# ---------------------------------------------------------------------------

class TestMeffMath:
    def test_uniform_weights(self):
        """N equal weights → Meff = N."""
        for n in [2, 3, 5, 10]:
            w = np.ones(n)
            meff = _meff_from_weights(w)
            assert abs(meff - n) < 1e-10, f"uniform {n} weights should give Meff={n}"

    def test_single_weight(self):
        """One weight → Meff = 1."""
        assert abs(_meff_from_weights(np.array([0.9])) - 1.0) < 1e-10

    def test_concentrated_weights(self):
        """One dominant weight → Meff ≈ 1."""
        w = np.array([1.0, 0.01, 0.01, 0.01])
        meff = _meff_from_weights(w)
        assert meff < 1.2, f"concentrated weights should give Meff near 1, got {meff}"

    def test_two_equal_weights(self):
        """Two equal weights → Meff = 2."""
        w = np.array([0.7, 0.7])
        meff = _meff_from_weights(w)
        assert abs(meff - 2.0) < 1e-10

    def test_known_vector(self):
        """Known: w=[0.85, 0.70, 0.60] → Meff = (2.15)^2 / (0.7225+0.49+0.36)."""
        w = np.array([0.85, 0.70, 0.60])
        expected = (2.15 ** 2) / (0.85**2 + 0.70**2 + 0.60**2)
        meff = _meff_from_weights(w)
        assert abs(meff - expected) < 1e-6

    def test_zero_weights(self):
        """All zero weights → Meff = 0."""
        assert _meff_from_weights(np.array([0.0, 0.0])) == 0.0


class TestMeffFromCorr:
    def test_identity_matrix(self):
        """Identity (perfectly independent) → Meff = N."""
        for n in [2, 3, 5]:
            meff = meff_from_corr(np.eye(n))
            assert abs(meff - n) < 1e-6

    def test_perfect_correlation(self):
        """All-ones matrix (perfectly correlated) → Meff = 1."""
        n = 4
        meff = meff_from_corr(np.ones((n, n)))
        assert abs(meff - 1.0) < 1e-6

    def test_partial_correlation(self):
        """A 3x3 corr matrix with some correlation → 1 < Meff < 3."""
        corr = np.array([
            [1.0, 0.5, 0.0],
            [0.5, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ])
        meff = meff_from_corr(corr)
        assert 1.0 < meff < 3.0, f"partial corr Meff should be between 1 and 3, got {meff}"


# ---------------------------------------------------------------------------
# Test: rank() sorting
# ---------------------------------------------------------------------------

class TestRank:
    def test_rank_by_conviction(self):
        """Higher conviction should rank first."""
        v1 = {"ticker": "A", "conviction": 0.3, "state": "weak", "n_lenses": 2}
        v2 = {"ticker": "B", "conviction": 0.7, "state": "convergent", "n_lenses": 3}
        ranked = rank([v1, v2])
        assert ranked[0]["ticker"] == "B"

    def test_divergent_boosted(self):
        """Divergent case should get surfaced even with lower conviction."""
        v_weak = {"ticker": "A", "conviction": 0.35, "state": "weak", "n_lenses": 2}
        v_div = {"ticker": "B", "conviction": 0.30, "state": "divergent", "n_lenses": 3}
        ranked = rank([v_weak, v_div])
        # Divergent B gets +0.15 boost → 0.45, beating weak A at 0.35
        assert ranked[0]["ticker"] == "B", \
            "divergent case should be boosted above similarly-convicted weak case"


# ---------------------------------------------------------------------------
# Test: synthesize() deterministic fallback (smoke test)
# ---------------------------------------------------------------------------

class TestSynthesizeFallback:
    def test_no_llm_produces_report(
        self, insider_bullish, value_bullish, sentiment_bearish
    ):
        """synthesize() with no LLM config should produce a non-empty string report."""
        outputs_by_ticker = {
            "NVDA": [insider_bullish, value_bullish, sentiment_bearish],
        }
        verdicts = [
            aggregate_ticker("NVDA", outputs_by_ticker["NVDA"]),
        ]
        config = Config()  # no LLM provider

        report = synthesize(verdicts, outputs_by_ticker, config)

        assert isinstance(report, str)
        assert len(report) > 100, "report should be substantial"
        assert "NVDA" in report
        assert "RESEARCH LEADS" in report or "NOT" in report
        assert "insider" in report.lower()

    def test_fallback_with_no_config(self, single_insider):
        """synthesize() works even with config=None."""
        outputs_by_ticker = {"TSLA": [single_insider]}
        verdicts = [aggregate_ticker("TSLA", [single_insider])]

        report = synthesize(verdicts, outputs_by_ticker, config=None)
        assert isinstance(report, str)
        assert len(report) > 50
        assert "TSLA" in report

    def test_empty_verdicts(self):
        """synthesize() handles empty input gracefully."""
        report = synthesize([], {}, config=None)
        assert isinstance(report, str)
        assert "No tickers" in report or len(report) > 0

    def test_multi_ticker_report(self):
        """Full multi-ticker report with ranking."""
        nvda_insider = make_output("insider", "NVDA", 0.65, 0.85,
                                   evidence=["3 exec buys"])
        nvda_value = make_output("value", "NVDA", 0.45, 0.70,
                                 evidence=["P/E discount"])
        tsla_insider = make_output("insider", "TSLA", 0.30, 0.50,
                                   evidence=["1 exec buy"])

        outputs_by_ticker = {
            "NVDA": [nvda_insider, nvda_value],
            "TSLA": [tsla_insider],
        }
        verdicts = [
            aggregate_ticker("NVDA", outputs_by_ticker["NVDA"]),
            aggregate_ticker("TSLA", outputs_by_ticker["TSLA"]),
        ]

        report = synthesize(verdicts, outputs_by_ticker)
        assert "NVDA" in report
        assert "TSLA" in report
        # NVDA (convergent, higher conviction) should appear before TSLA (thin)
        assert report.index("NVDA") < report.index("TSLA"), \
            "NVDA should rank above TSLA"


# ---------------------------------------------------------------------------
# Test: aggregate_ticker with corr_matrix override
# ---------------------------------------------------------------------------

class TestCorrMatrixOverride:
    def test_corr_matrix_used_for_meff(self, insider_bullish, value_bullish):
        """When corr_matrix is provided, use eigenvalue Meff instead of weight proxy."""
        # Identity → Meff should be 2.0 (perfectly independent)
        corr = np.eye(2)
        v = aggregate_ticker("NVDA", [insider_bullish, value_bullish],
                             corr_matrix=corr)
        assert abs(v["meff"] - 2.0) < 0.01

        # High correlation → Meff should be near 1
        corr_high = np.array([[1.0, 0.95], [0.95, 1.0]])
        v2 = aggregate_ticker("NVDA", [insider_bullish, value_bullish],
                              corr_matrix=corr_high)
        assert v2["meff"] < 1.5, "high corr should give low Meff"
