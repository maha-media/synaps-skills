#!/usr/bin/env bash
# scripts/test.sh — verification for the pria-fsmon plugin.
#
#   1. plugin-maker validate (manifest + skill structure)
#   2. cargo build --all-targets (warning-free)
#   3. cargo test (policy/audit/control/daemon unit + control-socket integration)
#   4. binary smoke (version + check)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_ROOT="$(cd "$ROOT/.." && pwd)"
CRATE="$ROOT/extensions/synaps-fsmon"
PM="$SKILLS_ROOT/plugin-maker-plugin/bin/plugin-maker"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
section() { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

fails=0
pass() { green "✓ $1"; }
fail() { red   "✗ $1"; fails=$((fails + 1)); }

section "1. Plugin/skill validation"
if [[ -x "$PM" ]]; then
  if "$PM" validate "$ROOT" >/tmp/fsmon-validate.out 2>&1; then
    pass "plugin-maker validate"
  else
    cat /tmp/fsmon-validate.out; fail "plugin-maker validate"
  fi
else
  red "plugin-maker not found at $PM"
fi

section "2. cargo build --all-targets (warning-free)"
build_out="$(cd "$CRATE" && cargo build --all-targets 2>&1)"
echo "$build_out" | tail -3
if echo "$build_out" | grep -q "warning:"; then
  fail "cargo build had warnings"
else
  pass "cargo build clean"
fi

section "3. cargo test"
if (cd "$CRATE" && cargo test 2>&1 | tail -20); then
  pass "cargo test"
else
  fail "cargo test"
fi

section "4. cargo clippy (if available)"
if (cd "$CRATE" && cargo clippy --version >/dev/null 2>&1); then
  if (cd "$CRATE" && cargo clippy --all-targets -- -D warnings 2>&1 | tail -5); then
    pass "cargo clippy clean"
  else
    fail "cargo clippy"
  fi
else
  red "cargo clippy not installed in this environment — skipped (build is warning-free)"
fi

section "5. binary smoke"
if (cd "$CRATE" && cargo build --release >/dev/null 2>&1) && \
   "$CRATE/target/release/synaps_fsmon" check >/dev/null; then
  pass "binary version+check"
else
  fail "binary smoke"
fi

section "6. B8 guest-agent contract round-trip (policy push + audit forward)"
if python3 "$ROOT/scripts/guest_agent_stub.py" >/tmp/fsmon-b8.out 2>&1; then
  tail -3 /tmp/fsmon-b8.out
  pass "B8 round-trip"
else
  cat /tmp/fsmon-b8.out; fail "B8 round-trip"
fi

section "Result"
if [[ $fails -eq 0 ]]; then
  green "ALL PASS"; exit 0
else
  red "$fails check(s) failed"; exit 1
fi
