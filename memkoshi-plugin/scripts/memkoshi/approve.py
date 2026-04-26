#!/usr/bin/env python3
"""Non-interactive approve/reject for memkoshi staged memories.

memkoshi's `review` command is interactive — it prompts the human for each
staged memory. Agents can't drive that, so this script exposes the same
underlying storage + search.index_memory() calls as a flag-based CLI.

Usage:
    approve.py --all                 # approve every staged memory
    approve.py --id mem_396f122b     # approve one
    approve.py --reject mem_xxx --reason "hallucination"

Honours MEMKOSHI_STORAGE env var (same as `memkoshi --storage`).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

try:
    from memkoshi.storage.sqlite import SQLiteBackend
    from memkoshi.search.engine import MemkoshiSearch
except ImportError:
    sys.stderr.write(
        "error: memkoshi not installed. Run:\n"
        "  pip install --user --break-system-packages "
        "git+https://github.com/HaseebKhalid1507/memkoshi.git\n"
        "or:\n"
        "  pipx install git+https://github.com/HaseebKhalid1507/memkoshi.git\n"
    )
    sys.exit(127)


def main() -> int:
    parser = argparse.ArgumentParser(description="Non-interactive memkoshi approval")
    parser.add_argument("--all", action="store_true", help="Approve every staged memory")
    parser.add_argument("--id", dest="memory_id", help="Approve a single memory by ID")
    parser.add_argument("--reject", dest="reject_id", help="Reject a memory by ID")
    parser.add_argument("--reason", default="", help="Rejection reason")
    parser.add_argument("--storage", default=None, help="Storage dir (overrides MEMKOSHI_STORAGE)")
    parser.add_argument("--json", action="store_true", help="JSON output")
    args = parser.parse_args()

    storage_path = args.storage or os.environ.get("MEMKOSHI_STORAGE", "~/.memkoshi")
    storage = SQLiteBackend(storage_path)
    storage.initialize()
    search = MemkoshiSearch(str(Path(storage_path).expanduser()))
    try:
        search.initialize()
    except Exception:
        # search is optional — approve still works without it (just no search index)
        pass

    result: dict = {"approved": [], "rejected": [], "errors": []}

    def approve_one(mem_id: str) -> None:
        try:
            storage.approve_memory(mem_id, "agent")
            mem = storage.get_memory(mem_id)
            if mem is not None:
                search.index_memory(mem)
            result["approved"].append(mem_id)
        except Exception as e:  # noqa: BLE001
            result["errors"].append({"id": mem_id, "error": str(e)})

    if args.reject_id:
        try:
            storage.reject_memory(args.reject_id, args.reason or "agent rejected")
            result["rejected"].append(args.reject_id)
        except Exception as e:  # noqa: BLE001
            result["errors"].append({"id": args.reject_id, "error": str(e)})
    elif args.all:
        staged = storage.list_staged()
        for mem in staged:
            approve_one(mem.id)
    elif args.memory_id:
        approve_one(args.memory_id)
    else:
        parser.print_help()
        return 2

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result["approved"]:
            print(f"approved {len(result['approved'])} memories:")
            for mid in result["approved"]:
                print(f"  + {mid}")
        if result["rejected"]:
            print(f"rejected {len(result['rejected'])} memories:")
            for mid in result["rejected"]:
                print(f"  - {mid}")
        if result["errors"]:
            print(f"errors ({len(result['errors'])}):", file=sys.stderr)
            for err in result["errors"]:
                print(f"  ! {err['id']}: {err['error']}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
