#!/usr/bin/env bash
# validate_sidecar.sh — S### rules for the provides.sidecar block.

if [[ -n "${_PM_VALIDATE_SIDECAR_LOADED:-}" ]]; then return 0; fi
_PM_VALIDATE_SIDECAR_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"

validate_sidecar() {
  local file="$1"
  local plugin_dir="$2"
  local errs=0

  # S001 — command non-empty
  local cmd inferred_lang=""
  cmd=$(pj_get "$file" '.provides.sidecar.command')
  if [[ -z "$cmd" ]]; then
    err "S001: provides.sidecar.command is empty"
    errs=$((errs + 1))
  fi

  case "$cmd" in
    *.js) inferred_lang="node" ;;
    *)
      if [[ -f "$plugin_dir/$cmd" ]]; then
        case "$(head -n 1 "$plugin_dir/$cmd" 2>/dev/null || true)" in
          *python*) inferred_lang="python" ;;
          *bash*|*sh*) inferred_lang="bash" ;;
        esac
      fi
      ;;
  esac

  # S004 — protocol_version (P010 already covers value range; we ensure presence)
  if ! pj_has "$file" '.provides.sidecar.protocol_version'; then
    warn "S004: provides.sidecar.protocol_version not set (defaults to 1; declare explicitly)"
  fi

  # S006 — lifecycle.command should be exposed
  local lc_cmd
  lc_cmd=$(pj_get "$file" '.provides.sidecar.lifecycle.command')
  if [[ -n "$lc_cmd" ]]; then
    # Look for a commands[] entry with that name OR a keybind targeting it
    local cmd_match kb_match
    cmd_match=$(jq -r --arg n "$lc_cmd" '.commands // [] | map(select(.name == $n)) | length' "$file" 2>/dev/null || echo 0)
    kb_match=$(jq -r --arg n "$lc_cmd" '.keybinds // [] | map(select((.command // "") | startswith($n))) | length' "$file" 2>/dev/null || echo 0)
    if [[ "$cmd_match" -eq 0 && "$kb_match" -eq 0 ]]; then
      warn "S006: lifecycle.command '$lc_cmd' is not in commands[] or keybinds[] — users have no UI to toggle it"
    fi
  fi

  # S007 — lifecycle.importance ∈ [-100, 100]
  if pj_has "$file" '.provides.sidecar.lifecycle.importance'; then
    local imp
    imp=$(pj_get "$file" '.provides.sidecar.lifecycle.importance')
    if [[ "$imp" =~ ^-?[0-9]+$ ]]; then
      if (( imp < -100 || imp > 100 )); then
        warn "S007: lifecycle.importance=$imp will be clamped to [-100, 100] by the CLI"
      fi
    fi
  fi



  # S008 — language-template syntax checks for known generated sidecar files.
  source "$LIB_DIR/languages.sh"
  local lang output check_json
  local -a check_cmd
  while IFS= read -r lang; do
    [[ -z "$lang" ]] && continue
    [[ -n "$inferred_lang" && "$lang" != "$inferred_lang" ]] && continue
    output="$(lang_get sidecar "$lang" '.output')"
    output="${output//\$\{NAME\}/$(jq -r '.name' "$file")}" 
    if [[ ! -f "$plugin_dir/$output" ]]; then
      continue
    fi
    manifest_cmd="$(pj_get "$file" '.provides.sidecar.command')"
    tpl_cmd="$(lang_get sidecar "$lang" '.command')"
    tpl_cmd="${tpl_cmd//\$\{NAME\}/$(jq -r '.name' "$file")}"
    if [[ "$manifest_cmd" != "$tpl_cmd" || "$cmd" != "$tpl_cmd" ]]; then
      continue
    fi
    check_json="$(lang_json sidecar "$lang" '.syntax_check // []')"
    [[ "$check_json" == "[]" || "$check_json" == "null" ]] && continue
    mapfile -t check_cmd < <(jq -r '.[]' <<<"$check_json")
    local i
    for i in "${!check_cmd[@]}"; do
      check_cmd[$i]="${check_cmd[$i]//\$\{OUTPUT\}/$plugin_dir/$output}"
      check_cmd[$i]="${check_cmd[$i]//\$\{NAME\}/$(jq -r '.name' "$file")}"
    done
    if command -v "${check_cmd[0]}" >/dev/null 2>&1; then
      if ! "${check_cmd[@]}" >/dev/null 2>&1; then
        err "S008: syntax check failed for generated $lang sidecar: $output"
        errs=$((errs + 1))
      fi
    else
      warn "S008: skipping $lang sidecar syntax check; missing ${check_cmd[0]}"
    fi
  done < <(list_template_languages sidecar)

  return $errs
}
