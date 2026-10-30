#!/usr/bin/env bash
# Offline unit tests for the social-web plugin (no network).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
python3 -c 'import ast,sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]' scripts/socialweb scripts/shared-browser-preflight
export PYTHONDONTWRITEBYTECODE=1
python3 -m unittest discover -s tests "$@"
