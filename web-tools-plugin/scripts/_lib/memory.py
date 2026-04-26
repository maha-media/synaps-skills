"""
web-tools/_lib/memory.py

Thin wrapper around VelociRAG for the `web` plugin namespace.

    ~/.synaps-cli/memory/web/
      notes/         ← markdown files we write (source of truth)
      db/            ← VelociRAG's index (derived)
      failures.jsonl ← raw operational failure log

All memory writes are best-effort — they NEVER fail an op.

API:
    recall(query, *, limit=5, tags=None, threshold=None) -> list[dict]
    commit(text, *, tags=None, category=None, status='active',
           title=None, kind=None, reindex=True)          -> dict
    log_failure(**rec)                                    -> None
    recent_failures(host, op, since_ms=...)               -> list[dict]
    is_stale(host, op, err_class)                         -> bool
    reindex()                                             -> bool

Env:
    WEB_MEMORY_ROOT   override root path (default: ~/.synaps-cli/memory/web)
    WEB_MEMORY_DEBUG  if set, log diagnostics to stderr
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(os.environ.get("WEB_MEMORY_ROOT") or Path.home() / ".synaps-cli" / "memory" / "web")
NOTES = ROOT / "notes"
INDEX = ROOT / "db"
FAILURES = ROOT / "failures.jsonl"
SOURCE = "web"
TIMEOUT_S = 5.0
REINDEX_TIMEOUT_S = 30.0
STALE_THRESHOLD = 2
STALE_WINDOW_MS = 7 * 24 * 3600 * 1000
DEBUG = bool(os.environ.get("WEB_MEMORY_DEBUG"))


def _dbg(*a: Any) -> None:
    if DEBUG:
        print("[memory]", *a, file=sys.stderr)


def _ensure_dirs() -> None:
    try:
        NOTES.mkdir(parents=True, exist_ok=True)
        INDEX.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        _dbg("mkdir", e)


def velocirag_available() -> bool:
    try:
        r = subprocess.run(
            ["velocirag", "--version"],
            capture_output=True, text=True, timeout=2.0,
        )
        return r.returncode == 0
    except Exception:
        return False


# ── tag helpers ─────────────────────────────────────────────────────────────

def _normalize_tags(tags: str | Iterable[str] | None) -> list[str]:
    if not tags:
        return []
    if isinstance(tags, str):
        tags = tags.split(",")
    out = []
    for t in tags:
        t = str(t).strip()
        if not t:
            continue
        t = t.replace(":", "-").replace(".", "-").lower()
        out.append(t)
    return out


def _slug(s: str, max_len: int = 50) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(s or "note").lower()).strip("-")
    return s[:max_len] or "note"


def _short_hash(s: str) -> str:
    return hashlib.sha1(str(s).encode()).hexdigest()[:8]


def _build_frontmatter(meta: dict) -> str:
    lines = ["---"]
    for k, v in meta.items():
        if v is None:
            continue
        if isinstance(v, list):
            inner = ", ".join(json.dumps(x) for x in v)
            lines.append(f"{k}: [{inner}]")
        elif isinstance(v, str) and re.search(r"[:#\n]", v):
            lines.append(f"{k}: {json.dumps(v)}")
        else:
            lines.append(f"{k}: {v}")
    lines.append("---")
    lines.append("")
    return "\n".join(lines)


# ── recall ──────────────────────────────────────────────────────────────────

def recall(query: str, *, limit: int = 5, tags: str | Iterable[str] | None = None,
           threshold: float | None = None) -> list[dict]:
    """Semantic search across notes. Tag AND-intersection is post-filtered."""
    if not query:
        return []
    _ensure_dirs()
    norm_tags = _normalize_tags(tags)
    args = ["velocirag", "search", query, "--db", str(INDEX),
            "--format", "json", "-l", str(limit * 3)]
    if threshold is not None:
        args += ["-t", str(threshold)]
    if norm_tags:
        args += ["--tags", norm_tags[0]]
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=TIMEOUT_S)
        if r.returncode != 0:
            _dbg("recall non-zero", r.returncode, (r.stderr or "")[:200])
            return []
        try:
            hits = json.loads(r.stdout or "[]")
        except Exception:
            return []
        if isinstance(hits, dict):
            hits = hits.get("results") or hits.get("hits") or []
        if not isinstance(hits, list):
            return []
        if len(norm_tags) > 1:
            required = set(norm_tags[1:])

            def has_all(h: dict) -> bool:
                meta = h.get("metadata") or {}
                fm = meta.get("frontmatter") or {}
                ht = set(
                    (h.get("tags") or [])
                    + (meta.get("tags") or [])
                    + (fm.get("tags") or [])
                )
                return required.issubset(ht)
            hits = [h for h in hits if has_all(h)]
        return hits[:limit]
    except Exception as e:
        _dbg("recall threw", e)
        return []


# ── commit ──────────────────────────────────────────────────────────────────

def commit(text: str, *, tags: str | Iterable[str] | None = None,
           category: str | None = None, status: str = "active",
           title: str | None = None, kind: str | None = None,
           reindex: bool = True) -> dict:
    """Write a markdown note, optionally reindex.

    Returns {'path': str|None, 'indexed': bool}.
    """
    if not text:
        return {"path": None, "indexed": False}
    _ensure_dirs()
    norm_tags = _normalize_tags(tags)
    if kind:
        kind_tag = f"kind-{kind}"
        if kind_tag not in norm_tags:
            norm_tags.insert(0, kind_tag)
    title_raw = title or text.split("\n", 1)[0][:60]
    fm = _build_frontmatter({
        "tags": norm_tags,
        "category": category,
        "status": status,
        "title": title_raw,
        "created": datetime.now(timezone.utc).date().isoformat(),
    })
    body = text if text.endswith("\n") else text + "\n"
    fname = f"{_slug(title_raw)}-{_short_hash(text)}.md"
    file = NOTES / fname
    try:
        file.write_text(fm + body, encoding="utf-8")
    except Exception as e:
        _dbg("write", e)
        return {"path": None, "indexed": False}
    indexed = reindex_now() if reindex else False
    return {"path": str(file), "indexed": indexed}


def reindex_now() -> bool:
    """Rebuild the velocirag index from notes/. mtime-incremental."""
    _ensure_dirs()
    try:
        r = subprocess.run(
            ["velocirag", "index", str(NOTES), "--db", str(INDEX), "-s", SOURCE],
            capture_output=True, text=True, timeout=REINDEX_TIMEOUT_S,
        )
        if r.returncode != 0:
            _dbg("reindex non-zero", r.returncode, (r.stderr or "")[:200])
        return r.returncode == 0
    except Exception as e:
        _dbg("reindex threw", e)
        return False


# Public alias matching the JS API
reindex = reindex_now


# ── failures ────────────────────────────────────────────────────────────────

def log_failure(**rec: Any) -> None:
    try:
        _ensure_dirs()
        rec.setdefault("ts", datetime.now(timezone.utc).isoformat())
        with FAILURES.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception as e:
        _dbg("log_failure", e)


def _read_failures() -> list[dict]:
    try:
        if not FAILURES.exists():
            return []
        out = []
        for line in FAILURES.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                continue
        return out
    except Exception as e:
        _dbg("read_failures", e)
        return []


def _ts_ms(s: str) -> float:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return 0.0


def recent_failures(host: str, op: str, since_ms: int = STALE_WINDOW_MS) -> list[dict]:
    cutoff = time.time() * 1000 - since_ms
    return [
        r for r in _read_failures()
        if r.get("host") == host
        and r.get("op") == op
        and _ts_ms(r.get("ts", "")) >= cutoff
    ]


def is_stale(host: str, op: str, err_class: str) -> bool:
    recs = [r for r in recent_failures(host, op) if r.get("err_class") == err_class]
    return len(recs) >= STALE_THRESHOLD


__all__ = [
    "ROOT", "NOTES", "INDEX", "FAILURES", "SOURCE",
    "velocirag_available",
    "recall", "commit", "reindex", "reindex_now",
    "log_failure", "recent_failures", "is_stale",
]
