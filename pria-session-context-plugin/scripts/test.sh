#!/usr/bin/env bash
# scripts/test.sh — verification for the pria-session-context plugin.
#
# Runs:
#   1. plugin-maker validate  (manifest ⊆ closed HookKind/Permission catalog)
#   2. python unit tests      (loader, audit, policy, credential)
#   3. stdio handshake smoke   (real subprocess over JSON-RPC framing)
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

section "1. Manifest validation (closed HookKind/Permission catalog)"
if [[ -x "$PM" ]]; then
  if "$PM" validate "$ROOT" >/tmp/pria-validate.out 2>&1; then
    pass "plugin-maker validate"
  else
    cat /tmp/pria-validate.out; fail "plugin-maker validate"
  fi
else
  red "plugin-maker not found at $PM (skipping manifest validate)"
fi

section "2. Python unit tests"
if PRIA_AUDIT_QUIET=1 python3 -m unittest discover -s "$ROOT/tests" -p 'test_*.py' -v 2>&1; then
  pass "unit tests"
else
  fail "unit tests"
fi

section "3. Stdio handshake smoke test"
if python3 "$ROOT/scripts/stdio_harness.py"; then
  pass "stdio handshake"
else
  fail "stdio handshake"
fi

section "Result"
if [[ $fails -eq 0 ]]; then
  green "ALL PASS"
  exit 0
else
  red "$fails check(s) failed"
  exit 1
fi
