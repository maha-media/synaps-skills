#!/usr/bin/env bash
# info.sh — rich human-facing summary of a plugin (and `doctor`).

if [[ -n "${_PM_INFO_LOADED:-}" ]]; then return 0; fi
_PM_INFO_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=frontmatter.sh
source "$LIB_DIR/frontmatter.sh"

info_plugin() {
  local dir="$1"
  local file="$dir/.synaps-plugin/plugin.json"

  if [[ ! -f "$file" ]]; then
    err "not a plugin: $dir"
    return 1
  fi

  local name version desc category license
  name=$(pj_get    "$file" '.name')
  version=$(pj_get "$file" '.version')
  desc=$(pj_get    "$file" '.description')
  category=$(pj_get "$file" '.category')
  license=$(pj_get "$file" '.license')

  printf '%s%s%s %s%s%s\n' "${C_BOLD}" "$name" "${C_OFF}" "${C_DIM}$version${C_OFF}" "" ""
  printf '  %s\n' "${C_DIM}$dir${C_OFF}"
  [[ -n "$desc" ]] && printf '  %s\n' "$desc"
  printf '\n'

  # Skills
  local skill_count=0
  local skill_lines=()
  while IFS= read -r s; do
    [[ -z "$s" ]] && continue
    skill_count=$((skill_count + 1))
    local sname sdesc
    sname=$(fm_get "$s/SKILL.md" name 2>/dev/null || basename "$s")
    sdesc=$(fm_get "$s/SKILL.md" description 2>/dev/null | head -c 80)
    skill_lines+=("    $sname — $sdesc")
  done < <(enumerate_skills "$dir")
  printf '  %sSkills (%d):%s\n' "${C_BOLD}" "$skill_count" "${C_OFF}"
  for l in "${skill_lines[@]}"; do printf '%s\n' "$l"; done

  # Commands
  if pj_has "$file" '.commands'; then
    local cmd_count
    cmd_count=$(jq -r '.commands | length' "$file")
    printf '  %sCommands (%d):%s\n' "${C_BOLD}" "$cmd_count" "${C_OFF}"
    jq -r '.commands[] | "    /\(.name) — \(.description // "")"' "$file"
  fi

  # Keybinds
  if pj_has "$file" '.keybinds'; then
    local kb_count
    kb_count=$(jq -r '.keybinds | length' "$file")
    printf '  %sKeybinds (%d):%s\n' "${C_BOLD}" "$kb_count" "${C_OFF}"
    jq -r '.keybinds[] | "    \(.key) → \(.action) \(.command // .skill // .prompt // .script // "")"' "$file"
  fi

  # Settings
  if pj_has "$file" '.settings.categories'; then
    local cat_count
    cat_count=$(jq -r '.settings.categories | length' "$file")
    printf '  %sSettings categories (%d):%s\n' "${C_BOLD}" "$cat_count" "${C_OFF}"
    jq -r '.settings.categories[] | "    \(.id): \(.label) (\((.fields // []) | length) fields)"' "$file"
  fi

  # Help entries
  if pj_has "$file" '.help_entries'; then
    local h_count
    h_count=$(jq -r '.help_entries | length' "$file")
    printf '  %sHelp entries (%d):%s\n' "${C_BOLD}" "$h_count" "${C_OFF}"
    jq -r '.help_entries[] | "    \(.command) — \(.title)"' "$file"
  fi

  # Extension
  if pj_has "$file" '.extension'; then
    local ec_cmd ec_perms ec_hooks
    ec_cmd=$(pj_get "$file" '.extension.command')
    ec_perms=$(jq -r '.extension.permissions // [] | length' "$file")
    ec_hooks=$(jq -r '.extension.hooks // [] | length' "$file")
    printf '  %sExtension:%s %s (%d permission(s), %d hook(s))\n' "${C_BOLD}" "${C_OFF}" "$ec_cmd" "$ec_perms" "$ec_hooks"
    jq -r '.extension.permissions // [] | .[] | "      perm: " + .' "$file"
    jq -r '.extension.hooks // [] | .[] | "      hook: " + .hook + (if .tool then " [tool=" + .tool + "]" else "" end)' "$file"
  fi

  # Sidecar
  if pj_has "$file" '.provides.sidecar'; then
    local sc_cmd sc_proto sc_lc
    sc_cmd=$(pj_get   "$file" '.provides.sidecar.command')
    sc_proto=$(pj_get "$file" '.provides.sidecar.protocol_version')
    sc_lc=$(pj_get    "$file" '.provides.sidecar.lifecycle.command')
    printf '  %sSidecar:%s %s (proto v%s%s)\n' "${C_BOLD}" "${C_OFF}" "$sc_cmd" "${sc_proto:-1}" "${sc_lc:+, lifecycle=$sc_lc}"
  fi

  # Compatibility
  if pj_has "$file" '.compatibility'; then
    local syn proto
    syn=$(pj_get   "$file" '.compatibility.synaps')
    proto=$(pj_get "$file" '.compatibility.extension_protocol')
    printf '  %sCompatibility:%s synaps=%s extension_protocol=%s\n' "${C_BOLD}" "${C_OFF}" "${syn:-?}" "${proto:-?}"
  fi

  printf '\n'
}

# Doctor: validate + lint + install-readiness
doctor_plugin() {
  local dir="$1"

  printf '%sDoctor:%s %s\n' "${C_BOLD}" "${C_OFF}" "$dir"
  hr

  # Source validate.sh and lint.sh on demand to avoid circular includes.
  source "$LIB_DIR/validate.sh"
  source "$LIB_DIR/lint.sh"

  local v_errs=0
  validate_plugin "$dir" || v_errs=$?

  printf '\n'

  # Reset lint counters and run
  _LINT_WARN=0; _LINT_ERR=0; _LINT_STRICT=0
  lint_plugin "$dir"

  printf '\n'

  # Install-readiness checks
  printf '%sInstall-readiness:%s\n' "${C_BOLD}" "${C_OFF}"
  local ok=true

  # Extension command resolves
  if pj_has "$dir/.synaps-plugin/plugin.json" '.extension.command'; then
    local ec
    ec=$(pj_get "$dir/.synaps-plugin/plugin.json" '.extension.command')
    if [[ "$ec" != /* && "$ec" != python* && "$ec" != node* ]] && [[ ! -e "$dir/$ec" ]]; then
      err "  extension.command '$ec' not found under plugin root"
      ok=false
    else
      ok "  extension.command resolves: $ec"
    fi
  fi

  # Sidecar binary present + executable
  if pj_has "$dir/.synaps-plugin/plugin.json" '.provides.sidecar.command'; then
    local sc
    sc=$(pj_get "$dir/.synaps-plugin/plugin.json" '.provides.sidecar.command')
    if [[ "$sc" != /* ]]; then sc="$dir/$sc"; fi
    if [[ -x "$sc" ]]; then
      ok "  sidecar binary executable: $sc"
    elif [[ -e "$sc" ]]; then
      warn "  sidecar binary present but not executable: $sc"
    else
      warn "  sidecar binary not yet built: $sc"
    fi
  fi

  # README.md
  if [[ -f "$dir/README.md" ]]; then
    ok "  README.md present"
  else
    warn "  README.md missing"
  fi

  printf '\n'
  if [[ "$v_errs" -eq 0 ]]; then
    ok "doctor: $(basename "$dir") is healthy"
    return 0
  fi
  err "doctor: $(basename "$dir") has $v_errs validation error(s)"
  return 1
}
