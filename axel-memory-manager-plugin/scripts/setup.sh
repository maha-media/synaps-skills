#!/usr/bin/env bash
# scripts/setup.sh — build the axel-memory-manager Rust extension binary.
#
# Run once after installing the plugin (or after every plugin update). Synaps
# pulls source via git and ignores `target/`, so the binary has to be built
# locally.
#
# Usage:
#   ./scripts/setup.sh           # release build (default — what plugin.json points at)
#   ./scripts/setup.sh --debug   # debug build (faster compile, slower runtime)
#   ./scripts/setup.sh --check   # cargo check only (no binary)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT_DIR="$PLUGIN_DIR/extensions/memory-manager"
PROFILE="release"
CHECK=0

for arg in "$@"; do
  case "$arg" in
    --debug)   PROFILE="debug" ;;
    --release) PROFILE="release" ;;
    --check)   CHECK=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *)
      echo "setup.sh: unknown arg: $arg" >&2
      exit 2 ;;
  esac
done

if ! command -v cargo >/dev/null 2>&1; then
  echo "setup.sh: cargo not found — install Rust toolchain first (https://rustup.rs)" >&2
  exit 1
fi

echo "→ axel-memory-manager: building extension ($PROFILE) in $EXT_DIR"
cd "$EXT_DIR"

if [[ "$CHECK" == "1" ]]; then
  cargo check
  echo "✓ cargo check passed"
  exit 0
fi

if [[ "$PROFILE" == "release" ]]; then
  cargo build --release
  BIN="$EXT_DIR/target/release/memory-manager"
else
  cargo build
  BIN="$EXT_DIR/target/debug/memory-manager"
fi

if [[ ! -x "$BIN" ]]; then
  echo "setup.sh: expected binary not found at $BIN" >&2
  exit 1
fi

echo "✓ built: $BIN ($(du -h "$BIN" | cut -f1))"
echo
echo "Plugin manifest expects the release binary at:"
echo "  extensions/memory-manager/target/release/memory-manager"
echo
if [[ "$PROFILE" == "debug" ]]; then
  echo "⚠ You built --debug. Synaps will look for the release binary."
  echo "  Either re-run without --debug or update plugin.json's extension.command."
fi
