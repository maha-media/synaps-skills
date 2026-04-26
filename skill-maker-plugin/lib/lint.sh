#!/usr/bin/env bash
# lint.sh — opinionated quality checks for plugins and skills.
#
# Rules (severity = warn unless --strict):
#   F003  description < 40 chars
#   F004  description > 200 chars
#   F005  description lacks trigger phrase ("use when", "for ", "drives ", etc.)
#   B001  SKILL.md body > 300 lines (consider progressive disclosure)
#   B002  TODO / FIXME / XXX / placeholder text in shipped SKILL.md
#   B003  body has no `##` section headings
#   P004  plugin.json description < 40 chars

if [[ -n "${_SKILL_LINT_LOADED:-}" ]]; then return 0; fi
_SKILL_LINT_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=frontmatter.sh
source "$LIB_DIR/frontmatter.sh"

# Trigger phrases (case-insensitive substring match)
_TRIGGERS=(
  "use when"
  "use before"
  "use after"
  "use for"
  "use to"
  "for "
  "drives "
  "creates "
  "scaffold"
  "validates"
  "lints"
  "guides"
  "delivers"
  "performs"
  "extracts"
  "fetches"
  "breaks "
  "decomposes"
  "decomposing"
  "breaking "
  "writing "
  "writes "
  "before "
  "after "
  "when "
  "while "
)

# _has_trigger STRING → 0 if any trigger phrase present
_has_trigger() {
  local s="${1,,}"  # lowercase
  for t in "${_TRIGGERS[@]}"; do
    [[ "$s" == *"$t"* ]] && return 0
  done
  return 1
}

# Counters: error count returned by callers; warnings always emitted to stderr.
_LINT_WARN=0
_LINT_ERR=0
_LINT_STRICT=0

# emit_warn ID FILE MSG → if --strict: count as error and use err(); else warn()
_emit() {
  local id="$1" file="$2" msg="$3"
  local prefix="$id: $file"
  if [[ "$_LINT_STRICT" -eq 1 ]]; then
    err "$prefix: $msg"
    _LINT_ERR=$((_LINT_ERR + 1))
  else
    warn "$prefix: $msg"
    _LINT_WARN=$((_LINT_WARN + 1))
  fi
}

# lint_skill_md FILE
lint_skill_md() {
  local file="$1"
  [[ -f "$file" ]] || return 0

  local desc
  desc=$(fm_get "$file" description || true)

  if [[ -n "$desc" ]]; then
    local len="${#desc}"
    if [[ "$len" -lt 40 ]]; then
      _emit F003 "$file" "description too short ($len chars; aim ≥40)"
    elif [[ "$len" -gt 200 ]]; then
      _emit F004 "$file" "description too long ($len chars; aim ≤200)"
    fi
    if ! _has_trigger "$desc"; then
      _emit F005 "$file" "description lacks a trigger phrase (e.g. 'Use when …', 'Drives …')"
    fi
  fi

  # body length (excluding frontmatter)
  local body_lines
  body_lines=$(awk '
    BEGIN { state = 0 }
    state == 0 && /^---[[:space:]]*$/ { state = 1; next }
    state == 1 && /^---[[:space:]]*$/ { state = 2; next }
    state == 2 { count++ }
    END { print count + 0 }
  ' "$file")
  if [[ "$body_lines" -gt 300 ]]; then
    _emit B001 "$file" "body is $body_lines lines — consider progressive disclosure (split into docs/)"
  fi

  # placeholder / TODO scan (only inside the body, not frontmatter)
  local placeholders
  placeholders=$(awk '
    BEGIN { state = 0 }
    state == 0 && /^---[[:space:]]*$/ { state = 1; next }
    state == 1 && /^---[[:space:]]*$/ { state = 2; next }
    state == 2 && /TODO|FIXME|XXX|_TODO|_REPLACE_|<placeholder>/ { print NR ": " $0 }
  ' "$file")
  if [[ -n "$placeholders" ]]; then
    local count
    count=$(printf '%s\n' "$placeholders" | wc -l)
    _emit B002 "$file" "$count TODO/placeholder marker(s) found (first: $(printf '%s\n' "$placeholders" | head -1))"
  fi

  # section headings count
  local heading_count
  heading_count=$(awk '
    BEGIN { state = 0 }
    state == 0 && /^---[[:space:]]*$/ { state = 1; next }
    state == 1 && /^---[[:space:]]*$/ { state = 2; next }
    state == 2 && /^##[[:space:]]/ { count++ }
    END { print count + 0 }
  ' "$file")
  if [[ "$heading_count" -eq 0 && "$body_lines" -gt 30 ]]; then
    _emit B003 "$file" "no '##' section headings in a ${body_lines}-line body"
  fi
}

# lint_plugin_json FILE
lint_plugin_json() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local desc
  desc=$(jq -r '.description // empty' "$file" 2>/dev/null || true)
  if [[ -n "$desc" ]]; then
    local len="${#desc}"
    if [[ "$len" -lt 40 ]]; then
      _emit P004 "$file" "description too short ($len chars; aim ≥40)"
    fi
  fi
}

# lint_plugin DIR — runs all checks
lint_plugin() {
  local dir="$1"
  lint_plugin_json "$dir/.synaps-plugin/plugin.json"
  while IFS= read -r skill_dir; do
    [[ -z "$skill_dir" ]] && continue
    lint_skill_md "$skill_dir/SKILL.md"
  done < <(enumerate_skills "$dir")
}

# lint_main — entrypoint, parses args
lint_main() {
  local target="."
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --strict) _LINT_STRICT=1; shift ;;
      --*) die "unknown lint flag: $1" ;;
      *) target="$1"; shift ;;
    esac
  done

  target=$(cd "$target" && pwd)
  local plugins_checked=0

  if is_plugin_dir "$target"; then
    lint_plugin "$target"
    plugins_checked=1
  else
    while IFS= read -r p; do
      [[ -z "$p" ]] && continue
      info "${C_BOLD}→ $p${C_OFF}"
      lint_plugin "$p"
      plugins_checked=$((plugins_checked + 1))
    done < <(enumerate_plugins "$target")
  fi

  if [[ "$plugins_checked" -eq 0 ]]; then
    die "no plugins found under $target"
  fi

  if [[ "$_LINT_ERR" -eq 0 && "$_LINT_WARN" -eq 0 ]]; then
    ok "${plugins_checked} plugin(s) lint-clean"
    return 0
  fi

  if [[ "$_LINT_STRICT" -eq 1 ]]; then
    if [[ "$_LINT_ERR" -gt 0 ]]; then
      err "${_LINT_ERR} lint error(s) (--strict)"
      return 1
    fi
  else
    info "${C_DIM}${_LINT_WARN} warning(s); use --strict to fail on these${C_OFF}"
  fi
  return 0
}
