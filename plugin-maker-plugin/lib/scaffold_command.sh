#!/usr/bin/env bash
# scaffold_command.sh — append a command entry to a plugin's commands[].
#
# Public:
#   scaffold_command <kind> <name> [--plugin PATH] [--description TEXT] [--force] ...
#
# Kind-specific flags:
#   shell       : --command CMD [--args A1,A2,…]
#   extension   : --tool TOOL [--input JSON]
#   skill       : --skill NAME --prompt TEXT
#   interactive : [--subcommands s1,s2,…]

if [[ -n "${_PM_SCAFFOLD_CMD_LOADED:-}" ]]; then return 0; fi
_PM_SCAFFOLD_CMD_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"

scaffold_command() {
  local kind="${1:-}"; shift || true
  local name="${1:-}"; shift || true

  [[ -n "$kind" ]] || die "usage: plugin-maker new command <shell|extension|skill|interactive> <name> ..."
  [[ -n "$name" ]] || die "command name required"

  local plugin_path="" desc=""
  local cmd="" args_csv="" tool="" input="{}" skill="" prompt="" subcmds_csv="" force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --plugin)       plugin_path="$2"; shift 2 ;;
      --description)  desc="$2"; shift 2 ;;
      --command)      cmd="$2"; shift 2 ;;
      --args)         args_csv="$2"; shift 2 ;;
      --tool)         tool="$2"; shift 2 ;;
      --input)        input="$2"; shift 2 ;;
      --skill)        skill="$2"; shift 2 ;;
      --prompt)       prompt="$2"; shift 2 ;;
      --subcommands)  subcmds_csv="$2"; shift 2 ;;
      --force)        force=1; shift ;;
      *)              die "unknown flag: $1" ;;
    esac
  done

  if [[ -z "$plugin_path" ]]; then
    plugin_path=$(plugin_root_of ".") || die "not inside a plugin (use --plugin PATH)"
  fi
  is_plugin_dir "$plugin_path" || die "not a plugin: $plugin_path"

  local pj="$plugin_path/.synaps-plugin/plugin.json"

  # Refuse duplicate name unless --force
  local existing
  existing=$(jq -r --arg n "$name" '.commands // [] | map(select(.name == $n)) | length' "$pj")
  if [[ "$existing" != "0" && "$force" -ne 1 ]]; then
    die "command '$name' already exists in $pj (use --force)"
  fi

  local entry
  case "$kind" in
    shell)
      [[ -n "$cmd" ]] || die "shell command requires --command"
      local args_json='[]'
      if [[ -n "$args_csv" ]]; then
        args_json=$(awk -F, '{ printf "["; for(i=1;i<=NF;i++) printf "\"%s\"%s", $i, (i<NF?",":""); printf "]"; }' <<<"$args_csv")
      fi
      entry=$(jq -n --arg n "$name" --arg d "$desc" --arg c "$cmd" --argjson a "$args_json" \
        '{name:$n, description:$d, command:$c, args:$a}')
      ;;
    extension)
      [[ -n "$tool" ]] || die "extension command requires --tool"
      entry=$(jq -n --arg n "$name" --arg d "$desc" --arg t "$tool" --argjson i "$input" \
        '{name:$n, description:$d, tool:$t, input:$i}')
      ;;
    skill)
      [[ -n "$skill" && -n "$prompt" ]] || die "skill command requires --skill and --prompt"
      entry=$(jq -n --arg n "$name" --arg d "$desc" --arg s "$skill" --arg p "$prompt" \
        '{name:$n, description:$d, skill:$s, prompt:$p}')
      ;;
    interactive)
      local subs_json='[]'
      if [[ -n "$subcmds_csv" ]]; then
        subs_json=$(awk -F, '{ printf "["; for(i=1;i<=NF;i++) printf "\"%s\"%s", $i, (i<NF?",":""); printf "]"; }' <<<"$subcmds_csv")
      fi
      entry=$(jq -n --arg n "$name" --arg d "$desc" --argjson s "$subs_json" \
        '{name:$n, description:$d, interactive:true, subcommands:$s}')
      ;;
    *)
      die "unknown command kind: '$kind' (expected: shell|extension|skill|interactive)"
      ;;
  esac

  if [[ "$existing" != "0" ]]; then
    # Replace
    jq --arg n "$name" --argjson e "$entry" \
      '.commands |= ((. // []) | map(if .name == $n then $e else . end))' \
      "$pj" > "$pj.tmp" && mv "$pj.tmp" "$pj"
  else
    jq --argjson e "$entry" \
      '.commands = ((.commands // []) + [$e])' \
      "$pj" > "$pj.tmp" && mv "$pj.tmp" "$pj"
  fi

  ok "added $kind command '$name' to $pj"
}
