"""Tests for YFinanceSource — fixture/mock based, NO network.

We inject fake yfinance Ticker objects (real pandas frames) and assert the
adapter maps them to the documented base.py shapes, and that failures raise
DataUnavailable.
"""
import datetime as dt

import pandas as pd
import pytest

from finlens.data.yfinance_source import YFinanceSource
from finlens.data.base import DataUnavailable


class FakeTicker:
    def __init__(self, *, history=None, info=None, insider=None, news=None, raises=None):
        self._history = history
        self._info = info
        self._insider = insider
        self._news = news
        self._raises = raises or {}

    def history(self, period="6mo", auto_adjust=True):
        if "history" in self._raises:
            raise self._raises["history"]
        return self._history

    @property
    def info(self):
        if "info" in self._raises:
            raise self._raises["info"]
        return self._info

    @property
    def insider_transactions(self):
        return self._insider

    @property
    def news(self):
        return self._news


def _src_with(ticker_obj):
    src = YFinanceSource()
    src._yf = type("YF", (), {"Ticker": staticmethod(lambda t: ticker_obj)})
    src._cache = {}
    return src


def _price_frame(n=130):
    idx = pd.date_range(end=dt.datetime(2026, 6, 26), periods=n, freq="D")
    return pd.DataFrame({
        "Open": [100 + i for i in range(n)],
        "High": [101 + i for i in range(n)],
        "Low": [99 + i for i in range(n)],
        "Close": [100 + i for i in range(n)],
        "Volume": [1_000_000 + i for i in range(n)],
    }, index=idx)


class TestPrices:
    def test_maps_ohlcv_chronologically(self):
        src = _src_with(FakeTicker(history=_price_frame(130)))
        out = src.prices("nvda", "6mo")
        assert out["ticker"] == "NVDA"
        assert len(out["closes"]) == 130
        assert out["closes"][0] < out["closes"][-1]  # chronological
        assert out["freshness"] is not None
        assert len(out["volumes"]) == len(out["closes"]) == len(out["dates"])

    def test_empty_history_raises(self):
        src = _src_with(FakeTicker(history=pd.DataFrame()))
        with pytest.raises(DataUnavailable):
            src.prices("nvda")

    def test_fetch_exception_raises_dataunavailable(self):
        src = _src_with(FakeTicker(raises={"history": RuntimeError("network")}))
        with pytest.raises(DataUnavailable):
            src.prices("nvda")


class TestFundamentals:
    def test_maps_known_fields_and_normalizes_dte(self):
        info = {"trailingPE": 29.5, "priceToSalesTrailing12Months": 18.4,
                "trailingPegRatio": 0.6, "grossMargins": 0.65, "operatingMargins": 0.65,
                "profitMargins": 0.63, "revenueGrowth": 0.85, "earningsGrowth": 2.1,
                "debtToEquity": 45.0, "freeCashflow": 3.0e10, "marketCap": 3.0e12,
                "sector": "Technology"}
        src = _src_with(FakeTicker(info=info))
        out = src.fundamentals("nvda")
        assert out["pe"] == 29.5
        assert out["net_margin"] == 0.63
        # debtToEquity 45.0 (percent) → 0.45
        assert out["debt_to_equity"] == pytest.approx(0.45)
        assert out["sector"] == "Technology"

    def test_all_empty_raises(self):
        src = _src_with(FakeTicker(info={"sector": "X"}))
        with pytest.raises(DataUnavailable):
            src.fundamentals("nvda")

    def test_no_info_raises(self):
        src = _src_with(FakeTicker(info={}))
        with pytest.raises(DataUnavailable):
            src.fundamentals("nvda")


class TestInsider:
    def _frame(self):
        return pd.DataFrame({
            "Shares": [1000, 500],
            "Value": [200000, 90000],
            "Text": ["Purchase at price 200", "Sale at price 180"],
            "Position": ["Chief Executive Officer", "Director"],
            "Start Date": [pd.Timestamp("2026-06-20"), pd.Timestamp("2026-06-18")],
        })

    def test_maps_buy_sell_and_exec(self):
        src = _src_with(FakeTicker(insider=self._frame()))
        out = src.insider_trades("nvda", days=3650)
        txns = {t["transaction"] for t in out["trades"]}
        assert "buy" in txns and "sell" in txns
        buy = [t for t in out["trades"] if t["transaction"] == "buy"][0]
        assert buy["value"] > 0 and buy["is_executive"] is True

    def test_none_raises(self):
        src = _src_with(FakeTicker(insider=None))
        with pytest.raises(DataUnavailable):
            src.insider_trades("nvda")


class TestNews:
    def test_maps_titles(self):
        news = [{"content": {"title": "NVDA beats earnings", "pubDate": "2026-06-27T00:00:00Z",
                              "provider": {"displayName": "Reuters"}}, "link": "http://x"}]
        src = _src_with(FakeTicker(news=news))
        out = src.news("nvda")
        assert out["items"][0]["title"] == "NVDA beats earnings"

    def test_empty_raises(self):
        src = _src_with(FakeTicker(news=[]))
        with pytest.raises(DataUnavailable):
            src.news("nvda")
