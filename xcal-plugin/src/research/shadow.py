"""shadow — Verdict Journal + outcome attribution.

Inspired by Vibe-Trading's Shadow Account pattern: record every verdict
xcal emits, then score whether it was right once prices move.

Lifecycle: open → monitoring → scored

Usage:
    from .shadow import record_verdict, load_journal, score_journal

    rec = record_verdict(verdict, price_at_verdict=150.0)
    records = load_journal()
    stats = score_journal(records, lambda t: current_prices.get(t))
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from .verdict import Verdict


# ── dataclass ────────────────────────────────────────────────────────────────

@dataclass
class VerdictRecord:
    ticker: str
    question: str
    stance: Optional[str]           # "pass" | "fail" | "grey_zone" | None
    confidence: float               # mean of finding.confidence, or 0.0
    n_findings: int
    n_red_flags: int
    mirror_test_present: bool
    price_at_verdict: Optional[float]
    ts: str                         # ISO-8601 UTC
    skill_used: str
    status: str = "open"            # open | monitoring | scored
    memory_id: Optional[str] = None


# ── path resolution ──────────────────────────────────────────────────────────

def _default_journal_path() -> Path:
    env = os.environ.get("XCAL_JOURNAL", "")
    if env:
        return Path(env)
    return Path.home() / ".config" / "xcal" / "verdicts.jsonl"


def _resolve(journal_path) -> Path:
    if journal_path is None:
        return _default_journal_path()
    return Path(journal_path)


# ── record_verdict ───────────────────────────────────────────────────────────

def record_verdict(verdict, *, price_at_verdict=None, journal_path=None):
    """Build a VerdictRecord from a Verdict, append it to the journal.

    Best-effort: never raises. Returns the record regardless of I/O outcome.
    """
    confs = [f.confidence for f in verdict.findings if f.confidence is not None]
    confidence = sum(confs) / len(confs) if confs else 0.0

    rec = VerdictRecord(
        ticker=verdict.ticker,
        question=verdict.question,
        stance=verdict.stance,
        confidence=confidence,
        n_findings=len(verdict.findings),
        n_red_flags=len(verdict.red_flags),
        mirror_test_present=bool(verdict.mirror_test),
        price_at_verdict=price_at_verdict,
        ts=datetime.now(timezone.utc).isoformat(),
        skill_used=verdict.skill_used,
        status="open",
        memory_id=verdict.axel_memory_id,
    )

    try:
        path = _resolve(journal_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(asdict(rec), ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001 — best-effort, never raise
        pass

    return rec


# ── load_journal ─────────────────────────────────────────────────────────────

def load_journal(journal_path=None):
    """Read the JSONL journal; skip malformed lines tolerantly."""
    path = _resolve(journal_path)
    records = []
    try:
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    records.append(VerdictRecord(**obj))
                except Exception:  # noqa: BLE001 — skip malformed
                    pass
    except FileNotFoundError:
        pass
    except Exception:  # noqa: BLE001
        pass
    return records


# ── score_journal ─────────────────────────────────────────────────────────────

def score_journal(records, current_price_fn, *, market_return=0.0):
    """Attribution pass.

    For each record that has price_at_verdict, compute return vs market and
    determine directional accuracy:
      - 'fail' is CORRECT if return < market_return  (thesis: avoid)
      - 'pass' is CORRECT if return > market_return  (thesis: buy)
      - 'grey_zone' is excluded from accuracy (non-call)

    Returns:
        {
          "by_stance": {
            "<stance>": {"avg_return": float, "count": int, "correct": int}
          },
          "directional_accuracy": float,   # correct / n_calls
          "n_scored": int,                 # records with a priceable outcome
          "n_calls": int,                  # scored records with actionable stance
        }
    """
    by_stance = {}
    n_scored = 0
    n_calls = 0
    n_correct = 0

    for rec in records:
        if rec.price_at_verdict is None or rec.price_at_verdict == 0.0:
            continue

        current = current_price_fn(rec.ticker)
        if current is None:
            continue

        ret = (current - rec.price_at_verdict) / rec.price_at_verdict
        n_scored += 1

        stance = rec.stance or "none"
        bucket = by_stance.setdefault(stance, {"avg_return": 0.0, "count": 0, "correct": 0})
        bucket["count"] += 1
        # running mean
        prev_n = bucket["count"] - 1
        bucket["avg_return"] = (bucket["avg_return"] * prev_n + ret) / bucket["count"]

        # directional accuracy — only for actionable stances
        if stance in ("pass", "fail"):
            n_calls += 1
            correct = (stance == "pass" and ret > market_return) or \
                      (stance == "fail" and ret < market_return)
            if correct:
                n_correct += 1
                bucket["correct"] += 1

    directional_accuracy = (n_correct / n_calls) if n_calls > 0 else 0.0

    return {
        "by_stance": by_stance,
        "directional_accuracy": directional_accuracy,
        "n_scored": n_scored,
        "n_calls": n_calls,
    }
