#!/usr/bin/env python3
"""xcal Synaps extension — Phase 2.0 skeleton.

Speaks Content-Length-framed JSON-RPC over stdio (mirrors finlens).
Phase 2.0 only: handshake + `research_ticker` returning a STUB finalized Verdict.
Real lens-driving loop arrives in Phase 2.2.
"""
import json
import os
import sys
from pathlib import Path

# make `src` importable regardless of CWD
REPO = Path(__file__).resolve().parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from src.research.verdict import (  # noqa: E402
    Verdict, Finding, LensCall, verdict_to_json,
)
from src.research import loop as research_loop  # noqa: E402

TOOLS = [
    {
        "name": "research_ticker",
        "description": (
            "Run a deterministic 6-lens finance research pass on a ticker, "
            "returning a cited Verdict. Numbers come only from finlens; "
            "reasoning is structured by a SKILL.md plan."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "ticker": {"type": "string", "description": "e.g. 'NVDA'."},
                "question": {"type": "string",
                             "description": "e.g. 'Is the Q3 setup risk-on?'"},
            },
            "required": ["ticker", "question"],
        },
    },
]


# ── JSON-RPC framing (mirror of finlens) ────────────────────────────────────
def _read_message():
    headers = {}
    while True:
        line = b""
        while not line.endswith(b"\r\n"):
            ch = sys.stdin.buffer.read(1)
            if not ch:
                return None
            line += ch
        line = line[:-2]
        if line == b"":
            break
        if b":" in line:
            k, _, v = line.partition(b":")
            headers[k.strip().lower()] = v.strip()
    length = int(headers.get(b"content-length", b"0"))
    if length <= 0:
        return None
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def _send_message(obj):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    sys.stdout.buffer.flush()


def _log(msg):
    # stdout is reserved for RPC; progress prints go to stderr.
    print(f"[xcal] {msg}", file=sys.stderr, flush=True)


def _ok(rid, result):
    _send_message({"jsonrpc": "2.0", "id": rid, "result": result})


def _err(rid, code, message):
    _send_message({"jsonrpc": "2.0", "id": rid,
                   "error": {"code": code, "message": message}})


# ── Stub research_ticker (Phase 2.0) ────────────────────────────────────────
def _stub_verdict(ticker: str, question: str) -> str:
    lc = LensCall(call_id="finlens:fundamentals#stub",
                  lens="fundamentals", status="ok", latency_ms=0)
    v = Verdict(ticker=ticker, question=question, skill_used="quarterly-check",
                lens_calls=[lc])
    v.findings.append(Finding(
        claim=f"{ticker}: stub numeric finding (phase 2.0)",
        kind="numeric", value=0.0,
        citations=("finlens:fundamentals#stub",), confidence=0.0,
    ))
    v.findings.append(Finding(
        claim="qualitative stub finding — no citation required",
        kind="qualitative", value=None, citations=(), confidence=0.0,
    ))
    v.synthesis = "Phase 2.0 stub verdict — real lens loop arrives in phase 2.2."
    v.reflection = {"status": "skipped", "reason": "phase-2.0-stub"}
    v.finalize()
    return verdict_to_json(v)


def dispatch_tool(name: str, inp: dict) -> str:
    if name == "research_ticker":
        ticker = str(inp.get("ticker", "")).strip().upper()
        question = str(inp.get("question", "")).strip()
        if not ticker or not question:
            raise ValueError("research_ticker requires non-empty 'ticker' and 'question'")
        # Phase 2.2: real ReAct loop unless XCAL_STUB=1 (legacy escape hatch).
        if os.environ.get("XCAL_STUB") == "1":
            return _stub_verdict(ticker, question)
        v = research_loop.research_ticker(ticker, question)
        return verdict_to_json(v)
    raise ValueError(f"unknown tool: {name}")


def main():
    # Phase 2.3: subprocess reflection entry. Must short-circuit BEFORE the
    # RPC loop. Invoked as: `python main.py --mode=reflect --session=<sid>`
    argv = sys.argv[1:]
    if argv and any(a.startswith("--mode=reflect") or a == "--mode=reflect"
                    for a in argv):
        # parse --session=<sid>
        sid = ""
        for a in argv:
            if a.startswith("--session="):
                sid = a.split("=", 1)[1].strip()
        if not sid:
            print("xcal: --mode=reflect requires --session=<sid>",
                  file=sys.stderr)
            sys.exit(2)
        # Defensive: even if the parent forgot to set this, we set it here so
        # any code inside the child that checks config.in_reflection() agrees.
        os.environ.setdefault("XCAL_IN_REFLECTION", "1")
        from src.research import reflect as _reflect  # noqa: E402
        try:
            result = _reflect.run_from_session_id(sid)
            print(json.dumps(result, ensure_ascii=False))
            sys.exit(0)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"action": "none", "applied": False,
                              "reason": f"reflect crashed: {type(e).__name__}: {e}"}))
            sys.exit(1)

    _log("xcal extension started")
    while True:
        msg = _read_message()
        if msg is None:
            break
        method = msg.get("method", "")
        rid = msg.get("id")
        params = msg.get("params") or {}
        try:
            if method == "initialize":
                _ok(rid, {"protocol_version": 1, "capabilities": {"tools": TOOLS}})
            elif method == "tool.call":
                tname = params.get("name", "")
                tinput = params.get("input", params.get("arguments", {})) or {}
                try:
                    text = dispatch_tool(tname, tinput)
                    _ok(rid, {"content": text})
                except Exception as e:  # noqa: BLE001
                    _err(rid, -32000, f"{type(e).__name__}: {e}")
            elif method == "hook.handle":
                _ok(rid, {"action": "continue"})
            elif method == "shutdown":
                _ok(rid, {})
                break
            else:
                if rid is not None:
                    _err(rid, -32601, f"Method not found: {method}")
        except Exception as e:  # noqa: BLE001
            _log(f"error on {method}: {e}")
            if rid is not None:
                _err(rid, -32000, str(e))
    _log("xcal extension stopped")


if __name__ == "__main__":
    main()
