#!/usr/bin/env bash
# validate_settings.sh — T### rules for the settings.categories block.

if [[ -n "${_PM_VALIDATE_SETTINGS_LOADED:-}" ]]; then return 0; fi
_PM_VALIDATE_SETTINGS_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=catalog.sh
source "$LIB_DIR/catalog.sh"

validate_settings() {
  local file="$1"
  local errs=0

  local cat_count
  cat_count=$(jq -r '.settings.categories | length' "$file" 2>/dev/null || echo 0)

  local i=0
  while [[ "$i" -lt "$cat_count" ]]; do
    local cid clabel
    cid=$(jq -r ".settings.categories[$i].id // empty" "$file")
    clabel=$(jq -r ".settings.categories[$i].label // empty" "$file")

    if [[ -z "$cid" ]]; then
      err "T001: settings.categories[$i] missing 'id'"
      errs=$((errs + 1))
    fi
    if [[ -z "$clabel" ]]; then
      err "T001: settings.categories[$i] missing 'label'"
      errs=$((errs + 1))
    fi

    local field_count
    field_count=$(jq -r ".settings.categories[$i].fields // [] | length" "$file")
    local j=0
    while [[ "$j" -lt "$field_count" ]]; do
      local key label editor numeric opt_count
      key=$(jq -r ".settings.categories[$i].fields[$j].key // empty" "$file")
      label=$(jq -r ".settings.categories[$i].fields[$j].label // empty" "$file")
      editor=$(jq -r ".settings.categories[$i].fields[$j].editor // empty" "$file")
      numeric=$(jq -r ".settings.categories[$i].fields[$j].numeric // false" "$file")
      opt_count=$(jq -r ".settings.categories[$i].fields[$j].options // [] | length" "$file")

      if [[ -z "$key" ]]; then
        err "T002: settings.categories[$i].fields[$j] missing 'key'"
        errs=$((errs + 1))
      fi
      if [[ -z "$label" ]]; then
        err "T002: settings.categories[$i].fields[$j] missing 'label'"
        errs=$((errs + 1))
      fi
      if [[ -z "$editor" ]]; then
        err "T002: settings.categories[$i].fields[$j] missing 'editor'"
        errs=$((errs + 1))
      elif ! is_known_editor_kind "$editor"; then
        err "T002: settings.categories[$i].fields[$j] unknown editor kind: '$editor'"
        errs=$((errs + 1))
      fi

      # T003 — cycler needs options
      if [[ "$editor" == "cycler" && "$opt_count" -eq 0 ]]; then
        err "T003: settings.categories[$i].fields[$j] editor=cycler requires non-empty 'options[]'"
        errs=$((errs + 1))
      fi

      # T004 — numeric only meaningful on text
      if [[ "$numeric" == "true" && "$editor" != "text" ]]; then
        err "T004: settings.categories[$i].fields[$j] 'numeric: true' only applies to editor=text (got '$editor')"
        errs=$((errs + 1))
      fi

      # T005 — custom requires extension declared
      if [[ "$editor" == "custom" ]]; then
        if ! pj_has "$file" '.extension'; then
          warn "T005: settings.categories[$i].fields[$j] editor=custom requires an extension to render the overlay (no .extension declared)"
        fi
      fi

      j=$((j + 1))
    done

    i=$((i + 1))
  done

  return $errs
}
