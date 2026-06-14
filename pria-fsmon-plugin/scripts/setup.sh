#!/usr/bin/env bash
# scripts/setup.sh — build/verify the synaps_fsmon file-write monitor binary.
#
# This daemon is a SIBLING DAEMON (HS-5): it is built here and launched by the
# Pria guest agent / systemd, NOT spawned by SynapsCLI as an extension/sidecar.
#
# Usage:
#   ./scripts/setup.sh             # cargo release build
#   ./scripts/setup.sh --debug     # cargo debug build
#   ./scripts/setup.sh --check     # verify the binary exists and runs
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CRATE_DIR="$PLUGIN_DIR/extensions/synaps-fsmon"
PROFILE="release"
CHECK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug) PROFILE="debug" ;;
    --release) PROFILE="release" ;;
    --check) CHECK=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "setup.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

bin_path() {
  echo "$CRATE_DIR/target/$PROFILE/synaps_fsmon"
}

if [[ "$CHECK" == "1" ]]; then
  BIN="$(bin_path)"
  if [[ ! -x "$BIN" ]]; then
    echo "setup.sh: missing binary: $BIN (run setup.sh first)" >&2
    exit 1
  fi
  "$BIN" version
  "$BIN" check
  exit $?
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "setup.sh: cargo not found — install Rust from https://rustup.rs" >&2
  exit 1
fi

echo "→ synaps_fsmon: building ($PROFILE) in $CRATE_DIR"
cd "$CRATE_DIR"
if [[ "$PROFILE" == "release" ]]; then
  cargo build --release
else
  cargo build
fi

BIN="$(bin_path)"
echo "✓ synaps_fsmon built: $BIN ($(du -h "$BIN" | cut -f1))"
"$BIN" version
