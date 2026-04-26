#!/usr/bin/env bash
# synaps.sh — drive the Synaps `/plugins` TUI from a side pane.
#
# Use this after `git push` to a marketplace repo: it opens Synaps in a fresh
# tmux pane, navigates the plugins modal, refreshes the marketplace cache,
# and installs/updates plugins — then quits cleanly. Detection is via
# `~/.synaps-cli/plugins.json` mutations (the TUI saves on every action), not
# screen-scraping, so it's robust across theme/layout changes.
#
# Subcommands:
#   refresh [MARKETPLACE]               refresh marketplace cache (default: synaps-skills)
#   install PLUGIN [--marketplace M]    install a cached plugin
#   update  PLUGIN                      update an installed plugin to latest cached SHA
#   sync    PLUGIN [--marketplace M]    refresh + (install | update); the "I just pushed" workflow
#   status  [PLUGIN]                    print installed/cached state (no TUI needed)
#
# Flags (apply to refresh/install/update/sync):
#   --pane NAME            tmux pane name to use (default: synaps-sync)
#   --keep-pane            don't kill the pane on success (for debugging)
#   --timeout SEC          per-step timeout (default: 30)
#   --synaps-cmd CMD       command to launch synaps (default: synaps)

set -eu

PROG="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PANE_SH="$SCRIPT_DIR/pane.sh"

PLUGINS_JSON="${SYNAPS_PLUGINS_JSON:-$HOME/.synaps-cli/plugins.json}"

die()  { echo "$PROG: error: $*" >&2; exit 1; }
warn() { echo "$PROG: $*" >&2; }
info() { echo "$PROG: $*" >&2; }

require_deps() {
    [ -n "${TMUX:-}" ]              || die "not inside tmux (TMUX env var unset)"
    [ -x "$PANE_SH" ]               || die "pane.sh not found at $PANE_SH"
    command -v python3 >/dev/null   || die "python3 required for plugins.json parsing"
    [ -f "$PLUGINS_JSON" ]          || die "plugins.json not found at $PLUGINS_JSON"
}

# --- plugins.json helpers (python for jq-free environments) ---

# pj CODE [ARG...]  → python3 -c CODE PLUGINS_JSON ARG...
# So sys.argv[1] is always the json path, sys.argv[2:] are caller args.
pj() {
    local code="$1"; shift
    python3 -c "$code" "$PLUGINS_JSON" "$@"
}

list_installed_names() {
    pj 'import json,sys
d=json.load(open(sys.argv[1]))
print("\n".join(p["name"] for p in d["installed"]))'
}

installed_index_of() {
    pj '
import json, sys
d = json.load(open(sys.argv[1]))
for i, p in enumerate(d["installed"]):
    if p["name"] == sys.argv[2]:
        print(i); break
else:
    sys.exit(1)
' "$1"
}

installed_commit_of() {
    pj '
import json, sys
d = json.load(open(sys.argv[1]))
for p in d["installed"]:
    if p["name"] == sys.argv[2]:
        print(p.get("installed_commit","")); break
' "$1"
}

# Given a plugin name, find which marketplace caches it. Output: "MP_NAME|PLUGIN_INDEX". Exit 1 if not found.
find_in_marketplace() {
    pj '
import json, sys
d = json.load(open(sys.argv[1]))
plugin = sys.argv[2]
prefer = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
hits = []
for m in d["marketplaces"]:
    for i, p in enumerate(m["cached_plugins"]):
        if p["name"] == plugin:
            hits.append((m["name"], i))
if not hits:
    sys.exit(1)
if prefer:
    for name, idx in hits:
        if name == prefer:
            print(f"{name}|{idx}"); sys.exit(0)
    sys.exit(2)
print(f"{hits[0][0]}|{hits[0][1]}")
' "$1" "${2:-}"
}

# 0-based index of marketplace in marketplaces[].
marketplace_index_of() {
    pj '
import json, sys
d = json.load(open(sys.argv[1]))
for i, m in enumerate(d["marketplaces"]):
    if m["name"] == sys.argv[2]:
        print(i); break
else:
    sys.exit(1)
' "$1"
}

marketplace_last_refreshed() {
    pj '
import json, sys
d = json.load(open(sys.argv[1]))
for m in d["marketplaces"]:
    if m["name"] == sys.argv[2]:
        print(m.get("last_refreshed","")); break
' "$1"
}

# Poll until a python expression on plugins.json evaluates True (exit 0).
# Args: TIMEOUT_SEC PY_EXPR_USING_d
# The python snippet has `d` (loaded JSON dict) and `sys` available, plus any
# extra args as sys.argv[2:]. It must `sys.exit(0)` for ready, `sys.exit(1)` for not yet.
poll_json() {
    local timeout="$1"; shift
    local code="$1"; shift
    local elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        if python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
$code
" "$PLUGINS_JSON" "$@" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 124
}

# --- TUI driving ---

PANE_NAME="synaps-sync"
KEEP_PANE=0
TIMEOUT=30
SYNAPS_CMD="synaps"

ensure_synaps_pane() {
    "$PANE_SH" spawn "$PANE_NAME" --size 35 --side below >/dev/null
    local id
    id="$("$PANE_SH" id "$PANE_NAME")"
    # If the pane isn't already running synaps, launch it.
    local current_cmd
    current_cmd="$(tmux display -t "$id" -p '#{pane_current_command}' 2>/dev/null)"
    if [ "$current_cmd" != "synaps" ]; then
        info "launching synaps in pane $PANE_NAME ($id)..."
        tmux send-keys -t "$id" "$SYNAPS_CMD" Enter
        # Wait for the TUI to render — heuristic: bottom status line contains
        # 'enter send' once the TUI's input box is visible.
        local elapsed=0
        while [ "$elapsed" -lt "$TIMEOUT" ]; do
            if tmux capture-pane -t "$id" -p 2>/dev/null | grep -q 'enter send'; then
                return 0
            fi
            sleep 1
            elapsed=$((elapsed + 1))
        done
        die "synaps TUI did not become ready within ${TIMEOUT}s"
    fi
}

cleanup_pane() {
    [ "$KEEP_PANE" -eq 1 ] && return 0
    local id
    id="$("$PANE_SH" id "$PANE_NAME" 2>/dev/null || true)"
    [ -z "$id" ] && return 0
    # Send Ctrl-C twice to quit synaps cleanly, then kill the pane.
    tmux send-keys -t "$id" C-c
    sleep 0.4
    tmux send-keys -t "$id" C-c
    sleep 0.4
    "$PANE_SH" close "$PANE_NAME" 2>/dev/null || true
}

# Open /plugins modal. If a modal is already open from a prior operation,
# Esc out of it first so we always start from a fresh state:
# selected_left=0 (Installed), focus=Left.
open_plugins_modal() {
    local id; id="$("$PANE_SH" id "$PANE_NAME")"
    # Esc twice: closes any sub-mode (Detail / Confirm / TrustPrompt) then the modal itself.
    tmux send-keys -t "$id" Escape
    sleep 0.15
    tmux send-keys -t "$id" Escape
    sleep 0.15
    tmux send-keys -t "$id" "/plugins" Enter
    sleep 0.6
}

# Send N Down keypresses with brief settle delay between each.
nav_down() {
    local id="$1" n="$2"
    [ "$n" -le 0 ] && return 0
    local i=0
    while [ "$i" -lt "$n" ]; do
        tmux send-keys -t "$id" Down
        sleep 0.08
        i=$((i + 1))
    done
}

# --- subcommands ---

cmd_status() {
    local filter="${1:-}"
    pj '
import json, sys
d = json.load(open(sys.argv[1]))
flt = sys.argv[2] if len(sys.argv) > 2 else ""
installed = {p["name"]: p for p in d["installed"]}
print("=== installed ===")
for p in d["installed"]:
    if flt and p["name"] != flt: continue
    name = p["name"]
    sha = p.get("installed_commit", "")[:8]
    latest = (p.get("latest_commit") or "")[:8]
    mp = p.get("marketplace", "")
    flag = "" if not latest or latest == sha else f" (update available: {latest})"
    print(f"  {name:<14} {sha}  marketplace={mp}{flag}")
print()
print("=== cached (per marketplace) ===")
for m in d["marketplaces"]:
    mname = m["name"]
    refreshed = m.get("last_refreshed","-")
    print(f"  [{mname}] last_refreshed={refreshed}")
    for p in m["cached_plugins"]:
        if flt and p["name"] != flt: continue
        name = p["name"]
        ver = p.get("version","?")
        status = "installed" if name in installed else "available"
        print(f"    {name:<14} v{ver:<10} {status}")
' "$filter"
}

cmd_refresh() {
    local mp="${1:-synaps-skills}"
    require_deps

    local mp_idx
    mp_idx="$(marketplace_index_of "$mp")" || die "marketplace '$mp' not registered"
    local before
    before="$(marketplace_last_refreshed "$mp")"
    info "refreshing marketplace '$mp' (left row index $((mp_idx + 1)))"

    ensure_synaps_pane
    open_plugins_modal
    local id; id="$("$PANE_SH" id "$PANE_NAME")"

    # selected_left starts at 0 (Installed). Marketplace rows start at 1.
    nav_down "$id" $((mp_idx + 1))
    sleep 0.2
    # Press 'r' to refresh (Left focus is default; 'r' works in both Left/Right).
    tmux send-keys -t "$id" r

    info "polling plugins.json for last_refreshed change..."
    if poll_json "$TIMEOUT" '
for m in d["marketplaces"]:
    if m["name"] == sys.argv[2] and m.get("last_refreshed","") != sys.argv[3]:
        sys.exit(0)
sys.exit(1)
' "$mp" "$before"; then
        local after; after="$(marketplace_last_refreshed "$mp")"
        info "refreshed: $before → $after"
        cleanup_pane
        return 0
    else
        cleanup_pane
        die "refresh timed out after ${TIMEOUT}s (last_refreshed unchanged)"
    fi
}

cmd_install() {
    local plugin="" prefer_mp=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --marketplace) prefer_mp="$2"; shift 2 ;;
            -*) die "unknown flag: $1" ;;
            *) [ -z "$plugin" ] && plugin="$1" || die "extra arg: $1"; shift ;;
        esac
    done
    [ -n "$plugin" ] || die "install: PLUGIN required"
    require_deps

    if list_installed_names | grep -qx "$plugin"; then
        warn "'$plugin' is already installed; use \`$PROG update $plugin\` instead"
        return 0
    fi

    local hit mp_name plug_idx
    hit="$(find_in_marketplace "$plugin" "$prefer_mp")" \
        || die "plugin '$plugin' not in any cached marketplace${prefer_mp:+ (preferred: $prefer_mp)}"
    mp_name="${hit%|*}"
    plug_idx="${hit#*|}"

    local mp_idx; mp_idx="$(marketplace_index_of "$mp_name")"
    info "installing '$plugin' from marketplace '$mp_name' (mp row $((mp_idx + 1)), plugin row $plug_idx)"

    ensure_synaps_pane
    open_plugins_modal
    local id; id="$("$PANE_SH" id "$PANE_NAME")"

    # Navigate Left to the marketplace row, then Tab to Right, then Down to the plugin.
    nav_down "$id" $((mp_idx + 1))
    sleep 0.2
    tmux send-keys -t "$id" Tab
    sleep 0.3
    nav_down "$id" "$plug_idx"
    sleep 0.2
    tmux send-keys -t "$id" i

    info "polling plugins.json for '$plugin' to appear in installed[]..."
    if poll_json "$TIMEOUT" '
sys.exit(0 if any(p["name"]==sys.argv[2] for p in d["installed"]) else 1)
' "$plugin"; then
        local sha; sha="$(installed_commit_of "$plugin")"
        info "installed: $plugin @ ${sha:0:8}"
        cleanup_pane
        return 0
    else
        cleanup_pane
        die "install timed out after ${TIMEOUT}s — possible trust prompt or git error; rerun with --keep-pane to inspect"
    fi
}

cmd_update() {
    local plugin="${1:-}"
    [ -n "$plugin" ] || die "update: PLUGIN required"
    require_deps

    local idx; idx="$(installed_index_of "$plugin")" \
        || die "'$plugin' is not installed (use \`$PROG install $plugin\`)"
    local before; before="$(installed_commit_of "$plugin")"
    info "updating '$plugin' (currently @ ${before:0:8}, installed[] row $idx)"

    ensure_synaps_pane
    open_plugins_modal
    local id; id="$("$PANE_SH" id "$PANE_NAME")"

    # selected_left=0 (Installed) is the default. Tab to Right, Down to plugin row, press 'u'.
    tmux send-keys -t "$id" Tab
    sleep 0.3
    nav_down "$id" "$idx"
    sleep 0.2
    tmux send-keys -t "$id" u

    info "polling plugins.json for installed_commit change..."
    if poll_json "$TIMEOUT" '
for p in d["installed"]:
    if p["name"] == sys.argv[2] and p.get("installed_commit","") != sys.argv[3]:
        sys.exit(0)
sys.exit(1)
' "$plugin" "$before"; then
        local after; after="$(installed_commit_of "$plugin")"
        info "updated: ${before:0:8} → ${after:0:8}"
        cleanup_pane
        return 0
    else
        cleanup_pane
        die "update timed out after ${TIMEOUT}s (commit unchanged — already up-to-date? rerun with: $PROG refresh; $PROG update $plugin)"
    fi
}

cmd_sync() {
    local plugin="" prefer_mp=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --marketplace) prefer_mp="$2"; shift 2 ;;
            -*) die "unknown flag: $1" ;;
            *) [ -z "$plugin" ] && plugin="$1" || die "extra arg: $1"; shift ;;
        esac
    done
    [ -n "$plugin" ] || die "sync: PLUGIN required"
    require_deps

    # Determine which marketplace owns this plugin so we know what to refresh.
    local hit mp_name
    if hit="$(find_in_marketplace "$plugin" "$prefer_mp" 2>/dev/null)"; then
        mp_name="${hit%|*}"
    else
        mp_name="${prefer_mp:-synaps-skills}"
    fi
    info "sync: refresh marketplace '$mp_name' + install/update '$plugin'"

    cmd_refresh "$mp_name"

    if list_installed_names | grep -qx "$plugin"; then
        cmd_update "$plugin"
    else
        if [ -n "$prefer_mp" ]; then
            cmd_install "$plugin" --marketplace "$prefer_mp"
        else
            cmd_install "$plugin"
        fi
    fi
}

usage() {
    sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
    exit 2
}

# Parse global flags first (any order), then dispatch subcommand.
ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --pane)        PANE_NAME="$2"; shift 2 ;;
        --keep-pane)   KEEP_PANE=1; shift ;;
        --timeout)     TIMEOUT="$2"; shift 2 ;;
        --synaps-cmd)  SYNAPS_CMD="$2"; shift 2 ;;
        -h|--help|help) usage ;;
        *) ARGS+=("$1"); shift ;;
    esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

[ $# -gt 0 ] || usage
sub="$1"; shift
case "$sub" in
    refresh) cmd_refresh "$@" ;;
    install) cmd_install "$@" ;;
    update)  cmd_update  "$@" ;;
    sync)    cmd_sync    "$@" ;;
    status)  cmd_status  "$@" ;;
    *) die "unknown subcommand: $sub (try --help)" ;;
esac
