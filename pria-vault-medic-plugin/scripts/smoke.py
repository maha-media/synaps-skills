#!/usr/bin/env python3
"""smoke.py — MANUAL live smoke test for pria-vault-medic-plugin.

Tests READ-ONLY endpoints only (vault_health, vault_diagnose).
Repair smoke is opt-in via --allow-repair and requires explicit upload_id + verb.

Usage:
  PRIA_API_KEY=pria_... python3 scripts/smoke.py
  python3 scripts/smoke.py --base https://priastaging.praxislxp.com
  python3 scripts/smoke.py --allow-repair --upload-id <id> --verb requeue

⚠️  This script is NOT part of the automated test suite.
    Never run during CI or the build process.
    PRIA_API_KEY required. Makes live network calls.
    --allow-repair enables WRITE calls — use on staging only.
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.client import PriaClient, DEFAULT_BASE  # noqa: E402
from pria.tools import (  # noqa: E402
    ToolHandler,
    TOOL_VAULT_HEALTH,
    TOOL_VAULT_DIAGNOSE,
    TOOL_VAULT_REPAIR,
    TOOL_VAULT_REGRADE,
)


def pprint(label: str, data: dict):
    print(f"\n── {label} ──")
    print(json.dumps(data, indent=2, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description="Live smoke test for pria-vault-medic-plugin")
    parser.add_argument("--base", default=DEFAULT_BASE, help="Pria API base URL")
    parser.add_argument("--vault", default="personal", choices=["personal", "institution"])
    parser.add_argument("--allow-repair", action="store_true",
                        help="Enable WRITE repair smoke (staging only — handle with care)")
    parser.add_argument("--upload-id", default="",
                        help="Upload ID to repair (required if --allow-repair)")
    parser.add_argument("--verb", default="requeue", choices=["requeue", "reload", "reingest"],
                        help="Repair verb (requires --allow-repair)")
    parser.add_argument("--source-url", default="",
                        help="Source URL for verb=reingest")
    args = parser.parse_args()

    key = os.environ.get("PRIA_API_KEY", "").strip()
    if not key:
        print("ERROR: PRIA_API_KEY env var not set.", file=sys.stderr)
        sys.exit(1)

    print(f"Base URL : {args.base}")
    print(f"Vault    : {args.vault}")

    # Verify JWT exchange
    print("\n── JWT exchange ──")
    client = PriaClient(api_key=key, base_url=args.base)
    try:
        token = client._exchange()
        print(f"JWT obtained: {token[:20]}...[REDACTED]")
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    handler = ToolHandler({"pria_api_base": args.base})
    os.environ["PRIA_API_KEY"] = key  # ensure handler picks it up

    # vault_health
    pprint("vault_health", handler.call(TOOL_VAULT_HEALTH, {"vault": args.vault}))

    # vault_diagnose
    pprint("vault_diagnose (first 5 issues)",
           {**handler.call(TOOL_VAULT_DIAGNOSE, {"vault": args.vault, "limit": 50}),
            "triage": handler.call(TOOL_VAULT_DIAGNOSE, {"vault": args.vault, "limit": 50})
            .get("triage", [])[:5]})

    # vault_repair — DRY RUN always, live only with --allow-repair
    print("\n── vault_repair (dry_run=True — no mutations) ──")
    dry_result = handler.call(TOOL_VAULT_REPAIR, {
        "upload_id": args.upload_id or "PLACEHOLDER_ID",
        "verb": args.verb,
        "dry_run": True,
        **({"source_url": args.source_url} if args.source_url else {}),
    })
    print(json.dumps(dry_result, indent=2))

    if args.allow_repair:
        if not args.upload_id:
            print("ERROR: --upload-id required for --allow-repair", file=sys.stderr)
            sys.exit(1)
        print(f"\n⚠️  LIVE REPAIR: verb={args.verb} upload_id={args.upload_id}")
        print("Proceeding in 3 seconds... (Ctrl-C to abort)")
        import time
        time.sleep(3)
        live_result = handler.call(TOOL_VAULT_REPAIR, {
            "upload_id": args.upload_id,
            "verb": args.verb,
            "dry_run": False,
            **({"source_url": args.source_url} if args.source_url else {}),
        })
        pprint("vault_repair (LIVE)", live_result)

        # re-grade after repair
        pprint("vault_regrade (post-repair)", handler.call(TOOL_VAULT_REGRADE, {
            "vault": args.vault,
        }))

    print("\nSmoke test done.")


if __name__ == "__main__":
    main()
