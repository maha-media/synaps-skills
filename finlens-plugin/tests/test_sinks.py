"""Tests for the results API sink — no real network (urlopen monkeypatched)."""
import json
import urllib.request
import urllib.error

import pytest

from finlens.config import Config
from finlens.sinks import build_payload, post_results


def _cfg(**kw):
    c = Config()
    for k, v in kw.items():
        setattr(c, k, v)
    return c


def test_build_payload_shape():
    p = build_payload("run-1", ["NVDA", "TSLA"], [{"ticker": "NVDA", "direction": "bullish"}])
    assert p["schema"] == "finlens.results/1.0"
    assert p["run_id"] == "run-1"
    assert p["count"] == 1
    assert p["watchlist"] == ["NVDA", "TSLA"]
    assert "NOT FINANCIAL ADVICE" in p["disclaimer"]


def test_no_url_returns_false():
    assert post_results({"x": 1}, _cfg(results_api=None)) is False


class _Resp:
    def __init__(self, status):
        self.status = status
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def getcode(self): return self.status


def test_success_posts_with_bearer(monkeypatch):
    captured = {}
    def fake_urlopen(req, timeout=20):
        captured["url"] = req.full_url
        captured["auth"] = req.headers.get("Authorization")
        captured["body"] = json.loads(req.data.decode())
        return _Resp(200)
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    cfg = _cfg(results_api="https://api.example.com/finlens", results_api_token="secret123")
    ok = post_results(build_payload("r1", ["NVDA"], [{"ticker": "NVDA"}]), cfg, log=lambda *_: None)
    assert ok is True
    assert captured["auth"] == "Bearer secret123"
    assert captured["body"]["run_id"] == "r1"


def test_failure_returns_false_after_retries(monkeypatch):
    def boom(req, timeout=20):
        raise urllib.error.URLError("connection refused")
    monkeypatch.setattr(urllib.request, "urlopen", boom)
    cfg = _cfg(results_api="https://down.example.com")
    ok = post_results({"x": 1}, cfg, retries=2, log=lambda *_: None)
    assert ok is False


def test_non_2xx_is_failure(monkeypatch):
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=20: _Resp(500))
    cfg = _cfg(results_api="https://api.example.com")
    ok = post_results({"x": 1}, cfg, retries=1, log=lambda *_: None)
    assert ok is False
