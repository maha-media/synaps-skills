"""Tests for the finlens subprocess adapter — no live finlens required."""
from __future__ import annotations
import json
import os
import sys
from pathlib import Path

import pytest

from src.research.adapters import finlens_call


@pytest.fixture
def fake_finlens(tmp_path, monkeypatch):
    """Build a fake FINLENS_HOME/.venv/bin/python that echoes a canned JSON
    payload — exercises the adapter end-to-end without touching real finlens."""
    home = tmp_path / "finlens"
    venv_bin = home / ".venv" / "bin"
    venv_bin.mkdir(parents=True)
    py = venv_bin / "python"
    # The driver feeds the script via `python -c <code> lens ticker`.
    # We replace the interpreter with a shell script that ignores the script
    # and emits the canned payload we want.
    canned = {"ok": True, "payload": {
        "lens": "fundamentals", "ticker": "NVDA",
        "signal": "bullish", "score": 0.42, "confidence": 0.7,
        "evidence": ["rev +18% YoY"],
    }}
    py.write_text(
        "#!/usr/bin/env bash\n"
        f"echo '{json.dumps(canned)}'\n"
    )
    py.chmod(0o755)
    monkeypatch.setenv("FINLENS_HOME", str(home))
    return home


def test_call_lens_returns_well_formed_dict(fake_finlens):
    out = finlens_call.call_lens("fundamentals", "nvda")
    assert out["status"] == "ok"
    assert out["lens"] == "fundamentals"
    assert out["ticker"] == "NVDA"
    assert out["call_id"].startswith("finlens:fundamentals#")
    assert isinstance(out["latency_ms"], int)
    assert out["payload"]["signal"] == "bullish"
    assert out["payload"]["score"] == 0.42


def test_call_lens_call_ids_are_unique(fake_finlens):
    ids = {finlens_call.call_lens("fundamentals", "NVDA")["call_id"] for _ in range(5)}
    assert len(ids) == 5


def test_call_lens_missing_python_degrades_gracefully(tmp_path, monkeypatch):
    monkeypatch.setenv("FINLENS_HOME", str(tmp_path / "does-not-exist"))
    out = finlens_call.call_lens("fundamentals", "NVDA")
    assert out["status"] == "error"
    assert "not found" in out["error"]
    assert out["payload"] is None
    assert out["call_id"].startswith("finlens:fundamentals#")


def test_call_lens_error_payload_degrades(tmp_path, monkeypatch):
    home = tmp_path / "finlens"
    bin_ = home / ".venv" / "bin"
    bin_.mkdir(parents=True)
    py = bin_ / "python"
    py.write_text("#!/usr/bin/env bash\necho '{\"ok\": false, \"error\": \"finlens 401\"}'\n")
    py.chmod(0o755)
    monkeypatch.setenv("FINLENS_HOME", str(home))
    out = finlens_call.call_lens("news", "NVDA")
    assert out["status"] == "error"
    assert "finlens 401" in out["error"]


@pytest.mark.skipif(os.environ.get("XCAL_LIVE_FINLENS") != "1",
                    reason="live finlens gated behind XCAL_LIVE_FINLENS=1")
def test_live_finlens_smoke():
    out = finlens_call.call_lens("fundamentals", "NVDA")
    assert out["status"] in ("ok", "error")
    assert out["call_id"]
