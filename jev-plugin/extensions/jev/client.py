"""HTTP client for the TypeSafe System One endpoint.

Stdlib only. One request per decision batch; honours the hook budget by
keeping timeout + at most one retry under ~4.5 s (the runtime's
HANDLER_TIMEOUT is 5 s and is fail-open, so we must answer before it).
"""

from __future__ import annotations

import json
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
        self.timeout_s = timeout_s
        self.base_url = base_url
        self.stats = Stats()

    # ── public ──────────────────────────────────────────────────────────────

    def decide(self, state, questions: dict, *, op: str = "decide") -> dict:
        """POST one batch. Returns the parsed response body.

        Raises JevError on any failure. Retries once on 429/529 if there is
        budget left; never sleeps past the hook deadline.
        """
        body = json.dumps({"state": state, "model": self.model, "questions": questions}).encode("utf-8")
        deadline = time.monotonic() + self.timeout_s + 1.2  # one bounded retry window
        attempt = 0
        t0 = time.monotonic()
        while True:
            attempt += 1
            try:
                resp = self._post(body)
                self._record(op, resp, t0)
                return resp
            except _Retryable as e:
                remaining = deadline - time.monotonic()
                if attempt >= 2 or remaining < 0.6:
                    self.stats.errors += 1
                    raise JevError(str(e)) from e
                time.sleep(min(e.retry_after, max(0.0, remaining - 0.5), 1.0))
            except JevError:
                self.stats.errors += 1
                raise

    # ── internals ───────────────────────────────────────────────────────────

    def _post(self, body: bytes) -> dict:
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
            with urllib.request.urlopen(req, timeout=self.timeout_s) as r:
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

    def _record(self, op: str, resp: dict, t0: float) -> None:
        s = self.stats
        s.calls += 1
        s.total_ms += int((time.monotonic() - t0) * 1000)
        s.input_tokens += int((resp.get("usage") or {}).get("input_tokens") or 0)
        s.last_model = str(resp.get("model") or s.last_model)
        s.by_op[op] = s.by_op.get(op, 0) + 1


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
