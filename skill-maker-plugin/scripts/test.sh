#!/usr/bin/env bash
# test.sh — smoke test for skill-maker.
#
# Verifies:
#   1. All 6 plugins in the monorepo validate cleanly
#   2. Scaffolding round-trip: new → validate → no errors
#   3. Lint round-trip: scaffolded plugin produces expected warnings
#
# Run from anywhere. Exits 0 on pass, non-zero on fail.

set -euo pipefail

# Locate self
SELF=$(readlink -f "$0")
PLUGIN_ROOT=$(cd "$(dirname "$SELF")/.." && pwd)
REPO_ROOT=$(cd "$PLUGIN_ROOT/.." && pwd)
SKILL="$PLUGIN_ROOT/bin/skill"

echo "skill-maker smoke test"
echo "  plugin: $PLUGIN_ROOT"
echo "  repo:   $REPO_ROOT"
echo

fail=0

# ── 1. validate all known plugins ──────────────────────────────────────────

echo "→ validating all plugins under $REPO_ROOT"
if "$SKILL" validate "$REPO_ROOT" >/dev/null 2>&1; then
  echo "  ✓ all plugins validate clean"
else
  echo "  ✗ validation failed"
  "$SKILL" validate "$REPO_ROOT"
  fail=$((fail + 1))
fi

# ── 2. scaffold + validate round-trip ──────────────────────────────────────

tmp=$(mktemp -d)
trap "rm -rf $tmp" EXIT

echo
echo "→ round-trip: single-skill"
"$SKILL" new plugin smoke-single --plugin-dir "$tmp" \
  --desc "Smoke-test plugin scaffolded by test.sh — validates round-trip behavior." \
  >/dev/null 2>&1
if "$SKILL" validate "$tmp/smoke-single-plugin" >/dev/null 2>&1; then
  echo "  ✓ single-skill scaffold validates clean"
else
  echo "  ✗ single-skill scaffold failed validation"
  "$SKILL" validate "$tmp/smoke-single-plugin"
  fail=$((fail + 1))
fi

echo
echo "→ round-trip: umbrella"
"$SKILL" new plugin smoke-umbrella --umbrella --plugin-dir "$tmp" \
  --desc "Smoke-test umbrella plugin — verifies the index + docs/ layout works." \
  >/dev/null 2>&1
if "$SKILL" validate "$tmp/smoke-umbrella-plugin" >/dev/null 2>&1; then
  echo "  ✓ umbrella scaffold validates clean"
else
  echo "  ✗ umbrella scaffold failed validation"
  fail=$((fail + 1))
fi

echo
echo "→ round-trip: memory"
"$SKILL" new plugin smoke-memory --memory --plugin-dir "$tmp" \
  --desc "Smoke-test plugin with memory hooks — verifies VelociRAG scaffolding emits." \
  >/dev/null 2>&1
if "$SKILL" validate "$tmp/smoke-memory-plugin" >/dev/null 2>&1; then
  echo "  ✓ memory scaffold validates clean"
else
  echo "  ✗ memory scaffold failed validation"
  fail=$((fail + 1))
fi

# memory layout produces lib/memory.sh + docs/self-healing.md
if [[ -f "$tmp/smoke-memory-plugin/lib/memory.sh" && -f "$tmp/smoke-memory-plugin/docs/self-healing.md" ]]; then
  echo "  ✓ memory layout has lib/memory.sh + docs/self-healing.md"
else
  echo "  ✗ memory layout missing expected files"
  fail=$((fail + 1))
fi

# ── 3. add skill round-trip ────────────────────────────────────────────────

echo
echo "→ round-trip: add a skill"
"$SKILL" new skill helper --plugin "$tmp/smoke-single-plugin" \
  --desc "Helper skill — use to verify that add-skill scaffolding works on existing plugins." \
  >/dev/null 2>&1
if "$SKILL" validate "$tmp/smoke-single-plugin" >/dev/null 2>&1; then
  echo "  ✓ add-skill validates clean"
else
  echo "  ✗ add-skill broke validation"
  fail=$((fail + 1))
fi

# ── 4. lint catches expected drift ─────────────────────────────────────────

echo
echo "→ lint catches short description"
"$SKILL" new plugin shorty --plugin-dir "$tmp" --desc "no" >/dev/null 2>&1
warns=$("$SKILL" lint "$tmp/shorty-plugin" 2>&1 | grep -c '⚠' || true)
if [[ "$warns" -ge 2 ]]; then
  echo "  ✓ lint emits ≥2 warnings on bad scaffold ($warns)"
else
  echo "  ✗ lint should have emitted warnings on bad scaffold (got $warns)"
  fail=$((fail + 1))
fi

# ── 5. force overwrite ─────────────────────────────────────────────────────

echo
echo "→ refuses to overwrite without --force"
if "$SKILL" new plugin smoke-single --plugin-dir "$tmp" >/dev/null 2>&1; then
  echo "  ✗ should have refused"
  fail=$((fail + 1))
else
  echo "  ✓ refused"
fi
if "$SKILL" new plugin smoke-single --plugin-dir "$tmp" --force --desc "now forced overwrite of the smoke-single plugin's metadata." >/dev/null 2>&1; then
  echo "  ✓ --force overwrites"
else
  echo "  ✗ --force failed"
  fail=$((fail + 1))
fi

# ── summary ────────────────────────────────────────────────────────────────

echo
if [[ "$fail" -eq 0 ]]; then
  echo "✓ all smoke tests passed"
  exit 0
else
  echo "✗ $fail smoke test(s) failed"
  exit 1
fi
