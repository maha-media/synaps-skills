"""tests/test_sentiment.py — fixture-based unit tests for SentimentLens.

All tests inject a fake fetch_stream so no network calls are made.
Tests cover the four required behaviours:
  (a) heavy-bull input  → negative (bearish) score + confidence ≤ 0.35
  (b) spam messages get filtered and don't influence the score
  (c) empty stream      → None
  (d) confidence hard-capped at 0.35 regardless of sample size

Additional tests cover:
  (e) rare-bearish input → positive (bullish/neutral) score
  (f) thin-tagged sample → neutral score + evidence of thinness
  (g) contract validity  → LensOutput fields are coherent (score/signal sign,
      confidence ≤ 1.0, evidence is a list)
  (h) fetch exception    → None (graceful, no crash)
"""
from __future__ import annotations

import pytest
from finlens.lenses.sentiment import SentimentLens


# ── helpers to build fake message dicts ──────────────────────────────────────

def _msg(body: str, sentiment: str | None = None, ts: str = "2025-01-20T12:00:00Z") -> dict:
    """Build a minimal StockTwits message dict."""
    return {
        "body": body,
        "created_at": ts,
        "entities": {
            "sentiment": {"basic": sentiment} if sentiment else None
        },
    }


def _spam_msg(ts: str = "2025-01-20T12:00:00Z") -> dict:
    """A cashtag-list spam post: ≥3 cashtags, <4 real words."""
    return _msg("$AAPL $TSLA $NVDA $AMD go", ts=ts)


def _make_lens(messages: list[dict]) -> SentimentLens:
    """Return a SentimentLens whose fetch_stream always returns *messages*."""
    return SentimentLens(fetch_stream=lambda ticker: messages)


# ── (c) empty stream → None ───────────────────────────────────────────────────

class TestEmptyStream:
    def test_none_on_empty_list(self):
        lens = _make_lens([])
        result = lens.analyze("AAPL")
        assert result is None, "Empty stream must return None"

    def test_none_on_all_spam(self):
        """All messages are spam → zero usable → None."""
        messages = [_spam_msg() for _ in range(15)]
        lens = _make_lens(messages)
        result = lens.analyze("AAPL")
        assert result is None, "All-spam stream must return None"


# ── (a) heavy-bull input → negative (bearish/contrarian) score ───────────────

class TestHeavyBull:
    """90%+ bullish tagged posts — well above the ~85% baseline → contrarian bearish."""

    def _heavy_bull_messages(self, n_bull: int = 18, n_bear: int = 2) -> list[dict]:
        msgs = []
        for i in range(n_bull):
            msgs.append(_msg(f"Super bullish on this stock #{i}", "Bullish",
                             ts=f"2025-01-20T{10 + i // 6:02d}:{(i * 3) % 60:02d}:00Z"))
        for i in range(n_bear):
            msgs.append(_msg(f"I'm out, too risky #{i}", "Bearish",
                             ts=f"2025-01-20T10:{i * 5:02d}:00Z"))
        return msgs

    def test_score_is_negative(self):
        lens = _make_lens(self._heavy_bull_messages())
        out = lens.analyze("TSLA")
        assert out is not None
        assert out.score < 0, (
            f"90% bull crowd should yield negative (bearish) contrarian score, got {out.score}"
        )

    def test_signal_is_bearish_or_neutral(self):
        lens = _make_lens(self._heavy_bull_messages())
        out = lens.analyze("TSLA")
        assert out is not None
        assert out.signal in ("bearish", "neutral"), (
            f"Expected bearish or neutral signal for extreme-bull crowd, got {out.signal!r}"
        )

    def test_confidence_low(self):
        """Confidence must be ≤ 0.35 (doctrine: weak signal, cap applies)."""
        lens = _make_lens(self._heavy_bull_messages())
        out = lens.analyze("TSLA")
        assert out is not None
        assert out.confidence <= 0.35, f"confidence {out.confidence} exceeds 0.35 cap"

    def test_score_magnitude_small(self):
        """Score magnitude stays ≤ 0.20 (MAX_SCORE hard cap)."""
        lens = _make_lens(self._heavy_bull_messages())
        out = lens.analyze("TSLA")
        assert out is not None
        assert abs(out.score) <= 0.20, f"|score| {abs(out.score)} exceeds 0.20 cap"

    def test_evidence_mentions_bullish_crowd(self):
        lens = _make_lens(self._heavy_bull_messages())
        out = lens.analyze("TSLA")
        assert out is not None
        evidence_blob = " ".join(out.evidence).lower()
        assert "bull" in evidence_blob, "Evidence should mention bullish crowd percentage"

    def test_meta_contains_expected_keys(self):
        lens = _make_lens(self._heavy_bull_messages())
        out = lens.analyze("TSLA")
        assert out is not None
        for key in ("bull", "bear", "tagged", "bull_pct", "dispersion",
                    "spam_filtered", "sample_size", "baseline_pct", "edge_vs_baseline"):
            assert key in out.meta, f"meta missing key: {key!r}"

    def test_meta_bull_gt_bear(self):
        lens = _make_lens(self._heavy_bull_messages())
        out = lens.analyze("TSLA")
        assert out is not None
        assert out.meta["bull"] > out.meta["bear"]

    def test_ticker_uppercased(self):
        lens = _make_lens(self._heavy_bull_messages())
        out = lens.analyze("tsla")
        assert out is not None
        assert out.ticker == "TSLA"


# ── (b) spam filtering ────────────────────────────────────────────────────────

class TestSpamFiltering:
    """Spam posts must be removed before counting; spam count must be in meta."""

    def _mixed_messages(self) -> list[dict]:
        """10 real bullish, 5 real bearish, 8 spam. Only real ones scored."""
        msgs = []
        for i in range(10):
            msgs.append(_msg(f"Love this ticker long term #{i}", "Bullish",
                             ts=f"2025-01-20T10:{i * 2:02d}:00Z"))
        for i in range(5):
            msgs.append(_msg(f"Looks over-extended, fading #{i}", "Bearish",
                             ts=f"2025-01-20T11:{i * 3:02d}:00Z"))
        for i in range(8):
            msgs.append(_spam_msg(ts=f"2025-01-20T09:{i * 5:02d}:00Z"))
        return msgs

    def test_spam_filtered_count_in_meta(self):
        lens = _make_lens(self._mixed_messages())
        out = lens.analyze("NVDA")
        assert out is not None
        assert out.meta["spam_filtered"] == 8, (
            f"Expected 8 spam filtered, got {out.meta['spam_filtered']}"
        )

    def test_spam_does_not_inflate_sample_size(self):
        """sample_size counts non-spam messages only."""
        lens = _make_lens(self._mixed_messages())
        out = lens.analyze("NVDA")
        assert out is not None
        assert out.meta["sample_size"] == 15, (
            f"Expected 15 usable (non-spam), got {out.meta['sample_size']}"
        )

    def test_spam_does_not_affect_tagged_counts(self):
        """Bull + bear should only count the 15 real posts; 10+5=15 tagged."""
        lens = _make_lens(self._mixed_messages())
        out = lens.analyze("NVDA")
        assert out is not None
        assert out.meta["tagged"] == 15
        assert out.meta["bull"] == 10
        assert out.meta["bear"] == 5

    def test_all_spam_returns_none(self):
        lens = _make_lens([_spam_msg() for _ in range(20)])
        assert lens.analyze("NVDA") is None


# ── (d) confidence cap ────────────────────────────────────────────────────────

class TestConfidenceCap:
    """Confidence must never exceed 0.35 regardless of how many tagged posts."""

    def _large_bull_stream(self, n: int = 200) -> list[dict]:
        return [
            _msg(f"Very bullish #{i}", "Bullish",
                 ts=f"2025-01-20T{10 + i // 60:02d}:{i % 60:02d}:00Z")
            for i in range(n)
        ]

    def test_confidence_capped_at_0_35_large_sample(self):
        lens = _make_lens(self._large_bull_stream(200))
        out = lens.analyze("AAPL")
        assert out is not None
        assert out.confidence <= 0.35, (
            f"Confidence {out.confidence} exceeds 0.35 cap on large sample"
        )

    def test_confidence_is_positive(self):
        lens = _make_lens(self._large_bull_stream(200))
        out = lens.analyze("AAPL")
        assert out is not None
        assert out.confidence > 0.0

    def test_more_posts_do_not_exceed_cap(self):
        """500 tagged posts should not push confidence above 0.35."""
        msgs = [_msg(f"bull #{i}", "Bullish") for i in range(500)]
        lens = _make_lens(msgs)
        out = lens.analyze("AAPL")
        assert out is not None
        assert out.confidence <= 0.35


# ── (e) rare-bearish input → positive or neutral score ───────────────────────

class TestRareBearish:
    """When the crowd is unusually bearish (below ~85% bull baseline), score ≥ 0."""

    def _rare_bear_messages(self, n_bull: int = 4, n_bear: int = 6) -> list[dict]:
        """40% bull = extremely rare and below baseline → contrarian bullish note."""
        msgs = []
        for i in range(n_bull):
            msgs.append(_msg(f"Still some hope #{i}", "Bullish",
                             ts=f"2025-01-20T10:{i * 5:02d}:00Z"))
        for i in range(n_bear):
            msgs.append(_msg(f"This is over, get out #{i}", "Bearish",
                             ts=f"2025-01-20T11:{i * 4:02d}:00Z"))
        return msgs

    def test_score_is_non_negative(self):
        lens = _make_lens(self._rare_bear_messages())
        out = lens.analyze("GME")
        assert out is not None
        assert out.score >= 0.0, (
            f"Below-baseline bullishness should yield non-negative score, got {out.score}"
        )

    def test_signal_not_bearish(self):
        lens = _make_lens(self._rare_bear_messages())
        out = lens.analyze("GME")
        assert out is not None
        assert out.signal in ("bullish", "neutral"), (
            f"Below-baseline crowd should not produce bearish signal, got {out.signal!r}"
        )

    def test_confidence_still_capped(self):
        lens = _make_lens(self._rare_bear_messages())
        out = lens.analyze("GME")
        assert out is not None
        assert out.confidence <= 0.35


# ── (f) thin-tagged → neutral score ──────────────────────────────────────────

class TestThinTagged:
    """With < 4 tagged posts, score should be 0 (neutral, can't determine direction)."""

    def _thin_messages(self) -> list[dict]:
        """3 real posts but only 2 have sentiment tags — below _MIN_TAGGED_FOR_SCORE."""
        return [
            _msg("Watching this one", "Bullish", ts="2025-01-20T10:00:00Z"),
            _msg("Might be time to exit", "Bearish", ts="2025-01-20T10:01:00Z"),
            _msg("Just tracking the news", None, ts="2025-01-20T10:02:00Z"),
        ]

    def test_score_is_zero_on_thin_sample(self):
        lens = _make_lens(self._thin_messages())
        out = lens.analyze("SPY")
        assert out is not None
        assert out.score == 0.0, f"Thin tagged sample should return score=0, got {out.score}"

    def test_signal_is_neutral_on_thin_sample(self):
        lens = _make_lens(self._thin_messages())
        out = lens.analyze("SPY")
        assert out is not None
        assert out.signal == "neutral"

    def test_evidence_mentions_thin(self):
        lens = _make_lens(self._thin_messages())
        out = lens.analyze("SPY")
        assert out is not None
        blob = " ".join(out.evidence).lower()
        assert any(word in blob for word in ("thin", "too", "tagged", "enough")), (
            "Evidence should explain the thin-data situation"
        )


# ── (g) contract validity ─────────────────────────────────────────────────────

class TestContractValidity:
    """LensOutput fields must always satisfy the contract."""

    def _standard_messages(self) -> list[dict]:
        msgs = [_msg(f"bullish #{i}", "Bullish",
                     ts=f"2025-01-20T10:{i:02d}:00Z") for i in range(12)]
        msgs += [_msg(f"bearish #{i}", "Bearish",
                      ts=f"2025-01-20T11:{i:02d}:00Z") for i in range(3)]
        return msgs

    def test_score_in_range(self):
        lens = _make_lens(self._standard_messages())
        out = lens.analyze("NVDA")
        assert out is not None
        assert -1.0 <= out.score <= 1.0

    def test_confidence_in_range(self):
        lens = _make_lens(self._standard_messages())
        out = lens.analyze("NVDA")
        assert out is not None
        assert 0.0 <= out.confidence <= 1.0

    def test_signal_coherent_with_score(self):
        """LensOutput.__post_init__ already enforces this, but be explicit."""
        lens = _make_lens(self._standard_messages())
        out = lens.analyze("NVDA")
        assert out is not None
        if out.signal == "bearish":
            assert out.score <= 0
        elif out.signal == "bullish":
            assert out.score >= 0
        # neutral allows anything in deadband

    def test_evidence_is_list_of_strings(self):
        lens = _make_lens(self._standard_messages())
        out = lens.analyze("NVDA")
        assert out is not None
        assert isinstance(out.evidence, list)
        assert all(isinstance(e, str) for e in out.evidence)

    def test_lens_name_is_sentiment(self):
        lens = _make_lens(self._standard_messages())
        out = lens.analyze("NVDA")
        assert out is not None
        assert out.lens == "sentiment"

    def test_meta_is_dict(self):
        lens = _make_lens(self._standard_messages())
        out = lens.analyze("NVDA")
        assert out is not None
        assert isinstance(out.meta, dict)


# ── (h) graceful exception handling ──────────────────────────────────────────

class TestGracefulFailure:
    """If the fetch callable raises, analyze() must return None, not propagate."""

    def test_fetch_exception_returns_none(self):
        def boom(ticker):
            raise RuntimeError("network down")

        lens = SentimentLens(fetch_stream=boom)
        result = lens.analyze("AAPL")
        assert result is None, "fetch exception must be swallowed and return None"

    def test_fetch_returns_non_list_returns_none(self):
        """If fetch_stream returns None instead of a list, analyze returns None."""
        lens = SentimentLens(fetch_stream=lambda t: None)
        # None is falsy → should return None gracefully
        result = lens.analyze("AAPL")
        assert result is None


# ── edge: untagged-only messages ──────────────────────────────────────────────

class TestUntaggedMessages:
    """Posts with no sentiment tag are counted toward usable but not toward tagged."""

    def test_untagged_only_returns_thin_result(self):
        """10 posts with no sentiment tags → tagged=0 < threshold → neutral score."""
        msgs = [_msg(f"Just watching #{i}", None) for i in range(10)]
        lens = _make_lens(msgs)
        out = lens.analyze("SPY")
        # usable_count=10 → not None, but tagged=0 < 4 → score=0
        assert out is not None
        assert out.score == 0.0
        assert out.signal == "neutral"
        assert out.meta["tagged"] == 0


# ── score direction invariant ─────────────────────────────────────────────────

class TestScoreDirectionInvariant:
    """Score should be negative for above-baseline bull% and positive for below."""

    @pytest.mark.parametrize("n_bull,n_bear,expected_sign", [
        (19, 1, "negative"),   # 95% bull → well above 85% baseline → score < 0
        (4, 16, "positive"),   # 20% bull → far below 85% baseline → score > 0
    ])
    def test_score_sign(self, n_bull, n_bear, expected_sign):
        msgs = (
            [_msg(f"bull #{i}", "Bullish",
                  ts=f"2025-01-20T10:{i:02d}:00Z") for i in range(n_bull)]
            + [_msg(f"bear #{i}", "Bearish",
                    ts=f"2025-01-20T11:{i:02d}:00Z") for i in range(n_bear)]
        )
        lens = _make_lens(msgs)
        out = lens.analyze("XYZ")
        assert out is not None
        if expected_sign == "negative":
            assert out.score < 0, (
                f"n_bull={n_bull}/{n_bull+n_bear} → expected score < 0, got {out.score}"
            )
        else:
            assert out.score > 0, (
                f"n_bull={n_bull}/{n_bull+n_bear} → expected score > 0, got {out.score}"
            )
