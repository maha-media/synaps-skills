import pytest

from src.research.router import Router, RouterError, tool_schema, VALID_LENSES


def test_tool_schema_shape():
    s = tool_schema()
    assert s["name"] == "finlens"
    props = s["input_schema"]["properties"]
    assert set(props["lens"]["enum"]) == set(VALID_LENSES)
    assert s["input_schema"]["required"] == ["lens", "ticker"]


def test_router_rejects_unknown_lens():
    r = Router(call_lens=lambda *a, **k: {"call_id": "x"})
    with pytest.raises(RouterError):
        r.dispatch({"lens": "macro", "ticker": "NVDA"})
    with pytest.raises(RouterError):
        r.dispatch({"lens": "fundamentals", "ticker": ""})
    assert r.results == []


def test_router_dispatches_known_lens_and_records_call_id():
    calls = []

    def fake(lens, ticker, **_):
        calls.append((lens, ticker))
        return {"call_id": f"finlens:{lens}#abc", "lens": lens,
                "ticker": ticker, "status": "ok", "latency_ms": 0,
                "payload": {"x": 1}}

    r = Router(call_lens=fake)
    out = r.dispatch({"lens": "fundamentals", "ticker": "nvda"})
    assert out["call_id"] == "finlens:fundamentals#abc"
    assert calls == [("fundamentals", "NVDA")]
    assert r.call_ids() == ["finlens:fundamentals#abc"]
    assert r.find("finlens:fundamentals#abc")["payload"] == {"x": 1}


def test_router_malformed_adapter_result():
    r = Router(call_lens=lambda *a, **k: {"no_call_id": True})
    with pytest.raises(RouterError):
        r.dispatch({"lens": "news", "ticker": "AAPL"})
