#!/usr/bin/env bash
set -euo pipefail
VM=${1:?usage: health-check.sh VM}
python3 "$(dirname "$0")/../scripts/vmctl.py" status "$VM"
