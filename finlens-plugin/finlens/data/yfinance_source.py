"""finlens.data.yfinance_source — free DataSource backed by yfinance.

The fallback that makes the whole pipeline run with zero paid API key.
Defensive everywhere: any missing field / fetch failure → DataUnavailable so a
lens degrades to None instead of crashing the run.
"""
from __future__ import annotations

import datetime as _dt
from typing import Any

from .base import (DataSource, DataUnavailable,
                   CAP_PRICES, CAP_FUNDAMENTALS, CAP_INSIDER, CAP_NEWS)


def _iso(d: Any) -> str | None:
    try:
        if d is None:
            return None
        if hasattr(d, "strftime"):
            return d.strftime("%Y-%m-%dT%H:%M:%SZ")
        return str(d)
    except Exception:
        return None


def _f(v: Any) -> float | None:
    try:
        if v is None:
            return None
        v = float(v)
        if v != v:  # NaN
            return None
        return v
    except (TypeError, ValueError):
        return None


class YFinanceSource(DataSource):
    name = "yfinance"
    capabilities = {CAP_PRICES, CAP_FUNDAMENTALS, CAP_INSIDER, CAP_NEWS}

    def __init__(self):
        try:
            import yfinance as yf  # noqa: F401
        except Exception as e:  # noqa: BLE001
            raise DataUnavailable(f"yfinance import failed: {e}")
        self._yf = yf
        self._cache: dict[str, Any] = {}

    def _ticker(self, ticker: str):
        ticker = ticker.upper().strip()
        if ticker not in self._cache:
            self._cache[ticker] = self._yf.Ticker(ticker)
        return self._cache[ticker]

    # ---- prices ----
    def prices(self, ticker: str, period: str = "6mo") -> dict[str, Any]:
        try:
            hist = self._ticker(ticker).history(period=period, auto_adjust=True)
        except Exception as e:  # noqa: BLE001
            raise DataUnavailable(f"yfinance prices({ticker}): {e}")
        if hist is None or len(hist) == 0:
            raise DataUnavailable(f"yfinance prices({ticker}): empty")
        try:
            closes = [float(x) for x in hist["Close"].tolist()]
            highs = [float(x) for x in hist["High"].tolist()]
            lows = [float(x) for x in hist["Low"].tolist()]
            volumes = [float(x) for x in hist["Volume"].tolist()]
            dates = [_iso(d) for d in hist.index.tolist()]
        except Exception as e:  # noqa: BLE001
            raise DataUnavailable(f"yfinance prices({ticker}) parse: {e}")
        return {"ticker": ticker.upper(), "period": period,
                "closes": closes, "highs": highs, "lows": lows,
                "volumes": volumes, "dates": dates,
                "freshness": dates[-1] if dates else None}

    # ---- fundamentals ----
    def fundamentals(self, ticker: str) -> dict[str, Any]:
        try:
            info = self._ticker(ticker).info
        except Exception as e:  # noqa: BLE001
            raise DataUnavailable(f"yfinance fundamentals({ticker}): {e}")
        if not info or not isinstance(info, dict):
            raise DataUnavailable(f"yfinance fundamentals({ticker}): no info")
        dte = _f(info.get("debtToEquity"))
        if dte is not None and dte > 5:  # yfinance reports as percent (145.0 -> 1.45)
            dte = dte / 100.0
        out = {
            "pe": _f(info.get("trailingPE")),
            "ps": _f(info.get("priceToSalesTrailing12Months")),
            "peg": _f(info.get("trailingPegRatio") or info.get("pegRatio")),
            "pb": _f(info.get("priceToBook")),
            "gross_margin": _f(info.get("grossMargins")),
            "op_margin": _f(info.get("operatingMargins")),
            "net_margin": _f(info.get("profitMargins")),
            "revenue_growth": _f(info.get("revenueGrowth")),
            "earnings_growth": _f(info.get("earningsGrowth")),
            "debt_to_equity": dte,
            "free_cashflow": _f(info.get("freeCashflow")),
            "market_cap": _f(info.get("marketCap")),
            "sector": info.get("sector"),
            "freshness": _iso(_dt.datetime.now(_dt.timezone.utc)),
        }
        if all(out[k] is None for k in ("pe", "ps", "net_margin", "revenue_growth", "market_cap")):
            raise DataUnavailable(f"yfinance fundamentals({ticker}): all key fields empty")
        return out

    # ---- insider trades ----
    def insider_trades(self, ticker: str, days: int = 90) -> dict[str, Any]:
        try:
            df = self._ticker(ticker).insider_transactions
        except Exception as e:  # noqa: BLE001
            raise DataUnavailable(f"yfinance insider({ticker}): {e}")
        if df is None or len(df) == 0:
            raise DataUnavailable(f"yfinance insider({ticker}): none")
        cutoff = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None) - _dt.timedelta(days=days)
        trades = []
        cols = {c.lower(): c for c in df.columns}

        def col(*names):
            for n in names:
                if n in cols:
                    return cols[n]
            return None

        c_text = col("text", "transaction")
        c_val = col("value")
        c_shares = col("shares")
        c_pos = col("position", "insider")
        c_date = col("start date", "date")
        for _, row in df.iterrows():
            text = str(row[c_text]).lower() if c_text else ""
            pos = str(row[c_pos]) if c_pos else ""
            dt_raw = row[c_date] if c_date else None
            try:
                dt = dt_raw.to_pydatetime() if hasattr(dt_raw, "to_pydatetime") else None
            except Exception:
                dt = None
            if dt is not None and dt.replace(tzinfo=None) < cutoff:
                continue
            if any(w in text for w in ("purchase", "buy", "acqui")):
                txn = "buy"
            elif any(w in text for w in ("sale", "sell", "dispos")):
                txn = "sell"
            else:
                txn = "other"
            val = _f(row[c_val]) if c_val else None
            shares = _f(row[c_shares]) if c_shares else None
            signed_val = None
            if val is not None:
                signed_val = -abs(val) if txn == "sell" else abs(val)
            is_exec = any(k in pos.lower() for k in
                          ("ceo", "cfo", "coo", "chief", "president", "officer", "director"))
            trades.append({
                "name": str(row[c_pos]) if c_pos else None,
                "title": pos or None,
                "transaction": txn,
                "shares": shares,
                "value": signed_val,
                "date": _iso(dt) if dt else (_iso(dt_raw) if dt_raw is not None else None),
                "is_open_market": ("open market" in text) or None,
                "is_executive": is_exec or None,
            })
        if not trades:
            raise DataUnavailable(f"yfinance insider({ticker}): none in {days}d")
        return {"ticker": ticker.upper(), "trades": trades,
                "freshness": _iso(_dt.datetime.now(_dt.timezone.utc))}

    # ---- news ----
    def news(self, ticker: str, limit: int = 20) -> dict[str, Any]:
        try:
            raw = self._ticker(ticker).news
        except Exception as e:  # noqa: BLE001
            raise DataUnavailable(f"yfinance news({ticker}): {e}")
        if not raw:
            raise DataUnavailable(f"yfinance news({ticker}): none")
        items = []
        for n in raw[:limit]:
            content = n.get("content", n) if isinstance(n, dict) else {}
            title = (content.get("title") or n.get("title") if isinstance(n, dict) else None)
            if not title:
                continue
            ts = None
            if isinstance(n, dict):
                ts = (content.get("pubDate") or n.get("providerPublishTime"))
            if isinstance(ts, (int, float)):
                ts = _iso(_dt.datetime.fromtimestamp(ts, _dt.timezone.utc))
            prov = ""
            if isinstance(n, dict):
                prov = ((n.get("provider") or {}).get("displayName")
                        or (content.get("provider") or {}).get("displayName") or "")
            items.append({"title": str(title), "source": prov,
                          "date": ts, "url": n.get("link", "") if isinstance(n, dict) else ""})
        if not items:
            raise DataUnavailable(f"yfinance news({ticker}): no titles")
        return {"ticker": ticker.upper(), "items": items,
                "freshness": _iso(_dt.datetime.now(_dt.timezone.utc))}
