"""Tests for the axel CLI adapter — no live axel required by default."""
from __future__ import annotations
import json
import os
import subprocess
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from src.research.adapters import axel_cli


# Content >= 50 chars, topic >= 5 chars — passes the adapter guards.
LONG_CONTENT = "x" * 60
GOOD_TOPIC = "nvda-q3"


@pytest.fixture
def fake_axel_bin(tmp_path, monkeypatch):
    p = tmp_path / "axel"
    p.write_text("#!/usr/bin/env bash\nexit 0\n")
    p.chmod(0o755)
    monkeypatch.setenv("AXEL_BIN", str(p))
    return p


def _make_run(stdout="", stderr="", code=0):
    proc = MagicMock()
    proc.returncode = code
    proc.stdout = stdout
    proc.stderr = stderr
    return proc


# ── search ─────────────────────────────────────────────────────────────────
def test_search_builds_correct_argv_and_parses_json(fake_axel_bin):
    payload = {"count": 2, "query": "nvda", "results": [
        {"doc_id": "skills::quarterly-check", "content": "x", "score": 0.9},
        {"doc_id": "memories::cases::abc", "content": "y", "score": 0.7},
    ]}
    with patch("src.research.adapters.axel_cli.subprocess.run",
               return_value=_make_run(stdout=json.dumps(payload))) as run:
        out = axel_cli.search("nvda quarterly", limit=10)
    argv = run.call_args[0][0]
    assert argv[0] == str(fake_axel_bin)
    assert "search" in argv
    assert "nvda quarterly" in argv
    assert "--limit" in argv and "10" in argv
    assert "--json" in argv
    assert out["status"] == "ok"
    assert out["count"] == 2
    assert len(out["results"]) == 2


def test_search_ignores_progress_lines(fake_axel_bin):
    payload = {"count": 0, "results": []}
    stdout = json.dumps(payload)
    with patch("src.research.adapters.axel_cli.subprocess.run",
               return_value=_make_run(stdout=stdout, stderr="Building search index...")):
        out = axel_cli.search("xyz")
    assert out["status"] == "ok"


def test_search_nonzero_exit_returns_error(fake_axel_bin):
    with patch("src.research.adapters.axel_cli.subprocess.run",
               return_value=_make_run(code=2, stderr="boom")):
        out = axel_cli.search("nvda")
    assert out["status"] == "error"
    assert "boom" in out["error"]


# ── remember ───────────────────────────────────────────────────────────────
def test_remember_builds_correct_argv(fake_axel_bin):
    with patch("src.research.adapters.axel_cli.subprocess.run",
               return_value=_make_run(stdout="✅ Memory stored: mem_abc123")) as run:
        out = axel_cli.remember(LONG_CONTENT, category="cases", topic=GOOD_TOPIC)
    argv = run.call_args[0][0]
    assert argv[0] == str(fake_axel_bin)
    assert "remember" in argv
    assert LONG_CONTENT in argv
    assert "--category" in argv and "cases" in argv
    assert "--topic" in argv and GOOD_TOPIC in argv
    # exactly one --topic
    assert sum(1 for a in argv if a == "--topic") == 1
    assert out["status"] == "ok"
    assert out["memory_id"] == "mem_abc123"


def test_remember_rejects_empty(fake_axel_bin):
    out = axel_cli.remember("   ")
    assert out["status"] == "error"
    assert out["memory_id"] is None


def test_remember_parses_memory_id(fake_axel_bin):
    """Adapter extracts mem_<hex> id from axel's success line."""
    stdout = "✅ Memory stored: mem_abc123\n"
    with patch("src.research.adapters.axel_cli.subprocess.run",
               return_value=_make_run(stdout=stdout)):
        out = axel_cli.remember(LONG_CONTENT, category="cases", topic=GOOD_TOPIC)
    assert out["status"] == "ok"
    assert out["memory_id"] == "mem_abc123"


def test_remember_rejects_invalid_category(fake_axel_bin):
    """Invalid category short-circuits — axel binary is never invoked."""
    with patch("src.research.adapters.axel_cli.subprocess.run") as run:
        out = axel_cli.remember(LONG_CONTENT, category="research", topic=GOOD_TOPIC)
    assert out["status"] == "error"
    assert "invalid category" in out["error"]
    assert run.call_count == 0


def test_remember_validates_length(fake_axel_bin):
    """content<50 or topic<5 → error, no subprocess call."""
    with patch("src.research.adapters.axel_cli.subprocess.run") as run:
        short = axel_cli.remember("too short", category="cases", topic=GOOD_TOPIC)
        topic = axel_cli.remember(LONG_CONTENT, category="cases", topic="hi")
    assert short["status"] == "error" and "too short" in short["error"]
    assert topic["status"] == "error" and "topic too short" in topic["error"]
    assert run.call_count == 0


def test_remember_nonzero_exit_returns_error(fake_axel_bin):
    with patch("src.research.adapters.axel_cli.subprocess.run",
               return_value=_make_run(code=1, stderr="Error: bad")):
        out = axel_cli.remember(LONG_CONTENT, category="cases", topic=GOOD_TOPIC)
    assert out["status"] == "error"
    assert out["memory_id"] is None
    assert "bad" in out["error"]


# ── live (gated) ───────────────────────────────────────────────────────────
@pytest.mark.skipif(os.environ.get("XCAL_LIVE_AXEL") != "1",
                    reason="live axel gated behind XCAL_LIVE_AXEL=1")
def test_live_axel_smoke():
    out = axel_cli.search("test", limit=1)
    assert out["status"] in ("ok", "error")


@pytest.mark.skipif(os.environ.get("XCAL_LIVE_AXEL") != "1",
                    reason="live axel round-trip gated behind XCAL_LIVE_AXEL=1")
def test_remember_live_round_trip(tmp_path, monkeypatch):
    """Live: against a temp brain, write content and assert a real mem_ id."""
    brain = tmp_path / "brain"
    bin_ = os.environ.get("AXEL_BIN", "axel")
    subprocess.run([bin_, "--brain", str(brain), "init"], check=True,
                   capture_output=True, text=True)
    content = "Live round-trip test content — must exceed fifty characters for axel."
    out = axel_cli.remember(content, category="cases", topic="live-test",
                            brain=str(brain))
    assert out["status"] == "ok", out
    assert out["memory_id"] and out["memory_id"].startswith("mem_")
