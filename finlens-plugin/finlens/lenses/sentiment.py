"""finlens.lenses.sentiment — StockTwits contrarian risk-flag lens.

Research basis (RESEARCH-FINDINGS.md):
  Semenova & Winkler 2025; Gu/Hirshleifer/Teoh/Wu 2025 (NBER GIFfluence);
  Jin & Tian 2026; Hirshleifer et al. 2026; Theodorakopoulos 2026.

Key findings applied:
  1. StockTwits is ~85% bullish by structural baseline — absolute bull% is noise.
  2. Aggregate optimism NEGATIVELY predicts 2–4wk returns → CONTRARIAN polarity.
     Extreme bullishness = mild bearish risk-flag; extreme (rare) bearishness =
     mild bullish signal.
  3. Magnitude is intentionally small, confidence capped at 0.35 — this is a
     weak, noisy, gameable signal whose value is in flagging EXTREMES only.
  4. DISPERSION (bull/bear disagreement) and VOLUME SPIKE are surfaced as
     sub-signals in evidence and meta, not as strong directional votes.
  5. Spam filtering (cashtag-list posts) is mandatory — mirrors v2 reference.

Score formula:
  bull_pct = bull / (bull + bear) * 100   [only among sentiment-tagged posts]

  The platform's structural bias sits ~85% bull.  We measure EDGE from that
  baseline and flip sign for the contrarian direction:

      raw_edge  = (bull_pct - BULL_BASELINE) / 50     ∈ [-∞, +∞] but clamped
      score     = -K * raw_edge                        (negated = contrarian)
      clamped   = clip(score, -MAX_SCORE, +MAX_SCORE)

  K = 0.25 (scaling factor): at +30pp above baseline the score ≈ -0.15
  MAX_SCORE = 0.20 (hard cap; keeps magnitude "small" as doctrine requires)
  Confidence grows with tagged-post count, hard-capped at 0.35.
  Returns None when there are zero usable (non-spam) posts.
"""
from __future__ import annotations

import re
import datetime
from typing import Callable

from ..contract import make_output, LensOutput
from ..lenses.base import Lens
from .. import data as _data_pkg   # lazy; only used when resolving default import

# ── tuning constants (research-calibrated) ───────────────────────────────────
# Platform structural bull-bias anchor (from v2 reference observation + literature)
_BULL_BASELINE = 85.0          # percent

# Contrarian scaling: edge/50 * K, negated.
# At 30pp above baseline → raw_edge=0.60 → score=-0.15 (intentionally muted).
_K = 0.25

# Hard caps on score magnitude and confidence — doctrine says keep both small.
_MAX_SCORE = 0.20
_MAX_CONF = 0.35

# Minimum tagged posts to emit any score at all (below this → neutral + low conf)
_MIN_TAGGED_FOR_SCORE = 4

# Spam detection — mirrors _stocktwits_v2_reference.py exactly.
_CASHTAG = re.compile(r"\$[A-Za-z][A-Za-z.\-]{0,6}")


# ── helpers ───────────────────────────────────────────────────────────────────

def _is_spam(body: str) -> bool:
    """True if the post looks like a cashtag-list dump (≥3 cashtags, <4 real words).

    Identical logic to v2 reference is_spam().
    """
    tags = _CASHTAG.findall(body)
    words = [w for w in re.split(r"\s+", _CASHTAG.sub("", body).strip()) if len(w) > 2]
    return len(tags) >= 3 and len(words) < 4


def _confidence_from_tagged(n: int) -> float:
    """Map tagged-post count to a confidence score, hard-capped at MAX_CONF.

    Mirrors the v2 reference confidence() tiers but capped lower per doctrine.
      n ≥ 20 → 0.35 (cap)
      n ≥ 10 → 0.25
      n ≥  4 → 0.15
      n <  4 → 0.07  (thin — barely above zero)
    """
    if n >= 20:
        return _MAX_CONF          # 0.35
    if n >= 10:
        return 0.25
    if n >= 4:
        return 0.15
    return 0.07


def _dispersion(bull: int, bear: int) -> float:
    """Bull/bear dispersion: 0 = pure consensus, 1 = perfect split (50/50)."""
    tagged = bull + bear
    if tagged == 0:
        return 0.0
    bull_frac = bull / tagged
    # entropy-style: 1 - |2p-1|  → 0 at extremes, 1 at 50/50
    return 1.0 - abs(2 * bull_frac - 1)


def _parse_ts(s: str) -> datetime.datetime | None:
    """Parse StockTwits ISO timestamp string, return UTC-aware datetime or None."""
    try:
        return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=datetime.timezone.utc
        )
    except Exception:  # noqa: BLE001
        return None


# ── lens ─────────────────────────────────────────────────────────────────────

class SentimentLens(Lens):
    """StockTwits contrarian risk-flag.

    Aggregate crowd optimism on StockTwits negatively predicts 2–4wk returns
    (Semenova & Winkler 2025; Jin & Tian 2026).  Extreme bullishness = a mild
    bearish risk-flag.  Confidence is capped at 0.35 — this is a weak signal
    whose value lives in DIVERGENCE from other lenses, not in isolation.

    Constructor args:
      fetch_stream: callable(ticker: str) -> list[dict]
        Override for testing. Defaults to stocktwits.fetch_symbol_stream.
    """

    name: str = "sentiment"
    description: str = (
        "StockTwits contrarian risk-flag: crowd euphoria → mild bearish caution; "
        "rare platform-level bearishness → mild bullish. "
        "Confidence ≤0.35; value lies in divergence, not isolation."
    )

    def __init__(self, fetch_stream: Callable[[str], list[dict]] | None = None) -> None:
        if fetch_stream is not None:
            self._fetch = fetch_stream
        else:
            # Lazy import to avoid pulling in urllib at import time in tests.
            from ..data import stocktwits as _st
            self._fetch = _st.fetch_symbol_stream

    # ── core analysis ─────────────────────────────────────────────────────────

    def analyze(self, ticker: str) -> LensOutput | None:  # noqa: C901  (modest complexity)
        """Fetch StockTwits stream, apply spam filter, compute contrarian score.

        Returns None when there are zero usable posts (no data read possible).
        Never raises on data gaps — callers expect graceful None.
        """
        ticker = str(ticker).upper().strip()

        try:
            messages: list[dict] = self._fetch(ticker)
        except Exception:  # noqa: BLE001
            # Network errors are a data gap, not a lens crash.
            return None

        if not messages:
            return None

        # ── pass 1: spam filter + count sentiment tags ─────────────────────
        bull = 0
        bear = 0
        spam_filtered = 0
        usable_count = 0
        timestamps: list[datetime.datetime] = []

        for msg in messages:
            body: str = msg.get("body", "")

            if _is_spam(body):
                spam_filtered += 1
                continue

            usable_count += 1

            # Collect timestamps for a volume-spike hint
            ts_raw = msg.get("created_at", "")
            if ts_raw:
                ts = _parse_ts(ts_raw)
                if ts:
                    timestamps.append(ts)

            # Sentiment tag from StockTwits UI checkbox
            entities = msg.get("entities") or {}
            sentiment_block = entities.get("sentiment") or {}
            basic = sentiment_block.get("basic")
            if basic == "Bullish":
                bull += 1
            elif basic == "Bearish":
                bear += 1

        # ── guard: no usable posts at all ────────────────────────────────────
        if usable_count == 0:
            return None

        # ── velocity sub-signal (msgs/hour across the stream's time window) ──
        velocity: float | None = None
        if len(timestamps) >= 2:
            span_s = (max(timestamps) - min(timestamps)).total_seconds()
            if span_s > 180:  # at least 3 minutes of span to avoid division artifacts
                velocity = round(len(timestamps) / (span_s / 3600), 1)

        # ── freshness: most-recent post timestamp ────────────────────────────
        data_freshness: str | None = None
        if timestamps:
            data_freshness = max(timestamps).strftime("%Y-%m-%dT%H:%M:%SZ")

        # ── tagged stats ─────────────────────────────────────────────────────
        tagged = bull + bear

        # ── compute contrarian score ──────────────────────────────────────────
        #
        # We need enough tagged posts to say anything directional.
        # Below threshold → return neutral + very low confidence (not None —
        # we DID read data; we just can't determine direction).
        if tagged < _MIN_TAGGED_FOR_SCORE:
            # Not zero data, but too thin to score direction.
            confidence = _confidence_from_tagged(tagged)
            evidence = [
                f"Only {tagged} sentiment-tagged post(s) after spam filter "
                f"({usable_count} usable, {spam_filtered} spam removed) — "
                "too thin for a directional read.",
                "StockTwits is ~85% bull by baseline; small samples are dominated by that bias.",
            ]
            meta = {
                "bull": bull,
                "bear": bear,
                "tagged": tagged,
                "bull_pct": None,
                "dispersion": 0.0,
                "spam_filtered": spam_filtered,
                "sample_size": usable_count,
                "velocity_msgs_per_hr": velocity,
                "baseline_pct": _BULL_BASELINE,
                "edge_vs_baseline": None,
            }
            return make_output(
                lens=self.name,
                ticker=ticker,
                score=0.0,
                confidence=confidence,
                evidence=evidence,
                data_freshness=data_freshness,
                meta=meta,
            )

        # ── sufficient tagged posts: compute full contrarian score ────────────
        bull_pct = 100.0 * bull / tagged

        # Edge vs platform baseline (positive = more bullish than usual)
        edge = bull_pct - _BULL_BASELINE

        # Contrarian score: positive edge (extra bullishness) → negative score.
        # raw_edge normalised by 50pp so a ±50pp swing maps to ±1 before K.
        raw_score = -_K * (edge / 50.0)
        score = max(-_MAX_SCORE, min(_MAX_SCORE, raw_score))

        # Confidence grows with sample size, hard ceiling at 0.35.
        confidence = _confidence_from_tagged(tagged)

        # ── dispersion sub-signal ─────────────────────────────────────────────
        disp = _dispersion(bull, bear)
        disp_pct = round(disp * 100, 1)

        # ── human-readable evidence bullets ───────────────────────────────────
        evidence: list[str] = []

        # Primary contrarian framing
        if bull_pct >= 90:
            evidence.append(
                f"Crowd {bull_pct:.0f}% bullish on a structurally bull-biased platform "
                f"({edge:+.0f}pp above ~{_BULL_BASELINE:.0f}% baseline) "
                "→ contrarian caution flag."
            )
        elif bull_pct >= 75:
            evidence.append(
                f"Crowd {bull_pct:.0f}% bullish "
                f"({edge:+.0f}pp vs ~{_BULL_BASELINE:.0f}% baseline) "
                "— near baseline noise, muted contrarian read."
            )
        elif bull_pct <= 50:
            evidence.append(
                f"Crowd only {bull_pct:.0f}% bullish — rare for this platform "
                f"({edge:+.0f}pp below ~{_BULL_BASELINE:.0f}% baseline) "
                "→ mild contrarian bullish note."
            )
        else:
            evidence.append(
                f"Crowd {bull_pct:.0f}% bullish "
                f"({edge:+.0f}pp vs ~{_BULL_BASELINE:.0f}% baseline) "
                "— within baseline noise band."
            )

        # Sample quality note
        evidence.append(
            f"{bull}🐂 / {bear}🐻 sentiment-tagged posts "
            f"({tagged} total tagged, {spam_filtered} spam removed, "
            f"{usable_count} usable messages)."
        )

        # Dispersion sub-signal
        if disp >= 0.60:
            evidence.append(
                f"High dispersion ({disp_pct}%) — crowd disagrees; "
                "uncertainty is elevated (Jin & Tian 2026)."
            )
        elif disp <= 0.20:
            evidence.append(
                f"Low dispersion ({disp_pct}%) — crowd consensus; "
                "herding may amplify reversal risk."
            )
        else:
            evidence.append(f"Moderate dispersion ({disp_pct}%).")

        # Velocity sub-signal
        if velocity is not None:
            evidence.append(
                f"Stream velocity: {velocity} msgs/hr "
                "(spike may indicate event-driven attention surge; "
                "volume spikes precede volatility — Semenova & Winkler 2025)."
            )

        # Confidence caveats
        evidence.append(
            f"Confidence capped at {_MAX_CONF:.2f} — StockTwits sentiment is a weak, "
            "noisy, gameable signal; interpret as a risk-flag, not a directional vote."
        )

        # ── meta dict for synthesis layer ─────────────────────────────────────
        meta: dict = {
            "bull": bull,
            "bear": bear,
            "tagged": tagged,
            "bull_pct": round(bull_pct, 1),
            "dispersion": round(disp, 3),
            "dispersion_pct": disp_pct,
            "spam_filtered": spam_filtered,
            "sample_size": usable_count,
            "velocity_msgs_per_hr": velocity,
            "baseline_pct": _BULL_BASELINE,
            "edge_vs_baseline": round(edge, 1),
        }

        return make_output(
            lens=self.name,
            ticker=ticker,
            score=score,
            confidence=confidence,
            evidence=evidence,
            data_freshness=data_freshness,
            meta=meta,
        )
