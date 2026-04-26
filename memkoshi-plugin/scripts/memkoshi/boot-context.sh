#!/usr/bin/env bash
# Print a boot-context block suitable for `synaps -s <(boot-context.sh)` injection.
# Falls back gracefully if memkoshi isn't installed yet.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v memkoshi >/dev/null 2>&1; then
    cat <<EOF
# Memory boot context

(memkoshi not installed — run the plugin's setup script:
  bash $SCRIPT_DIR/setup.sh

 This will install memkoshi + stelline via pipx and run \`memkoshi init\`.
 Pass \`--no-stelline\` to skip the optional richer write path.)
EOF
    exit 0
fi

BUDGET="${1:-2048}"

echo "# Memory boot context"
echo
echo "You have persistent memory via the \`memkoshi\` CLI. Recall before answering"
echo "questions about prior work; commit new decisions; review staged memories."
echo "Load the \`memkoshi\` skill for full workflow."
echo
echo '```'
memkoshi context boot --budget "$BUDGET" 2>/dev/null || memkoshi boot 2>/dev/null
echo '```'
