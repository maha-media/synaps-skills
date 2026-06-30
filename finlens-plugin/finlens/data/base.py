"""finlens.data.base — the DataSource interface every data adapter implements.

Lenses depend on this interface, NOT on a concrete vendor. yfinance/SEC EDGAR is
the free fallback; financialdatasets.ai is the paid primary. Same interface, swap
freely. A source advertises capabilities via `supports()`; unsupported calls raise
DataUnavailable so a lens can degrade gracefully instead of crashing the run.
"""
from __future__ import annotations

from abc import ABC
from typing import Any

# capability constants
CAP_PRICES = "prices"
CAP_FUNDAMENTALS = "fundamentals"
CAP_INSIDER = "insider"
CAP_NEWS = "news"


class DataUnavailable(Exception):
    """A source can't satisfy this request (unsupported capability or fetch failure)."""


class DataSource(ABC):
    name: str = "base"
    capabilities: set[str] = set()

    def supports(self, capability: str) -> bool:
        return capability in self.capabilities

    # --- data methods; default = unsupported. Adapters override what they provide. ---

    def prices(self, ticker: str, period: str = "6mo") -> dict[str, Any]:
        """Return OHLCV history.
        Shape: {"ticker", "period", "closes": [float], "volumes": [float],
                "highs": [float], "lows": [float], "dates": [iso], "freshness": iso}
        Lists are chronological (oldest→newest). Raise DataUnavailable on failure.
        """
        raise DataUnavailable(f"{self.name}: prices not supported")

    def fundamentals(self, ticker: str) -> dict[str, Any]:
        """Return a flat dict of fundamental metrics, keys (None if missing):
        pe, ps, peg, pb, gross_margin, op_margin, net_margin, revenue_growth,
        earnings_growth, debt_to_equity, free_cashflow, market_cap, sector,
        plus "freshness": iso. Raise DataUnavailable on failure.
        """
        raise DataUnavailable(f"{self.name}: fundamentals not supported")

    def insider_trades(self, ticker: str, days: int = 90) -> dict[str, Any]:
        """Return insider (Form 4) activity over `days`.
        Shape: {"ticker", "trades": [ {name, title, transaction ("buy"/"sell"/"other"),
                shares, value (usd, +buy/-sell), date (iso), is_open_market (bool|None),
                is_executive (bool|None)} ], "freshness": iso}.
        Raise DataUnavailable on failure.
        """
        raise DataUnavailable(f"{self.name}: insider not supported")

    def news(self, ticker: str, limit: int = 20) -> dict[str, Any]:
        """Return recent headlines.
        Shape: {"ticker", "items": [ {title, source, date (iso), url} ], "freshness": iso}.
        Raise DataUnavailable on failure.
        """
        raise DataUnavailable(f"{self.name}: news not supported")


class MultiSource(DataSource):
    """Tries an ordered list of sources, first that supports+succeeds wins.

    Primary (e.g. financialdatasets) → fallback (yfinance/EDGAR). The orchestrator
    builds this; lenses just see a single DataSource.
    """

    name = "multi"

    def __init__(self, sources: list[DataSource]):
        self.sources = list(sources)
        caps: set[str] = set()
        for s in self.sources:
            caps |= set(s.capabilities)
        self.capabilities = caps

    def _try(self, method: str, ticker: str, *args, **kwargs):
        errors = []
        for s in self.sources:
            cap = method if method != "insider_trades" else CAP_INSIDER
            cap = {"prices": CAP_PRICES, "fundamentals": CAP_FUNDAMENTALS,
                   "insider_trades": CAP_INSIDER, "news": CAP_NEWS}[method]
            if not s.supports(cap):
                continue
            try:
                return getattr(s, method)(ticker, *args, **kwargs)
            except DataUnavailable as e:
                errors.append(f"{s.name}: {e}")
            except Exception as e:  # noqa: BLE001 — a flaky source must not kill the run
                errors.append(f"{s.name}: {type(e).__name__}: {e}")
        raise DataUnavailable(f"all sources failed for {method}({ticker}): {'; '.join(errors)}")

    def prices(self, ticker, period="6mo"):
        return self._try("prices", ticker, period)

    def fundamentals(self, ticker):
        return self._try("fundamentals", ticker)

    def insider_trades(self, ticker, days=90):
        return self._try("insider_trades", ticker, days)

    def news(self, ticker, limit=20):
        return self._try("news", ticker, limit)
