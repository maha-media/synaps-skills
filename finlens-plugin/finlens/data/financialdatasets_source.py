"""finlens.data.financialdatasets_source — OPTIONAL paid primary (financialdatasets.ai).

The clean API that dexter uses — fundamentals, insider, prices, news in one place.
Degrades gracefully: with no API key, capabilities={} and every method raises
DataUnavailable, so the pipeline runs free-only. Uses urllib (no new deps).
"""
from __future__ import annotations

import datetime as _dt
import json
import urllib.request
import urllib.parse
from typing import Any

from .base import (DataSource, DataUnavailable,
                   CAP_PRICES, CAP_FUNDAMENTALS, CAP_INSIDER, CAP_NEWS)

_BASE = "https://api.financialdatasets.ai"


def _iso_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class FinancialDatasetsSource(DataSource):
    name = "financialdatasets"

    def __init__(self, api_key: str | None):
        self.api_key = (api_key or "").strip()
        # No key → advertise nothing; the MultiSource skips us and uses yfinance.
        self.capabilities = ({CAP_PRICES, CAP_FUNDAMENTALS, CAP_INSIDER, CAP_NEWS}
                             if self.api_key else set())

    def _get(self, path: str, params: dict) -> dict:
        if not self.api_key:
            raise DataUnavailable("financialdatasets: no api key")
        url = f"{_BASE}{path}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"X-API-KEY": self.api_key})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            raise DataUnavailable(f"financialdatasets {path}: {e}")

    def prices(self, ticker: str, period: str = "6mo") -> dict[str, Any]:
        days = {"1mo": 31, "3mo": 93, "6mo": 186, "1y": 366}.get(period, 186)
        end = _dt.date.today()
        start = end - _dt.timedelta(days=days)
        d = self._get("/prices/", {"ticker": ticker.upper(), "interval": "day",
                                   "interval_multiplier": 1,
                                   "start_date": start.isoformat(), "end_date": end.isoformat()})
        rows = d.get("prices") or []
        if not rows:
            raise DataUnavailable(f"financialdatasets prices({ticker}): empty")
        rows = sorted(rows, key=lambda r: r.get("time", ""))
        return {"ticker": ticker.upper(), "period": period,
                "closes": [float(r["close"]) for r in rows],
                "highs": [float(r["high"]) for r in rows],
                "lows": [float(r["low"]) for r in rows],
                "volumes": [float(r.get("volume", 0)) for r in rows],
                "dates": [r.get("time") for r in rows],
                "freshness": rows[-1].get("time")}

    def fundamentals(self, ticker: str) -> dict[str, Any]:
        d = self._get("/financial-metrics/snapshot/", {"ticker": ticker.upper()})
        m = d.get("snapshot") or d.get("financial_metrics") or {}
        if not m:
            raise DataUnavailable(f"financialdatasets fundamentals({ticker}): empty")
        g = m.get
        return {"pe": g("price_to_earnings_ratio"), "ps": g("price_to_sales_ratio"),
                "peg": g("peg_ratio"), "pb": g("price_to_book_ratio"),
                "gross_margin": g("gross_margin"), "op_margin": g("operating_margin"),
                "net_margin": g("net_margin"), "revenue_growth": g("revenue_growth"),
                "earnings_growth": g("earnings_growth"), "debt_to_equity": g("debt_to_equity"),
                "free_cashflow": g("free_cash_flow"), "market_cap": g("market_cap"),
                "sector": g("sector"), "freshness": _iso_now()}

    def insider_trades(self, ticker: str, days: int = 90) -> dict[str, Any]:
        d = self._get("/insider-trades/", {"ticker": ticker.upper(), "limit": 100})
        rows = d.get("insider_trades") or []
        if not rows:
            raise DataUnavailable(f"financialdatasets insider({ticker}): empty")
        cutoff = _dt.date.today() - _dt.timedelta(days=days)
        trades = []
        for r in rows:
            dstr = (r.get("transaction_date") or r.get("filing_date") or "")[:10]
            try:
                if dstr and _dt.date.fromisoformat(dstr) < cutoff:
                    continue
            except ValueError:
                pass
            shares = r.get("transaction_shares")
            txn = "buy" if (shares or 0) > 0 else ("sell" if (shares or 0) < 0 else "other")
            val = r.get("transaction_value")
            title = (r.get("title") or r.get("position") or "").lower()
            trades.append({
                "name": r.get("name"), "title": r.get("title") or r.get("position"),
                "transaction": txn, "shares": shares, "value": val, "date": dstr or None,
                "is_open_market": r.get("is_board_director") is not None or None,
                "is_executive": any(k in title for k in
                                    ("ceo", "cfo", "coo", "chief", "president", "officer")) or None,
            })
        if not trades:
            raise DataUnavailable(f"financialdatasets insider({ticker}): none in {days}d")
        return {"ticker": ticker.upper(), "trades": trades, "freshness": _iso_now()}

    def news(self, ticker: str, limit: int = 20) -> dict[str, Any]:
        d = self._get("/news/", {"ticker": ticker.upper(), "limit": limit})
        rows = d.get("news") or []
        if not rows:
            raise DataUnavailable(f"financialdatasets news({ticker}): empty")
        items = [{"title": r.get("title", ""), "source": r.get("source", ""),
                  "date": r.get("date"), "url": r.get("url", "")}
                 for r in rows if r.get("title")]
        if not items:
            raise DataUnavailable(f"financialdatasets news({ticker}): no titles")
        return {"ticker": ticker.upper(), "items": items, "freshness": _iso_now()}
