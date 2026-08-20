"""finlens.lenses.news — NewsLens: lightweight headline convergence-checker.

Research basis (RESEARCH-FINDINGS.md):
  Wu/Zhang/Li 2026; Lehner & Lopez-Lira 2026; Dixit & Tiwary 2026 (72-study);
  Yao & Zheng 2026 (reproducibility audit).

Research rules baked in:
  1. News predicts VOLATILITY better than direction (16.9% vs 5.8% error reduction).
     Role = convergence-checker + vol-informative flag, NOT a direction predictor.
  2. Horizon: 1–4 weeks. Intraday and same-day reads are largely arbitraged on
     mega-caps; we operate at ≥3-day labels.
  3. Score kept SMALL (hard cap ±0.35), confidence MODEST (cap 0.40).
     A single headline can't justify a confident directional call.
  4. Elevated headline VOLUME is flagged in evidence — it signals a potential
     volatility regime shift regardless of direction.
  5. Returns None when there are no headlines (no data = no read).

Sentiment method:
  Keyword matching on lowercased headline text.  Intentionally simple:
  the literature shows raw sentiment degrades fast; we want a very weak
  directional nudge, not a sophisticated NLP score.  The real value of
  this lens to synthesis is the headline-count / recency context.

  positive_words: beat, beats, surge, surges, surged, upgrade, upgraded,
                  record, profit, profits, breakthrough, outperform, raises,
                  raised, growth, grew, strong, strength, boost, boosted
  negative_words: miss, misses, missed, probe, probed, lawsuit, lawsuits,
                  cut, cuts, cutting, fall, falls, fell, decline, declines,
                  declined, downgrade, downgraded, warning, loss, losses,
                  layoff, layoffs, recall, investigation, fraud, fine, fined

  per-headline score: (pos_hits - neg_hits) / (pos_hits + neg_hits + 1)
    → normalised to [-1, +1] for each headline
  aggregate score: mean of per-headline scores, then scaled by 0.35 and clamped.

Confidence:
  Base confidence = min(0.40, 0.08 * sqrt(n_headlines)).
  Slightly boosted if the freshest headline is within 3 days.
"""
from __future__ import annotations

import math
import datetime as _dt
from typing import Any

from ..contract import LensOutput, make_output
from ..data.base import DataSource, DataUnavailable
from .base import Lens

# ── tuning constants ──────────────────────────────────────────────────────────
_MAX_SCORE = 0.35          # hard cap — this is a weak supporting lens
_MAX_CONF  = 0.40          # hard cap on confidence
_RECENCY_BOOST = 0.06      # bonus confidence if freshest headline ≤ 3 days old
_HIGH_VOLUME_THRESHOLD = 10  # ≥10 headlines → flag elevated volume in evidence

# ── keyword lists ─────────────────────────────────────────────────────────────
_POSITIVE_WORDS = frozenset({
    "beat", "beats", "surge", "surges", "surged", "upgrade", "upgraded",
    "record", "profit", "profits", "breakthrough", "outperform", "outperforms",
    "raises", "raised", "growth", "grew", "strong", "strength", "boost",
    "boosted", "bullish", "exceed", "exceeds", "exceeded", "top", "tops",
    "rally", "rallied", "win", "wins", "won", "approval", "approves", "approved",
})

_NEGATIVE_WORDS = frozenset({
    "miss", "misses", "missed", "probe", "probed", "lawsuit", "lawsuits",
    "cut", "cuts", "cutting", "fall", "falls", "fell", "decline", "declines",
    "declined", "downgrade", "downgraded", "warning", "loss", "losses",
    "layoff", "layoffs", "recall", "investigation", "fraud", "fine", "fined",
    "drop", "drops", "dropped", "short", "weak", "weakness", "disappoint",
    "disappoints", "disappointed", "disappointing", "default", "defaults",
    "penalty", "penalties", "charge", "charges", "charged",
})


# ── helpers ───────────────────────────────────────────────────────────────────

def _score_headline(title: str) -> float:
    """Score one headline title: positive float = positive tone, negative = negative.
    Range: [-1, +1] (strictly — returns from a ratio formula).
    """
    tokens = set(title.lower().split())
    pos = len(tokens & _POSITIVE_WORDS)
    neg = len(tokens & _NEGATIVE_WORDS)
    # per-headline normalised score: difference over total_hits+1 (avoids div/0)
    return (pos - neg) / (pos + neg + 1)


def _parse_date(date_str: str | None) -> _dt.date | None:
    """Try common ISO date formats; return a date or None."""
    if not date_str:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return _dt.datetime.strptime(date_str[:19], fmt[:len(date_str[:19])]).date()
        except ValueError:
            continue
    # Last resort: try just the first 10 chars
    try:
        return _dt.date.fromisoformat(date_str[:10])
    except ValueError:
        return None


# ── lens ──────────────────────────────────────────────────────────────────────

class NewsLens(Lens):
    """Lightweight headline convergence-checker + volatility-flag.

    Scores a ticker's recent headlines using a small keyword sentiment list,
    emitting a deliberately SMALL directional score (cap ±0.35) and MODEST
    confidence (cap 0.40).  The main value to the synthesis layer is:
      - headline COUNT (elevated volume → volatility-regime flag)
      - recency (freshness)
      - weak directional nudge that can confirm or contradict other lenses

    Returns None when data.news() is unavailable or returns zero headlines.
    """

    name = "news"
    description = (
        "Keyword headline sentiment (convergence-checker, vol-informative). "
        "Predicts volatility > direction; 1–4wk horizon. Score ≤|0.35|, conf ≤0.40."
    )

    def __init__(self, data: DataSource) -> None:
        self.data = data

    def analyze(self, ticker: str) -> LensOutput | None:  # noqa: C901
        ticker = str(ticker).upper().strip()

        try:
            raw = self.data.news(ticker, limit=20)
        except DataUnavailable:
            return None
        except Exception:
            return None

        if not raw or not isinstance(raw, dict):
            return None

        items: list[dict[str, Any]] = raw.get("items", []) or []
        freshness: str | None = raw.get("freshness")

        if not items:
            return None

        n = len(items)
        today = _dt.date.today()

        # ── score each headline ───────────────────────────────────────────────
        headline_scores: list[float] = []
        dates: list[_dt.date] = []

        for item in items:
            title: str = str(item.get("title", ""))
            if title:
                headline_scores.append(_score_headline(title))
            d = _parse_date(item.get("date"))
            if d:
                dates.append(d)

        if not headline_scores:
            return None

        # ── aggregate score ───────────────────────────────────────────────────
        mean_hl_score = sum(headline_scores) / len(headline_scores)
        # Scale to [-MAX_SCORE, +MAX_SCORE]
        raw_score = mean_hl_score * _MAX_SCORE / max(abs(mean_hl_score), 1.0) \
                    if abs(mean_hl_score) > 1e-9 else 0.0
        # mean_hl_score is already in ~[-1,+1], just clamp and scale
        raw_score = mean_hl_score * _MAX_SCORE
        score = max(-_MAX_SCORE, min(_MAX_SCORE, raw_score))

        # ── confidence ────────────────────────────────────────────────────────
        base_conf = min(_MAX_CONF, 0.08 * math.sqrt(n))
        # Recency boost: freshest headline within 3 days
        most_recent = max(dates) if dates else None
        recency_boost = 0.0
        if most_recent is not None:
            days_old = (today - most_recent).days
            if days_old <= 3:
                recency_boost = _RECENCY_BOOST
        confidence = min(_MAX_CONF, base_conf + recency_boost)

        # ── data_freshness ────────────────────────────────────────────────────
        data_freshness = freshness
        if not data_freshness and most_recent:
            data_freshness = most_recent.isoformat()

        # ── evidence strings ──────────────────────────────────────────────────
        evidence: list[str] = []

        # Headline count / recency
        if most_recent:
            days_old_str = f"{(today - most_recent).days}d ago"
            evidence.append(
                f"{n} headline(s) retrieved; most recent: {most_recent} ({days_old_str})."
            )
        else:
            evidence.append(f"{n} headline(s) retrieved.")

        # Elevated volume flag (volatility-informative)
        if n >= _HIGH_VOLUME_THRESHOLD:
            evidence.append(
                f"Elevated news volume ({n} headlines) → potential volatility-regime signal. "
                "High news flow predicts vol expansion more reliably than direction "
                "(Dixit & Tiwary 2026: 16.9% vol reduction vs 5.8% return)."
            )

        # Directional tone
        positive_count = sum(1 for s in headline_scores if s > 0)
        negative_count = sum(1 for s in headline_scores if s < 0)
        neutral_count  = len(headline_scores) - positive_count - negative_count

        if abs(score) < 0.02:
            evidence.append(
                f"Mixed/neutral tone across {n} headline(s) "
                f"({positive_count} positive, {negative_count} negative, {neutral_count} neutral keywords)."
            )
        elif score > 0:
            evidence.append(
                f"Mild positive tone: {positive_count}/{n} headlines match positive keywords "
                f"(beat/surge/upgrade/record etc.) — weak directional note only."
            )
        else:
            evidence.append(
                f"Mild negative tone: {negative_count}/{n} headlines match negative keywords "
                f"(miss/probe/lawsuit/cut etc.) — weak directional note only."
            )

        # Honesty cap caveat
        evidence.append(
            f"Score capped at ±{_MAX_SCORE}, confidence at {_MAX_CONF} — "
            "news sentiment predicts volatility > direction; treat as convergence-check only."
        )

        # ── meta ──────────────────────────────────────────────────────────────
        meta: dict = {
            "headline_count": n,
            "most_recent_date": most_recent.isoformat() if most_recent else None,
            "days_since_most_recent": (today - most_recent).days if most_recent else None,
            "positive_headlines": positive_count,
            "negative_headlines": negative_count,
            "neutral_headlines": neutral_count,
            "mean_headline_score": round(mean_hl_score, 4),
            "elevated_volume": n >= _HIGH_VOLUME_THRESHOLD,
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
