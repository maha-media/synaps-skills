#!/usr/bin/env python3
"""smoke.py — MANUAL live smoke test against the real Pria API.

Usage:
  PRIA_API_KEY=pria_... python3 scripts/smoke.py
  python3 scripts/smoke.py --base https://pria.praxislxp.com

This script is NOT part of the automated test suite and must NEVER run
during CI or the build process. It requires a real PRIA_API_KEY and will
make live network calls to the Pria API.
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


def main():
    parser = argparse.ArgumentParser(description="Live smoke test for pria-tools-plugin")
    parser.add_argument("--base", default=DEFAULT_BASE, help="Pria API base URL")
    parser.add_argument("--query", default="machine learning", help="Search query")
    parser.add_argument("--limit", type=int, default=3, help="Max results")
    args = parser.parse_args()

    key = os.environ.get("PRIA_API_KEY", "").strip()
    if not key:
        print("ERROR: PRIA_API_KEY env var not set.", file=sys.stderr)
        sys.exit(1)

    print(f"Base URL : {args.base}")
    print(f"Query    : {args.query!r}")
    print(f"Limit    : {args.limit}")
    print()

    client = PriaClient(api_key=key, base_url=args.base)

    print("── JWT exchange ──")
    token = client._exchange()
    # Never print the full token; show only first 20 chars
    print(f"JWT obtained: {token[:20]}...[REDACTED]")
    print()

    print("── search_knowledge ──")
    try:
        raw = client.search_content(query=args.query, limit=args.limit)
        results = raw.get("results") or []
        print(f"Total scanned : {raw.get('totalScanned')}")
        print(f"Results       : {len(results)}")
        for i, r in enumerate(results[:args.limit]):
            upload = r.get("upload") or {}
            print(f"  [{i}] score={r.get('score'):.3f} source={r.get('source')}"
                  f" file={upload.get('file_title') or upload.get('originalname')}")
            print(f"       snippet: {(r.get('snippet') or '')[:100]!r}")
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
    print()

    print("── search_history ──")
    try:
        raw = client.search_histories(search=args.query, limit=args.limit)
        data = raw.get("data") or []
        print(f"Records returned: {len(data)}")
        for i, rec in enumerate(data[:args.limit]):
            in_ = rec.get("in") or {}
            print(f"  [{i}] id={rec.get('id')} created={rec.get('created')}")
            print(f"       input: {str(in_.get('input') or '')[:80]!r}")
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)

    print()
    print("Smoke test done.")


if __name__ == "__main__":
    main()
