"""finlens_call — subprocess adapter into finlens's own venv.

The Synaps extension protocol is unidirectional (core → extension), so we
reach finlens by shelling into its venv and mirroring the EXACT code path
finlens's own extension uses for a single lens. From
`finlens/synaps-extension/main.py::run_lens`:

    from finlens.orchestrator import build_data_source, build_lenses
    cfg = Config.from_env(...); cfg.output_dir = ...
    data   = build_data_source(cfg)
    lenses = build_lenses(cfg, data)
    target = next(l for l in lenses if l.name == lens_name)
    out    = target.analyze(ticker.upper())

We invoke that same code with a tiny driver script piped to the finlens
venv python; output is captured as JSON on stdout.

Slice-1 note: one subprocess per lens call. A long-lived child speaking
line-delimited JSON over stdin/stdout would amortize startup across the
six lenses per research run — leaving that as a slice-2 optimization
(the public API here would not change).
"""
from __future__ import annotations
import json
import os
import subprocess
import time
import uuid
from typing import Any

from .. import config

# Driver script run inside finlens's venv. Reads (lens, ticker) from argv,
# prints one JSON line on stdout. Stderr is finlens's own progress chatter.
_DRIVER = r"""
import json, os, sys, contextlib
FINLENS_ROOT = os.environ["FINLENS_ROOT"]
if FINLENS_ROOT not in sys.path:
    sys.path.insert(0, FINLENS_ROOT)
lens_name, ticker = sys.argv[1], sys.argv[2].upper()
try:
    from finlens.config import Config
    from finlens.orchestrator import build_data_source, build_lenses
    cfg = Config.from_env(os.path.join(FINLENS_ROOT, ".env"))
    cfg.output_dir = os.path.join(FINLENS_ROOT, "output")
    with contextlib.redirect_stdout(sys.stderr):
        data   = build_data_source(cfg)
        lenses = build_lenses(cfg, data)
        target = next((l for l in lenses if getattr(l, "name", "") == lens_name), None)
        if target is None:
            print(json.dumps({"ok": False, "error": f"unknown lens: {lens_name}"}))
            sys.exit(0)
        out = target.analyze(ticker)
    if out is None:
        print(json.dumps({"ok": True, "payload": None}))
        sys.exit(0)
    payload = {
        "lens": getattr(out, "lens", lens_name),
        "ticker": getattr(out, "ticker", ticker),
        "signal": getattr(out, "signal", None),
        "score": getattr(out, "score", None),
        "confidence": getattr(out, "confidence", None),
        "evidence": list(getattr(out, "evidence", []) or []),
        "meta": getattr(out, "meta", None) or {},
    }
    print(json.dumps({"ok": True, "payload": payload}))
except BaseException as e:
    print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
"""


def _new_call_id(lens: str) -> str:
    return f"finlens:{lens}#{uuid.uuid4().hex[:12]}"


def call_lens(lens: str, ticker: str, *, timeout: int = 60) -> dict[str, Any]:
    """Run one finlens lens against one ticker. Never raises — errors degrade
    to status='error'. Returns a uniformly-shaped dict suitable for embedding
    into Verdict.lens_calls + Verdict.findings citations."""
    call_id = _new_call_id(lens)
    finlens_root = config.finlens_home()
    py = config.finlens_python()
    started = time.monotonic()

    if not py.exists():
        return {
            "call_id": call_id, "lens": lens, "ticker": ticker.upper(),
            "status": "error", "latency_ms": 0,
            "error": f"finlens python not found at {py}",
            "payload": None,
        }

    env = dict(os.environ)
    env["FINLENS_ROOT"] = str(finlens_root)
    try:
        proc = subprocess.run(
            [str(py), "-c", _DRIVER, lens, ticker],
            env=env, capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {
            "call_id": call_id, "lens": lens, "ticker": ticker.upper(),
            "status": "error", "latency_ms": int((time.monotonic() - started) * 1000),
            "error": f"finlens timeout after {timeout}s", "payload": None,
        }
    except OSError as e:
        return {
            "call_id": call_id, "lens": lens, "ticker": ticker.upper(),
            "status": "error", "latency_ms": int((time.monotonic() - started) * 1000),
            "error": f"spawn failed: {e}", "payload": None,
        }

    latency_ms = int((time.monotonic() - started) * 1000)
    stdout = (proc.stdout or "").strip().splitlines()
    last = stdout[-1] if stdout else ""
    try:
        parsed = json.loads(last) if last else {"ok": False, "error": "empty stdout"}
    except json.JSONDecodeError as e:
        parsed = {"ok": False, "error": f"json parse: {e}; raw={last[:200]!r}"}

    if proc.returncode != 0 and not parsed.get("ok"):
        return {
            "call_id": call_id, "lens": lens, "ticker": ticker.upper(),
            "status": "error", "latency_ms": latency_ms,
            "error": parsed.get("error") or (proc.stderr or "")[:500] or f"exit {proc.returncode}",
            "payload": None,
        }
    if not parsed.get("ok"):
        return {
            "call_id": call_id, "lens": lens, "ticker": ticker.upper(),
            "status": "error", "latency_ms": latency_ms,
            "error": parsed.get("error", "unknown"), "payload": None,
        }
    return {
        "call_id": call_id, "lens": lens, "ticker": ticker.upper(),
        "status": "ok", "latency_ms": latency_ms,
        "error": None, "payload": parsed.get("payload"),
    }
