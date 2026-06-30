"""axel_cli — subprocess wrapper around the axel CLI binary.

The Synaps protocol is unidirectional (core → extension), so xcal
reaches axel by shelling into the same binary axel ships as a CLI.
See `~/Projects/axel/crates/axel/src/main.rs` for the full surface.

Used surface in slice-1:
    axel search <query> --limit N --json
    axel remember <content> --category C --topic T

Notes on axel's remember validation (mirrored here to fail loud + cheap):
  * `category` must be one of: events, preferences, entities, cases, patterns
  * `content` must be >= 50 chars (after strip)
  * `topic`   must be >= 5 chars
  * On success axel prints: "✅ Memory stored: mem_<hex>"
There is no --importance flag.
"""
from __future__ import annotations
import json
import re
import subprocess
from typing import Any, Optional

from .. import config


VALID_CATEGORIES = {"events", "preferences", "entities", "cases", "patterns"}
_MEM_ID_RE = re.compile(r"mem_[0-9a-fA-F]+")


def _run(argv: list[str], *, timeout: int = 30) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout, check=False,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except FileNotFoundError as e:
        return 127, "", f"axel not found: {e}"
    except subprocess.TimeoutExpired:
        return 124, "", f"axel timeout after {timeout}s"
    except OSError as e:
        return 1, "", f"spawn failed: {e}"


def search(query: str, limit: int = 5, *, brain: Optional[str] = None) -> dict[str, Any]:
    """Returns {status, count, results[], (error)}. Never raises."""
    bin_ = config.axel_bin()
    argv = [bin_]
    if brain:
        argv += ["--brain", brain]
    argv += ["search", str(query), "--limit", str(int(limit)), "--json"]
    code, out, err = _run(argv)
    if code != 0:
        return {"status": "error", "count": 0, "results": [],
                "error": (err or out or f"exit {code}").strip()[:500]}
    try:
        parsed = json.loads(out)
    except json.JSONDecodeError:
        last = next((ln for ln in reversed(out.splitlines()) if ln.strip()), "")
        try:
            parsed = json.loads(last)
        except json.JSONDecodeError as e:
            return {"status": "error", "count": 0, "results": [],
                    "error": f"json parse: {e}; raw={out[:200]!r}"}
    return {
        "status": "ok",
        "count": int(parsed.get("count", len(parsed.get("results", [])))),
        "results": list(parsed.get("results", [])),
    }


def remember(content: str, *, category: str = "cases",
             topic: str = "general",
             brain: Optional[str] = None,
             importance: Optional[float] = None) -> dict[str, Any]:
    """Persist `content` to axel. Returns
        {status: "ok"|"error", memory_id: str|None, output: str, error: str|None}.
    Never raises. `importance` is accepted for caller compatibility but
    ignored — current axel CLI has no such flag.
    """
    del importance  # silence linters; not supported by axel
    if not isinstance(content, str):
        return {"status": "error", "memory_id": None, "output": "",
                "error": "content must be a string"}
    stripped = content.strip()
    if len(stripped) < 50:
        return {"status": "error", "memory_id": None, "output": "",
                "error": f"content too short ({len(stripped)}<50)"}
    if not isinstance(topic, str) or len(topic) < 5:
        return {"status": "error", "memory_id": None, "output": "",
                "error": f"topic too short ({len(topic) if isinstance(topic, str) else 0}<5)"}
    if category not in VALID_CATEGORIES:
        return {"status": "error", "memory_id": None, "output": "",
                "error": f"invalid category {category!r}; must be one of {sorted(VALID_CATEGORIES)}"}

    bin_ = config.axel_bin()
    argv = [bin_]
    if brain:
        argv += ["--brain", brain]
    argv += ["remember", content, "--category", category, "--topic", topic]

    code, out, err = _run(argv)
    if code != 0:
        return {"status": "error", "memory_id": None, "output": out.strip(),
                "error": (err or f"exit {code}").strip()[:500]}
    m = _MEM_ID_RE.search(out) or _MEM_ID_RE.search(err)
    return {"status": "ok",
            "memory_id": m.group(0) if m else None,
            "output": out.strip(),
            "error": None}
