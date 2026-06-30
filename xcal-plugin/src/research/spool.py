"""spool — session record handoff for the reflection subprocess.

The parent (research_ticker) writes a JSON record keyed by session id to
config.spool_dir(). The child (`main.py --mode=reflect --session=<sid>`)
reads it back. Records are deleted by the child after a successful read
unless XCAL_KEEP_SPOOL=1 (for debugging).

Container-clean: path comes from config, not hardcoded.
"""
from __future__ import annotations
import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any

from . import config

_SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class SpoolError(ValueError):
    pass


def _root() -> Path:
    d = config.spool_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d


def _validate_sid(sid: str) -> None:
    if not isinstance(sid, str) or not _SID_RE.match(sid):
        raise SpoolError(f"invalid session id: {sid!r}")


def new_session_id() -> str:
    return f"r-{int(time.time()*1000)}-{secrets.token_hex(4)}"


def path_for(sid: str) -> Path:
    _validate_sid(sid)
    return _root() / f"{sid}.json"


def write(sid: str, record: dict[str, Any]) -> Path:
    p = path_for(sid)
    p.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    return p


def read(sid: str) -> dict[str, Any]:
    p = path_for(sid)
    if not p.exists():
        raise SpoolError(f"session not in spool: {sid}")
    return json.loads(p.read_text(encoding="utf-8"))


def consume(sid: str) -> dict[str, Any]:
    """Read + delete (unless XCAL_KEEP_SPOOL=1)."""
    rec = read(sid)
    if os.environ.get("XCAL_KEEP_SPOOL", "") != "1":
        try:
            path_for(sid).unlink()
        except FileNotFoundError:
            pass
    return rec
