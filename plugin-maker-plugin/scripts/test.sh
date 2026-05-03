#!/usr/bin/env bash
# scripts/test.sh — end-to-end smoke test for plugin-maker.
#
# Verifies:
#   1. CLI dispatches every subcommand.
#   2. Catalog dumps work (and short aliases).
#   3. Validate is clean on plugin-maker itself.
#   4. Scaffolding a new plugin + extension + sidecar + command + keybind
#      + settings yields a manifest that validate-and-lint clean.
#   5. The Python extension at extensions/plugin_maker_ext.py responds to
#      initialize / shutdown.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PM="$ROOT/bin/plugin-maker"

green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
section() { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

fails=0
pass() { green "✓ $1"; }
fail() { red   "✗ $1"; fails=$((fails + 1)); }

section "1. CLI surface"
"$PM" --help >/dev/null && pass "--help"             || fail "--help"
"$PM" catalog hooks >/dev/null && pass "catalog hooks" || fail "catalog hooks"
"$PM" catalog perms >/dev/null && pass "catalog perms (alias)" || fail "catalog perms"
"$PM" catalog frames >/dev/null && pass "catalog frames" || fail "catalog frames"
"$PM" catalog actions >/dev/null && pass "catalog actions" || fail "catalog actions"

section "2. Self-validation"
"$PM" validate "$ROOT" >/dev/null 2>&1 && pass "plugin-maker validates itself" || fail "self-validate"
"$PM" lint     "$ROOT" >/dev/null 2>&1 && pass "plugin-maker lints clean"      || fail "self-lint"

section "3. Scaffolding round-trip"
TMP="$(mktemp -d -t pm-test.XXXXXX)"
cd "$TMP"
"$PM" new plugin demo --umbrella --extension python --sidecar python \
  --desc "Use when smoke-testing plugin-maker scaffolders end-to-end." \
  >/dev/null 2>&1 && pass "new plugin (umbrella+ext+sidecar)" || fail "new plugin"

cd "$TMP/demo-plugin"
"$PM" new command interactive demo --description "Demo interactive command for testing." >/dev/null && pass "new command interactive" || fail "new command"
"$PM" new command shell hello --description "Print hello." --command "echo hello" >/dev/null && pass "new command shell" || fail "new command shell"
"$PM" new keybind C-S-d --action slash_command --command "demo --help" --description "Demo keybind." >/dev/null && pass "new keybind" || fail "new keybind"
"$PM" new settings category demo --label "Demo Settings" >/dev/null && pass "new settings category" || fail "new settings"
"$PM" new settings field demo theme --label Theme --type cycler --options dark,light --default dark >/dev/null && pass "new settings field cycler" || fail "new settings field"

"$PM" validate . >/dev/null 2>&1 && pass "scaffolded plugin validates" || fail "scaffolded validate"
"$PM" lint     . >/dev/null 2>&1 && pass "scaffolded plugin lints"     || fail "scaffolded lint"

section "4. Extension JSON-RPC handshake"
EXT="$ROOT/extensions/plugin_maker_ext.py"
if [[ -x "$EXT" ]]; then
  out="$(printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
    '{"jsonrpc":"2.0","id":2,"method":"shutdown","params":{}}' \
    | "$EXT" 2>/dev/null)"
  if grep -q '"protocol_version":1' <<<"$out"; then
    pass "extension responds to initialize"
  else
    fail "extension initialize response"
  fi
  if grep -q '"id":2' <<<"$out"; then
    pass "extension responds to shutdown"
  else
    fail "extension shutdown response"
  fi
else
  yellow "skip — extension not executable"
fi

section "5. Cleanup"
rm -rf "$TMP" && pass "tmp removed" || fail "tmp removed"

section "RESULT"
if [[ "$fails" -eq 0 ]]; then
  green "✓ all smoke tests passed"
  exit 0
else
  red   "✗ $fails test(s) failed"
  exit 1
fi
