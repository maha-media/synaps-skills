#!/usr/bin/env bash
# scripts/test.sh — verification for pria-app-builder-plugin.
#
# Runs:
#   1. plugin-maker validate + lint --strict (manifest, skills frontmatter/body)
#   2. python unit tests (schemas, validation, gateway request shaping, RPC)
#   3. stdio handshake smoke (real subprocess over JSON-RPC framing, no network)
#   4. syntax/JSON checks
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_ROOT="$(cd "$ROOT/.." && pwd)"
PM="$SKILLS_ROOT/plugin-maker-plugin/bin/plugin-maker"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
section() { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

fails=0
pass() { green "✓ $1"; }
fail() { red   "✗ $1"; fails=$((fails + 1)); }

section "1. plugin-maker validate + lint"
if [[ -x "$PM" ]]; then
  if "$PM" validate "$ROOT"; then pass "plugin-maker validate"; else fail "plugin-maker validate"; fi
  if "$PM" lint --strict "$ROOT"; then pass "plugin-maker lint --strict"; else fail "plugin-maker lint --strict"; fi
else
  red "plugin-maker not found at $PM (skipping manifest validate/lint)"
fi

section "2. Python unit tests"
if python3 -W error::ResourceWarning -m unittest discover -s "$ROOT/tests" -p 'test_*.py'; then
  pass "unit tests"
else
  fail "unit tests"
fi

section "3. Stdio handshake smoke test"
if python3 "$ROOT/scripts/stdio_harness.py"; then pass "stdio handshake"; else fail "stdio handshake"; fi

section "4. Syntax + JSON"
if python3 -m py_compile "$ROOT/main.py" "$ROOT/app_builder_tools.py"; then pass "py_compile"; else fail "py_compile"; fi
if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$ROOT/.synaps-plugin/plugin.json"; then pass "plugin.json parses"; else fail "plugin.json parses"; fi
if bash -n "$ROOT/scripts/test.sh"; then pass "bash -n"; else fail "bash -n"; fi

section "Result"
if [[ $fails -eq 0 ]]; then green "ALL PASS"; exit 0; else red "$fails check(s) failed"; exit 1; fi
