#!/usr/bin/env bash
# common.sh — shared helpers (logging, color, arg parsing, path helpers).
# Source this from any other lib/*.sh.

# Idempotent: only define helpers once.
if [[ -n "${_SKILL_COMMON_LOADED:-}" ]]; then return 0; fi
_SKILL_COMMON_LOADED=1

# ── color (TTY-aware) ──────────────────────────────────────────────────────

if [[ -t 2 ]]; then
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_DIM=$'\033[2m'
  C_BOLD=$'\033[1m'
  C_OFF=$'\033[0m'
else
  C_RED= C_GREEN= C_YELLOW= C_BLUE= C_DIM= C_BOLD= C_OFF=
fi

# ── logging ────────────────────────────────────────────────────────────────

info() { printf '%s\n' "$*" >&2; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_OFF" "$*" >&2; }
warn() { printf '%s⚠%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
err()  { printf '%s✗%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; }
die()  { err "$*"; exit 1; }
hr()   { printf '%s\n' "${C_DIM}────────────────────────────────────────────────${C_OFF}" >&2; }

# ── deps ───────────────────────────────────────────────────────────────────

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "missing required tool: $cmd"
}

# ── path helpers ───────────────────────────────────────────────────────────

# repo_root_of PATH → prints the dir containing .synaps-plugin if found by walking up
# Usage: ROOT=$(plugin_root_of "$PATH")
plugin_root_of() {
  local p="${1:-.}"
  p=$(cd "$p" 2>/dev/null && pwd) || return 1
  while [[ "$p" != "/" ]]; do
    if [[ -f "$p/.synaps-plugin/plugin.json" ]]; then
      printf '%s\n' "$p"
      return 0
    fi
    p=$(dirname "$p")
  done
  return 1
}

# is_plugin_dir PATH → 0 if dir is a plugin root
is_plugin_dir() {
  [[ -f "$1/.synaps-plugin/plugin.json" ]]
}

# enumerate_plugins ROOT → emit each */.synaps-plugin/plugin.json's parent dir
enumerate_plugins() {
  local root="${1:-.}"
  find "$root" -maxdepth 3 -type f -name plugin.json -path '*/.synaps-plugin/*' 2>/dev/null \
    | while read -r f; do
        printf '%s\n' "$(dirname "$(dirname "$f")")"
      done
}

# enumerate_skills PLUGIN_DIR → emit each skill dir
enumerate_skills() {
  local plugin="${1:-.}"
  [[ -d "$plugin/skills" ]] || return 0
  find "$plugin/skills" -mindepth 1 -maxdepth 1 -type d | sort
}

# ── arg helpers ────────────────────────────────────────────────────────────

# pop_flag NAME ARRAY... → look for --NAME in array, return its value via stdout
# Not used yet; we parse args directly in subcommands.
