#!/usr/bin/env bash
# scaffold_sidecar.sh — add a sidecar binary stub + provides.sidecar block.
#
# Public:
#   scaffold_sidecar --plugin PATH [--lang python|bash|node|...] [--lifecycle-cmd NAME] [--protocol 2] [--force]

if [[ -n "${_PM_SCAFFOLD_SC_LOADED:-}" ]]; then return 0; fi
_PM_SCAFFOLD_SC_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
TMPL_DIR="${TMPL_DIR:-$(cd "$LIB_DIR/../templates" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=languages.sh
source "$LIB_DIR/languages.sh"

_pm_expand_sidecar_lang_value() {
  local value="$1"
  value="${value//\$\{NAME\}/$NAME}"
  if [[ -n "${rel_output:-}" ]]; then
    value="${value//\$\{OUTPUT\}/$rel_output}"
  fi
  printf '%s\n' "$value"
}

_pm_expand_sidecar_json_array() {
  local surface="$1" lang="$2" expr="$3"
  local manifest item expanded out='[]'
  manifest="$(lang_manifest_path "$surface" "$lang")"
  while IFS= read -r item; do
    [[ -z "$item" ]] && continue
    expanded="$(_pm_expand_sidecar_lang_value "$item")"
    out="$(jq -c --arg v "$expanded" '. + [$v]' <<<"$out")"
  done < <(jq -r "$expr // [] | .[]" "$manifest")
  printf '%s\n' "$out"
}

_scaffold_sidecar_in() {
  local plugin_dir="$1"
  local lang="${2:-python}"
  local lc_cmd="${3:-}"
  local proto="${4:-2}"

  require_template_language sidecar "$lang"

  local manifest template rel_output template_path output_path sidecar_cmd sidecar_args_json
  manifest="$(lang_manifest_path sidecar "$lang")"
  template="$(jq -r '.template' "$manifest")"
  rel_output="$(_pm_expand_sidecar_lang_value "$(jq -r '.output' "$manifest")")"
  sidecar_cmd="$(_pm_expand_sidecar_lang_value "$(jq -r '.command' "$manifest")")"
  sidecar_args_json="$(_pm_expand_sidecar_json_array sidecar "$lang" '.args')"
  template_path="$(dirname "$manifest")/$template"
  output_path="$plugin_dir/$rel_output"

  mkdir -p "$(dirname "$output_path")"
  render_template "$template_path" "$output_path"
  if [[ "$(jq -r '.executable // false' "$manifest")" == "true" ]]; then
    chmod +x "$output_path"
  fi

  local pj="$plugin_dir/.synaps-plugin/plugin.json"
  local lifecycle_block='null'
  if [[ -n "$lc_cmd" ]]; then
    lifecycle_block=$(jq -n --arg cmd "$lc_cmd" --arg dn "${NAME^}" '{
      command: $cmd,
      display_name: $dn,
      importance: 0
    }')
  fi

  jq --arg bin "$sidecar_cmd" \
     --argjson args "$sidecar_args_json" \
     --argjson proto "$proto" \
     --argjson lifecycle "$lifecycle_block" \
     '.provides = (.provides // {}) | .provides.sidecar = {
        command: $bin,
        args: $args,
        protocol_version: $proto
      } | (if $lifecycle != null then .provides.sidecar.lifecycle = $lifecycle else . end)' \
     "$pj" > "$pj.tmp" && mv "$pj.tmp" "$pj"

  ok "added sidecar block + $rel_output"
  info "  language:    $lang"
  info "  protocol:    v$proto"
  if [[ -n "$lc_cmd" ]]; then info "  lifecycle:   /$lc_cmd toggle"; fi
  return 0
}

scaffold_sidecar() {
  local plugin_path="" lang="python" lc_cmd="" proto=2 force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --plugin)         plugin_path="$2"; shift 2 ;;
      --lang)           lang="$2"; shift 2 ;;
      --lifecycle-cmd)  lc_cmd="$2"; shift 2 ;;
      --protocol)       proto="$2"; shift 2 ;;
      --force)          force=1; shift ;;
      *)                die "unknown flag for 'new sidecar': $1" ;;
    esac
  done

  if [[ -z "$plugin_path" ]]; then
    plugin_path=$(plugin_root_of ".") || die "not inside a plugin (use --plugin PATH)"
  fi
  is_plugin_dir "$plugin_path" || die "not a plugin: $plugin_path"

  if [[ "$proto" != "1" && "$proto" != "2" ]]; then
    die "unsupported sidecar protocol_version: $proto (must be 1 or 2)"
  fi

  require_template_language sidecar "$lang"

  NAME=$(jq -r '.name' "$plugin_path/.synaps-plugin/plugin.json")
  FORCE="$force"
  SIDECAR_LANG="$lang"
  LIFECYCLE_CMD="$lc_cmd"
  _set_scaffold_env 2>/dev/null || true
  _scaffold_sidecar_in "$plugin_path" "$lang" "$lc_cmd" "$proto"
}
