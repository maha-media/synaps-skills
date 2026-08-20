#!/usr/bin/env python3
"""smoke.py — MANUAL live smoke test against the real Pria API (READ-ONLY).

Usage:
  PRIA_API_KEY=pria_... python3 scripts/smoke.py
  PRIA_API_KEY=pria_... python3 scripts/smoke.py --base https://priastaging.praxislxp.com

This script is NOT part of the automated test suite. It makes live read-only
network calls to the Pria API and requires a real PRIA_API_KEY. Never run
during CI or the build process. Never commit keys.
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.client import PriaClient, DEFAULT_BASE  # noqa: E402


def pprint(data):
    print(json.dumps(data, indent=2, ensure_ascii=False))


def _truncate(text: str, n: int = 80) -> str:
    return text[:n] + "..." if len(text) > n else text


def main():
    parser = argparse.ArgumentParser(description="Live smoke test for pria-black-box-plugin")
    parser.add_argument("--base", default=DEFAULT_BASE, help="Pria API base URL")
    parser.add_argument("--limit", type=int, default=3, help="Histories to list")
    parser.add_argument("--history-id", default=None,
                        help="Specific history ID to trace (default: most recent)")
    parser.add_argument("--reasoning", action="store_true",
                        help="Fetch thinking rounds if available")
    args = parser.parse_args()

    key = os.environ.get("PRIA_API_KEY", "").strip()
    if not key:
        print("ERROR: PRIA_API_KEY env var not set.", file=sys.stderr)
        sys.exit(1)

    print(f"Base URL : {args.base}")
    print()

    client = PriaClient(api_key=key, base_url=args.base)

    print("── JWT exchange ──")
    token = client._exchange()
    print(f"JWT obtained: {token[:20]}...[REDACTED]")
    print()

    # 1. List recent histories with observability flags
    print(f"── list_histories (limit={args.limit}) ──")
    raw = client.list_histories(limit=args.limit)
    rows = raw.get("data") or []
    print(f"Returned {len(rows)} rows")
    for i, row in enumerate(rows):
        print(f"  [{i}] id={row.get('id')}  model={row.get('conversation_model')}"
              f"  hasRag={row.get('hasRagSearch')}  hasThinking={row.get('hasThinking')}"
              f"  latencyMs={row.get('latencyMs')}  credits={row.get('credits')}")
        in_ = (row.get("in") or {})
        print(f"       input: {_truncate(str(in_.get('input') or ''))}")
    print()

    if not rows:
        print("No history rows — nothing to trace. Done.")
        return

    # 2. Trace the selected (or most recent) history
    target = rows[-1] if not args.history_id else next(
        (r for r in rows if r.get("id") == args.history_id), rows[-1]
    )
    hist_id = target.get("id")
    print(f"── trace_answer for history_id={hist_id} ──")

    if target.get("hasRagSearch"):
        print("  Fetching RAG/KAG segments...")
        rag_raw = client.get_rag_search(hist_id)
        segs = rag_raw.get("ragSearch") or []
        print(f"  Segments: {len(segs)}")
        for j, seg in enumerate(segs[:5]):
            conf = seg.get("confidential", False)
            text = _truncate(seg.get("chunkText") or "")
            print(f"    [{j}] score={seg.get('score')}  mode={seg.get('mode')}"
                  f"  file={seg.get('originalname')}  confidential={conf}")
            print(f"         text: {text!r}")
    else:
        print("  No RAG/KAG retrieval for this turn.")

    if args.reasoning and target.get("hasThinking"):
        print("  Fetching thinking rounds...")
        think_raw = client.get_thinking(hist_id)
        rounds = think_raw.get("thinking") or []
        print(f"  Thinking rounds: {len(rounds)}")
        for t in rounds[:2]:
            print(f"    round={t.get('round')}  durationMs={t.get('durationMs')}"
                  f"  model={t.get('model')}")
            print(f"    text: {_truncate(t.get('text') or '')}...")

    print()
    print("── source health (personal vault) ──")
    try:
        issues = client.files_with_issues(vault="personal")
        files = issues.get("files") or []
        print(f"  {len(files)} file(s) with issues")
        for f in files[:5]:
            print(f"    {f.get('name')}  issue={f.get('issue')}")
    except Exception as exc:
        print(f"  Health check error: {exc}")

    print()
    print("Smoke test done. All calls were READ-ONLY.")


if __name__ == "__main__":
    main()
