#!/usr/bin/env python3
"""VM automation memory helper wrapping VelociRAG when available."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import subprocess
from pathlib import Path

MEMORY_ROOT = Path.home() / ".synaps-cli" / "memory" / "vm"


def recall(args):
    if shutil.which("velocirag") is None:
        return {"available": False, "results": [], "message": "velocirag not installed"}
    completed = subprocess.run(["velocirag", "search", str(MEMORY_ROOT), args.query], text=True, capture_output=True, check=False)
    return {"available": completed.returncode == 0, "stdout": completed.stdout, "stderr": completed.stderr}


def commit(args):
    MEMORY_ROOT.mkdir(parents=True, exist_ok=True)
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = MEMORY_ROOT / f"{timestamp}-{args.kind}.md"
    payload = args.text or (Path(args.file).read_text() if args.file else "")
    path.write_text(f"---\nkind: {args.kind}\ncreated: {timestamp}\n---\n\n{payload}\n")
    indexed = False
    if shutil.which("velocirag") is not None:
        subprocess.run(["velocirag", "index", str(MEMORY_ROOT)], check=False)
        indexed = True
    return {"path": str(path), "indexed": indexed}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("recall"); p.add_argument("query"); p.set_defaults(func=recall)
    p = sub.add_parser("commit"); p.add_argument("--kind", choices=["selector", "plan", "failure", "lesson"], required=True); p.add_argument("--text"); p.add_argument("--file"); p.set_defaults(func=commit)
    args = parser.parse_args()
    print(json.dumps(args.func(args), indent=2))


if __name__ == "__main__":
    main()
