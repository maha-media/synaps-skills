#!/usr/bin/env bash
# scaffold.sh — create new plugins and skills from templates.
#
# Public functions:
#   scaffold_plugin <name> [--umbrella] [--memory] [--extension LANG] [--sidecar LANG] [--desc TEXT] [--force]
#   scaffold_skill  <name> [--plugin PATH] [--desc TEXT] [--umbrella] [--force]

if [[ -n "${_PM_SCAFFOLD_LOADED:-}" ]]; then return 0; fi
_PM_SCAFFOLD_LOADED=1

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
TMPL_DIR="${TMPL_DIR:-$(cd "$LIB_DIR/../templates" && pwd)}"

# shellcheck source=common.sh
source "$LIB_DIR/common.sh"

require_cmd jq
require_cmd envsubst

# ── helpers ────────────────────────────────────────────────────────────────

_git_cfg() { git config --get "$1" 2>/dev/null || printf '%s' "${2:-}"; }

# render_template SRC DST → envsubst with whitelisted vars
render_template() {
  local src="$1" dst="$2"
  local vars='${NAME} ${DESC} ${VERSION} ${AUTHOR_NAME} ${AUTHOR_URL} ${REPOSITORY} ${CATEGORY} ${LICENSE} ${DATE} ${EXT_LANG} ${SIDECAR_LANG} ${LIFECYCLE_CMD} ${HOOKS_CSV} ${PERMS_CSV}'
  mkdir -p "$(dirname "$dst")"
  envsubst "$vars" < "$src" > "$dst"
}

write_or_fail() {
  local dst="$1"
  if [[ -e "$dst" && "${FORCE:-0}" -ne 1 ]]; then
    die "refusing to overwrite $dst (use --force)"
  fi
}

_set_scaffold_env() {
  : "${NAME:?must set NAME}"
  export NAME
  export DESC="${DESC:-Use when describing the ${NAME} plugin (replace with a real trigger phrase + verb).}"
  export VERSION="${VERSION:-0.1.0}"
  export DATE="${DATE:-$(date -u +%Y-%m-%d)}"
  export AUTHOR_NAME="${AUTHOR_NAME:-$(_git_cfg user.name 'Anonymous')}"
  local origin
  origin=$(_git_cfg remote.origin.url '')
  if [[ -z "${AUTHOR_URL:-}" ]]; then
    if [[ "$origin" =~ github\.com[:/]+([^/]+)/ ]]; then
      AUTHOR_URL="https://github.com/${BASH_REMATCH[1]}"
    else
      AUTHOR_URL="https://example.com"
    fi
  fi
  export AUTHOR_URL
  if [[ -z "${REPOSITORY:-}" ]]; then
    if [[ "$origin" =~ github\.com[:/]+([^/]+/[^/]+)(\.git)?$ ]]; then
      REPOSITORY="${BASH_REMATCH[1]%.git}"
    else
      REPOSITORY="example/${NAME}"
    fi
  fi
  export REPOSITORY
  export CATEGORY="${CATEGORY:-productivity}"
  export LICENSE="${LICENSE:-MIT}"
  export EXT_LANG="${EXT_LANG:-python}"
  export SIDECAR_LANG="${SIDECAR_LANG:-python}"
  export LIFECYCLE_CMD="${LIFECYCLE_CMD:-}"
  export HOOKS_CSV="${HOOKS_CSV:-}"
  export PERMS_CSV="${PERMS_CSV:-}"
}

# ── scaffold_plugin ────────────────────────────────────────────────────────

scaffold_plugin() {
  local umbrella=0 add_memory=0 add_ext=0 add_sidecar=0 force=0
  local out_parent="."
  NAME=""
  DESC=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --umbrella)   umbrella=1; shift ;;
      --memory)     add_memory=1; shift ;;
      --extension)  add_ext=1; EXT_LANG="${2:-python}"; shift 2 ;;
      --sidecar)    add_sidecar=1; SIDECAR_LANG="${2:-python}"; shift 2 ;;
      --force)      force=1; shift ;;
      --desc)       DESC="$2"; shift 2 ;;
      --plugin-dir) out_parent="$2"; shift 2 ;;
      --category)   CATEGORY="$2"; shift 2 ;;
      --license)    LICENSE="$2"; shift 2 ;;
      --*)          die "unknown flag for 'new plugin': $1" ;;
      *)
        if [[ -z "$NAME" ]]; then NAME="$1"
        else die "unexpected positional arg: $1"
        fi
        shift
        ;;
    esac
  done

  [[ -n "$NAME" ]] || die "usage: plugin-maker new plugin <name> [--umbrella] [--memory] [--extension LANG] [--sidecar LANG] [--desc TEXT]"
  is_kebab "$NAME" || die "plugin name must be lower-kebab-case (got '$NAME')"

  FORCE="$force"
  _set_scaffold_env

  local plugin_dir="$out_parent/${NAME}-plugin"
  if [[ -d "$plugin_dir" && "$force" -ne 1 ]]; then
    die "refusing to overwrite existing dir: $plugin_dir (use --force)"
  fi

  info "${C_BOLD}scaffolding plugin '${NAME}' → ${plugin_dir}${C_OFF}"
  info "  layout:      $([[ $umbrella -eq 1 ]] && echo umbrella || echo single)"
  info "  memory:      $([[ $add_memory -eq 1 ]] && echo yes || echo no)"
  info "  extension:   $([[ $add_ext -eq 1 ]] && echo "$EXT_LANG" || echo no)"
  info "  sidecar:     $([[ $add_sidecar -eq 1 ]] && echo "$SIDECAR_LANG" || echo no)"
  info "  description: $DESC"

  mkdir -p "$plugin_dir/.synaps-plugin" "$plugin_dir/skills/${NAME}"
  render_template "$TMPL_DIR/plugin.json.tmpl" "$plugin_dir/.synaps-plugin/plugin.json"
  render_template "$TMPL_DIR/README.md.tmpl"   "$plugin_dir/README.md"

  if [[ "$umbrella" -eq 1 ]]; then
    render_template "$TMPL_DIR/umbrella/SKILL.md.tmpl"  "$plugin_dir/skills/${NAME}/SKILL.md"
    render_template "$TMPL_DIR/umbrella/example.md.tmpl" "$plugin_dir/docs/example.md"
  else
    render_template "$TMPL_DIR/single/SKILL.md.tmpl" "$plugin_dir/skills/${NAME}/SKILL.md"
  fi

  if [[ "$add_memory" -eq 1 ]]; then
    mkdir -p "$plugin_dir/lib" "$plugin_dir/docs"
    render_template "$TMPL_DIR/memory/memory.sh.tmpl"        "$plugin_dir/lib/memory.sh"
    render_template "$TMPL_DIR/memory/self-healing.md.tmpl"  "$plugin_dir/docs/self-healing.md"
    chmod +x "$plugin_dir/lib/memory.sh"
  fi

  if [[ "$add_ext" -eq 1 ]]; then
    source "$LIB_DIR/scaffold_extension.sh"
    _scaffold_extension_in "$plugin_dir" "$EXT_LANG"
  fi

  if [[ "$add_sidecar" -eq 1 ]]; then
    source "$LIB_DIR/scaffold_sidecar.sh"
    _scaffold_sidecar_in "$plugin_dir" "$SIDECAR_LANG"
  fi

  ok "wrote $(find "$plugin_dir" -type f | wc -l) files into $plugin_dir"
  info ""
  info "next steps:"
  info "  1. Edit description in $plugin_dir/.synaps-plugin/plugin.json"
  info "  2. Edit $plugin_dir/skills/${NAME}/SKILL.md"
  info "  3. plugin-maker validate $plugin_dir"
}

# ── scaffold_skill ─────────────────────────────────────────────────────────

scaffold_skill() {
  local plugin_path="" force=0 umbrella=0
  NAME=""
  DESC=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --plugin)   plugin_path="$2"; shift 2 ;;
      --desc)     DESC="$2"; shift 2 ;;
      --umbrella) umbrella=1; shift ;;
      --force)    force=1; shift ;;
      --*)        die "unknown flag for 'new skill': $1" ;;
      *)
        if [[ -z "$NAME" ]]; then NAME="$1"
        else die "unexpected positional arg: $1"
        fi
        shift
        ;;
    esac
  done

  [[ -n "$NAME" ]] || die "usage: plugin-maker new skill <name> [--plugin PATH] [--desc TEXT]"
  is_kebab "$NAME" || die "skill name must be lower-kebab-case (got '$NAME')"

  if [[ -z "$plugin_path" ]]; then
    plugin_path=$(plugin_root_of ".") || die "not inside a plugin (use --plugin PATH)"
  fi

  is_plugin_dir "$plugin_path" || die "not a plugin: $plugin_path"

  FORCE="$force"
  _set_scaffold_env

  local skill_dir="$plugin_path/skills/${NAME}"
  if [[ -d "$skill_dir" && "$force" -ne 1 ]]; then
    die "skill already exists: $skill_dir (use --force)"
  fi

  info "${C_BOLD}scaffolding skill '${NAME}' → ${skill_dir}${C_OFF}"
  mkdir -p "$skill_dir"

  if [[ "$umbrella" -eq 1 ]]; then
    render_template "$TMPL_DIR/umbrella/SKILL.md.tmpl" "$skill_dir/SKILL.md"
  else
    render_template "$TMPL_DIR/single/SKILL.md.tmpl" "$skill_dir/SKILL.md"
  fi

  ok "wrote $skill_dir/SKILL.md"
}
