#!/usr/bin/env bash
# scaffold_sidecar.sh — add a sidecar binary stub + provides.sidecar block.
#
# Public:
#   scaffold_sidecar --plugin PATH [--lang python|rust] [--lifecycle-cmd NAME] [--protocol 2] [--force]

if [[ -n "${_PM_SCAFFOLD_SC_LOADED:-}" ]]; then return 0; fi
_PM_SCAFFOLD_SC_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
TMPL_DIR="${TMPL_DIR:-$(cd "$LIB_DIR/../templates" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"

_scaffold_sidecar_in() {
  local plugin_dir="$1"
  local lang="${2:-python}"
  local lc_cmd="${3:-}"
  local proto="${4:-2}"

  mkdir -p "$plugin_dir/bin"

  local bin_name="${NAME}-sidecar"
  case "$lang" in
    python)
      render_template "$TMPL_DIR/sidecar/sidecar.py.tmpl" "$plugin_dir/bin/$bin_name"
      chmod +x "$plugin_dir/bin/$bin_name"
      ;;
    rust)
      die "rust sidecar template not implemented yet (only --lang python)"
      ;;
    *)
      die "unknown sidecar language: '$lang' (supported: python)"
      ;;
  esac

  local pj="$plugin_dir/.synaps-plugin/plugin.json"
  local lifecycle_block='null'
  if [[ -n "$lc_cmd" ]]; then
    lifecycle_block=$(jq -n --arg cmd "$lc_cmd" --arg dn "${NAME^}" '{
      command: $cmd,
      display_name: $dn,
      importance: 0
    }')
  fi

  jq --arg bin "bin/$bin_name" \
     --argjson proto "$proto" \
     --argjson lifecycle "$lifecycle_block" \
     '.provides = (.provides // {}) | .provides.sidecar = {
        command: $bin,
        protocol_version: $proto
      } | (if $lifecycle != null then .provides.sidecar.lifecycle = $lifecycle else . end)' \
     "$pj" > "$pj.tmp" && mv "$pj.tmp" "$pj"

  ok "added sidecar block + bin/$bin_name"
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

  NAME=$(jq -r '.name' "$plugin_path/.synaps-plugin/plugin.json")
  FORCE="$force"
  SIDECAR_LANG="$lang"
  LIFECYCLE_CMD="$lc_cmd"
  _set_scaffold_env 2>/dev/null || true
  _scaffold_sidecar_in "$plugin_path" "$lang" "$lc_cmd" "$proto"
}
