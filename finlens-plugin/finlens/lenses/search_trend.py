"""finlens.lenses.search_trend — SearchTrendLens: Google Trends attention/vol flag.

Research basis (RESEARCH-FINDINGS.md):
  Wang & Xiang 2026 (18 markets); Chowdhury & Urquhart 2026 (attention → bubbles/vol);
  Hattapoğlu 2026.  Da/Engelberg/Gao 2011 (canonical); Preis/Moat/Stanley 2013.

Research rules baked in:
  1. Google Trends predicts VOLUME + VOLATILITY robustly.
     Directional returns prediction: WEAK and contested.
  2. This lens emits a near-ZERO directional score on purpose.
     Its job is to encode the ATTENTION LEVEL in meta + evidence so the
     synthesis layer can (a) widen confidence bands, (b) treat high-attention
     periods as elevated-volatility regimes, (c) shrink position sizes.
  3. Confidence is LOW (cap 0.25) because attention ≠ direction.
  4. pytrends is an OPTIONAL dependency: if unavailable or any request fails,
     analyze() returns None gracefully — never crashes.
  5. The lens must still IMPORT cleanly even without pytrends installed.

Attention scoring:
  We fetch 3-month weekly interest-over-time for the ticker symbol.
  Google Trends returns values 0–100 (relative interest, not absolute).

  attention_level: mean of last 4 weeks of values (0–100 scale)
  spike_flag: True if any week in the last 4 is ≥ 1.5× the 12-week mean
              AND the absolute value ≥ 40
  trend_slope: sign of linear trend over 12 weeks (+1 rising, -1 falling, 0 flat)

  Direction score: intentionally near-zero.
    score = 0.0 + tiny_nudge  where tiny_nudge ∈ [-0.05, +0.05]
    (a rising trend nudges very slightly positive; falling slightly negative)
    This keeps the contract coherent (signal/score agree) while signalling
    to synthesis that direction is NOT the message here.

  Confidence:
    0.10 base; +0.05 if spike_flag; +0.05 if data covers ≥8 weeks.
    Hard cap 0.25.  Stays low because we deliberately do not directionally vote.

pytrends wrapper:
  - Wrapped entirely in try/except.
  - A single TrendReq with a generous timeout; catches all network/parse errors.
  - Returns None (not raises) on any failure.
"""
from __future__ import annotations

from ..contract import LensOutput, make_output
from ..data.base import DataSource
from .base import Lens

# ── constants ─────────────────────────────────────────────────────────────────
_MAX_SCORE         = 0.05    # direction is NOT this lens's job; score ~zero
_MAX_CONF          = 0.25    # attention ≠ direction; keep confidence low
_SPIKE_MULTIPLIER  = 1.5     # a week at ≥1.5× the rolling mean = "spike"
_SPIKE_ABS_MIN     = 40      # and must be ≥ 40/100 in absolute terms
_RECENT_WEEKS      = 4       # window for "recent" attention level
_MIN_WEEKS_FOR_TREND = 4     # need at least this many data points


# ── pytrends optional import ──────────────────────────────────────────────────
# Module-level: set _PYTRENDS_OK flag so we can gate at analyze() time.

_PYTRENDS_OK = False
try:
    from pytrends.request import TrendReq as _TrendReq  # type: ignore[import-not-found]
    _PYTRENDS_OK = True
except Exception:  # noqa: BLE001 — optional dep absent or broken install
    _TrendReq = None  # type: ignore[assignment,misc]


# ── helper: fetch via pytrends ────────────────────────────────────────────────

def _fetch_trends(ticker: str) -> list[int] | None:
    """Fetch 3-month weekly interest-over-time for `ticker`.

    Returns a list of weekly interest values (0–100), oldest first,
    or None on any failure (network, rate-limit, parse error, etc.).
    """
    if not _PYTRENDS_OK or _TrendReq is None:
        return None
    try:
        pytrends = _TrendReq(hl="en-US", tz=0, timeout=(10, 25))
        pytrends.build_payload([ticker], cat=0, timeframe="today 3-m", geo="", gprop="")
        df = pytrends.interest_over_time()
        if df is None or df.empty:
            return None
        if ticker not in df.columns:
            return None
        series = df[ticker].tolist()
        # Filter out non-numeric
        values = []
        for v in series:
            try:
                values.append(int(v))
            except (TypeError, ValueError):
                pass
        return values if values else None
    except Exception:  # noqa: BLE001 — any network/parse failure → graceful None
        return None


# ── helpers: attention metrics ────────────────────────────────────────────────

def _attention_level(values: list[int], n: int = _RECENT_WEEKS) -> float:
    """Mean of the last `n` weekly values."""
    tail = values[-n:] if len(values) >= n else values
    return sum(tail) / len(tail) if tail else 0.0


def _spike_flag(values: list[int], n_recent: int = _RECENT_WEEKS) -> bool:
    """True if any recent week is a spike vs the longer rolling mean."""
    if len(values) < 2:
        return False
    rolling_mean = sum(values) / len(values)
    if rolling_mean < 1:
        return False
    recent = values[-n_recent:] if len(values) >= n_recent else values
    return any(
        v >= _SPIKE_MULTIPLIER * rolling_mean and v >= _SPIKE_ABS_MIN
        for v in recent
    )


def _trend_slope(values: list[int]) -> int:
    """Crude sign of trend: +1 rising, -1 falling, 0 flat.

    Compares the mean of the first-half vs second-half of the series.
    """
    n = len(values)
    if n < _MIN_WEEKS_FOR_TREND:
        return 0
    mid = n // 2
    first_half = sum(values[:mid]) / mid
    second_half = sum(values[mid:]) / (n - mid)
    delta = second_half - first_half
    if delta > 5:    # >5 point increase over the period
        return 1
    if delta < -5:   # >5 point decrease
        return -1
    return 0


def _label_attention(level: float) -> str:
    """Human-readable attention tier."""
    if level >= 75:
        return "very high"
    if level >= 50:
        return "elevated"
    if level >= 25:
        return "moderate"
    return "low"


# ── lens ──────────────────────────────────────────────────────────────────────

class SearchTrendLens(Lens):
    """Google Trends attention/volatility regime flag.

    Does NOT attempt directional prediction — the literature is clear that
    search interest predicts volume/volatility robustly but direction weakly.

    Score ≈ 0.0 ± 0.05 (intentionally tiny).  The real output is:
      meta["attention_level"]  — 0–100 mean recent weekly interest
      meta["attention_tier"]   — "low" / "moderate" / "elevated" / "very high"
      meta["spike_flag"]       — True if a recent week is a clear spike
      meta["trend_slope"]      — +1 rising / -1 falling / 0 flat

    The synthesis layer reads these to widen confidence bands and flag
    elevated-volatility regimes — it should NOT use this lens's score
    as a directional vote.

    Constructor args:
      fetch_fn: optional override for the pytrends fetcher.
                Signature: (ticker: str) -> list[int] | None
                Used in tests to inject fake data without network.
    """

    name = "search_trend"
    description = (
        "Google Trends attention/vol regime flag. Score ≈ 0; real output is "
        "attention level + spike flag in meta (widen vol bands in synthesis). "
        "pytrends optional — returns None gracefully if unavailable."
    )

    def __init__(self, fetch_fn=None) -> None:
        # Allow test injection; fall back to the real pytrends fetcher.
        self._fetch = fetch_fn if fetch_fn is not None else _fetch_trends

    def analyze(self, ticker: str) -> LensOutput | None:
        ticker = str(ticker).upper().strip()

        # Fetch weekly interest values
        try:
            values = self._fetch(ticker)
        except Exception:  # noqa: BLE001 — optional dep
            return None

        if not values:
            return None

        n_weeks = len(values)

        # ── compute attention metrics ─────────────────────────────────────────
        level    = _attention_level(values)
        spike    = _spike_flag(values)
        slope    = _trend_slope(values)
        tier     = _label_attention(level)
        rolling_mean = sum(values) / n_weeks if n_weeks else 0.0

        # ── directional score: intentionally near-zero ────────────────────────
        # A rising trend nudges +0.03; falling nudges -0.03; flat = 0.0
        score = slope * 0.03
        score = max(-_MAX_SCORE, min(_MAX_SCORE, score))

        # ── confidence ────────────────────────────────────────────────────────
        conf = 0.10
        if spike:
            conf += 0.05    # spike is more actionable (vol-informative)
        if n_weeks >= 8:
            conf += 0.05    # more data points = slightly better read
        confidence = min(_MAX_CONF, conf)

        # ── evidence ──────────────────────────────────────────────────────────
        evidence: list[str] = []

        evidence.append(
            f"Google Trends: {n_weeks} weeks of data; "
            f"recent attention {tier} ({level:.0f}/100, "
            f"rolling mean {rolling_mean:.1f}/100)."
        )

        if spike:
            evidence.append(
                f"Search interest SPIKING in recent weeks — "
                "spikes precede elevated volatility regimes (Wang & Xiang 2026; "
                "Chowdhury & Urquhart 2026). Synthesis layer: widen confidence bands."
            )
        else:
            evidence.append(
                f"No spike detected; attention is {tier} — "
                "consistent with a normal volatility regime."
            )

        if slope == 1:
            evidence.append(
                "Rising trend in search interest over the 3-month window — "
                "growing public awareness; does NOT predict direction (Wang & Xiang 2026)."
            )
        elif slope == -1:
            evidence.append(
                "Falling trend in search interest — waning public attention; "
                "direction-neutral but may indicate decreasing liquidity risk."
            )

        evidence.append(
            f"Score intentionally near-zero ({score:+.2f}): this lens is an "
            "attention/vol flag, not a directional vote. "
            f"Confidence capped at {_MAX_CONF} (attention ≠ direction)."
        )

        # ── meta ──────────────────────────────────────────────────────────────
        meta: dict = {
            "n_weeks": n_weeks,
            "attention_level": round(level, 1),
            "attention_tier": tier,
            "rolling_mean": round(rolling_mean, 1),
            "spike_flag": spike,
            "trend_slope": slope,
            "pytrends_available": _PYTRENDS_OK,
        }

        return make_output(
            lens=self.name,
            ticker=ticker,
            score=score,
            confidence=confidence,
            evidence=evidence,
            meta=meta,
        )
