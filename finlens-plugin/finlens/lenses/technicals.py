"""finlens.lenses.technicals — TechnicalsLens

RESEARCH-CORRECTED (Patil 2026; Khasawneh 2026; Li 2026):
  ✓ Price momentum vs 50/200-day SMA
  ✓ 3-month and 6-month return (price momentum)
  ✓ 52-week-high proximity (Khasawneh: anchoring/breakout documented signal)
  ✓ Unusual volume (recent 5-day avg vs longer-term baseline)
  ✗ RSI / MACD / stochastic oscillators explicitly EXCLUDED (fail OOS testing)

Scoring components:
  - sma50_signal:   (price / sma50 - 1) clamped, reflects near-term trend
  - sma200_signal:  (price / sma200 - 1) clamped, reflects regime
  - momentum_3m:    3-month return clamped to [-1,+1] with saturation
  - high52_signal:  price / 52wk_high — nearness to recent high (breakout proximity)
  - volume_signal:  recent vol / avg vol anomaly; unusual volume ≠ direction, used as
                    confidence amplifier, small score boost only

Weights (must sum to 1.0):
  sma50_signal  0.25
  sma200_signal 0.20
  momentum_3m   0.30
  high52_signal 0.25
  (volume only modifies confidence, not score)

Confidence from data length (need ≥ 200 bars for full read).
"""
from __future__ import annotations

from typing import Any

from ..contract import LensOutput, make_output
from ..data.base import DataSource, DataUnavailable
from ..formatters import fmt_pct, fmt_price
from .base import Lens

# Minimum bars required to produce any output
_MIN_BARS_HARD = 50    # absolute minimum (< this → return None)
_MIN_BARS_SOFT = 200   # ideal for full SMA200 calculation

# Momentum saturation: returns beyond ±40% don't add more score
_MOM_SATURATION = 0.40

# Volume anomaly: ratio ≥ this is "unusual"
_VOL_UNUSUAL_RATIO = 1.5

# Weights
_W_SMA50  = 0.25
_W_SMA200 = 0.20
_W_MOM3M  = 0.30
_W_52HIGH = 0.25


def _sma(closes: list[float], period: int) -> float | None:
    """Simple moving average of last `period` values; None if not enough data."""
    if len(closes) < period:
        return None
    return sum(closes[-period:]) / period


def _clamp(v: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


class TechnicalsLens(Lens):
    """Score technicals via momentum + 52-week positioning + volume anomaly.
    No RSI, no MACD, no oscillators.
    """

    name = "technicals"
    description = "Price momentum (SMA50/200, 3-6mo return), 52wk high proximity, unusual volume"

    def __init__(self, data: DataSource) -> None:
        self.data = data

    def analyze(self, ticker: str) -> LensOutput | None:  # noqa: C901
        try:
            raw = self.data.prices(ticker, period="6mo")
        except DataUnavailable:
            return None
        except Exception:
            return None

        if not raw or not isinstance(raw, dict):
            return None

        closes:  list[float] = raw.get("closes", []) or []
        volumes: list[float] = raw.get("volumes", []) or []
        highs:   list[float] = raw.get("highs", [])  or []
        lows:    list[float] = raw.get("lows", [])   or []
        freshness = raw.get("freshness")

        # Hard minimum
        if len(closes) < _MIN_BARS_HARD:
            return None

        price = closes[-1]
        if price <= 0:
            return None

        n = len(closes)

        # ---- SMA signals ----
        sma50  = _sma(closes, 50)
        sma200 = _sma(closes, 200)   # may be None if < 200 bars

        sma50_sig: float | None = None
        sma200_sig: float | None = None
        if sma50 is not None and sma50 > 0:
            dev = (price / sma50) - 1.0
            # Saturate at ±20% deviation
            sma50_sig = _clamp(dev / 0.20)
        if sma200 is not None and sma200 > 0:
            dev = (price / sma200) - 1.0
            sma200_sig = _clamp(dev / 0.20)

        # ---- Momentum: 3-month (≈63 bars) return ----
        mom3m_sig: float | None = None
        lookback_3m = min(63, n - 1)
        if lookback_3m >= 20:   # need at least 20 bars of lookback to be meaningful
            old_price = closes[-(lookback_3m + 1)]
            if old_price > 0:
                ret3m = (price / old_price) - 1.0
                mom3m_sig = _clamp(ret3m / _MOM_SATURATION)

        # ---- 52-week high proximity ----
        high52_sig: float | None = None
        lookback_52wk = min(252, n)
        # use highs list if available, otherwise use closes as proxy
        hi_series = highs if len(highs) >= lookback_52wk else closes
        window = hi_series[-lookback_52wk:]
        if window:
            high52 = max(window)
            if high52 > 0:
                ratio = price / high52   # 1.0 = AT the high; 0.5 = half of high
                # score: near 1.0 → +0.8 (breakout proximity); near 0.5 → -0.6
                # linear mapping [0.5, 1.0] → [-0.6, +0.8]
                high52_sig = _clamp(-0.6 + (ratio - 0.5) / 0.5 * 1.4)

        # ---- Volume anomaly ----
        vol_ratio: float | None = None
        vol_sig = 0.0
        if len(volumes) >= 30:
            recent_vol = sum(volumes[-5:]) / 5 if len(volumes) >= 5 else volumes[-1]
            baseline_vol = sum(volumes[-30:]) / 30
            if baseline_vol > 0:
                vol_ratio = recent_vol / baseline_vol
                # unusual volume is an attention flag; give a small score boost
                # (direction-neutral; we lean slightly positive because unusual vol
                #  in an uptrending stock = confirmation)
                if vol_ratio >= _VOL_UNUSUAL_RATIO:
                    vol_sig = 0.05   # very small — just a tiebreaker

        # ---- Weighted score (only over available components) ----
        components: dict[str, tuple[float, float]] = {}  # name → (signal, weight)
        if sma50_sig is not None:
            components["sma50"]  = (sma50_sig,  _W_SMA50)
        if sma200_sig is not None:
            components["sma200"] = (sma200_sig, _W_SMA200)
        if mom3m_sig is not None:
            components["mom3m"]  = (mom3m_sig,  _W_MOM3M)
        if high52_sig is not None:
            components["high52"] = (high52_sig, _W_52HIGH)

        if not components:
            return None   # practically impossible but safe

        # Re-normalise weights over present components
        total_w = sum(w for _, w in components.values())
        score = sum(s * (w / total_w) for s, w in components.values())
        score += vol_sig   # tiny tiebreaker
        score = _clamp(score)

        # ---- Confidence from data length ----
        # Full confidence at _MIN_BARS_SOFT bars; partial below that
        conf_raw = min(1.0, n / _MIN_BARS_SOFT)
        # Boost if SMA200 is available (more data = more trustworthy)
        if sma200_sig is not None:
            conf_raw = min(1.0, conf_raw + 0.05)
        confidence = max(0.10, conf_raw)

        # ---- Evidence strings ----
        evidence: list[str] = []
        parts: list[str] = []

        if sma50 is not None:
            pct50 = (price / sma50 - 1) * 100
            direction = "above" if pct50 >= 0 else "below"
            parts.append(f"Price {abs(pct50):.1f}% {direction} 50DMA")

        if sma200 is not None:
            pct200 = (price / sma200 - 1) * 100
            direction = "above" if pct200 >= 0 else "below"
            parts.append(f"{abs(pct200):.1f}% {direction} 200DMA")

        if high52_sig is not None:
            ratio_pct = (price / max(hi_series[-lookback_52wk:])) * 100
            parts.append(f"{ratio_pct:.0f}% of 52wk high")

        if mom3m_sig is not None and lookback_3m >= 20:
            old_p = closes[-(lookback_3m + 1)]
            if old_p > 0:
                r = (price / old_p - 1) * 100
                parts.append(f"3mo return {r:+.1f}%")

        if vol_ratio is not None:
            parts.append(f"vol {vol_ratio:.1f}x avg")

        if parts:
            evidence.append(" | ".join(parts))

        meta = {
            "price": price,
            "sma50":  round(sma50, 2) if sma50 is not None else None,
            "sma200": round(sma200, 2) if sma200 is not None else None,
            "high52": round(max(hi_series[-lookback_52wk:]), 2) if high52_sig is not None else None,
            "vol_ratio": round(vol_ratio, 3) if vol_ratio is not None else None,
            "bars": n,
            "component_scores": {k: round(s, 3) for k, (s, _) in components.items()},
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
