#!/usr/bin/env bash
# pane.sh — manage named tmux worker panes for agent-driven workflows.
#
# Subcommands:
#   spawn  NAME [--size PCT] [--side below|right|above|left]   create or return existing pane
#   run    NAME CMD [--timeout S] [--lines N]                  send command, wait for prompt, return output
#   send   NAME INPUT                                          fire-and-forget input (no wait)
#   keys   NAME KEY [KEY...]                                   send raw tmux keys (e.g. C-c, Enter, Up)
#   poll   NAME [--lines N] [--full]                           current snapshot
#   wait   NAME [--timeout S]                                  block until shell prompt returns
#   close  NAME                                                kill pane
#   list                                                        list all named panes
#   id     NAME                                                print pane target id (e.g. %2), exit 1 if not found
#
# Naming uses tmux pane titles, set via `select-pane -T NAME`.
# All operations are session-wide (uses `list-panes -a`), so panes work
# across windows but stay scoped to the tmux server.

set -eu

PROG="$(basename "$0")"

die()  { echo "$PROG: error: $*" >&2; exit 1; }
warn() { echo "$PROG: $*" >&2; }

require_tmux() {
    [ -n "${TMUX:-}" ] || die "not inside a tmux session (TMUX env var unset)"
    command -v tmux >/dev/null 2>&1 || die "tmux command not found on PATH"
}

# Find pane id by title. Echoes pane id (e.g. %2) or empty.
pane_id_of() {
    local name="$1"
    tmux list-panes -a -F '#{pane_title}|#{pane_id}' 2>/dev/null \
        | awk -F'|' -v n="$name" '$1==n {print $2; exit}'
}

# Get target id, dying if not found.
pane_id_required() {
    local name="$1"
    local id
    id="$(pane_id_of "$name")"
    [ -n "$id" ] || die "no pane named '$name' (use \`$PROG list\` to see panes)"
    echo "$id"
}

cmd_spawn() {
    local name="" size=30 side=below
    while [ $# -gt 0 ]; do
        case "$1" in
            --size) size="$2"; shift 2 ;;
            --side) side="$2"; shift 2 ;;
            --) shift; break ;;
            -*) die "unknown flag: $1" ;;
            *) [ -z "$name" ] && name="$1" || die "extra arg: $1"; shift ;;
        esac
    done
    [ -n "$name" ] || die "spawn: NAME required"

    local existing
    existing="$(pane_id_of "$name")"
    if [ -n "$existing" ]; then
        echo "$existing"
        return 0
    fi

    local flag
    case "$side" in
        below) flag="-v" ;;
        above) flag="-vb" ;;
        right) flag="-h" ;;
        left)  flag="-hb" ;;
        *) die "invalid --side: $side (use below|above|right|left)" ;;
    esac

    # -d  : don't switch focus to the new pane
    # -P  : print info about new pane
    # -F  : format string — get the new pane id
    # -l  : size as percentage
    local new_id
    new_id="$(tmux split-window $flag -d -P -F '#{pane_id}' -l "${size}%")"
    [ -n "$new_id" ] || die "split-window failed"

    # Set title and enable pane border title display
    tmux select-pane -t "$new_id" -T "$name"
    tmux set -g pane-border-status top 2>/dev/null || true

    echo "$new_id"
}

# Capture and return last N lines from a pane.
# Trailing blank lines (from unused screen rows) are stripped before tailing.
capture_tail() {
    local id="$1" lines="${2:-40}"
    local raw
    if [ "$lines" = "all" ]; then
        raw="$(tmux capture-pane -t "$id" -p -S - 2>/dev/null)"
    else
        raw="$(tmux capture-pane -t "$id" -p 2>/dev/null)"
    fi
    # Strip trailing empty lines, then tail
    printf '%s' "$raw" | awk '
        { lines[NR] = $0 }
        END {
            last = NR
            while (last > 0 && lines[last] ~ /^[[:space:]]*$/) last--
            for (i = 1; i <= last; i++) print lines[i]
        }
    ' | { [ "$lines" = "all" ] && cat || tail -n "$lines"; }
}

# Detect a "shell is idle" prompt on the last non-empty line.
# Heuristic: line ends in `$ `, `# `, `> `, `% ` (with optional trailing whitespace).
is_idle() {
    local id="$1"
    local last
    last="$(tmux capture-pane -t "$id" -p 2>/dev/null \
            | awk 'NF{l=$0} END{print l}')"
    case "$last" in
        *"$ "|*"# "|*"> "|*"% "|*"$"|*"#"|*">"|*"%") return 0 ;;
        *) return 1 ;;
    esac
}

cmd_wait() {
    local name="" timeout=60
    while [ $# -gt 0 ]; do
        case "$1" in
            --timeout) timeout="$2"; shift 2 ;;
            -*) die "unknown flag: $1" ;;
            *) [ -z "$name" ] && name="$1" || die "extra arg: $1"; shift ;;
        esac
    done
    [ -n "$name" ] || die "wait: NAME required"
    local id; id="$(pane_id_required "$name")"

    local elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        if is_idle "$id"; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    warn "wait: timed out after ${timeout}s waiting for prompt in $name"
    return 124
}

cmd_run() {
    local name="" cmd="" timeout=60 lines=40
    while [ $# -gt 0 ]; do
        case "$1" in
            --timeout) timeout="$2"; shift 2 ;;
            --lines)   lines="$2";   shift 2 ;;
            --) shift; break ;;
            -*) die "unknown flag: $1" ;;
            *)
                if [ -z "$name" ]; then name="$1"
                elif [ -z "$cmd" ]; then cmd="$1"
                else die "extra arg: $1"
                fi
                shift ;;
        esac
    done
    [ -n "$name" ] || die "run: NAME required"
    [ -n "$cmd"  ] || die "run: CMD required"
    local id; id="$(pane_id_required "$name")"

    # Send command + Enter
    tmux send-keys -t "$id" "$cmd" Enter

    # Wait for prompt return
    local elapsed=0 ok=0
    sleep 0.3  # give the shell a moment to start producing output
    while [ "$elapsed" -lt "$timeout" ]; do
        if is_idle "$id"; then
            ok=1; break
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done

    capture_tail "$id" "$lines"
    if [ "$ok" -ne 1 ]; then
        echo "--- (still running after ${timeout}s; use \`$PROG poll $name\` or \`$PROG wait $name\`) ---" >&2
        return 124
    fi
}

cmd_send() {
    local name="$1"; shift || die "send: NAME required"
    [ $# -gt 0 ] || die "send: INPUT required"
    local id; id="$(pane_id_required "$name")"
    tmux send-keys -t "$id" "$*" Enter
}

cmd_keys() {
    local name="$1"; shift || die "keys: NAME required"
    [ $# -gt 0 ] || die "keys: at least one KEY required"
    local id; id="$(pane_id_required "$name")"
    tmux send-keys -t "$id" "$@"
}

cmd_poll() {
    local name="" lines=40 full=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --lines) lines="$2"; shift 2 ;;
            --full)  full=1; shift ;;
            -*) die "unknown flag: $1" ;;
            *) [ -z "$name" ] && name="$1" || die "extra arg: $1"; shift ;;
        esac
    done
    [ -n "$name" ] || die "poll: NAME required"
    local id; id="$(pane_id_required "$name")"
    if [ "$full" -eq 1 ]; then
        capture_tail "$id" all
    else
        capture_tail "$id" "$lines"
    fi
}

cmd_close() {
    local name="${1:-}"
    [ -n "$name" ] || die "close: NAME required"
    local id; id="$(pane_id_required "$name")"
    tmux kill-pane -t "$id"
}

cmd_list() {
    tmux list-panes -a -F '#{pane_title}|#{pane_id}|#{session_name}:#{window_index}.#{pane_index}|#{pane_current_command}' 2>/dev/null \
        | awk -F'|' '$1!="" && $1!~/^[0-9]+$/ {
            printf "  %-20s %-6s %-12s %s\n", $1, $2, $3, $4
        }'
}

cmd_id() {
    local name="${1:-}"
    [ -n "$name" ] || die "id: NAME required"
    pane_id_required "$name"
}

usage() {
    sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
    exit 2
}

main() {
    [ $# -gt 0 ] || usage
    require_tmux
    local sub="$1"; shift
    case "$sub" in
        spawn) cmd_spawn "$@" ;;
        run)   cmd_run   "$@" ;;
        send)  cmd_send  "$@" ;;
        keys)  cmd_keys  "$@" ;;
        poll)  cmd_poll  "$@" ;;
        wait)  cmd_wait  "$@" ;;
        close) cmd_close "$@" ;;
        list)  cmd_list  "$@" ;;
        id)    cmd_id    "$@" ;;
        -h|--help|help) usage ;;
        *) die "unknown subcommand: $sub (try --help)" ;;
    esac
}

main "$@"
