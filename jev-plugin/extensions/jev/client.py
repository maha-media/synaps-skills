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


@dataclass
class Stats:
    calls: int = 0
    errors: int = 0
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
            "input_tokens": self.input_tokens,
            "cost_usd": round(self.cost_usd, 6),
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
    ) -> None:
        if not api_key:
            raise JevError("api_key is empty")
        self.api_key = api_key
        self.model = model
        self.timeout_s = min(4.0, max(0.1, timeout_s)) if math.isfinite(timeout_s) else 3.0
        self.base_url = base_url
        self.stats = Stats()

    # ── public ──────────────────────────────────────────────────────────────

    def decide(self, state, questions: dict, *, op: str = "decide") -> dict:
        """POST one batch. Returns the parsed response body.

        Raises JevError on any failure. Retries once on 429/529 if there is
        budget left; never sleeps past the hook deadline.
        """
        body = json.dumps({"state": state, "model": self.model, "questions": questions}).encode("utf-8")
        t0 = time.monotonic()
        deadline = t0 + self.timeout_s
        attempt = 0
        resp = {}
        failed = False
        try:
            while True:
                attempt += 1
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise JevError("deadline exceeded")
                try:
                    resp = self._bounded_post(body, remaining)
                    if time.monotonic() > deadline:
                        raise JevError("deadline exceeded")
                    if not isinstance(resp, dict):
                        raise JevError("invalid response")
                    return resp
                except _Retryable as e:
                    remaining = deadline - time.monotonic()
                    delay = e.retry_after if math.isfinite(e.retry_after) else 0.3
                    delay = min(max(0.0, delay), 1.0)
                    if attempt >= 2 or remaining < delay + 0.1:
                        raise JevError("retry budget exhausted") from e
                    time.sleep(delay)
        except JevError:
            failed = True
            self.stats.errors += 1
            raise
        finally:
            self._record(op, resp if isinstance(resp, dict) else {}, t0, failed)

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
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:300]
            except Exception:  # noqa: BLE001
                pass
            if e.code in (429, 529):
                ra = e.headers.get("retry-after") if e.headers else None
                try:
                    ra_s = float(ra) if ra else 0.3
                except ValueError:
                    ra_s = 0.3
                raise _Retryable(f"HTTP {e.code}: {detail}", ra_s) from e
            raise JevError(f"HTTP {e.code}: {detail}") from e
        except urllib.error.URLError as e:
            raise JevError(f"network: {e.reason}") from e
        except (TimeoutError, OSError) as e:
            raise JevError(f"timeout/io: {e}") from e
        except json.JSONDecodeError as e:
            raise JevError(f"bad json: {e}") from e

    def _record(self, op: str, resp: dict, t0: float, failed: bool = False) -> None:
        s = self.stats
        s.calls += 1
        s.total_ms += int((time.monotonic() - t0) * 1000)
        usage = resp.get("usage")
        tokens = usage.get("input_tokens", 0) if isinstance(usage, dict) else 0
        tokens = tokens if isinstance(tokens, int) and not isinstance(tokens, bool) and tokens >= 0 else 0
        s.input_tokens += tokens
        s.last_model = str(resp.get("model") or s.last_model)
        s.by_op[op] = s.by_op.get(op, 0) + 1
        o = s.op_stats.setdefault(op, {"calls": 0, "errors": 0, "input_tokens": 0, "total_ms": 0, "mean_ms": 0, "cost_usd": 0.0})
        o["calls"] += 1
        o["errors"] += int(failed)
        o["input_tokens"] += tokens
        o["total_ms"] += int((time.monotonic() - t0) * 1000)
        o["mean_ms"] = o["total_ms"] // o["calls"]
        o["cost_usd"] = o["input_tokens"] * PRICE_PER_MTOK_INPUT / 1_000_000


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
