#!/usr/bin/env bash
# scaffold.sh — Create the .convergence working directory
# Usage: scaffold.sh <project-root> [--holdout]
set -euo pipefail

ROOT="${1:?Usage: scaffold.sh <project-root> [--holdout]}"
HOLDOUT=0
[[ "${2:-}" == "--holdout" ]] && HOLDOUT=1

mkdir -p "$ROOT/.convergence/scenarios"
mkdir -p "$ROOT/.convergence/reports"
mkdir -p "$ROOT/.convergence/verdicts"
mkdir -p "$ROOT/.convergence/prompts"
mkdir -p "$ROOT/.convergence/scores"
mkdir -p "$ROOT/.convergence/evolution"

echo '*' > "$ROOT/.convergence/.gitignore"

python3 -c "
import json, sys
from datetime import datetime, timezone
meta = {
    'created': datetime.now(timezone.utc).isoformat(),
    'holdout_mode': bool(int(sys.argv[1])),
    'tier': 'unknown',
    'feature': '',
    'total_calls': 0,
    'distribution': {},
    'budget_remaining': 10,
    'status': 'idle',
    'phase': ''
}
with open(sys.argv[2] + '/.convergence/pipeline-meta.json', 'w') as f:
    json.dump(meta, f, indent=2)
" "$HOLDOUT" "$ROOT"

echo "OK: .convergence/ scaffolded at $ROOT (holdout=$HOLDOUT)"
