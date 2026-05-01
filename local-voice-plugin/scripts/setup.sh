#!/usr/bin/env bash
set -euo pipefail

plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary_name="synaps-voice-plugin"
features="local-stt"
model_name=""

usage() {
  cat <<USAGE
Usage: $0 [--features FEATURES] [--model base.en]

Builds the Synaps local voice sidecar and installs it to:
  $plugin_dir/bin/$binary_name

Options:
  --features FEATURES  Cargo features to build (default: local-stt)
  --model base.en      Validate expected Whisper model path and print download guidance
  -h, --help           Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --features)
      features="${2:-}"
      [[ -n "$features" ]] || { echo "error: --features requires a value" >&2; exit 2; }
      shift 2
      ;;
    --model)
      model_name="${2:-}"
      [[ -n "$model_name" ]] || { echo "error: --model requires a value" >&2; exit 2; }
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v cargo >/dev/null 2>&1; then
  cat >&2 <<'ERR'
error: Rust/Cargo is required to build local voice.
Install Rust from https://rustup.rs/, then rerun this script.
ERR
  exit 1
fi

case "$(uname -s)" in
  Linux)
    echo "Detected Linux. If build fails for native audio/Whisper deps, install packages such as: build-essential pkg-config clang cmake libasound2-dev"
    ;;
  Darwin)
    echo "Detected macOS. Xcode command line tools are required. Optional Metal acceleration can be built with --features local-stt,metal."
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    echo "Detected Windows. Ensure Rust MSVC toolchain and required native build tools are installed."
    ;;
  *)
    echo "Detected unsupported/untested platform: $(uname -s). Continuing with source build."
    ;;
esac

cd "$plugin_dir"
echo "Building $binary_name with features: $features"
cargo build --release --features "$features"

mkdir -p "$plugin_dir/bin"
install_tmp="$plugin_dir/bin/.$binary_name.$$"
cp "$plugin_dir/target/release/$binary_name" "$install_tmp"
chmod +x "$install_tmp"
mv -f "$install_tmp" "$plugin_dir/bin/$binary_name"

model_path="\${HOME}/.synaps-cli/models/whisper/ggml-base.en.bin"
if [[ -n "$model_name" ]]; then
  case "$model_name" in
    base.en) model_path="\${HOME}/.synaps-cli/models/whisper/ggml-base.en.bin" ;;
    *) echo "warning: unknown model '$model_name'; using default config path $model_path" >&2 ;;
  esac
  expanded_model_path="${model_path/\$\{HOME\}/$HOME}"
  if [[ ! -f "$expanded_model_path" ]]; then
    cat <<MODEL

Whisper model not found at:
  $expanded_model_path

Download a GGML Whisper model before real mic transcription, for example:
  mkdir -p "$(dirname "$expanded_model_path")"
  curl -L -o "$expanded_model_path" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
MODEL
  fi
fi

cat <<CONFIG

Installed local voice sidecar:
  $plugin_dir/bin/$binary_name

Add/update Synaps config:

voice.enabled = true
voice.provider = sidecar
voice.sidecar.command = $plugin_dir/bin/$binary_name
voice.stt_model_path = $model_path

Then enable the local-voice plugin in Synaps if plugin enablement is available.
CONFIG
