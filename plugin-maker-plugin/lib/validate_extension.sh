#!/usr/bin/env bash
# validate_extension.sh — X### rules for the .extension block.

if [[ -n "${_PM_VALIDATE_EXT_LOADED:-}" ]]; then return 0; fi
_PM_VALIDATE_EXT_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=catalog.sh
source "$LIB_DIR/catalog.sh"

validate_extension() {
  local file="$1"
  local plugin_dir="$2"
  local errs=0

  # X001 — runtime
  local runtime
  runtime=$(pj_get "$file" '.extension.runtime')
  if [[ "$runtime" != "process" ]]; then
    err "X001: extension.runtime must be \"process\" (got '$runtime')"
    errs=$((errs + 1))
  fi

  # X002 — command non-empty
  local cmd
  cmd=$(pj_get "$file" '.extension.command')
  if [[ -z "$cmd" ]]; then
    err "X002: extension.command is empty"
    errs=$((errs + 1))
  fi

  # X003 — protocol_version
  local proto
  proto=$(pj_get "$file" '.extension.protocol_version // 1')
  if [[ "$proto" != "1" ]]; then
    err "X003: extension.protocol_version must be 1 (got '$proto')"
    errs=$((errs + 1))
  fi

  # X011 — relative command must resolve under plugin root (advisory: we just
  # check that if it looks like a relative path, the file exists at install).
  if [[ -n "$cmd" && "$cmd" != /* && "$cmd" != python* && "$cmd" != node* ]]; then
    if [[ ! -e "$plugin_dir/$cmd" ]]; then
      warn "X011: extension.command '$cmd' not found under $plugin_dir (will fail at load time)"
      # not counted as an error — it's a heuristic; the binary might be on PATH
    fi
  fi

  # X004 — every permission must be known
  # X005 — no reserved permissions
  local perms
  perms=$(jq -r '.extension.permissions // [] | .[]' "$file" 2>/dev/null || true)
  while IFS= read -r perm; do
    [[ -z "$perm" ]] && continue
    if ! is_known_permission "$perm"; then
      err "X004: unknown extension permission: '$perm'"
      errs=$((errs + 1))
      continue
    fi
    if is_reserved_permission "$perm"; then
      err "X005: reserved extension permission not yet implemented: '$perm'"
      errs=$((errs + 1))
    fi
  done <<<"$perms"

  # Build a quick lookup of permissions present (for X008 hook → perm check).
  local has_register=false
  while IFS= read -r perm; do
    case "$perm" in
      tools.register|providers.register|memory.read|memory.write|config.write|config.subscribe|audio.input|audio.output)
        has_register=true ;;
    esac
  done <<<"$perms"

  # X006 — must have ≥1 hook OR a register-permission
  local hook_count
  hook_count=$(jq -r '.extension.hooks // [] | length' "$file" 2>/dev/null || echo 0)
  if [[ "$hook_count" -eq 0 ]] && [[ "$has_register" != true ]]; then
    err "X006: extension declares no hooks and no register-permission (must subscribe to ≥1 hook OR request a register-style permission)"
    errs=$((errs + 1))
  fi

  # Iterate hooks
  local i=0
  while [[ "$i" -lt "$hook_count" ]]; do
    local hook tool match_keys
    hook=$(jq -r ".extension.hooks[$i].hook // empty" "$file")
    tool=$(jq -r ".extension.hooks[$i].tool // empty" "$file")

    # X007 — hook kind known
    if [[ -z "$hook" ]]; then
      err "X007: hooks[$i] missing 'hook' field"
      errs=$((errs + 1))
      i=$((i + 1)); continue
    fi
    if ! is_known_hook "$hook"; then
      err "X007: hooks[$i] unknown hook kind: '$hook'"
      errs=$((errs + 1))
      i=$((i + 1)); continue
    fi

    # X008 — required permission present
    local needed
    needed=$(hook_required_permission "$hook")
    if ! grep -Fqx "$needed" <<<"$perms"; then
      err "X008: hooks[$i] '$hook' requires permission '$needed' (not in extension.permissions)"
      errs=$((errs + 1))
    fi

    # X009 — tool filter only on tool-call hooks
    if [[ -n "$tool" ]] && ! hook_allows_tool_filter "$hook"; then
      err "X009: hooks[$i] '$hook' does not allow a tool filter (got tool='$tool')"
      errs=$((errs + 1))
    fi

    # X010 — match block keys
    if pj_has "$file" ".extension.hooks[$i].match"; then
      match_keys=$(jq -r ".extension.hooks[$i].match | keys[]" "$file" 2>/dev/null || true)
      while IFS= read -r mk; do
        [[ -z "$mk" ]] && continue
        if [[ "$mk" != "input_contains" && "$mk" != "input_equals" ]]; then
          err "X010: hooks[$i].match has unsupported key '$mk' (allowed: input_contains, input_equals)"
          errs=$((errs + 1))
        fi
      done <<<"$match_keys"
    fi

    i=$((i + 1))
  done

  # X012 — config keys non-empty + unique
  local cfg_keys
  cfg_keys=$(jq -r '.extension.config // [] | .[].key' "$file" 2>/dev/null || true)
  if [[ -n "$cfg_keys" ]]; then
    local empty_count
    empty_count=$(awk 'NF==0' <<<"$cfg_keys" | wc -l)
    if [[ "$empty_count" -gt 0 ]]; then
      err "X012: extension.config[] has $empty_count entry/entries with empty 'key'"
      errs=$((errs + 1))
    fi
    local dups
    dups=$(awk 'NF>0' <<<"$cfg_keys" | sort | uniq -d)
    if [[ -n "$dups" ]]; then
      err "X012: extension.config[] has duplicate keys: $(tr '\n' ' ' <<<"$dups")"
      errs=$((errs + 1))
    fi
  fi



  # X013 — language-template syntax checks for known generated extension files.
  source "$LIB_DIR/languages.sh"
  local lang output check_json
  local -a check_cmd
  while IFS= read -r lang; do
    [[ -z "$lang" ]] && continue
    output="$(lang_get extension "$lang" '.output')"
    output="${output//\$\{NAME\}/$(jq -r '.name' "$file")}" 
    if [[ ! -f "$plugin_dir/$output" ]]; then
      continue
    fi
    manifest_cmd="$(pj_get "$file" '.extension.command')"
    manifest_args="$(jq -r '.extension.args // [] | join(" ")' "$file" 2>/dev/null || true)"
    tpl_cmd="$(lang_get extension "$lang" '.command')"
    tpl_args="$(lang_json extension "$lang" '.args // []' | jq -r 'join(" ")')"
    tpl_args="${tpl_args//\$\{OUTPUT\}/$output}"
    if [[ "$manifest_cmd $manifest_args" != "$tpl_cmd $tpl_args" ]]; then
      continue
    fi
    check_json="$(lang_json extension "$lang" '.syntax_check // []')"
    [[ "$check_json" == "[]" || "$check_json" == "null" ]] && continue
    mapfile -t check_cmd < <(jq -r '.[]' <<<"$check_json")
    local i
    for i in "${!check_cmd[@]}"; do
      check_cmd[$i]="${check_cmd[$i]//\$\{OUTPUT\}/$plugin_dir/$output}"
      check_cmd[$i]="${check_cmd[$i]//\$\{NAME\}/$(jq -r '.name' "$file")}"
    done
    if command -v "${check_cmd[0]}" >/dev/null 2>&1; then
      if ! "${check_cmd[@]}" >/dev/null 2>&1; then
        err "X013: syntax check failed for generated $lang extension: $output"
        errs=$((errs + 1))
      fi
    else
      warn "X013: skipping $lang extension syntax check; missing ${check_cmd[0]}"
    fi
  done < <(list_template_languages extension)

  return $errs
}
