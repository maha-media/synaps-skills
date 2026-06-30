"""finlens.lenses.fundamentals — FundamentalsLens

Value/quality anchor.  Composite of four orthogonal dimensions:

  1. VALUATION  — cheaper vs rough thresholds → mild bullish
  2. GROWTH     — positive revenue + earnings growth → bullish
  3. MARGINS    — healthy op/net margins → quality indicator
  4. LEVERAGE   — high debt/equity → mild bearish drag

Research role: gets veto-weight in downstream synthesis because fundamental
value is the one factor with the longest documented edge (Fama/French, quality
premia), even if it is a slow signal with no short-term timing power.

Scoring is deliberately modest: fundamentals alone can't time an entry.
"""
from __future__ import annotations

from typing import Any

from ..contract import LensOutput, make_output
from ..data.base import DataSource, DataUnavailable
from ..formatters import fmt_ratio, fmt_pct
from .base import Lens

# ---------------------------------------------------------------------------
# Per-dimension scoring helpers
# ---------------------------------------------------------------------------

# Valuation: score contribution from a ratio; cheaper = more positive.
# Returns a value in [-1, +1].
# We use a simple piecewise linear scale against rough 'fair' and 'cheap' anchors.

_VALUATION_THRESHOLDS = {
    # (metric_key, cheap_threshold, fair_threshold, expensive_threshold)
    # score: +1 at cheap, 0 at fair, -1 at expensive
    "pe":  (10.0, 20.0, 40.0),
    "ps":  (1.0,  3.0,  8.0),
    "peg": (0.5,  1.5,  3.0),
    "pb":  (1.0,  3.0,  7.0),
}


def _val_score_one(val: float, cheap: float, fair: float, expensive: float) -> float:
    """Linear interpolation: cheap→+1, fair→0, expensive→-1."""
    if val <= cheap:
        return 1.0
    if val <= fair:
        # interpolate between +1 and 0
        return 1.0 - (val - cheap) / (fair - cheap)
    if val <= expensive:
        # interpolate between 0 and -1
        return -(val - fair) / (expensive - fair)
    return -1.0


def _valuation_score(f: dict) -> tuple[float, int, list[str]]:
    """Returns (score, n_present, evidence_parts)."""
    contributions: list[float] = []
    evidence: list[str] = []
    for key, (cheap, fair, exp) in _VALUATION_THRESHOLDS.items():
        v = f.get(key)
        if v is None:
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if v <= 0:
            # negative P/E etc. → don't score (uninformative for our purpose)
            continue
        s = _val_score_one(v, cheap, fair, exp)
        contributions.append(s)
        evidence.append(f"{key.upper()}={fmt_ratio(v)}")
    if not contributions:
        return 0.0, 0, []
    return sum(contributions) / len(contributions), len(contributions), evidence


def _growth_score(f: dict) -> tuple[float, int, list[str]]:
    """Positive revenue/earnings growth is bullish; negative is bearish."""
    scores: list[float] = []
    evidence: list[str] = []
    for key, label in (("revenue_growth", "RevGrowth"), ("earnings_growth", "EarnGrowth")):
        v = f.get(key)
        if v is None:
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        # v is a ratio: 0.15 = +15%.  Clamp to [-1, +1] with saturation at ±50%.
        s = max(-1.0, min(1.0, v / 0.5))
        scores.append(s)
        evidence.append(f"{label}={fmt_pct(v, signed=True)}")
    if not scores:
        return 0.0, 0, []
    return sum(scores) / len(scores), len(scores), evidence


def _margin_score(f: dict) -> tuple[float, int, list[str]]:
    """High op/net margin → quality / mild bullish.  Below-zero margins → bearish drag."""
    scores: list[float] = []
    evidence: list[str] = []
    # thresholds: (key, label, zero_level, good_level)
    for key, label, zero_lvl, good_lvl in (
        ("op_margin",  "OpMargin",  0.0,  0.20),
        ("net_margin", "NetMargin", 0.0,  0.15),
    ):
        v = f.get(key)
        if v is None:
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        # linear: 0→0, good_lvl→+0.8, <0 capped at -0.5
        if v >= good_lvl:
            s = min(0.8, v / good_lvl * 0.8)
        elif v >= zero_lvl:
            s = (v / good_lvl) * 0.8
        else:
            s = max(-0.5, v / 0.20)   # negative margin; small bearish drag
        scores.append(s)
        evidence.append(f"{label}={fmt_pct(v)}")
    if not scores:
        return 0.0, 0, []
    return sum(scores) / len(scores), len(scores), evidence


def _leverage_score(f: dict) -> tuple[float, int, list[str]]:
    """High D/E → mild bearish drag.  Low → slight positive."""
    v = f.get("debt_to_equity")
    if v is None:
        return 0.0, 0, []
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0.0, 0, []
    # D/E: 0→+0.2, 1→0, 2→-0.3, 5→-0.6 (capped)
    if v <= 0:
        s = 0.2
    elif v <= 1.0:
        s = 0.2 - v * 0.2          # +0.2 → 0 as D/E goes 0→1
    elif v <= 3.0:
        s = -(v - 1.0) * 0.15       # 0 → -0.30 as D/E goes 1→3
    else:
        s = max(-0.60, -0.30 - (v - 3.0) * 0.05)
    return s, 1, [f"D/E={fmt_ratio(v)}"]


# Dimension weights (must sum to 1.0)
_DIM_WEIGHTS = {
    "valuation": 0.35,
    "growth":    0.35,
    "margins":   0.20,
    "leverage":  0.10,
}


class FundamentalsLens(Lens):
    """Composite fundamental score across valuation, growth, margins, leverage.

    Confidence scales with how many key fields were present.
    Returns None if no key fields at all.
    """

    name = "fundamentals"
    description = "Composite value/quality: valuation ratios, growth, margins, leverage"

    def __init__(self, data: DataSource) -> None:
        self.data = data

    def analyze(self, ticker: str) -> LensOutput | None:  # noqa: C901
        try:
            f = self.data.fundamentals(ticker)
        except DataUnavailable:
            return None
        except Exception:
            return None

        if not f or not isinstance(f, dict):
            return None

        freshness = f.get("freshness")

        # Compute all four dimensions
        val_s, val_n, val_ev = _valuation_score(f)
        grw_s, grw_n, grw_ev = _growth_score(f)
        mar_s, mar_n, mar_ev = _margin_score(f)
        lev_s, lev_n, lev_ev = _leverage_score(f)

        total_fields = val_n + grw_n + mar_n + lev_n
        if total_fields == 0:
            return None  # nothing to work with

        # Weighted blend — only include dimensions we actually have data for
        # (re-normalise weights over present dimensions so missing dims don't pull to zero)
        dim_map = {
            "valuation": (val_s, val_n, _DIM_WEIGHTS["valuation"]),
            "growth":    (grw_s, grw_n, _DIM_WEIGHTS["growth"]),
            "margins":   (mar_s, mar_n, _DIM_WEIGHTS["margins"]),
            "leverage":  (lev_s, lev_n, _DIM_WEIGHTS["leverage"]),
        }

        present_weight_sum = sum(w for _, n, w in dim_map.values() if n > 0)
        score = 0.0
        for _, (s, n, w) in dim_map.items():
            if n > 0:
                score += s * (w / present_weight_sum)

        # Clamp
        score = max(-1.0, min(1.0, score))

        # Confidence: how many of the 8 'core' fields were present
        # core = pe, ps, revenue_growth, earnings_growth, op_margin, net_margin, debt_to_equity, peg
        CORE_FIELDS = ("pe", "ps", "revenue_growth", "earnings_growth",
                       "op_margin", "net_margin", "debt_to_equity", "peg")
        present_core = sum(1 for k in CORE_FIELDS if f.get(k) is not None)
        confidence = min(1.0, present_core / len(CORE_FIELDS))
        # Minimum confidence floor when we have at least something
        confidence = max(0.10, confidence)

        # Evidence
        evidence: list[str] = []
        all_ev = val_ev + grw_ev + mar_ev + lev_ev
        if all_ev:
            evidence.append("Fundamentals: " + " | ".join(all_ev))

        meta = {
            "valuation_score": round(val_s, 3),
            "growth_score":    round(grw_s, 3),
            "margin_score":    round(mar_s, 3),
            "leverage_score":  round(lev_s, 3),
            "fields_present":  total_fields,
            "core_fields_present": present_core,
        }

        return make_output(
            lens=self.name,
            ticker=ticker,
            score=score,
            confidence=confidence,
            evidence=evidence,
            data_freshness=freshness,
            meta=meta,
        )
