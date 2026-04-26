#!/usr/bin/env bash
# frontmatter.sh — parse YAML frontmatter from a markdown file.
#
# Public API:
#   fm_extract FILE                   → emits the frontmatter body to stdout
#                                       (between the leading --- markers, exclusive),
#                                       or non-zero if no valid frontmatter present.
#   fm_get FILE KEY                   → emits the value of KEY as a string,
#                                       or non-zero if missing.
#   fm_has FILE                       → 0 if file has frontmatter, 1 otherwise.
#
# Limitations: handles only flat scalar keys + simple inline arrays.
# Anything more exotic is deliberately not supported (frontmatter should
# stay simple). For our purposes this is enough.

if [[ -n "${_SKILL_FM_LOADED:-}" ]]; then return 0; fi
_SKILL_FM_LOADED=1

fm_has() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  # Must start with `---` on line 1
  local first
  first=$(head -n 1 "$file") || return 1
  [[ "$first" == "---" ]]
}

fm_extract() {
  local file="$1"
  fm_has "$file" || return 1
  # Print lines between first and second --- markers (exclusive).
  awk '
    BEGIN { state = 0 }
    state == 0 && /^---[[:space:]]*$/ { state = 1; next }
    state == 1 && /^---[[:space:]]*$/ { state = 2; exit }
    state == 1 { print }
  ' "$file"
}

# fm_get FILE KEY → emit value (string), strip surrounding quotes.
# If multiple keys with same name, last wins.
fm_get() {
  local file="$1" key="$2"
  fm_extract "$file" \
    | awk -v k="$key" '
        # match `key: value` (case-sensitive), capture value
        $0 ~ "^"k":[ \t]*" {
          # remove leading "key:" + whitespace
          sub("^"k":[ \t]*", "", $0)
          # strip trailing whitespace
          sub(/[ \t]+$/, "", $0)
          # strip matching surrounding quotes (double or single)
          if ($0 ~ /^".*"$/) {
            $0 = substr($0, 2, length($0)-2)
          } else if ($0 ~ /^'\''.*'\''$/) {
            $0 = substr($0, 2, length($0)-2)
          }
          val = $0
        }
        END { if (val != "") print val }
      '
}
