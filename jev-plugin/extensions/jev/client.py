"""HTTP client for the TypeSafe System One endpoint.

Stdlib only. One request per decision batch; honours the hook budget by
keeping timeout + at most one retry under ~4.5 s (the runtime's
HANDLER_TIMEOUT is 5 s and is fail-open, so we must answer before it).
"""

from __future__ import annotations

import json
import math
import signal
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

API_URL = "https://api.typesafe.ai/v1/systemone"
PRICE_PER_MTOK_INPUT = 0.042  # USD; output tokens are free (docs.typesafe.ai/models)


class JevError(Exception):
    """Any upstream failure: network, auth, validation, rate limit."""


def usage_tokens(resp):
    usage = resp.get("usage") if isinstance(resp, dict) else None
    tokens = usage.get("input_tokens") if isinstance(usage, dict) else None
    return tokens if type(tokens) is int and 0 <= tokens <= 2**53 - 1 else None


@dataclass
class Stats:
    calls: int = 0
    errors: int = 0
    wire_attempts: int = 0
    retries: int = 0
    unknown_usage_calls: int = 0
    unknown_usage_attempts: int = 0
    input_tokens: int = 0
    total_ms: int = 0
    last_model: str = ""
    by_op: dict[str, int] = field(default_factory=dict)

    op_stats: dict[str, dict] = field(default_factory=dict)

    @property
    def cost_usd(self) -> float:
        return self.input_tokens * PRICE_PER_MTOK_INPUT / 1_000_000

    @property
    def mean_ms(self) -> int:
        return self.total_ms // self.calls if self.calls else 0

    def snapshot(self) -> dict:
        return {
            "calls": self.calls,
            "errors": self.errors,
            "input_tokens": None if self.unknown_usage_calls or self.unknown_usage_attempts else self.input_tokens,
            "cost_usd": None if self.unknown_usage_calls or self.unknown_usage_attempts else round(self.cost_usd, 6),
            "known_input_tokens": self.input_tokens,
            "known_cost_usd": self.cost_usd,
            "unknown_usage_calls": self.unknown_usage_calls,
            "unknown_usage_attempts": self.unknown_usage_attempts,
            "wire_attempts": self.wire_attempts,
            "retries": self.retries,
            "mean_ms": self.mean_ms,
            "model": self.last_model,
            "by_op": dict(self.by_op),
            "op_stats": {k: dict(v) for k, v in self.op_stats.items()},
            "cost_basis": "estimated Jev input-token cost only; no savings estimate",
        }


class DecisionClient:
    def __init__(
        self,
        api_key: str,
        model: str = "jev-latest",
        timeout_s: float = 3.0,
        base_url: str = API_URL,
        policy=None,
    ) -> None:
        if not api_key:
            raise JevError("api_key is empty")
        self.api_key = api_key
        self.model = model
        self.timeout_s = min(4.0, max(0.1, timeout_s)) if math.isfinite(timeout_s) else 3.0
        self.base_url = base_url
        self.stats = Stats()
        self.policy = policy

    # ── public ──────────────────────────────────────────────────────────────

    def decide(self, state, questions: dict, *, op: str = "decide") -> dict:
        """POST one batch. Returns the parsed response body.

        Raises JevError on any failure. Retries once on 429/529 if there is
        budget left; never sleeps past the hook deadline.
        """
        from .policy import PolicyDenied
        t0 = time.monotonic()
        deadline = t0 + self.timeout_s
        policy = self.policy if op not in ("guard", "probe", "test") else None
        ledger = policy.ledger() if policy else None
        attempt = 0
        resp = {}
        failed = False
        denied = False
        unknown_attempts = 0
        known_tokens = 0
        try:
            body = json.dumps({"state": state, "model": self.model, "questions": questions}).encode("utf-8")
            while True:
                now = time.monotonic()
                if policy:
                    policy.check(ledger, max(0, now - t0) * 1000)
                    if policy.settings["enabled"]:
                        deadline = min(deadline, t0 + max(0, policy.settings["latency_ms"] - ledger.latency_ms) / 1000)
                remaining = deadline - now
                if remaining <= 0:
                    raise JevError("deadline exceeded")
                if policy:
                    policy.reserve(ledger, max(0, now - t0) * 1000)
                attempt += 1
                self.stats.wire_attempts += 1
                self.stats.retries += int(attempt > 1)
                wire_resp = {}
                wire_failed = True
                retry = None
                try:
                    wire_resp = self._bounded_post(body, remaining)
                    resp = wire_resp
                    if time.monotonic() > deadline:
                        raise JevError("deadline exceeded")
                    if not isinstance(resp, dict):
                        raise JevError("invalid response")
                    wire_failed = False
                except _Retryable as e:
                    retry = e
                finally:
                    tokens = usage_tokens(wire_resp)
                    if tokens is None:
                        unknown_attempts += 1
                        self.stats.unknown_usage_attempts += 1
                    else:
                        known_tokens += tokens
                    if policy:
                        policy.observe(ledger, tokens, wire_failed)
                if retry is None:
                    return resp
                if policy:
                    policy.check(ledger, max(0, time.monotonic() - t0) * 1000)
                remaining = deadline - time.monotonic()
                delay = retry.retry_after if math.isfinite(retry.retry_after) else 0.3
                delay = min(max(0.0, delay), 1.0)
                if attempt >= 2 or remaining < delay + 0.1:
                    raise JevError("retry budget exhausted") from retry
                time.sleep(delay)
        except PolicyDenied:
            denied = True
            raise
        except Exception as e:
            failed = True
            self.stats.errors += 1
            if isinstance(e, JevError):
                raise
            raise JevError("decision transport or response failure") from None
        finally:
            if policy and attempt:
                ledger.latency_ms += max(0, time.monotonic() - t0) * 1000
            if not denied or attempt:
                self._record(op, resp if isinstance(resp, dict) else {}, t0, failed,
                             wire_attempts=attempt, unknown_attempts=unknown_attempts, known_tokens=known_tokens)

    # ── internals ───────────────────────────────────────────────────────────

    def _bounded_post(self, body: bytes, remaining: float) -> dict:
        # urllib's timeout is per socket operation, not wall time (DNS and
        # trickling bodies can exceed it). The stdio host dispatches on the
        # main thread: use a scoped POSIX timer for that full transport span.
        if not hasattr(signal, "setitimer") or threading.current_thread() is not threading.main_thread():
            raise JevError("hard transport deadline unavailable")
        previous_handler = signal.getsignal(signal.SIGALRM)
        previous_timer = signal.getitimer(signal.ITIMER_REAL)
        if previous_timer != (0.0, 0.0):
            raise JevError("transport deadline timer already in use")

        def expired(signum, frame):
            raise JevError("deadline exceeded")

        signal.signal(signal.SIGALRM, expired)
        try:
            signal.setitimer(signal.ITIMER_REAL, remaining)
            return self._post(body, timeout_s=remaining)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)

    def _post(self, body: bytes, *, timeout_s: float) -> dict:
        req = urllib.request.Request(
            self.base_url,
            data=body,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "User-Agent": "synaps-jev-plugin/0.1",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 529):
                ra = e.headers.get("retry-after") if e.headers else None
                try:
                    ra_s = float(ra) if ra else 0.3
                except ValueError:
                    ra_s = 0.3
                raise _Retryable(f"HTTP {e.code}", ra_s) from e
            raise JevError(f"HTTP {e.code}") from e
        except JevError:
            raise
        except Exception:
            # Never surface upstream payloads, URLs, credentials or exception text.
            raise JevError("transport or response decoding failure") from None

    def _record(self, op: str, resp: dict, t0: float, failed: bool = False,
                *, wire_attempts: int = 0, unknown_attempts: int = 0,
                known_tokens: int | None = None) -> None:
        s = self.stats
        elapsed = max(0, int((time.monotonic() - t0) * 1000))
        tokens = usage_tokens(resp) if known_tokens is None else known_tokens
        unknown = tokens is None or unknown_attempts > 0 or (known_tokens is not None and not wire_attempts)
        s.calls += 1
        s.total_ms += elapsed
        s.unknown_usage_calls += int(unknown)
        s.input_tokens += tokens or 0
        model = resp.get("model")
        if isinstance(model, str) and len(model) <= 256:
            s.last_model = model
        s.by_op[op] = s.by_op.get(op, 0) + 1
        o = s.op_stats.setdefault(op, {"calls": 0, "errors": 0, "known_input_tokens": 0,
            "total_ms": 0, "unknown_usage_calls": 0, "wire_attempts": 0,
            "unknown_usage_attempts": 0, "retries": 0})
        o["calls"] += 1
        o["errors"] += int(failed)
        o["known_input_tokens"] += tokens or 0
        o["unknown_usage_calls"] += int(unknown)
        o["wire_attempts"] += wire_attempts
        o["unknown_usage_attempts"] += unknown_attempts
        o["retries"] += max(0, wire_attempts - 1)
        o["total_ms"] += elapsed
        o["mean_ms"] = o["total_ms"] // o["calls"]
        o["known_cost_usd"] = o["known_input_tokens"] * PRICE_PER_MTOK_INPUT / 1e6
        o["input_tokens"] = None if o["unknown_usage_calls"] else o["known_input_tokens"]
        o["cost_usd"] = None if o["unknown_usage_calls"] else o["known_cost_usd"]


class _Retryable(Exception):
    def __init__(self, msg: str, retry_after: float) -> None:
        super().__init__(msg)
        self.retry_after = retry_after


# ── answer helpers (pure) ───────────────────────────────────────────────────

def top_level(answer: dict) -> tuple[str, str]:
    """For a score answer: (level_key, legend_text) of the most probable level."""
    probs = answer.get("probabilities") or {}
    if not probs:
        return "", ""
    k = max(probs, key=lambda x: probs[x])
    return k, str((answer.get("legend") or {}).get(k, k))
