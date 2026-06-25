#!/usr/bin/env bash
# git_guard.sh — defense-in-depth pre-commit guard (spec §6, §8).
# Independently blocks a committed Builder-lineage edit to protected oracle paths.
# Lineage role is read from env ORACLE_LINEAGE_ROLE (set by the orchestrator at
# dispatch time). Designer/Architect/Orchestrator pass; Builder is blocked when a
# staged change touches a protected path. Exits non-zero to abort the commit.
set -euo pipefail

ROLE="${ORACLE_LINEAGE_ROLE:-unknown}"
PROTECTED_RE='^(\.oracle/|tools/oracle/|test/oracle-harness/)'

staged="$(git diff --cached --name-only 2>/dev/null || true)"
offending="$(printf '%s\n' "$staged" | grep -E "$PROTECTED_RE" || true)"

case "$ROLE" in
  designer|orchestrator)
    exit 0 ;;
  architect)
    # Architect may only touch .oracle/contract/**
    bad="$(printf '%s\n' "$offending" | grep -vE '^\.oracle/contract/' | grep -E "$PROTECTED_RE" || true)"
    if [ -n "$bad" ]; then
      echo "ORACLE GUARD: architect may only modify .oracle/contract/** — blocked:" >&2
      printf '%s\n' "$bad" >&2
      exit 1
    fi
    exit 0 ;;
  builder)
    if [ -n "$offending" ]; then
      echo "ORACLE GUARD: write-segregation — builder lineage may not edit oracle/test paths. Blocked commit:" >&2
      printf '%s\n' "$offending" >&2
      exit 1
    fi
    exit 0 ;;
  *)
    if [ -n "$offending" ]; then
      echo "ORACLE GUARD: unknown lineage role '$ROLE' may not edit protected paths. Blocked:" >&2
      printf '%s\n' "$offending" >&2
      exit 1
    fi
    exit 0 ;;
esac
