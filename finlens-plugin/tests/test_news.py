"""tests/test_news.py — unit tests for NewsLens.

Uses a FakeDataSource to inject controlled headline fixtures.
No network, no pytrends, no real data sources.

Tests:
  - positive headlines → mild positive score (small but > 0), small confidence
  - zero headlines / DataUnavailable → None
  - confidence is capped at _MAX_CONF (0.40)
  - score is capped at ±_MAX_SCORE (0.35)
  - elevated headline volume flagged in evidence
  - meta keys present and correct
"""
from __future__ import annotations

import datetime
import pytest

from finlens.lenses.news import NewsLens, _MAX_CONF, _MAX_SCORE, _HIGH_VOLUME_THRESHOLD
from finlens.data.base import DataSource, DataUnavailable, CAP_NEWS
from finlens.contract import LensOutput


# ── FakeDataSource ─────────────────────────────────────────────────────────────

class FakeDataSource(DataSource):
    """Minimal DataSource that returns whatever news fixture we inject."""

    name = "fake"
    capabilities = {CAP_NEWS}

    def __init__(self, items: list[dict] | None = None, raise_error: bool = False):
        self._items = items        # None → raise DataUnavailable
        self._raise = raise_error

    def news(self, ticker: str, limit: int = 20) -> dict:
        if self._raise or self._items is None:
            raise DataUnavailable("fake: no news")
        today = datetime.date.today().isoformat()
        return {
            "ticker": ticker,
            "items": self._items[:limit],
            "freshness": today,
        }


# ── helpers ────────────────────────────────────────────────────────────────────

def _make_headline(title: str, days_ago: int = 1) -> dict:
    d = (datetime.date.today() - datetime.timedelta(days=days_ago)).isoformat()
    return {"title": title, "source": "TestSource", "date": d, "url": "http://example.com"}


# ── fixtures ───────────────────────────────────────────────────────────────────

POSITIVE_HEADLINES = [
    _make_headline("ACME beats earnings expectations by wide margin"),
    _make_headline("ACME shares surge on record quarterly profit"),
    _make_headline("Analyst upgrades ACME to outperform after strong growth"),
    _make_headline("ACME raised guidance as revenue growth accelerates"),
    _make_headline("Breakthrough product approved for ACME"),
]

NEGATIVE_HEADLINES = [
    _make_headline("ACME misses revenue estimates as sales fall short"),
    _make_headline("SEC investigation probe launched into ACME practices"),
    _make_headline("ACME faces lawsuit after product recall"),
    _make_headline("ACME downgraded as margins decline on losses"),
    _make_headline("Warning: ACME cuts jobs in major layoffs"),
]

MIXED_HEADLINES = [
    _make_headline("ACME beats earnings"),
    _make_headline("ACME faces lawsuit"),
    _make_headline("ACME raises guidance"),
    _make_headline("ACME misses on revenue"),
]

# Elevated volume (≥ _HIGH_VOLUME_THRESHOLD)
MANY_HEADLINES = [
    _make_headline(f"ACME news item {i} beats surge") for i in range(15)
]


# ── tests ──────────────────────────────────────────────────────────────────────

class TestNewsLensPositive:
    """Positive headlines → mild positive score."""

    def setup_method(self):
        self.lens = NewsLens(data=FakeDataSource(items=POSITIVE_HEADLINES))

    def test_returns_lens_output(self):
        out = self.lens.analyze("ACME")
        assert isinstance(out, LensOutput)

    def test_positive_score(self):
        out = self.lens.analyze("ACME")
        assert out is not None
        assert out.score > 0, f"expected positive score, got {out.score}"

    def test_score_is_small(self):
        """Score must stay within the honest cap."""
        out = self.lens.analyze("ACME")
        assert out is not None
        assert out.score <= _MAX_SCORE

    def test_signal_is_bullish(self):
        out = self.lens.analyze("ACME")
        assert out is not None
        assert out.signal == "bullish"

    def test_confidence_is_modest(self):
        """Confidence must be at or below the hard cap."""
        out = self.lens.analyze("ACME")
        assert out is not None
        assert out.confidence <= _MAX_CONF

    def test_confidence_nonzero(self):
        """We had real headlines — confidence should be > 0."""
        out = self.lens.analyze("ACME")
        assert out is not None
        assert out.confidence > 0

    def test_ticker_uppercased(self):
        out = self.lens.analyze("acme")
        assert out is not None
        assert out.ticker == "ACME"

    def test_lens_name(self):
        out = self.lens.analyze("ACME")
        assert out is not None
        assert out.lens == "news"

    def test_evidence_list_populated(self):
        out = self.lens.analyze("ACME")
        assert out is not None
        assert len(out.evidence) >= 2

    def test_meta_headline_count(self):
        out = self.lens.analyze("ACME")
        assert out is not None
        assert out.meta["headline_count"] == len(POSITIVE_HEADLINES)

    def test_meta_positive_count_gt_negative(self):
        out = self.lens.analyze("ACME")
        assert out is not None
        assert out.meta["positive_headlines"] > out.meta["negative_headlines"]


class TestNewsLensNegative:
    """Negative headlines → mild negative score."""

    def setup_method(self):
        self.lens = NewsLens(data=FakeDataSource(items=NEGATIVE_HEADLINES))

    def test_negative_score(self):
        out = self.lens.analyze("ACME")
        assert out is not None
        assert out.score < 0, f"expected negative score, got {out.score}"

    def test_signal_is_bearish(self):
        out = self.lens.analyze("ACME")
        assert out is not None
        assert out.signal == "bearish"

    def test_score_capped(self):
        out = self.lens.analyze("ACME")
        assert out is not None
        assert out.score >= -_MAX_SCORE


class TestNewsLensNoData:
    """No headlines or unavailable data → None."""

    def test_empty_items_returns_none(self):
        lens = NewsLens(data=FakeDataSource(items=[]))
        assert lens.analyze("ACME") is None

    def test_data_unavailable_returns_none(self):
        lens = NewsLens(data=FakeDataSource(raise_error=True))
        assert lens.analyze("ACME") is None

    def test_none_items_returns_none(self):
        lens = NewsLens(data=FakeDataSource(items=None, raise_error=True))
        assert lens.analyze("ACME") is None


class TestNewsLensMixed:
    """Mixed headlines → score near zero."""

    def test_mixed_score_small(self):
        lens = NewsLens(data=FakeDataSource(items=MIXED_HEADLINES))
        out = lens.analyze("ACME")
        # Mixed might round to zero-ish — just assert it's within bounds
        assert out is not None
        assert -_MAX_SCORE <= out.score <= _MAX_SCORE


class TestNewsLensConfidenceCap:
    """Confidence never exceeds _MAX_CONF regardless of headline count."""

    def test_confidence_cap_many_headlines(self):
        items = [_make_headline(f"beats surge record {i}") for i in range(50)]
        lens = NewsLens(data=FakeDataSource(items=items))
        out = lens.analyze("TICKER")
        assert out is not None
        assert out.confidence <= _MAX_CONF, (
            f"confidence {out.confidence} exceeds cap {_MAX_CONF}"
        )


class TestNewsLensElevatedVolume:
    """≥ _HIGH_VOLUME_THRESHOLD headlines → elevated volume flagged in evidence."""

    def test_elevated_volume_in_evidence(self):
        lens = NewsLens(data=FakeDataSource(items=MANY_HEADLINES))
        out = lens.analyze("ACME")
        assert out is not None
        evidence_text = " ".join(out.evidence).lower()
        assert "elevat" in evidence_text or "volume" in evidence_text, (
            f"expected 'elevated' or 'volume' in evidence, got: {out.evidence}"
        )

    def test_elevated_volume_meta_flag(self):
        lens = NewsLens(data=FakeDataSource(items=MANY_HEADLINES))
        out = lens.analyze("ACME")
        assert out is not None
        assert out.meta.get("elevated_volume") is True


class TestNewsLensRecency:
    """Headlines from today → recency boost reflected in confidence."""

    def test_fresh_headlines_confidence(self):
        fresh = [_make_headline("ACME beats earnings", days_ago=0) for _ in range(5)]
        stale = [_make_headline("ACME beats earnings", days_ago=30) for _ in range(5)]

        lens_fresh = NewsLens(data=FakeDataSource(items=fresh))
        lens_stale = NewsLens(data=FakeDataSource(items=stale))

        out_fresh = lens_fresh.analyze("ACME")
        out_stale = lens_stale.analyze("ACME")

        assert out_fresh is not None
        assert out_stale is not None
        # Fresh should have >= confidence (recency boost)
        assert out_fresh.confidence >= out_stale.confidence


class TestNewsLensContractValid:
    """LensOutput contract is always valid (validate() doesn't raise)."""

    def test_contract_valid_positive(self):
        lens = NewsLens(data=FakeDataSource(items=POSITIVE_HEADLINES))
        out = lens.analyze("ACME")
        assert out is not None
        out.validate()  # should not raise

    def test_contract_valid_negative(self):
        lens = NewsLens(data=FakeDataSource(items=NEGATIVE_HEADLINES))
        out = lens.analyze("ACME")
        assert out is not None
        out.validate()
