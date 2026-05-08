#!/usr/bin/env bash
# scripts/setup.sh — install the axel-memory-manager extension binary.
#
# Default behavior downloads a prebuilt binary from the latest synaps-skills
# GitHub release. If no matching binary is available and Cargo is installed, it
# falls back to a local release build.
#
# Usage:
#   ./scripts/setup.sh                 # install prebuilt binary, fallback to Cargo
#   ./scripts/setup.sh --from-source   # force local Cargo release build
#   ./scripts/setup.sh --debug         # local Cargo debug build
#   ./scripts/setup.sh --check         # verify the manifest binary exists and runs
#   ./scripts/setup.sh --version TAG   # download from a specific release tag
#   ./scripts/setup.sh --update        # re-download latest prebuilt, fallback to Cargo
#   ./scripts/setup.sh --update --version TAG  # re-download a pinned release tag

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT_DIR="$PLUGIN_DIR/extensions/memory-manager"
BIN="$EXT_DIR/target/release/memory-manager"
REPO="maha-media/synaps-skills"
VERSION="latest"
PROFILE="release"
CHECK=0
FROM_SOURCE=0
UPDATE=0

while [[ $# -gt 0 ]]; do
  arg="$1"
  case "$arg" in
    --debug)       PROFILE="debug"; FROM_SOURCE=1 ;;
    --release)     PROFILE="release" ;;
    --from-source) FROM_SOURCE=1 ;;
    --check)       CHECK=1 ;;
    --update)      UPDATE=1 ;;
    --version=*)   VERSION="${arg#--version=}" ;;
    --version)
      if [[ $# -lt 2 ]]; then
        echo "setup.sh: --version requires a tag" >&2
        exit 2
      fi
      VERSION="$2"
      shift ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *)
      echo "setup.sh: unknown arg: $arg" >&2
      exit 2 ;;
  esac
  shift
done

platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    linux*)  os="linux" ;;
    darwin*) os="macos" ;;
    msys*|mingw*|cygwin*) os="windows" ;;
    *) echo "unsupported-os-$os"; return 1 ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *) echo "unsupported-arch-$arch"; return 1 ;;
  esac

  echo "$os-$arch"
}

check_binary() {
  if [[ ! -x "$BIN" ]]; then
    echo "setup.sh: missing executable: $BIN" >&2
    return 1
  fi
  echo "✓ axel-memory-manager binary installed: $BIN ($(du -h "$BIN" | cut -f1))"
}

cargo_build() {
  if ! command -v cargo >/dev/null 2>&1; then
    echo "setup.sh: cargo not found and prebuilt install did not succeed" >&2
    echo "setup.sh: install Rust from https://rustup.rs or use a platform with a published prebuilt binary" >&2
    return 1
  fi

  echo "→ axel-memory-manager: building extension ($PROFILE) in $EXT_DIR"
  cd "$EXT_DIR"

  if [[ "$PROFILE" == "release" ]]; then
    cargo build --release
    BIN="$EXT_DIR/target/release/memory-manager"
  else
    cargo build
    BIN="$EXT_DIR/target/debug/memory-manager"
  fi

  check_binary
  echo
  echo "Plugin manifest expects the release binary at:"
  echo "  extensions/memory-manager/target/release/memory-manager"
  if [[ "$PROFILE" == "debug" ]]; then
    echo "⚠ You built --debug. Synaps will look for the release binary."
    echo "  Either re-run without --debug or update plugin.json's extension.command."
  fi
}

download() {
  local url out
  url="$1"
  out="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 15 -o "$out" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$out" "$url"
  else
    echo "setup.sh: need curl or wget to download prebuilt binary" >&2
    return 1
  fi
}

install_prebuilt() {
  local plat asset base_url url tmp
  plat="$(platform)" || return 1
  asset="memory-manager-$plat"
  if [[ "$plat" == windows-* ]]; then
    asset="$asset.exe"
  fi

  if [[ "$VERSION" == "latest" ]]; then
    base_url="https://github.com/$REPO/releases/latest/download"
  else
    base_url="https://github.com/$REPO/releases/download/$VERSION"
  fi
  url="$base_url/$asset"

  echo "→ axel-memory-manager: downloading prebuilt binary ($asset)"
  mkdir -p "$(dirname "$BIN")"
  tmp="$(mktemp "$BIN.download.XXXXXX")"
  if download "$url" "$tmp"; then
    mv "$tmp" "$BIN"
    chmod 0755 "$BIN"
    check_binary
    return 0
  fi
  rm -f "$tmp"
  return 1
}

if [[ "$CHECK" == "1" ]]; then
  check_binary
  exit $?
fi

if [[ "${UPDATE:-0}" == "1" ]]; then
  echo "→ axel-memory-manager: checking for newer prebuilt binary"
  if install_prebuilt; then
    exit 0
  fi
  echo "⚠ no newer prebuilt available; falling back to local Cargo build" >&2
  cargo_build
  exit $?
fi

if [[ "$FROM_SOURCE" == "1" ]]; then
  cargo_build
  exit $?
fi

if install_prebuilt; then
  exit 0
fi

echo "⚠ prebuilt binary unavailable for $(platform 2>/dev/null || echo unknown); falling back to local Cargo build" >&2
cargo_build
