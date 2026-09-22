"""Session accounting + JSONL audit trail.

Audit records never contain full file bodies — only what was sent to Jev
(previews) and what came back. Best-effort: a failed write never breaks a
hook.
"""

from __future__ import annotations

from collections import deque

import json
import os
import time
from pathlib import Path


def synaps_base_dir() -> Path:
    configured = os.environ.get("SYNAPS_BASE_DIR")
    return Path(configured) if configured else Path.home() / ".synaps-cli"


OPS = frozenset("compress router triage discovery reports verification evidence select decide guard diagnose context".split())
GLOSS = {
    "lowconfidence": "Valid answer below the local confidence threshold.",
    "modelabstention": "Model selected the supplied abstention option.",
    "invalidresponse": "Response failed local schema validation.",
    "transporterror": "Decision transport failed; no upstream details retained.",
    "review": "Ambiguous outcome; local review remains necessary.",
    "accepted": "Passed local validation; not source authority.",
    "local": "Deterministic local handling; no model decision.",
    "cache": "Reused a lifecycle cache entry; no new decision call.",
    "disabled": "Feature disabled.", "nokey": "No API key configured.",
    "explicitfields": "Explicit caller fields leave nothing to fill.",
    "noeconomiccandidate": "No eligible economic candidate for this operation.",
    "continue": "Guard locally continued.", "confirm": "Guard locally requested confirmation.",
    "block": "Guard locally blocked.",
    "budget_calls": "Optional call budget exhausted.",
    "budget_cost": "Optional estimated cost budget exhausted.",
    "budget_latency": "Optional latency budget exhausted.",
    "budget_unknown_usage": "Unknown usage prevents optional budget admission.",
    "circuit_open": "Optional error circuit denied admission.",
    "notpressure": "No host context pressure at a finished turn; no boundary decision.",
}


def classify_choice(answer, criteria, threshold=.8, *, validator=None):
    """Diagnostics only. Never used to authorize an action or relax acceptance."""
    from .triage import valid_choice
    if validator is None:
        def validator(a):
            if (not isinstance(a, dict) or set(a) - {"type", "choice", "confidence", "probabilities", "score"}
                    or a.get("type", "choice") != "choice"):
                return None
            p = a.get("probabilities")
            if isinstance(p, dict) and set(p) - criteria.keys():
                return None
            return valid_choice(a, criteria, threshold=0)
    try:
        choice = validator(answer)
        if choice is None or choice is False:
            return "invalidresponse"
        if answer.get("choice") in ("unknown", "abstain", "__jev_abstain__", "keep", "unclear"):
            return "modelabstention"
        if answer["confidence"] < threshold:
            return "lowconfidence"
        return "accepted"
    except (TypeError, ValueError, KeyError, OverflowError):
        return "invalidresponse"


def explain_error(audit, op, error):
    # The client owns transport/budget diagnostics. Hook-local errors remain review.
    if not getattr(error, "diagnosed", False):
        audit.explain(op, "review")


class Audit:
    def __init__(self, audit_file: str | None) -> None:
        self.path: Path | None = None
        if audit_file:
            p = Path(audit_file)
            self.path = p if p.is_absolute() else synaps_base_dir() / p
        self.counters: dict[str, int] = {}
        self._explanations = deque(maxlen=64)
        self._sequence = 0

    def explain(self, op, reason):
        if not isinstance(op, str) or not isinstance(reason, str) or op not in OPS or reason not in GLOSS:
            return
        self._sequence += 1
        self._explanations.append({"sequence": self._sequence, "op": op, "reason": reason})

    def explanations(self):
        return [dict(row) for row in self._explanations]

    def clear_explanations(self):
        self._explanations.clear()

    def bump(self, key: str) -> None:
        self.counters[key] = self.counters.get(key, 0) + 1

    def write(self, record: dict) -> None:
        if self.path is None:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            record.setdefault("ts", round(time.time(), 3))
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, separators=(",", ":")) + "\n")
            # Keep the audit log private: it contains command text.
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        except OSError:
            pass
