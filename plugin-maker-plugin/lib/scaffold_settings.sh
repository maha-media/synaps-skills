#!/usr/bin/env bash
# scaffold_settings.sh — add a settings category or field.
#
# Public:
#   scaffold_settings_category <id> --label LABEL [--plugin PATH] [--force]
#   scaffold_settings_field <category> <key> --label LABEL --editor <text|cycler|picker|custom>
#                                            [--options o1,o2,…] [--default V] [--numeric] [--help TEXT]
#                                            [--plugin PATH] [--force]

if [[ -n "${_PM_SCAFFOLD_SETTINGS_LOADED:-}" ]]; then return 0; fi
_PM_SCAFFOLD_SETTINGS_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=catalog.sh
source "$LIB_DIR/catalog.sh"

scaffold_settings_category() {
  local id="${1:-}"; shift || true
  [[ -n "$id" ]] || die "usage: plugin-maker new settings <id> --label LABEL [--plugin PATH]"

  local plugin_path="" label="" force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --plugin) plugin_path="$2"; shift 2 ;;
      --label)  label="$2"; shift 2 ;;
      --force)  force=1; shift ;;
      *)        die "unknown flag: $1" ;;
    esac
  done

  [[ -n "$label" ]] || die "--label required"

  if [[ -z "$plugin_path" ]]; then
    plugin_path=$(plugin_root_of ".") || die "not inside a plugin (use --plugin PATH)"
  fi
  is_plugin_dir "$plugin_path" || die "not a plugin: $plugin_path"

  local pj="$plugin_path/.synaps-plugin/plugin.json"
  local existing
  existing=$(jq -r --arg i "$id" '.settings.categories // [] | map(select(.id == $i)) | length' "$pj")
  if [[ "$existing" != "0" && "$force" -ne 1 ]]; then
    die "settings category '$id' already exists (use --force)"
  fi

  local entry
  entry=$(jq -n --arg i "$id" --arg l "$label" '{id:$i, label:$l, fields:[]}')

  jq --argjson e "$entry" \
    '.settings = (.settings // {categories:[]}) | .settings.categories = ((.settings.categories // []) + [$e])' \
    "$pj" > "$pj.tmp" && mv "$pj.tmp" "$pj"

  ok "added settings category '$id' ($label)"
}

scaffold_settings_field() {
  local cat_id="${1:-}"
  local key="${2:-}"
  if [[ -n "$cat_id" ]]; then shift; fi
  if [[ -n "$key" ]];    then shift; fi
  [[ -n "$cat_id" && -n "$key" ]] || die "usage: plugin-maker new field <category-id> <key> --label LABEL --editor <kind> [...]"

  local plugin_path="" label="" editor="" options_csv="" default="" numeric=false help_text="" force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --plugin)        plugin_path="$2"; shift 2 ;;
      --label)         label="$2"; shift 2 ;;
      --type|--editor) editor="$2"; shift 2 ;;
      --options)       options_csv="$2"; shift 2 ;;
      --default)       default="$2"; shift 2 ;;
      --numeric)       numeric=true; shift ;;
      --help)          help_text="$2"; shift 2 ;;
      --force)         force=1; shift ;;
      *)               die "unknown flag: $1" ;;
    esac
  done

  [[ -n "$label" && -n "$editor" ]] || die "--label and --type are required"
  is_known_editor_kind "$editor" || die "unknown field type: '$editor' (try: plugin-maker catalog editors)"

  if [[ -z "$plugin_path" ]]; then
    plugin_path=$(plugin_root_of ".") || die "not inside a plugin (use --plugin PATH)"
  fi
  is_plugin_dir "$plugin_path" || die "not a plugin: $plugin_path"

  local pj="$plugin_path/.synaps-plugin/plugin.json"

  # Category must exist
  local cat_exists
  cat_exists=$(jq -r --arg i "$cat_id" '.settings.categories // [] | map(select(.id == $i)) | length' "$pj")
  if [[ "$cat_exists" == "0" ]]; then
    die "settings category '$cat_id' not found — create it first with 'plugin-maker new settings $cat_id --label …'"
  fi

  # Cycler needs options
  if [[ "$editor" == "cycler" && -z "$options_csv" ]]; then
    die "editor=cycler requires --options o1,o2,…"
  fi

  local options_json='[]'
  if [[ -n "$options_csv" ]]; then
    options_json=$(awk -F, '{ printf "["; for(i=1;i<=NF;i++) printf "\"%s\"%s", $i, (i<NF?",":""); printf "]"; }' <<<"$options_csv")
  fi

  local entry
  entry=$(jq -n \
    --arg k "$key" --arg l "$label" --arg e "$editor" --arg h "$help_text" \
    --arg d "$default" --argjson opts "$options_json" --argjson num "$numeric" \
    '{
      key: $k, label: $l, editor: $e,
      options: $opts,
      default: (if $d == "" then null else $d end),
      help: (if $h == "" then null else $h end),
      numeric: $num
    } | with_entries(select(.value != null and .value != [] and .value != false))')

  jq --arg i "$cat_id" --arg k "$key" --argjson e "$entry" --argjson force "$([[ $force -eq 1 ]] && echo true || echo false)" \
    '.settings.categories |= map(
      if .id == $i then
        .fields = (
          if (.fields // []) | map(.key) | index($k) then
            (if $force then ((.fields // []) | map(if .key == $k then $e else . end)) else error("field exists") end)
          else
            ((.fields // []) + [$e])
          end
        )
      else . end
    )' "$pj" > "$pj.tmp" 2>/dev/null && mv "$pj.tmp" "$pj" || die "field '$key' already exists in '$cat_id' (use --force)"

  ok "added field '$key' ($editor) to settings category '$cat_id'"
}
