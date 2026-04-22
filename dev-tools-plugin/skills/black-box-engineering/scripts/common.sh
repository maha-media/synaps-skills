#!/usr/bin/env bash
# common.sh — Minimal shared helpers for BBE utility scripts
# Most pipeline logic has moved to the orchestrator agent.
# This file is kept for score-utils.sh and scaffold.sh compatibility.

# ─── JSON validation ────────────────────────────────────────

validate_json() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "ERROR: File not found: $file" >&2
    return 1
  fi
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$file" 2>/dev/null
}

estimate_tokens() {
  local file="$1"
  local chars
  chars=$(wc -c < "$file" | tr -d ' ')
  echo $(( chars / 4 ))
}
