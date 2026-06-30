#!/usr/bin/env bash
# scripts/setup.sh — build/verify the finlens Python venv.
#
# finlens is a Python-based Synaps extension (synaps-extension/main.py)
# launched via the venv python. This script builds .venv inside the plugin
# dir and installs deps from requirements.txt. With --check it verifies the
# venv and runs pytest.
#
# Usage:
#   ./scripts/setup.sh             # create .venv and install requirements.txt
#   ./scripts/setup.sh --check     # verify .venv/bin/python exists + run tests
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$PLUGIN_DIR/.venv"
PY="$VENV_DIR/bin/python"
CHECK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK=1 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "setup.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ "$CHECK" == "1" ]]; then
  if [[ ! -x "$PY" ]]; then
    echo "setup.sh: missing venv python: $PY (run setup.sh first)" >&2
    exit 1
  fi
  cd "$PLUGIN_DIR"
  "$PY" -m pytest -q
  exit $?
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "setup.sh: python3 not found" >&2
  exit 1
fi

echo "→ finlens: creating venv at $VENV_DIR"
python3 -m venv "$VENV_DIR"

echo "→ finlens: installing requirements"
"$VENV_DIR/bin/pip" install --upgrade pip >/dev/null
"$VENV_DIR/bin/pip" install -r "$PLUGIN_DIR/requirements.txt"

echo "✓ finlens venv ready: $PY"
