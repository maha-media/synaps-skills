"""Tests for FinancialDatasetsSource — the OPTIONAL paid primary.

We can't hit the live paid API (no key), so we verify the contract that matters:
with no key it advertises NO capabilities and every method raises DataUnavailable,
so the pipeline degrades to the free yfinance path. (Parsing is exercised live when
a key is present.)
"""
import pytest

from finlens.data.financialdatasets_source import FinancialDatasetsSource
from finlens.data.base import DataUnavailable, CAP_PRICES


def test_no_key_advertises_nothing():
    src = FinancialDatasetsSource(None)
    assert src.capabilities == set()
    assert not src.supports(CAP_PRICES)


def test_no_key_every_method_raises():
    src = FinancialDatasetsSource("")
    for call in (lambda: src.prices("NVDA"),
                 lambda: src.fundamentals("NVDA"),
                 lambda: src.insider_trades("NVDA"),
                 lambda: src.news("NVDA")):
        with pytest.raises(DataUnavailable):
            call()


def test_with_key_advertises_capabilities():
    src = FinancialDatasetsSource("fake-key-123")
    assert CAP_PRICES in src.capabilities
    assert len(src.capabilities) == 4
