#!/usr/bin/env bash
# scaffold_keybind.sh — append a keybind entry to a plugin's keybinds[].
#
# Public:
#   scaffold_keybind <key> --action <slash_command|load_skill|inject_prompt|run_script>
#                          [--command V|--skill V|--prompt V|--script V]
#                          [--description TEXT] [--plugin PATH] [--force]

if [[ -n "${_PM_SCAFFOLD_KB_LOADED:-}" ]]; then return 0; fi
_PM_SCAFFOLD_KB_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=catalog.sh
source "$LIB_DIR/catalog.sh"

scaffold_keybind() {
  local key="${1:-}"; shift || true
  [[ -n "$key" ]] || die "usage: plugin-maker new keybind <key> --action <kind> --command/skill/prompt/script V [--plugin PATH]"

  local plugin_path="" action="" cmd="" skill="" prompt="" script="" desc="" force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --plugin)      plugin_path="$2"; shift 2 ;;
      --action)      action="$2"; shift 2 ;;
      --command)     cmd="$2"; shift 2 ;;
      --skill)       skill="$2"; shift 2 ;;
      --prompt)      prompt="$2"; shift 2 ;;
      --script)      script="$2"; shift 2 ;;
      --description) desc="$2"; shift 2 ;;
      --force)       force=1; shift ;;
      *)             die "unknown flag: $1" ;;
    esac
  done

  if [[ -z "$plugin_path" ]]; then
    plugin_path=$(plugin_root_of ".") || die "not inside a plugin (use --plugin PATH)"
  fi
  is_plugin_dir "$plugin_path" || die "not a plugin: $plugin_path"

  is_known_action_kind "$action" || die "unknown action kind: '$action' (try: plugin-maker catalog action-types)"
  is_reserved_key "$key" && die "key '$key' is reserved by core (cannot be overridden)"

  # Required-field check
  local needed
  needed=$(action_required_field "$action")
  case "$needed" in
    command) [[ -z "$cmd" ]]    && die "action=$action requires --command" ;;
    skill)   [[ -z "$skill" ]]  && die "action=$action requires --skill" ;;
    prompt)  [[ -z "$prompt" ]] && die "action=$action requires --prompt" ;;
    script)  [[ -z "$script" ]] && die "action=$action requires --script" ;;
  esac

  local pj="$plugin_path/.synaps-plugin/plugin.json"
  local existing
  existing=$(jq -r --arg k "$key" '.keybinds // [] | map(select(.key == $k)) | length' "$pj")
  if [[ "$existing" != "0" && "$force" -ne 1 ]]; then
    die "keybind '$key' already exists in $pj (use --force)"
  fi

  local entry
  entry=$(jq -n \
    --arg k "$key" --arg a "$action" \
    --arg c "$cmd" --arg s "$skill" --arg p "$prompt" --arg sc "$script" --arg d "$desc" \
    '{
      key: $k,
      action: $a,
      command: (if $c == "" then null else $c end),
      skill: (if $s == "" then null else $s end),
      prompt: (if $p == "" then null else $p end),
      script: (if $sc == "" then null else $sc end),
      description: (if $d == "" then null else $d end)
    } | with_entries(select(.value != null))')

  if [[ "$existing" != "0" ]]; then
    jq --arg k "$key" --argjson e "$entry" \
      '.keybinds |= ((. // []) | map(if .key == $k then $e else . end))' \
      "$pj" > "$pj.tmp" && mv "$pj.tmp" "$pj"
  else
    jq --argjson e "$entry" \
      '.keybinds = ((.keybinds // []) + [$e])' \
      "$pj" > "$pj.tmp" && mv "$pj.tmp" "$pj"
  fi

  ok "added keybind '$key' → $action"
}
