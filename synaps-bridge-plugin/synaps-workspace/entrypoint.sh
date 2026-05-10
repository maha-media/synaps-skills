#!/usr/bin/env bash
# entrypoint.sh — synaps-workspace container startup
#
# Responsibilities:
#   1. Launch Xvfb virtual display :1
#   2. Launch dbus session bus
#   3. Launch Openbox window manager
#   4. Launch KasmVNC server on port 6901 (no-auth; protected by SCP proxy in production)
#   5. Idle via `tail -f /dev/null`
#
# The `synaps rpc` process is NOT started here.
# SCP launches it on demand via `docker exec ws-<id> synaps rpc`.
#
# Spec: docs/plans/PLATFORM.SPEC.md §3.4 entrypoint contract

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() { printf '[entrypoint] %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Signal handling — graceful shutdown
# ---------------------------------------------------------------------------
_children=()
_shutdown() {
  log "Received SIGTERM — shutting down child processes..."
  for pid in "${_children[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  # Give children up to 5 s to exit, then SIGKILL
  sleep 5
  for pid in "${_children[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      log "Force-killing $pid"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  log "Shutdown complete."
  exit 0
}
trap _shutdown SIGTERM SIGINT

# ---------------------------------------------------------------------------
# 1. Xvfb
# ---------------------------------------------------------------------------
log "Starting Xvfb on :1 (1280x800x24)"
Xvfb :1 -screen 0 1280x800x24 &
_children+=("$!")
export DISPLAY=:1

# Give Xvfb a moment to initialise before launching WM / VNC
sleep 1

# ---------------------------------------------------------------------------
# 2. dbus session bus
# ---------------------------------------------------------------------------
log "Starting dbus session bus"
eval "$(dbus-launch --sh-syntax)" || true
# dbus-launch exports DBUS_SESSION_BUS_ADDRESS, DBUS_SESSION_BUS_PID
if [ -n "${DBUS_SESSION_BUS_PID:-}" ]; then
  _children+=("${DBUS_SESSION_BUS_PID}")
fi

# ---------------------------------------------------------------------------
# 3. Openbox window manager
# ---------------------------------------------------------------------------
log "Starting openbox-session"
openbox-session &
_children+=("$!")
sleep 1

# ---------------------------------------------------------------------------
# 4. KasmVNC
#
# Phase 1: no-auth mode (production runs behind SCP's authenticated
# reverse proxy — see Phase 3 in PLATFORM.SPEC.md §5).
#
# KasmVNC >= 1.3.x requires a password even in single-user mode.
# We generate a random one at runtime (never exposed to callers — SCP
# proxies the WebSocket directly and does not need the VNC password).
# The password file path is /run/kasm_passwd (tmpfs, root-only in prod).
# ---------------------------------------------------------------------------
KASM_PASSWD_FILE="/tmp/kasm_passwd_${$}"
KASM_PASSWD="$(openssl rand -hex 16)"
printf '%s\n%s\n' "${KASM_PASSWD}" "${KASM_PASSWD}" > "${KASM_PASSWD_FILE}"
chmod 0600 "${KASM_PASSWD_FILE}"

log "Starting KasmVNC on port 6901 (password written to ${KASM_PASSWD_FILE})"

# kasmvncserver expects the password file to be readable by the invoking user.
# -noxstartup suppresses the default Xsession script (we manage openbox above).
# -disableBasicAuth removes the HTTP Basic Auth layer; the WS port is still
# protected by whatever proxy SCP puts in front (Phase 3+).
kasmvncserver \
  -display :1 \
  -websocketPort 6901 \
  -interface 0.0.0.0 \
  -select-de manual \
  -noxstartup \
  -passwd "${KASM_PASSWD_FILE}" \
  2>&1 | while IFS= read -r line; do log "[kasmvnc] ${line}"; done &
_children+=("$!")

# Allow VNC server to initialise
sleep 2

# ---------------------------------------------------------------------------
# 5. Idle — SCP will `docker exec` synaps rpc into this container
# ---------------------------------------------------------------------------
log "Desktop stack ready. Idling. SCP will exec 'synaps rpc' on demand."
tail -f /dev/null &
_children+=("$!")

# Wait on all background jobs; this blocks until the trap fires
wait
