#!/usr/bin/env bash
# languages.sh — directory-driven language template registry.

if [[ -n "${_PM_LANGUAGES_LOADED:-}" ]]; then return 0; fi
_PM_LANGUAGES_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
TMPL_DIR="${TMPL_DIR:-$(cd "$LIB_DIR/../templates" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"

surface_dir() {
  local surface="$1"
  printf '%s/%s\n' "$TMPL_DIR" "$surface"
}

list_template_languages() {
  local surface="$1" dir
  dir="$(surface_dir "$surface")"
  [[ -d "$dir" ]] || return 0
  find "$dir" -mindepth 1 -maxdepth 1 -type d ! -name '_*' -printf '%f\n' | sort
}

lang_manifest_path() {
  local surface="$1" lang="$2"
  printf '%s/%s/lang.json\n' "$(surface_dir "$surface")" "$lang"
}

is_template_language() {
  local surface="$1" lang="$2"
  [[ -f "$(lang_manifest_path "$surface" "$lang")" ]]
}

require_template_language() {
  local surface="$1" lang="$2" available
  if ! is_template_language "$surface" "$lang"; then
    available="$(list_template_languages "$surface" | paste -sd ', ' -)"
    die "unknown $surface language: '$lang' (available: ${available:-none}; try: plugin-maker catalog languages)"
  fi
}

lang_get() {
  local surface="$1" lang="$2" jq_expr="$3"
  jq -r "$jq_expr // empty" "$(lang_manifest_path "$surface" "$lang")"
}

lang_json() {
  local surface="$1" lang="$2" jq_expr="$3"
  jq -c "$jq_expr" "$(lang_manifest_path "$surface" "$lang")"
}

lang_interpreter_available() {
  local surface="$1" lang="$2" cmd
  cmd="$(lang_get "$surface" "$lang" '.requires[0]')"
  [[ -z "$cmd" ]] && return 0
  command -v "$cmd" >/dev/null 2>&1
}
