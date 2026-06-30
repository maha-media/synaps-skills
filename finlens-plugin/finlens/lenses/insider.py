"""finlens.lenses.insider — InsiderLens

THE ANCHOR lens per research (Contreras/Fidrmuc/Kozhan 2025; Shi/Ma/Song 2026;
Petmezas et al. 2026).  The only lens with a durable, documented edge.

Research rules baked in:
  - BUYS predict; SELLS are noise (diversification / tax / attention-gaming).
  - Signal concentrates in open-market buys by CEO/CFO-tier executives.
  - Score is driven entirely by qualifying OPEN-MARKET BUY activity.
  - Mostly-sells situation → near-zero score (NOT bearish) because sells don't predict.
  - Score bounded to ~|0.60| to avoid overclaiming; insider signal is modest but durable.
  - Confidence scales with count and dollar size of qualifying buys.
"""
from __future__ import annotations

import math
from typing import Any

from ..contract import LensOutput, make_output
from ..data.base import DataSource, DataUnavailable
from ..formatters import fmt_num
from .base import Lens

# Thresholds
_EXEC_BUY_WEIGHT = 1.5          # executive open-market buy counts this much vs rank-and-file
_MAX_SCORE = 0.60               # hard cap — insider signal is modest, never claim more
_CONF_PER_EXEC_BUY = 0.18       # each qualifying exec buy adds this to confidence
_CONF_PER_PLAIN_BUY = 0.10      # each non-exec open-market buy adds this
_HIGH_VALUE_THRESHOLD = 500_000  # buys ≥ $500k get a small size kicker


def _is_qualifying_buy(t: dict[str, Any]) -> bool:
    """True if the trade is an open-market BUY (the only ones that carry signal)."""
    txn = str(t.get("transaction", "")).lower()
    if txn != "buy":
        return False
    is_om = t.get("is_open_market")
    # if the flag is explicitly False → skip; None → we assume open-market (Form 4 typical)
    if is_om is False:
        return False
    return True


def _exec_weight(t: dict[str, Any]) -> float:
    """1.5 for executives, 1.0 for rank-and-file."""
    return _EXEC_BUY_WEIGHT if t.get("is_executive") else 1.0


class InsiderLens(Lens):
    """Score a ticker's insider activity.  Only open-market buys count.

    Scoring:
        weighted_units = Σ (exec_weight(t) * size_kicker(t))  for qualifying buys
        raw_score = tanh(weighted_units * 0.6)   # bounded in (-1, 1)
        score = clamp(raw_score, -_MAX_SCORE, +_MAX_SCORE)

    Confidence:
        Σ per-trade confidence increments, clamped to [0, 1].
    """

    name = "insider"
    description = "Form 4 open-market buy activity (CEO/CFO tier weighted; sells ignored)"

    def __init__(self, data: DataSource) -> None:
        self.data = data

    def analyze(self, ticker: str) -> LensOutput | None:  # noqa: C901
        try:
            raw = self.data.insider_trades(ticker, days=90)
        except DataUnavailable:
            return None
        except Exception:
            return None

        if not raw or not isinstance(raw, dict):
            return None

        trades = raw.get("trades", [])
        freshness = raw.get("freshness")

        if not trades:
            # No trades at all — no read; return low-confidence neutral
            return make_output(
                lens=self.name,
                ticker=ticker,
                score=0.0,
                confidence=0.05,
                evidence=["No insider trades found in last 90 days"],
                data_freshness=freshness,
                meta={"qualifying_buys": 0, "total_trades": 0},
            )

        qualifying_buys: list[dict] = []
        total_sell_count = 0
        total_trade_count = len(trades)

        for t in trades:
            if not isinstance(t, dict):
                continue
            txn = str(t.get("transaction", "")).lower()
            if txn == "sell":
                total_sell_count += 1
            if _is_qualifying_buy(t):
                qualifying_buys.append(t)

        # If no qualifying buys → neutral (sells alone don't make it bearish)
        if not qualifying_buys:
            evidence = []
            if total_sell_count > 0:
                evidence.append(
                    f"{total_sell_count} insider sell(s) in 90d — sells are noise; no bullish read"
                )
            else:
                evidence.append("No open-market buy activity in last 90 days")
            return make_output(
                lens=self.name,
                ticker=ticker,
                score=0.0,
                confidence=0.05,
                evidence=evidence,
                data_freshness=freshness,
                meta={
                    "qualifying_buys": 0,
                    "total_sells": total_sell_count,
                    "total_trades": total_trade_count,
                },
            )

        # --- Score from qualifying buys ---
        exec_buy_count = 0
        plain_buy_count = 0
        total_buy_value_usd = 0.0
        weighted_units = 0.0
        confidence = 0.0

        for t in qualifying_buys:
            ew = _exec_weight(t)
            if ew > 1.0:
                exec_buy_count += 1
            else:
                plain_buy_count += 1

            # value is +buy / -sell per contract; safe-guard against missing/negative
            val = t.get("value", 0) or 0
            try:
                val = abs(float(val))
            except (TypeError, ValueError):
                val = 0.0
            total_buy_value_usd += val

            # size kicker: large buys (≥$500k) get a 1.3x multiplier
            size_k = 1.3 if val >= _HIGH_VALUE_THRESHOLD else 1.0
            weighted_units += ew * size_k

            # confidence increment
            conf_inc = _CONF_PER_EXEC_BUY if ew > 1.0 else _CONF_PER_PLAIN_BUY
            confidence += conf_inc

        # _MAX_SCORE * tanh bounds the output to ±_MAX_SCORE *by construction* and
        # stays strictly monotonic — so the exec / size premium is never masked by a
        # hard clamp. Sensitivity tuned so realistic buy baskets land mid-range and
        # only an extreme cluster of large exec buys approaches the cap.
        raw_score = _MAX_SCORE * math.tanh(weighted_units * 0.28)
        score = min(_MAX_SCORE, max(-_MAX_SCORE, raw_score))
        confidence = min(1.0, confidence)

        # --- Evidence strings ---
        buy_desc_parts = []
        if exec_buy_count > 0:
            buy_desc_parts.append(f"{exec_buy_count} exec")
        if plain_buy_count > 0:
            buy_desc_parts.append(f"{plain_buy_count} other")
        buy_label = " + ".join(buy_desc_parts) + " open-market buy(s)"
        value_str = fmt_num(total_buy_value_usd, dollar=True) if total_buy_value_usd > 0 else "undisclosed value"
        evidence = [f"{buy_label} totaling {value_str} (90d)"]
        if total_sell_count > 0:
            evidence.append(f"{total_sell_count} sell(s) noted but excluded (diversification noise)")

        meta = {
            "qualifying_buys": len(qualifying_buys),
            "exec_buy_count": exec_buy_count,
            "plain_buy_count": plain_buy_count,
            "total_buy_value_usd": total_buy_value_usd,
            "total_sells": total_sell_count,
            "total_trades": total_trade_count,
            "weighted_units": round(weighted_units, 3),
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
