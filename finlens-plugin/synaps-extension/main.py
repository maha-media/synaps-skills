#!/usr/bin/env python3
"""finlens Synaps extension — exposes the multi-lens finance workflow as tools.

Protocol: Content-Length-framed JSON-RPC over stdin/stdout (mirrors synaps-tasks).
  initialize  → advertise tools
  tool.call   → run a tool, return {"content": text}
  shutdown    → ack

Tools:
  finlens_scan  — full multi-lens analysis + Meff-gated synthesis on tickers
  finlens_lens  — a single targeted lens on one ticker

Research leads, NOT advice. Paper-only.
"""
import sys
import os
import json
import contextlib

# make the finlens package importable — resolve relative to this file so the
# plugin works regardless of where it's installed (no hardcoded paths).
from pathlib import Path
FINLENS_ROOT = str(Path(__file__).resolve().parent.parent)  # plugin root (contains finlens/)
if FINLENS_ROOT not in sys.path:
    sys.path.insert(0, FINLENS_ROOT)

LENS_NAMES = ["insider", "fundamentals", "technicals", "sentiment", "news", "search_trend"]

TOOLS = [
    {
        "name": "finlens_scan",
        "description": ("Run the full finlens multi-lens finance workflow on one or more tickers: "
                        "6 research-corrected lenses (insider buys, fundamentals, technicals, "
                        "contrarian sentiment, news, search-trend) fused by a deterministic "
                        "Meff-gated synthesis into a ranked watchlist with convergence/divergence "
                        "flags. Research LEADS, not advice. Takes ~10-25s per ticker (live data)."),
        "input_schema": {
            "type": "object",
            "properties": {
                "tickers": {"type": "string",
                            "description": "Comma-separated tickers, e.g. 'NVDA,TSLA,AMD'. Required."}
            },
            "required": ["tickers"]
        }
    },
    {
        "name": "finlens_lens",
        "description": ("Run ONE finlens lens on one ticker for a targeted read. "
                        "insider=open-market-buy anchor; fundamentals=value/quality; "
                        "technicals=momentum/52wk (no oscillators); sentiment=CONTRARIAN crowd flag; "
                        "news=volatility-regime check; search_trend=attention flag. "
                        "Each returns signal/score/confidence + evidence. Research leads, not advice."),
        "input_schema": {
            "type": "object",
            "properties": {
                "lens": {"type": "string", "enum": LENS_NAMES, "description": "Which lens to run."},
                "ticker": {"type": "string", "description": "Single ticker, e.g. 'NVDA'."}
            },
            "required": ["lens", "ticker"]
        }
    },
]


# ── JSON-RPC framing ────────────────────────────────────────────────────────
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
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode("utf-8"))


def _send_message(obj):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8")
    sys.stdout.buffer.write(header + body)
    sys.stdout.buffer.flush()


def _log(msg):
    print(f"[finlens] {msg}", file=sys.stderr, flush=True)


def _ok(req_id, result):
    _send_message({"jsonrpc": "2.0", "id": req_id, "result": result})


def _err(req_id, code, message):
    _send_message({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


# ── finlens calls (stdout redirected to stderr so progress prints don't corrupt the RPC) ──
def _cfg(tickers):
    from finlens.config import Config
    cfg = Config.from_env(os.path.join(FINLENS_ROOT, ".env"))
    cfg.output_dir = os.path.join(FINLENS_ROOT, "output")
    if tickers:
        cfg.watchlist = tickers
    return cfg


def _fmt_output(o) -> str:
    arrow = {"bullish": "▲", "bearish": "▼", "neutral": "◆"}.get(o.signal, "·")
    lines = [f"{arrow} {o.lens} / {o.ticker}: {o.signal} "
             f"(score {o.score:+.2f}, confidence {o.confidence:.2f})"]
    for e in o.evidence:
        lines.append(f"   • {e}")
    return "\n".join(lines)


def run_scan(tickers: list[str]) -> str:
    from finlens import orchestrator
    cfg = _cfg(tickers)
    with contextlib.redirect_stdout(sys.stderr):
        result = orchestrator.run(cfg)
    verdicts = result["verdicts"]
    out = ["finlens scan — RESEARCH LEADS, NOT ADVICE (paper-only)\n"]
    for i, v in enumerate(verdicts, 1):
        d = v.get("direction", "?")
        arrow = {"bullish": "▲", "bearish": "▼", "neutral": "◆"}.get(d, "·")
        out.append(f"{i}. {arrow} {v.get('ticker')}  {d.upper()}  "
                   f"conviction={v.get('conviction', 0):.2f}  "
                   f"state={v.get('state', '?')}  Meff={v.get('meff', 0):.1f}")
        diss = v.get("dissenting") or []
        if v.get("state") == "divergent" and diss:
            out.append(f"     ⚡ divergence — dissenting: {', '.join(diss)} (high-info, investigate)")
        sm = v.get("summary")
        if sm:
            out.append(f"     {sm}")
    out.append(f"\nFull report: {result.get('report')}")
    out.append("Conviction ≥0.60 = notable; below = background noise. Do your own DD.")
    return "\n".join(out)


def run_lens(lens_name: str, ticker: str) -> str:
    from finlens.orchestrator import build_data_source, build_lenses
    cfg = _cfg(None)
    with contextlib.redirect_stdout(sys.stderr):
        data = build_data_source(cfg)
        lenses = build_lenses(cfg, data)
        target = next((l for l in lenses if getattr(l, "name", "") == lens_name), None)
        if target is None:
            return f"lens '{lens_name}' is not available."
        out = target.analyze(ticker.upper())
    if out is None:
        return f"{lens_name} / {ticker.upper()}: no read (no usable data)."
    return _fmt_output(out)


def dispatch_tool(name: str, inp: dict) -> str:
    if name == "finlens_scan":
        raw = inp.get("tickers", "")
        tickers = [t.strip().upper() for t in str(raw).replace(" ", ",").split(",") if t.strip()]
        if not tickers:
            return "finlens_scan: provide at least one ticker."
        return run_scan(tickers)
    if name == "finlens_lens":
        lens = str(inp.get("lens", "")).strip()
        ticker = str(inp.get("ticker", "")).strip()
        if lens not in LENS_NAMES or not ticker:
            return f"finlens_lens: need a valid lens ({', '.join(LENS_NAMES)}) and a ticker."
        return run_lens(lens, ticker)
    return f"unknown tool: {name}"


def main():
    _log("finlens extension started")
    while True:
        msg = _read_message()
        if msg is None:
            break
        method = msg.get("method", "")
        req_id = msg.get("id")
        params = msg.get("params", {}) or {}
        try:
            if method == "initialize":
                _ok(req_id, {"protocol_version": 1, "capabilities": {"tools": TOOLS}})
            elif method == "tool.call":
                tool_name = params.get("name", "")
                tool_input = params.get("input", params.get("arguments", {})) or {}
                try:
                    text = dispatch_tool(tool_name, tool_input)
                    _ok(req_id, {"content": text})
                except Exception as e:  # noqa: BLE001
                    _err(req_id, -32000, f"{type(e).__name__}: {e}")
            elif method == "hook.handle":
                _ok(req_id, {"action": "continue"})
            elif method == "shutdown":
                _ok(req_id, {})
                break
            else:
                if req_id is not None:
                    _err(req_id, -32601, f"Method not found: {method}")
        except Exception as e:  # noqa: BLE001
            _log(f"error on {method}: {e}")
            if req_id is not None:
                _err(req_id, -32000, str(e))
    _log("finlens extension stopped")


if __name__ == "__main__":
    main()
