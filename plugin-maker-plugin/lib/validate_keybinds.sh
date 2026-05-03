#!/usr/bin/env bash
# validate_keybinds.sh — K### rules for the keybinds block.
# Mirrors src/skills/keybinds.rs::parse_key + reserved-key list in catalog.sh.

if [[ -n "${_PM_VALIDATE_KB_LOADED:-}" ]]; then return 0; fi
_PM_VALIDATE_KB_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=catalog.sh
source "$LIB_DIR/catalog.sh"

# parse_key NOTATION → 0 if parses; emits canonical form on stdout (or error)
_parse_key() {
  local raw="$1"
  # Allow notation forms like: "C-s", "C-S-s", "A-Left", "F8", "Space", "C-Space"
  # Modifiers: C, S, A. Last component is the key name.
  if [[ -z "$raw" ]]; then return 1; fi
  local key
  IFS='-' read -r -a parts <<<"$raw"
  local n=${#parts[@]}
  if [[ "$n" -lt 1 ]]; then return 1; fi
  key="${parts[$((n-1))]}"

  # Validate modifiers
  local i=0
  while [[ "$i" -lt $((n-1)) ]]; do
    case "${parts[$i]}" in
      C|S|A) ;;
      *) return 1 ;;
    esac
    i=$((i + 1))
  done

  # Validate key
  if [[ "$key" =~ ^.$ ]]; then
    : # single char OK
  elif [[ "$key" =~ ^F([1-9]|1[0-2])$ ]]; then
    : # F1-F12
  else
    case "$key" in
      Space|Tab|Enter|Esc|Up|Down|Left|Right|Home|End|Backspace|PageUp|PageDown|Insert|Delete) ;;
      *) return 1 ;;
    esac
  fi

  printf '%s\n' "$raw"
  return 0
}

validate_keybinds() {
  local file="$1"
  local errs=0

  local kb_count
  kb_count=$(jq -r '.keybinds | length' "$file" 2>/dev/null || echo 0)

  local i=0
  while [[ "$i" -lt "$kb_count" ]]; do
    local key action cmd skill prompt script desc
    key=$(jq -r ".keybinds[$i].key // empty" "$file")
    action=$(jq -r ".keybinds[$i].action // empty" "$file")
    cmd=$(jq -r ".keybinds[$i].command // empty" "$file")
    skill=$(jq -r ".keybinds[$i].skill // empty" "$file")
    prompt=$(jq -r ".keybinds[$i].prompt // empty" "$file")
    script=$(jq -r ".keybinds[$i].script // empty" "$file")
    desc=$(jq -r ".keybinds[$i].description // empty" "$file")

    # K001 — key parses
    if ! _parse_key "$key" >/dev/null; then
      err "K001: keybinds[$i] invalid key notation: '$key'"
      errs=$((errs + 1))
    fi

    # K004 — reserved
    if is_reserved_key "$key"; then
      err "K004: keybinds[$i] '$key' is reserved by core (cannot be overridden)"
      errs=$((errs + 1))
    fi

    # K002 — action known
    if [[ -z "$action" ]] || ! is_known_action_kind "$action"; then
      err "K002: keybinds[$i] action must be one of: slash_command|load_skill|inject_prompt|run_script (got '$action')"
      errs=$((errs + 1))
    else
      # K003 — required field present
      local needed
      needed=$(action_required_field "$action")
      case "$needed" in
        command) [[ -z "$cmd" ]]   && { err "K003: keybinds[$i] action=$action requires 'command'";   errs=$((errs + 1)); } ;;
        skill)   [[ -z "$skill" ]] && { err "K003: keybinds[$i] action=$action requires 'skill'";     errs=$((errs + 1)); } ;;
        prompt)  [[ -z "$prompt" ]] && { err "K003: keybinds[$i] action=$action requires 'prompt'";   errs=$((errs + 1)); } ;;
        script)  [[ -z "$script" ]] && { err "K003: keybinds[$i] action=$action requires 'script'";   errs=$((errs + 1)); } ;;
      esac
    fi

    # K005 — description (lint, but counted as a low-noise hint)
    if [[ -z "$desc" ]]; then
      warn "K005: keybinds[$i] '$key' has no 'description' (shown in /keybinds)"
    fi

    i=$((i + 1))
  done

  return $errs
}
