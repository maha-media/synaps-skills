#!/usr/bin/env bash
# scripts/uninstall-systemd.sh — remove the synaps-bridge systemd user unit
#
# Stops and disables the unit, removes the unit file, reloads the daemon.
# Does NOT delete bridge.toml, slack-bridge.env, or any session data.
#
# Usage:
#   bash scripts/uninstall-systemd.sh [--dry-run]
#
# See README.md for full documentation.
# --------------------------------------------------------------------------

set -euo pipefail

OPT_DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) OPT_DRY_RUN=1 ;;
    *)
      echo "uninstall-systemd.sh: unknown flag: $arg" >&2
      exit 1
      ;;
  esac
done

info() { echo "[uninstall-systemd] $*"; }
die()  { echo "[uninstall-systemd] ERROR: $*" >&2; exit 1; }

# ─── platform guards ──────────────────────────────────────────────────────────

OS="$(uname -s 2>/dev/null || echo unknown)"
[ "$OS" = "Linux" ] || die "This uninstaller is Linux-only (detected: $OS)."

systemctl --user --version >/dev/null 2>&1 || \
  die "systemctl not found or systemd user instance not available."

[ "$(id -u)" -ne 0 ] || \
  die "Do not run as root. The unit is a user-level unit."

# ─── locate unit ──────────────────────────────────────────────────────────────

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/synaps-bridge.service"

CONFIG_PATH="$HOME/.synaps-cli/bridge/bridge.toml"
ENV_FILE="$HOME/.config/synaps/slack-bridge.env"
STATE_DIR="$HOME/.synaps-cli/bridge"

# ─── stop & disable ───────────────────────────────────────────────────────────

_run() {
  if [ "$OPT_DRY_RUN" -eq 1 ]; then
    info "[dry-run] Would run: $*"
  else
    info "Running: $*"
    "$@"
  fi
}

# Stop if running (ignore errors — may not be active)
if systemctl --user is-active --quiet synaps-bridge 2>/dev/null; then
  _run systemctl --user stop synaps-bridge
else
  info "Unit synaps-bridge is not currently active — nothing to stop."
fi

# Disable if enabled (ignore errors — may not be enabled)
if systemctl --user is-enabled --quiet synaps-bridge 2>/dev/null; then
  _run systemctl --user disable synaps-bridge
else
  info "Unit synaps-bridge is not enabled — skipping disable."
fi

# ─── remove unit file ─────────────────────────────────────────────────────────

if [ -f "$UNIT_PATH" ]; then
  if [ "$OPT_DRY_RUN" -eq 1 ]; then
    info "[dry-run] Would remove: $UNIT_PATH"
  else
    rm -f "$UNIT_PATH"
    info "Removed unit file: $UNIT_PATH"
  fi
else
  info "Unit file not found (already removed?): $UNIT_PATH"
fi

# ─── daemon-reload ────────────────────────────────────────────────────────────

_run systemctl --user daemon-reload

# ─── summary ──────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  synaps-bridge systemd unit removed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  The following files were intentionally kept:"
echo ""
echo "    Bridge config : $CONFIG_PATH"
echo "    Slack env file: $ENV_FILE"
echo "    Session data  : $STATE_DIR"
echo ""
echo "  To remove them manually:"
echo "    rm -f  $CONFIG_PATH"
echo "    rm -f  $ENV_FILE"
echo "    rm -rf $STATE_DIR"
echo ""
echo "  To also disable linger (if you enabled it):"
echo "    loginctl disable-linger \$USER"
echo ""
