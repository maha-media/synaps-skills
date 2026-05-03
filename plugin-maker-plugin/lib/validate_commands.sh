#!/usr/bin/env bash
# validate_commands.sh — C### rules for the commands[] block (4 shapes).
# Source: src/skills/manifest.rs::ManifestCommand
#
# Shapes:
#   shell       → has `command` (no tool/skill/prompt/interactive)
#   extension   → has `tool`
#   skill       → has `skill` + `prompt`
#   interactive → has `interactive: true`

if [[ -n "${_PM_VALIDATE_CMD_LOADED:-}" ]]; then return 0; fi
_PM_VALIDATE_CMD_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"

validate_commands() {
  local file="$1"
  local errs=0

  local count
  count=$(jq -r '.commands | length' "$file" 2>/dev/null || echo 0)

  # Detect duplicate names (P009)
  local dup_names
  dup_names=$(jq -r '.commands[]?.name' "$file" 2>/dev/null | sort | uniq -d)
  if [[ -n "$dup_names" ]]; then
    err "P009: duplicate command name(s): $(tr '\n' ' ' <<<"$dup_names")"
    errs=$((errs + 1))
  fi

  local i=0
  while [[ "$i" -lt "$count" ]]; do
    local name has_command has_tool has_skill has_prompt is_interactive
    name=$(jq -r ".commands[$i].name // empty" "$file")
    has_command=$(jq -r "(.commands[$i].command // null) != null" "$file")
    has_tool=$(jq -r "(.commands[$i].tool // null) != null" "$file")
    has_skill=$(jq -r "(.commands[$i].skill // null) != null" "$file")
    has_prompt=$(jq -r "(.commands[$i].prompt // null) != null" "$file")
    is_interactive=$(jq -r "(.commands[$i].interactive // false) == true" "$file")

    if [[ -z "$name" ]]; then
      err "P008: commands[$i] missing 'name'"
      errs=$((errs + 1))
      i=$((i + 1)); continue
    fi

    # Shape detection — exactly one must match.
    local shape="unknown"
    if [[ "$is_interactive" == "true" ]]; then
      shape="interactive"
    elif [[ "$has_tool" == "true" ]]; then
      shape="extension"
    elif [[ "$has_skill" == "true" || "$has_prompt" == "true" ]]; then
      shape="skill"
    elif [[ "$has_command" == "true" ]]; then
      shape="shell"
    fi

    case "$shape" in
      shell)
        # C001 — already by detection; nothing extra to assert
        ;;
      extension)
        # C002 — tool present (already detected)
        ;;
      skill)
        # C003 — skill + prompt both required
        if [[ "$has_skill" != "true" ]]; then
          err "C003: commands[$i] '$name' skill-prompt shape requires 'skill'"
          errs=$((errs + 1))
        fi
        if [[ "$has_prompt" != "true" ]]; then
          err "C003: commands[$i] '$name' skill-prompt shape requires 'prompt'"
          errs=$((errs + 1))
        fi
        ;;
      interactive)
        # C004 — interactive must be literal true (covered)
        ;;
      *)
        err "P008: commands[$i] '$name' matches no command shape (need one of: command, tool, skill+prompt, interactive:true)"
        errs=$((errs + 1))
        ;;
    esac

    i=$((i + 1))
  done

  return $errs
}
