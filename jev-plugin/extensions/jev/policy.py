"""Optional session budgets. Input-only cost is an estimate, not a dollar cap."""
from __future__ import annotations

import hashlib
import math
import time
import unicodedata
from contextlib import contextmanager
from dataclasses import dataclass, field

from .client import JevError, PRICE_PER_MTOK_INPUT

LIMITS = {
    "calls": (100, 1, 1_000_000, int),
    "cost_usd": (0.02, 0.000001, 1000, float),
    "latency_ms": (30000, 1, 86_400_000, int),
    "error_streak": (3, 1, 1000, int),
    "cooldown_s": (60, 0.001, 86400, float),
}


def validate(name, value):
    if name == "enabled":
        if value in ("true", "on"):
            return True
        if isinstance(value, bool):
            return value
        if value in ("false", "off"):
            return False
        raise ValueError("budget enabled must be on or off")
    _, low, high, kind = LIMITS[name]
    try:
        number = float(value)
        if isinstance(value, bool) or not math.isfinite(number) or not low <= number <= high or (kind is int and not number.is_integer()):
            raise ValueError
        return kind(number)
    except (ValueError, TypeError, OverflowError):
        raise ValueError(f"budget {name} must be finite in [{low}, {high}]") from None


class PolicyDenied(JevError):
    def __init__(self, reason):
        if reason not in {"budget_calls", "budget_cost", "budget_latency", "budget_unknown_usage", "circuit_open"}:
            reason = "budget_unknown_usage"
        self.reason = reason
        super().__init__(reason)


@dataclass
class Ledger:
    wire_attempts: int = 0
    known_input_tokens: int = 0
    unknown_usage_attempts: int = 0
    latency_ms: float = 0
    error_streak: int = 0
    open_until: float = 0
    half_open: bool = False
    denied: dict = field(default_factory=dict)

    def snapshot(self):
        cost = self.known_input_tokens * PRICE_PER_MTOK_INPUT / 1e6
        return {"wire_attempts": self.wire_attempts,
                "input_tokens": None if self.unknown_usage_attempts else self.known_input_tokens,
                "cost_usd": None if self.unknown_usage_attempts else cost,
                "known_input_tokens": self.known_input_tokens,
                "known_cost_usd": cost,
                "unknown_usage_attempts": self.unknown_usage_attempts,
                "latency_ms": self.latency_ms, "error_streak": self.error_streak,
                "denied": dict(self.denied)}


class BudgetPolicy:
    """128 ledgers total: unscoped, overflow, and at most 126 digested sessions.

    No eviction: new sessions at capacity share overflow to prevent fresh-budget
    bypass. The serial extension permits one implicit half-open attempt.
    """
    def __init__(self, cfg=None):
        self.settings = {k: v[0] for k, v in LIMITS.items()}
        self.settings["enabled"] = False
        self.scope = "unscoped"
        self.reset()
        self.configure(cfg or {})

    def configure(self, cfg):
        updates = {name: validate(name, cfg["budget_" + name])
                   for name in self.settings if "budget_" + name in cfg}
        self.settings.update(updates)

    def reset(self):
        self.ledgers = {"unscoped": Ledger(), "overflow": Ledger()}

    @contextmanager
    def scoped(self, session_id=None):
        previous = self.scope
        valid = (isinstance(session_id, str) and bool(session_id.strip())
                 and len(session_id) <= 256
                 and not any(unicodedata.category(c).startswith("C") for c in session_id))
        self.scope = hashlib.sha256(session_id.encode()).hexdigest() if valid else "unscoped"
        try:
            yield
        finally:
            self.scope = previous

    def ledger(self):
        key = self.scope
        if key not in self.ledgers:
            if len(self.ledgers) >= 128:
                key = "overflow"
            else:
                self.ledgers[key] = Ledger()
        return self.ledgers[key]

    def deny(self, ledger, reason):
        ledger.denied[reason] = ledger.denied.get(reason, 0) + 1
        raise PolicyDenied(reason)

    def check(self, ledger, elapsed_ms=0):
        if not self.settings["enabled"]:
            return
        s = self.settings
        if ledger.wire_attempts >= s["calls"]:
            self.deny(ledger, "budget_calls")
        if ledger.known_input_tokens * PRICE_PER_MTOK_INPUT / 1e6 >= s["cost_usd"]:
            self.deny(ledger, "budget_cost")
        if ledger.latency_ms + elapsed_ms >= s["latency_ms"]:
            self.deny(ledger, "budget_latency")
        if ledger.half_open or (ledger.error_streak >= s["error_streak"] and time.monotonic() < ledger.open_until):
            self.deny(ledger, "circuit_open")
        if ledger.unknown_usage_attempts:
            self.deny(ledger, "budget_unknown_usage")

    def reserve(self, ledger, elapsed_ms):
        self.check(ledger, elapsed_ms)
        if self.settings["enabled"] and ledger.error_streak >= self.settings["error_streak"]:
            ledger.half_open = True
        ledger.wire_attempts += 1

    def observe(self, ledger, tokens, failed):
        if tokens is None:
            ledger.unknown_usage_attempts += 1
        else:
            ledger.known_input_tokens += tokens
        ledger.half_open = False
        ledger.error_streak = ledger.error_streak + 1 if failed else 0
        if failed and ledger.error_streak >= self.settings["error_streak"]:
            ledger.open_until = time.monotonic() + self.settings["cooldown_s"]

    def snapshot(self):
        snaps = [l.snapshot() for l in self.ledgers.values()]
        aggregate = {k: sum(s[k] for s in snaps) for k in ("wire_attempts", "known_input_tokens", "known_cost_usd", "unknown_usage_attempts", "latency_ms")}
        aggregate["input_tokens"] = None if aggregate["unknown_usage_attempts"] else aggregate["known_input_tokens"]
        aggregate["cost_usd"] = None if aggregate["unknown_usage_attempts"] else aggregate["known_cost_usd"]
        aggregate["denied"] = {}
        for s in snaps:
            for k, v in s["denied"].items():
                aggregate["denied"][k] = aggregate["denied"].get(k, 0) + v
        return {"settings": dict(self.settings), "ledger_count": len(self.ledgers),
                "aggregate": aggregate, "unscoped": self.ledgers["unscoped"].snapshot(),
                "overflow": self.ledgers["overflow"].snapshot(),
                "scope_fallback": "untrusted/missing context: unscoped; capacity: shared overflow"}
