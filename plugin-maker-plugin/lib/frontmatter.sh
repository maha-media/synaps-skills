#!/usr/bin/env bash
# frontmatter.sh — parse YAML frontmatter from a markdown file.
#
# Public API:
#   fm_extract FILE     → emits the frontmatter body (between leading `---` markers).
#   fm_get FILE KEY     → emits the value of KEY (last wins; quoted strings stripped).
#   fm_has FILE         → 0 if file has frontmatter, 1 otherwise.
#
# Limitations: flat scalar keys only. By design — frontmatter must stay simple.

if [[ -n "${_PM_FM_LOADED:-}" ]]; then return 0; fi
_PM_FM_LOADED=1

fm_has() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  local first
  first=$(head -n 1 "$file") || return 1
  [[ "$first" == "---" ]]
}

fm_extract() {
  local file="$1"
  fm_has "$file" || return 1
  awk '
    BEGIN { state = 0 }
    state == 0 && /^---[[:space:]]*$/ { state = 1; next }
    state == 1 && /^---[[:space:]]*$/ { state = 2; exit }
    state == 1 { print }
  ' "$file"
}

fm_get() {
  local file="$1" key="$2"
  fm_extract "$file" \
    | awk -v k="$key" '
        $0 ~ "^"k":[ \t]*" {
          sub("^"k":[ \t]*", "", $0)
          sub(/[ \t]+$/, "", $0)
          if ($0 ~ /^".*"$/)       { $0 = substr($0, 2, length($0)-2) }
          else if ($0 ~ /^'\''.*'\''$/) { $0 = substr($0, 2, length($0)-2) }
          val = $0
        }
        END { if (val != "") print val }
      '
}
