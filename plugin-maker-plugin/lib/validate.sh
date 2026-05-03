#!/usr/bin/env bash
# validate.sh — structural validation for plugins, skills, and the full plugin
# manifest surface. Runs only error-severity rules. Lint rules live in lint.sh.
#
# Top-level entrypoint: validate_plugin DIR → returns total error count.
#
# Sub-validators are sourced from sibling files: validate_extension.sh,
# validate_sidecar.sh, validate_settings.sh, validate_keybinds.sh,
# validate_commands.sh.

if [[ -n "${_PM_VALIDATE_LOADED:-}" ]]; then return 0; fi
_PM_VALIDATE_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=catalog.sh
source "$LIB_DIR/catalog.sh"
# shellcheck source=frontmatter.sh
source "$LIB_DIR/frontmatter.sh"
# shellcheck source=validate_extension.sh
source "$LIB_DIR/validate_extension.sh"
# shellcheck source=validate_sidecar.sh
source "$LIB_DIR/validate_sidecar.sh"
# shellcheck source=validate_settings.sh
source "$LIB_DIR/validate_settings.sh"
# shellcheck source=validate_keybinds.sh
source "$LIB_DIR/validate_keybinds.sh"
# shellcheck source=validate_commands.sh
source "$LIB_DIR/validate_commands.sh"

# ── P — plugin manifest core ───────────────────────────────────────────────

validate_plugin_json() {
  local file="$1"
  local plugin_dir="$2"
  local errs=0

  if [[ ! -f "$file" ]]; then
    err "P001: missing $file"
    return 1
  fi

  if ! jq -e . "$file" >/dev/null 2>&1; then
    err "P001: $file is not valid JSON"
    return 1
  fi

  local name version
  name=$(pj_get "$file" '.name')
  version=$(pj_get "$file" '.version')

  if [[ -z "$name" ]]; then
    err "P001: $file missing 'name'"
    errs=$((errs + 1))
  elif ! is_kebab "$name"; then
    err "P002: $file 'name' must be lower-kebab-case (got '$name')"
    errs=$((errs + 1))
  fi

  if [[ -z "$version" ]]; then
    err "P001: $file missing 'version'"
    errs=$((errs + 1))
  elif ! is_semver "$version"; then
    err "P003: $file 'version' must be semver (got '$version')"
    errs=$((errs + 1))
  fi

  # P006 — parent dir == <name>-plugin/
  if [[ -n "$name" ]]; then
    local parent
    parent=$(basename "$plugin_dir")
    if [[ "$parent" != "${name}-plugin" ]]; then
      err "P006: plugin dir '$parent' should be '${name}-plugin'"
      errs=$((errs + 1))
    fi
  fi

  # P007 — compatibility.extension_protocol must be "1" if present
  if pj_has "$file" '.compatibility.extension_protocol'; then
    local proto
    proto=$(pj_get "$file" '.compatibility.extension_protocol')
    if [[ "$proto" != "1" ]]; then
      err "P007: compatibility.extension_protocol must be \"1\" (got '$proto')"
      errs=$((errs + 1))
    fi
  fi

  # P010 — provides.sidecar.protocol_version ∈ {1, 2}
  if pj_has "$file" '.provides.sidecar.protocol_version'; then
    local sver
    sver=$(pj_get "$file" '.provides.sidecar.protocol_version')
    if [[ "$sver" != "1" && "$sver" != "2" ]]; then
      err "P010: provides.sidecar.protocol_version must be 1 or 2 (got '$sver')"
      errs=$((errs + 1))
    fi
  fi

  return $errs
}

# ── F — skill frontmatter (errors only; lint adds F003-F005) ───────────────

validate_skill_md() {
  local file="$1"
  local errs=0

  if [[ ! -f "$file" ]]; then
    err "F001: missing $file"
    return 1
  fi

  if ! fm_has "$file"; then
    err "F001: $file has no YAML frontmatter (must start with '---')"
    return 1
  fi

  local name desc
  name=$(fm_get "$file" name || true)
  desc=$(fm_get "$file" description || true)

  if [[ -z "$name" ]]; then
    err "F001: $file frontmatter missing 'name'"
    errs=$((errs + 1))
  fi
  if [[ -z "$desc" ]]; then
    err "F001: $file frontmatter missing 'description'"
    errs=$((errs + 1))
  fi

  # F002 — name == parent dir
  local parent
  parent=$(basename "$(dirname "$file")")
  if [[ -n "$name" && "$name" != "$parent" ]]; then
    err "F002: $file frontmatter name '$name' != parent dir '$parent'"
    errs=$((errs + 1))
  fi

  return $errs
}

# ── plugin-level driver ────────────────────────────────────────────────────

validate_plugin() {
  local dir="$1"
  local total=0

  if [[ ! -d "$dir" ]]; then
    err "not a directory: $dir"
    return 1
  fi

  local manifest="$dir/.synaps-plugin/plugin.json"

  if [[ ! -f "$manifest" ]]; then
    err "$dir is not a plugin (no .synaps-plugin/plugin.json)"
    return 1
  fi

  validate_plugin_json "$manifest" "$dir" || total=$((total + $?))

  # Skills directory: required UNLESS this plugin provides an extension or
  # sidecar (extension-/sidecar-only plugins are valid — see local-voice,
  # extension-showcase). If skills/ exists, every subdir must have a SKILL.md.
  local has_ext=0 has_sidecar=0
  pj_has "$manifest" '.extension'           && has_ext=1
  pj_has "$manifest" '.provides.sidecar'    && has_sidecar=1

  if [[ ! -d "$dir/skills" ]]; then
    if [[ "$has_ext" -eq 0 && "$has_sidecar" -eq 0 ]]; then
      err "$dir missing skills/ directory (and no extension or sidecar provided)"
      total=$((total + 1))
    fi
  else
    local found=0
    while IFS= read -r skill_dir; do
      [[ -z "$skill_dir" ]] && continue
      found=1
      validate_skill_md "$skill_dir/SKILL.md" || total=$((total + $?))
    done < <(enumerate_skills "$dir")

    if [[ "$found" -eq 0 && "$has_ext" -eq 0 && "$has_sidecar" -eq 0 ]]; then
      err "$dir/skills/ contains no skill subdirectories"
      total=$((total + 1))
    fi
  fi

  # Subsystems — only if their corresponding section exists in the manifest.
  if pj_has "$manifest" '.extension'; then
    validate_extension "$manifest" "$dir" || total=$((total + $?))
  fi
  if pj_has "$manifest" '.provides.sidecar'; then
    validate_sidecar "$manifest" "$dir" || total=$((total + $?))
  fi
  if pj_has "$manifest" '.settings.categories'; then
    validate_settings "$manifest" || total=$((total + $?))
  fi
  if pj_has "$manifest" '.keybinds'; then
    validate_keybinds "$manifest" || total=$((total + $?))
  fi
  if pj_has "$manifest" '.commands'; then
    validate_commands "$manifest" || total=$((total + $?))
  fi

  return $total
}
