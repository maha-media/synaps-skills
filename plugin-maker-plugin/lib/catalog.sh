#!/usr/bin/env bash
# catalog.sh — canonical catalog of every plugin-surface enumerable.
#
# This is the SINGLE SOURCE OF TRUTH for plugin-maker. Every validator and
# every `catalog` subcommand reads from these arrays. When SynapsCLI bumps
# any of these enumerables (new hook kind, new permission, new editor kind),
# this is the only file we touch.
#
# All arrays are tab-separated `key<TAB>field<TAB>field…` strings stored as
# functions emitting one line per entry. Bash 4 associative-array equivalent
# without the bash-4 minimum.

if [[ -n "${_PM_CATALOG_LOADED:-}" ]]; then return 0; fi
_PM_CATALOG_LOADED=1

# ── extension permissions (12 total) ───────────────────────────────────────
# Source: src/extensions/permissions.rs::Permission
# Format: name<TAB>reserved<TAB>description
catalog_permissions() {
  cat <<'EOF'
tools.intercept	false	Subscribe to before_tool_call / after_tool_call hooks.
tools.override	true	[reserved] Override built-in tools — not yet implemented.
privacy.llm_content	false	Read LLM input/output (before_message, on_message_complete, on_compaction).
session.lifecycle	false	Subscribe to on_session_start / on_session_end.
tools.register	false	Register new tools the model can call.
providers.register	false	Register new model providers.
memory.read	false	Read from the local memory store via memory.query.
memory.write	false	Append to the local memory store via memory.append.
config.write	false	Read/write the plugin's namespaced config via config.get/set.
config.subscribe	false	Subscribe to hot-reload notifications for plugin config.
audio.input	false	Capture audio from input devices.
audio.output	false	Produce audio through output devices.
EOF
}

# ── hook kinds (7 total) ───────────────────────────────────────────────────
# Source: src/extensions/hooks/events.rs::HookKind
# Format: name<TAB>required_permission<TAB>allows_tool_filter<TAB>allowed_actions<TAB>description
catalog_hooks() {
  cat <<'EOF'
before_tool_call	tools.intercept	yes	continue,block,confirm,modify	Fires immediately before a tool is invoked. Handlers may block, modify, or require user confirmation.
after_tool_call	tools.intercept	yes	continue	Fires immediately after a tool returns. Handlers receive the output.
before_message	privacy.llm_content	no	continue,inject	Fires before an LLM message is sent. Handlers may inject extra context.
on_message_complete	privacy.llm_content	no	continue	Fires after an assistant response is added to history.
on_compaction	privacy.llm_content	no	continue	Fires after conversation compaction creates a replacement session.
on_session_start	session.lifecycle	no	continue	Fires when a new session is created.
on_session_end	session.lifecycle	no	continue	Fires when a session is torn down.
EOF
}

# ── command shapes (4 total) ───────────────────────────────────────────────
# Source: src/skills/manifest.rs::ManifestCommand
# Format: kind<TAB>required_field<TAB>description
catalog_command_kinds() {
  cat <<'EOF'
shell	command	Run an external program. Args go in `args[]`.
extension	tool	Invoke a tool registered by an extension. Input goes in `input` (JSON).
skill	skill+prompt	Inject a stored skill plus a prompt as a single user turn.
interactive	interactive=true	Route the slash command to the plugin extension's command.invoke RPC.
EOF
}

# ── settings editor kinds (4 total) ────────────────────────────────────────
# Source: src/skills/manifest.rs::ManifestEditorKind
# Format: name<TAB>requires<TAB>description
catalog_editor_kinds() {
  cat <<'EOF'
text	-	Free-text input. With numeric:true, accepts only numeric values.
cycler	options[]	Discrete-option cycler. Required: non-empty options[].
picker	-	Generic picker. Options supplied by the plugin at editor-open time.
custom	extension	Plugin-rendered overlay using settings.editor.{open,render,key,commit}.
EOF
}

# ── keybind action kinds (4 total) ─────────────────────────────────────────
# Source: src/skills/keybinds.rs::ManifestKeybind
# Format: action<TAB>required_field<TAB>description
catalog_action_kinds() {
  cat <<'EOF'
slash_command	command	Execute a slash command (e.g. "scholar quantum").
load_skill	skill	Load a named skill into the model context.
inject_prompt	prompt	Submit literal text as a user message.
run_script	script	Run a shell script and inject its stdout as a system message.
EOF
}

# ── sidecar frame protocol (v2) ────────────────────────────────────────────
# Source: src/sidecar/protocol.rs
# Direction: H=host→sidecar, S=sidecar→host
# Format: direction<TAB>type<TAB>fields<TAB>description
catalog_sidecar_frames() {
  cat <<'EOF'
H	init	config:obj	Plugin-defined initialization payload.
H	trigger	name:str,payload:obj?	Generic activation trigger. Plugin-defined name.
H	shutdown	-	Graceful shutdown.
S	hello	protocol_version:int,extension:str,capabilities:str[]	First frame from sidecar; declares protocol & capabilities.
S	status	state:str,label:str?,capabilities:str[]	Status update; UI may render the label.
S	insert_text	text:str,mode:append|final|replace	Insert text into the input buffer.
S	error	message:str	Error condition; UI surfaces to user.
EOF
}

# ── sidecar protocol versions ──────────────────────────────────────────────
catalog_sidecar_protocol_versions() {
  printf '%s\n' '1' '2'
}

# ── topic kinds for help_entries ───────────────────────────────────────────
catalog_help_topic_kinds() {
  printf '%s\n' 'Branch' 'Command'
}

# ── reserved core keybinds (cannot be overridden) ──────────────────────────
# Source: src/skills/keybinds.rs::register_core
# Format: notation
catalog_reserved_keys() {
  cat <<'EOF'
C-c
Esc
Enter
S-Enter
Tab
C-a
C-e
C-u
C-w
C-o
A-Left
A-Right
S-Up
S-Down
Up
Down
Left
Right
Backspace
A-Backspace
Home
End
EOF
}

# ── lookup helpers ─────────────────────────────────────────────────────────

# is_known_permission NAME → 0 if known
is_known_permission() {
  local name="$1"
  catalog_permissions | awk -F'\t' -v n="$name" '$1 == n { found=1 } END { exit !found }'
}

# is_reserved_permission NAME → 0 if reserved (e.g. tools.override)
is_reserved_permission() {
  local name="$1"
  catalog_permissions | awk -F'\t' -v n="$name" '$1 == n && $2 == "true" { found=1 } END { exit !found }'
}

# is_known_hook NAME → 0 if known
is_known_hook() {
  local name="$1"
  catalog_hooks | awk -F'\t' -v n="$name" '$1 == n { found=1 } END { exit !found }'
}

# hook_required_permission NAME → emits the required permission name
hook_required_permission() {
  local name="$1"
  catalog_hooks | awk -F'\t' -v n="$name" '$1 == n { print $2; exit }'
}

# hook_allows_tool_filter NAME → 0 if hook allows a tool filter
hook_allows_tool_filter() {
  local name="$1"
  catalog_hooks | awk -F'\t' -v n="$name" '$1 == n && $3 == "yes" { found=1 } END { exit !found }'
}

# is_known_editor_kind NAME → 0 if known
is_known_editor_kind() {
  local name="$1"
  catalog_editor_kinds | awk -F'\t' -v n="$name" '$1 == n { found=1 } END { exit !found }'
}

# is_known_action_kind NAME → 0 if known
is_known_action_kind() {
  local name="$1"
  catalog_action_kinds | awk -F'\t' -v n="$name" '$1 == n { found=1 } END { exit !found }'
}

# action_required_field ACTION → emits the required field name
action_required_field() {
  local name="$1"
  catalog_action_kinds | awk -F'\t' -v n="$name" '$1 == n { print $2; exit }'
}

# is_reserved_key NOTATION → 0 if reserved
is_reserved_key() {
  local key="$1"
  catalog_reserved_keys | awk -v k="$key" '$1 == k { found=1 } END { exit !found }'
}

# ── pretty-printers (used by `plugin-maker catalog <name>`) ────────────────

print_catalog_table() {
  local title="$1"; shift
  local header="$1"; shift
  local body
  body="$("$@")"

  printf '%s%s%s\n\n' "${C_BOLD}" "$title" "${C_OFF}"
  {
    printf '%s\n' "$header"
    printf '%s\n' "$body"
  } | column -t -s $'\t'
  printf '\n'
}

# Public dispatcher used by `bin/plugin-maker catalog <name>`
catalog_dispatch() {
  # accept common shorthands
  local what="${1:-}"
  case "$what" in
    perms|perm)        what=permissions ;;
    hook|h)            what=hooks ;;
    frames|sidecar)    what=sidecar-frames ;;
    editors|fields)    what=editor-kinds ;;
    actions|keybinds)  what=action-types ;;
    commands|cmds)     what=command-kinds ;;
  esac
  case "$what" in
    hooks)
      print_catalog_table "Hook kinds (7)" \
        $'KIND\tREQUIRES\tTOOL_FILTER\tACTIONS\tDESCRIPTION' catalog_hooks
      ;;
    permissions)
      print_catalog_table "Extension permissions (12)" \
        $'PERMISSION\tRESERVED\tDESCRIPTION' catalog_permissions
      ;;
    hook-permissions)
      printf '%shook → required permission%s\n\n' "${C_BOLD}" "${C_OFF}"
      catalog_hooks | awk -F'\t' '{ printf "  %-22s → %s\n", $1, $2 }'
      printf '\n'
      ;;
    sidecar-frames)
      print_catalog_table "Sidecar wire protocol (v2)" \
        $'DIR\tTYPE\tFIELDS\tDESCRIPTION' catalog_sidecar_frames
      ;;
    editor-kinds)
      print_catalog_table "Settings editor kinds (4)" \
        $'EDITOR\tREQUIRES\tDESCRIPTION' catalog_editor_kinds
      ;;
    action-types)
      print_catalog_table "Keybind action kinds (4)" \
        $'ACTION\tREQUIRES\tDESCRIPTION' catalog_action_kinds
      ;;
    command-kinds)
      print_catalog_table "Command shapes (4)" \
        $'KIND\tREQUIRES\tDESCRIPTION' catalog_command_kinds
      ;;
    ""|--help|-h|help)
      cat <<EOF
Usage: plugin-maker catalog <name>

Available catalogs:
  hooks               — 7 hook kinds with required permissions and tool-filter rules
  permissions         — 12 extension permissions (incl. reserved)
  hook-permissions    — hook → required-permission map
  sidecar-frames      — sidecar wire protocol v2 frames
  editor-kinds        — settings editor kinds (text/cycler/picker/custom)
  action-types        — keybind action kinds (slash_command/load_skill/inject_prompt/run_script)
  command-kinds       — slash-command shapes (shell/extension/skill/interactive)
EOF
      ;;
    *)
      die "unknown catalog: '$1' (try: plugin-maker catalog help)"
      ;;
  esac
}
