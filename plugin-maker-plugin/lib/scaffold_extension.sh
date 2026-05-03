#!/usr/bin/env bash
# scaffold_extension.sh — add an extension stub + manifest block to a plugin.
#
# Public:
#   scaffold_extension --plugin PATH [--lang python|bash|node|...] [--hooks h1,h2,…] [--perms p1,p2,…] [--force]

if [[ -n "${_PM_SCAFFOLD_EXT_LOADED:-}" ]]; then return 0; fi
_PM_SCAFFOLD_EXT_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
TMPL_DIR="${TMPL_DIR:-$(cd "$LIB_DIR/../templates" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=catalog.sh
source "$LIB_DIR/catalog.sh"
# shellcheck source=languages.sh
source "$LIB_DIR/languages.sh"

_pm_expand_lang_value() {
  local value="$1" output="$2"
  value="${value//\$\{NAME\}/$NAME}"
  value="${value//\$\{OUTPUT\}/$output}"
  printf '%s\n' "$value"
}

_pm_expand_json_array() {
  local surface="$1" lang="$2" expr="$3" output="$4"
  local manifest item expanded out='[]'
  manifest="$(lang_manifest_path "$surface" "$lang")"
  while IFS= read -r item; do
    [[ -z "$item" ]] && continue
    expanded="$(_pm_expand_lang_value "$item" "$output")"
    out="$(jq -c --arg v "$expanded" '. + [$v]' <<<"$out")"
  done < <(jq -r "$expr // [] | .[]" "$manifest")
  printf '%s\n' "$out"
}

# Internal helper used by `scaffold_plugin --extension LANG`.
_scaffold_extension_in() {
  local plugin_dir="$1"
  local lang="${2:-python}"
  local hooks_csv="${3:-on_session_start}"
  local perms_csv="${4:-session.lifecycle}"

  require_template_language extension "$lang"

  local manifest template output rel_output cmd args_json template_path output_path
  manifest="$(lang_manifest_path extension "$lang")"
  template="$(jq -r '.template' "$manifest")"
  rel_output="$(jq -r '.output' "$manifest")"
  rel_output="$(_pm_expand_lang_value "$rel_output" "")"
  output="$rel_output"
  template_path="$(dirname "$manifest")/$template"
  output_path="$plugin_dir/$output"

  mkdir -p "$(dirname "$output_path")"
  render_template "$template_path" "$output_path"
  if [[ "$(jq -r '.executable // false' "$manifest")" == "true" ]]; then
    chmod +x "$output_path"
  fi

  local hooks_json perms_json
  hooks_json=$(awk -F, '{ for(i=1;i<=NF;i++) printf "{\"hook\":\"%s\"}%s", $i, (i<NF?",":""); }' <<<"$hooks_csv")
  perms_json=$(awk -F, '{ for(i=1;i<=NF;i++) printf "\"%s\"%s", $i, (i<NF?",":""); }' <<<"$perms_csv")

  cmd="$(_pm_expand_lang_value "$(jq -r '.command' "$manifest")" "$output")"
  args_json="$(_pm_expand_json_array extension "$lang" '.args' "$output")"

  local pj="$plugin_dir/.synaps-plugin/plugin.json"
  jq --arg cmd "$cmd" \
     --argjson args "$args_json" \
     --argjson perms "[$perms_json]" \
     --argjson hooks "[$hooks_json]" \
     '.extension = {
        protocol_version: 1,
        runtime: "process",
        command: $cmd,
        args: $args,
        permissions: $perms,
        hooks: $hooks,
        config: []
      }' "$pj" > "$pj.tmp" && mv "$pj.tmp" "$pj"

  ok "added extension block + $output"
  info "  language:   $lang"
  info "  hooks:      $hooks_csv"
  info "  perms:      $perms_csv"
}

# Public CLI entrypoint
scaffold_extension() {
  local plugin_path="" lang="python" force=0
  HOOKS_CSV="on_session_start"
  PERMS_CSV="session.lifecycle"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --plugin) plugin_path="$2"; shift 2 ;;
      --lang)   lang="$2"; shift 2 ;;
      --hooks)  HOOKS_CSV="$2"; shift 2 ;;
      --perms)  PERMS_CSV="$2"; shift 2 ;;
      --force)  force=1; shift ;;
      *)        die "unknown flag for 'new extension': $1" ;;
    esac
  done

  if [[ -z "$plugin_path" ]]; then
    plugin_path=$(plugin_root_of ".") || die "not inside a plugin (use --plugin PATH)"
  fi
  is_plugin_dir "$plugin_path" || die "not a plugin: $plugin_path"

  local h
  for h in ${HOOKS_CSV//,/ }; do
    is_known_hook "$h" || die "unknown hook kind: '$h' (try: plugin-maker catalog hooks)"
  done
  local p
  for p in ${PERMS_CSV//,/ }; do
    is_known_permission "$p" || die "unknown permission: '$p' (try: plugin-maker catalog permissions)"
    is_reserved_permission "$p" && die "permission '$p' is reserved and not yet implemented"
  done

  NAME=$(jq -r '.name' "$plugin_path/.synaps-plugin/plugin.json")
  FORCE="$force"
  EXT_LANG="$lang"
  _scaffold_extension_in "$plugin_path" "$lang" "$HOOKS_CSV" "$PERMS_CSV"
}
