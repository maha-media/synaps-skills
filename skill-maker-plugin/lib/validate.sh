#!/usr/bin/env bash
# validate.sh — structural validation for plugins and skills.
#
# Rules are codified in docs/specs/skill-maker.md (P00x, F00x).
# Returns 0 on clean, non-zero count = number of errors.

if [[ -n "${_SKILL_VALIDATE_LOADED:-}" ]]; then return 0; fi
_SKILL_VALIDATE_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=frontmatter.sh
source "$LIB_DIR/frontmatter.sh"

# validate_plugin_json FILE → emit errors, return error count
validate_plugin_json() {
  local file="$1"
  local errs=0

  if [[ ! -f "$file" ]]; then
    err "P001: missing $file"
    return 1
  fi

  if ! jq -e . "$file" >/dev/null 2>&1; then
    err "P001: $file is not valid JSON"
    return 1
  fi

  local name version desc
  name=$(jq -r '.name // empty' "$file")
  version=$(jq -r '.version // empty' "$file")
  desc=$(jq -r '.description // empty' "$file")

  if [[ -z "$name" ]]; then
    err "P001: $file missing 'name'"
    ((errs++))
  elif [[ ! "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    err "P002: $file 'name' must be lower-kebab-case (got '$name')"
    ((errs++))
  fi

  if [[ -z "$version" ]]; then
    err "P001: $file missing 'version'"
    ((errs++))
  elif [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
    err "P003: $file 'version' must be semver (got '$version')"
    ((errs++))
  fi

  if [[ -z "$desc" ]]; then
    err "P001: $file missing 'description'"
    ((errs++))
  fi

  return $errs
}

# validate_skill_md FILE → emit errors, return error count.
# Expects the file's parent directory name to match frontmatter `name`.
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
    ((errs++))
  fi
  if [[ -z "$desc" ]]; then
    err "F001: $file frontmatter missing 'description'"
    ((errs++))
  fi

  # name must match parent directory
  local parent
  parent=$(basename "$(dirname "$file")")
  if [[ -n "$name" && "$name" != "$parent" ]]; then
    err "F002: $file frontmatter name '$name' != parent dir '$parent'"
    ((errs++))
  fi

  return $errs
}

# validate_plugin DIR → run plugin-level checks. Returns total error count.
validate_plugin() {
  local dir="$1"
  local total=0

  if [[ ! -d "$dir" ]]; then
    err "not a directory: $dir"
    return 1
  fi
  if [[ ! -f "$dir/.synaps-plugin/plugin.json" ]]; then
    err "$dir is not a plugin (no .synaps-plugin/plugin.json)"
    return 1
  fi

  validate_plugin_json "$dir/.synaps-plugin/plugin.json" || total=$((total + $?))

  # at least one skill must exist
  if [[ ! -d "$dir/skills" ]]; then
    err "$dir missing skills/ directory"
    ((total++))
  else
    local found=0
    while IFS= read -r skill_dir; do
      [[ -z "$skill_dir" ]] && continue
      found=1
      local skill_md="$skill_dir/SKILL.md"
      validate_skill_md "$skill_md" || total=$((total + $?))
    done < <(enumerate_skills "$dir")

    if [[ "$found" -eq 0 ]]; then
      err "$dir/skills/ contains no skill subdirectories"
      ((total++))
    fi
  fi

  return $total
}
