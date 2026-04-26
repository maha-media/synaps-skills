"""
web-tools/_lib/hooks.py

PRE / ACT / POST hook helpers for individual capability scripts (Python side).

Per the self-healing protocol every script does:

    PRE   recall_and_emit(query, host=..., op=...)
    ACT   ... real work ...
    POST  on success: exit 0 (NO auto-write)
          on failure: fail_and_exit(host=..., op=..., err=...)

All hook calls are best-effort and NEVER throw — they swallow internal
errors so a flaky velocirag install can't break the actual capability.

API:
    extract_host(url)                       -> str|None
    classify_error(err, *, stderr=, exit=)  -> str
    recall_and_emit(query, **opts)          -> list[hit]
    fail_and_exit(**opts)                   -> NoReturn

Env:
    WEB_HOOKS_QUIET   suppress stderr surface output
    WEB_MEMORY_DEBUG  passthrough to _lib/memory
"""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Any, NoReturn
from urllib.parse import urlparse

try:
    from . import memory  # type: ignore
except ImportError:
    # Allow direct execution via `sys.path.insert(0, .../scripts)` + `from _lib import hooks`
    import memory  # type: ignore


QUIET = bool(os.environ.get("WEB_HOOKS_QUIET"))


def _stderr(*a: Any) -> None:
    if not QUIET:
        print(*a, file=sys.stderr)


# ── host / url helpers ─────────────────────────────────────────────────────

_HOST_RX = re.compile(r"([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}", re.I)


def extract_host(url_or_text: str | None) -> str | None:
    if not url_or_text:
        return None
    s = str(url_or_text)
    try:
        u = urlparse(s)
        if u.hostname:
            return u.hostname.lower().lstrip().removeprefix("www.")
    except Exception:
        pass
    m = _HOST_RX.search(s)
    return m.group(0).lower().removeprefix("www.") if m else None


# ── error classifier ────────────────────────────────────────────────────────

_CLASS_RX = [
    (re.compile(r"\b(403|forbidden)\b", re.I),                "http_403"),
    (re.compile(r"\b(401|unauthor[i\s]?z?ed)\b", re.I),       "http_401"),
    (re.compile(r"\b(404|not\s*found)\b", re.I),              "http_404"),
    (re.compile(r"\b(429|too\s*many)\b", re.I),               "http_429"),
    (re.compile(r"\b(5\d\d|server\s*error|bad\s*gateway)\b", re.I), "http_5xx"),
    (re.compile(r"\b(timed?\s*out|deadline)\b", re.I),        "timeout"),
    (re.compile(r"\b(getaddrinfo|name or service|dns)\b", re.I),    "dns"),
    (re.compile(r"\b(connection\s*refused)\b", re.I),         "conn_refused"),
    (re.compile(r"\b(connection\s*reset)\b", re.I),           "conn_reset"),
    (re.compile(r"cert(ificate)?|TLS|SSL|self[-\s]signed", re.I),   "tls"),
    (re.compile(r"captcha|cloudflare\s*challenge", re.I),     "captcha"),
    (re.compile(r"out\s*of\s*memory|OOM|CUDA\s*out", re.I),   "oom"),
    (re.compile(r"no\s*captions|TRANSCRIPT_UNAVAILABLE", re.I), "no_transcript"),
    (re.compile(r"age[-\s]?gate|age\s*restricted", re.I),     "age_gate"),
    (re.compile(r"quota|rate\s*limit", re.I),                 "rate_limit"),
    (re.compile(r"ffmpeg|encoder|codec", re.I),               "media_decode"),
    (re.compile(r"unsupported\s*format", re.I),               "unsupported_format"),
    (re.compile(r"file\s*not\s*found|no\s*such\s*file", re.I), "file_not_found"),
]


def classify_error(err: Any, *, stderr: str = "", exit: int | None = None) -> str:
    text_parts: list[str] = []
    if isinstance(err, BaseException):
        text_parts.append(str(err))
    elif err is not None:
        text_parts.append(str(err))
    if stderr:
        text_parts.append(stderr)
    text = " ".join(text_parts)
    for rx, cls in _CLASS_RX:
        if rx.search(text):
            return cls
    if exit and exit != 0:
        return f"exit_{exit}"
    return "unknown"


# ── PRE hook ────────────────────────────────────────────────────────────────

def recall_and_emit(query: str, *, host: str | None = None,
                    op: str | None = None, tags: list[str] | None = None,
                    limit: int = 5, label: str = "memory") -> list[dict]:
    """Run memory.recall and pretty-print hits to stderr. Returns hits."""
    try:
        all_tags = list(tags or [])
        if host:
            all_tags.append(f"domain-{host.replace('.', '-')}")
        if op:
            all_tags.append(f"op-{op}")
        hits = memory.recall(query, limit=limit, tags=all_tags) or []
        if not hits or QUIET:
            return hits
        n = len(hits)
        tag_str = f" [{', '.join(all_tags)}]" if all_tags else ""
        _stderr(f"[{label}] {n} hit{'' if n == 1 else 's'} for \"{query}\"{tag_str}:")
        for h in hits:
            file = h.get("file") or h.get("path") or (h.get("metadata") or {}).get("file") or "?"
            score = h.get("score")
            score_str = f" ({score:.3f})" if isinstance(score, (int, float)) else ""
            title = h.get("title") or (h.get("metadata") or {}).get("title") or ""
            snippet_raw = h.get("content") or h.get("text") or h.get("body") or ""
            snippet = re.sub(r"\s+", " ", snippet_raw)[:160]
            _stderr(f"  • {title or file}{score_str}")
            if snippet:
                trail = "…" if len(snippet) == 160 else ""
                _stderr(f"    {snippet}{trail}")
        return hits
    except Exception:
        return []


# ── POST hook ───────────────────────────────────────────────────────────────

def fail_and_exit(*, host: str | None, op: str | None, err: Any,
                  exit: int = 1, err_class: str | None = None,
                  stderr: str = "", cmd: str | None = None,
                  args: dict | None = None) -> NoReturn:
    """Log failure, check staleness, emit STALE warning, exit non-zero. Never throws."""
    err_msg = str(err) if err else "failed"
    cls = err_class or classify_error(err, stderr=stderr, exit=exit)

    # Best-effort log
    try:
        memory.log_failure(
            host=host, op=op, exit=exit,
            err_class=cls,
            err=err_msg[:500],
            cmd=cmd, args=args,
        )
    except Exception:
        pass

    # Best-effort staleness check
    stale = False
    try:
        if host and op:
            stale = memory.is_stale(host, op, cls)
    except Exception:
        pass

    err_out = {
        "error": err_msg,
        "err_class": cls,
        "host": host, "op": op, "exit": exit,
        "stale": stale,
    }
    _stderr(f"✗ {op or 'op'} failed: {err_msg}")
    _stderr(f"  err_class={cls}" + (f" host={host}" if host else ""))
    if stale:
        _stderr(f"STALE: ({host}, {op}, {cls}) seen ≥2× in last 7d — recall + re-investigate.")
        _stderr(f"       velocirag search \"{host} {cls}\" --db ~/.synaps-cli/memory/web/db -l 5")
    _stderr(f"__error_json__ {json.dumps(err_out)}")
    sys.exit(exit)


__all__ = [
    "extract_host", "classify_error",
    "recall_and_emit", "fail_and_exit",
    "memory",
]
