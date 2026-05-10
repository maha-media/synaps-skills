#!/usr/bin/env bash
# scripts/install-systemd.sh — idempotent systemd user-unit installer
#
# Usage:
#   bash scripts/install-systemd.sh [--enable] [--start] [--linger] [--dry-run] [--allow-root]
#
# Flags:
#   --enable      Run `systemctl --user enable synaps-bridge` after install.
#   --start       Run `systemctl --user start  synaps-bridge` after enable
#                 (implies --enable).
#   --linger      Run `loginctl enable-linger` so the bridge survives logout.
#   --dry-run     Skip actual systemctl/loginctl calls; still writes all files.
#                 Used by the test harness.
#   --allow-root  Suppress the root-user guard (for CI/test environments only).
#
# See README.md for full installation instructions.
# --------------------------------------------------------------------------

set -euo pipefail

# ─── flag parsing ─────────────────────────────────────────────────────────────

OPT_ENABLE=0
OPT_START=0
OPT_LINGER=0
OPT_DRY_RUN=0
OPT_ALLOW_ROOT=0

for arg in "$@"; do
  case "$arg" in
    --enable)     OPT_ENABLE=1 ;;
    --start)      OPT_START=1; OPT_ENABLE=1 ;;
    --linger)     OPT_LINGER=1 ;;
    --dry-run)    OPT_DRY_RUN=1 ;;
    --allow-root) OPT_ALLOW_ROOT=1 ;;
    *)
      echo "install-systemd.sh: unknown flag: $arg" >&2
      exit 1
      ;;
  esac
done

# ─── helpers ──────────────────────────────────────────────────────────────────

info()  { echo "[install-systemd] $*"; }
warn()  { echo "[install-systemd] WARNING: $*" >&2; }
die()   { echo "[install-systemd] ERROR: $*" >&2; exit 1; }

# ─── 1. detect environment ────────────────────────────────────────────────────

OS="$(uname -s 2>/dev/null || echo unknown)"

if [ "$OS" = "Darwin" ]; then
  die "macOS detected. systemd user units are a Linux-only feature. \
Use launchd on macOS (see README.md — deferred feature)."
fi

# Detect WSL: /proc/version contains 'microsoft' or 'WSL'
if [ -f /proc/version ] && grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
  die "WSL detected. systemd user-session support in WSL is limited. \
Enable systemd in WSL2 (/etc/wsl.conf: [boot] systemd=true) then re-run, \
or manage the bridge process manually (see README.md)."
fi

if [ "$OS" != "Linux" ]; then
  die "Unsupported OS: $OS. This installer is Linux-only."
fi

# Require systemd user instance
if ! systemctl --user --version >/dev/null 2>&1; then
  die "systemctl not found or systemd user instance not available. \
Ensure systemd ≥ 232 is running and DBUS_SESSION_BUS_ADDRESS is set."
fi

# Refuse root (unless --allow-root passed for CI)
if [ "$OPT_ALLOW_ROOT" -eq 0 ] && [ "$(id -u)" -eq 0 ]; then
  die "Do not run this installer as root. It installs a systemd *user* unit \
for the current user. Run as a normal user."
fi

# ─── 2. resolve paths ─────────────────────────────────────────────────────────

# PLUGIN_DIR: the repository root, one level above this script.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

[ -f "$PLUGIN_DIR/bin/synaps-bridge.js" ] || \
  die "bin/synaps-bridge.js not found under PLUGIN_DIR=$PLUGIN_DIR. \
Run this script from within the synaps-bridge-plugin checkout."

# NODE: must be ≥ 20
NODE="$(command -v node 2>/dev/null || true)"
[ -n "$NODE" ] || die "node not found on PATH. Install Node.js ≥ 20 first."

NODE_VERSION="$("$NODE" -v 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  die "Node.js ≥ 20 required; found v$NODE_VERSION. \
Install a newer Node.js version (e.g. via fnm or nvm) and re-run."
fi

STATE_DIR="$HOME/.synaps-cli/bridge"
CONFIG_PATH="$STATE_DIR/bridge.toml"
ENV_FILE="$HOME/.config/synaps/slack-bridge.env"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/synaps-bridge.service"
TEMPLATE_PATH="$PLUGIN_DIR/systemd/synaps-bridge.service"

info "PLUGIN_DIR  = $PLUGIN_DIR"
info "NODE        = $NODE  (v$NODE_VERSION)"
info "STATE_DIR   = $STATE_DIR"
info "CONFIG_PATH = $CONFIG_PATH"
info "ENV_FILE    = $ENV_FILE"
info "UNIT_PATH   = $UNIT_PATH"

# ─── create state dir ─────────────────────────────────────────────────────────

mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR"

# ─── 3. materialise bridge.toml ───────────────────────────────────────────────

if [ ! -f "$CONFIG_PATH" ]; then
  [ -f "$PLUGIN_DIR/config/bridge.toml.example" ] || \
    die "config/bridge.toml.example not found in $PLUGIN_DIR"
  cp "$PLUGIN_DIR/config/bridge.toml.example" "$CONFIG_PATH"
  chmod 0600 "$CONFIG_PATH"
  info "Installed default config at $CONFIG_PATH (edit before starting)"
else
  info "bridge.toml exists; not overwriting"
fi

# ─── 4. create env file scaffold ─────────────────────────────────────────────

if [ ! -f "$ENV_FILE" ]; then
  ENV_DIR="$(dirname "$ENV_FILE")"
  mkdir -p "$ENV_DIR"
  chmod 0700 "$ENV_DIR"
  cat > "$ENV_FILE" <<'EOF'
# synaps-bridge — Slack auth env file
# Fill in your tokens, then start the service.
# SECURITY: this file MUST be mode 0600.
SLACK_BOT_TOKEN=xoxb-REPLACE-ME
SLACK_APP_TOKEN=xapp-REPLACE-ME
EOF
  chmod 0600 "$ENV_FILE"
  info "Created env file scaffold at $ENV_FILE — fill in your Slack tokens"
else
  info "Env file exists; not overwriting: $ENV_FILE"
fi

# ─── 5. render unit file ──────────────────────────────────────────────────────

[ -f "$TEMPLATE_PATH" ] || \
  die "Unit template not found: $TEMPLATE_PATH"

mkdir -p "$UNIT_DIR"

# Escape slashes for sed replacement strings
_esc() { printf '%s' "$1" | sed 's/[\/&]/\\&/g'; }

NODE_ESC="$(_esc "$NODE")"
PLUGIN_DIR_ESC="$(_esc "$PLUGIN_DIR")"
CONFIG_PATH_ESC="$(_esc "$CONFIG_PATH")"
ENV_FILE_ESC="$(_esc "$ENV_FILE")"

sed \
  -e "s/__NODE__/${NODE_ESC}/g" \
  -e "s/__PLUGIN_DIR__/${PLUGIN_DIR_ESC}/g" \
  -e "s/__CONFIG_PATH__/${CONFIG_PATH_ESC}/g" \
  -e "s/__ENV_FILE__/${ENV_FILE_ESC}/g" \
  "$TEMPLATE_PATH" > "$UNIT_PATH"

info "Rendered unit file → $UNIT_PATH"

# Verify no placeholders remain (skip comment lines)
if grep -v '^[[:space:]]*#' "$UNIT_PATH" | grep -q '__[A-Z_]*__' 2>/dev/null; then
  LEFTOVERS="$(grep -v '^[[:space:]]*#' "$UNIT_PATH" | grep -o '__[A-Z_]*__' | sort -u | tr '\n' ' ')"
  die "BUG: unresolved placeholders in rendered unit: $LEFTOVERS"
fi

# ─── 6. reload + enable + start ──────────────────────────────────────────────

if [ "$OPT_DRY_RUN" -eq 1 ]; then
  info "[dry-run] Would run: systemctl --user daemon-reload"
  [ "$OPT_ENABLE" -eq 1 ] && info "[dry-run] Would run: systemctl --user enable synaps-bridge"
  [ "$OPT_START"  -eq 1 ] && info "[dry-run] Would run: systemctl --user start  synaps-bridge"
else
  info "Running: systemctl --user daemon-reload"
  systemctl --user daemon-reload

  if [ "$OPT_ENABLE" -eq 1 ]; then
    info "Running: systemctl --user enable synaps-bridge"
    systemctl --user enable synaps-bridge
  fi

  if [ "$OPT_START" -eq 1 ]; then
    info "Running: systemctl --user start synaps-bridge"
    systemctl --user start synaps-bridge
  fi
fi

# ─── 7. linger ────────────────────────────────────────────────────────────────

if [ "$OPT_LINGER" -eq 1 ]; then
  if [ "$OPT_DRY_RUN" -eq 1 ]; then
    info "[dry-run] Would run: loginctl enable-linger $USER"
  else
    info "Running: loginctl enable-linger $USER"
    loginctl enable-linger "$USER"
    info "Linger enabled — bridge will start at boot without an active login session."
  fi
else
  warn "Linger not enabled. The bridge will stop when you log out. \
Pass --linger to persist across sessions, or run: loginctl enable-linger \$USER"
fi

# ─── next steps ───────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  synaps-bridge systemd unit installed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Edit your Slack tokens:"
echo "       \$EDITOR $ENV_FILE"
echo ""
echo "  2. (Optional) Edit bridge config:"
echo "       \$EDITOR $CONFIG_PATH"
echo ""
echo "  3. Start the service:"
echo "       systemctl --user start synaps-bridge"
echo ""
echo "  4. Follow logs:"
echo "       journalctl --user -u synaps-bridge -f"
echo ""
echo "  5. Check status:"
echo "       synaps bridge status"
echo ""
echo "  To run at boot without login:"
echo "       loginctl enable-linger \$USER"
echo ""
