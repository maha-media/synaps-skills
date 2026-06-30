"""finlens.data.stocktwits — thin public-API client for StockTwits.

Two public functions:
  fetch_symbol_stream(ticker) -> list[dict]   — raw message dicts from
      https://api.stocktwits.com/api/2/streams/symbol/{T}.json
  fetch_trending()            -> list[str]    — symbol strings from
      https://api.stocktwits.com/api/2/trending/symbols.json

Design rules:
  - Pure data fetch. Zero scoring, zero opinion.
  - Graceful on failure: fetch_symbol_stream returns [] and
    fetch_trending returns [] if the API is unreachable or returns garbage.
  - Retries with backoff copied from the v2 reference scanner.
  - Respects the public UA header convention the v2 reference uses.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from typing import Any

# ── constants ────────────────────────────────────────────────────────────────
_UA = "Mozilla/5.0 (finance-poc/0.2)"
_BASE = "https://api.stocktwits.com/api/2"
_TIMEOUT = 15   # seconds per request
_TRIES = 3      # retry attempts
_BACKOFF = 1.5  # seconds between retries


# ── internal helpers ─────────────────────────────────────────────────────────

def _get(url: str) -> Any | None:
    """HTTP GET → parsed JSON, or None on any failure (with stderr warning)."""
    for attempt in range(_TRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": _UA})
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
                return json.load(resp)
        except Exception as exc:  # noqa: BLE001
            if attempt == _TRIES - 1:
                print(
                    f"[stocktwits] fetch failed {url}: {exc}",
                    file=sys.stderr,
                )
                return None
            time.sleep(_BACKOFF)
    return None  # unreachable, but satisfies type-checker


# ── public API ───────────────────────────────────────────────────────────────

def fetch_symbol_stream(ticker: str) -> list[dict]:
    """Fetch the most-recent StockTwits message stream for *ticker*.

    Returns a list of raw message dicts (may be empty on failure or
    rate-limit). The caller decides what to do with them — no filtering here.

    Each dict has at least:
      "body"       : str  — the post text
      "created_at" : str  — ISO-ish timestamp ("2025-01-20T14:32:00Z")
      "entities"   : {
          "sentiment": {"basic": "Bullish" | "Bearish" | null}
      }
    """
    url = f"{_BASE}/streams/symbol/{ticker.upper()}.json"
    data = _get(url)
    if not data:
        return []
    return list(data.get("messages", []))


def fetch_trending() -> list[str]:
    """Fetch the current list of trending ticker symbols.

    Returns a list of uppercase symbol strings, or [] on failure.
    """
    url = f"{_BASE}/trending/symbols.json"
    data = _get(url)
    if not data:
        return []
    symbols = data.get("symbols", [])
    return [s["symbol"] for s in symbols if isinstance(s, dict) and "symbol" in s]
