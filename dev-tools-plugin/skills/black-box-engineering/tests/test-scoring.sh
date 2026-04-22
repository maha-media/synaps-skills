#!/usr/bin/env bash
# tests/test-scoring.sh — verify quality scoring utilities
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPT_DIR/scripts/common.sh"
source "$SCRIPT_DIR/scripts/score-utils.sh"
PASS=0; FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  ✅ $label"; PASS=$((PASS + 1))
  else
    echo "  ❌ $label (expected '$expected', got '$actual')"; FAIL=$((FAIL + 1))
  fi
}

WORK_DIR="/tmp/bbe-test-scoring-$$"
mkdir -p "$WORK_DIR/scores" "$WORK_DIR/evolution" "$WORK_DIR/verdicts"
trap "rm -rf $WORK_DIR" EXIT

# ─── extract_verdict tests ───────────────────────────────────

echo "--- extract_verdict ---"

# PROCEED: overall >= 0.8
cat > "$WORK_DIR/verdict-pass.json" << 'EOF'
{"outcome":"pass","overall":0.85,"verdict":"PROCEED","summary":"good","dimensions":{"spec_compliance":0.9,"code_quality":0.8,"test_coverage":0.8,"edge_cases":0.85,"security":0.9}}
EOF
RESULT=$(extract_verdict "$WORK_DIR/verdict-pass.json" "0.8")
assert_eq "0.85 → PROCEED" "PROCEED" "$RESULT"

# REVIEW: overall 0.7-0.79
cat > "$WORK_DIR/verdict-review.json" << 'EOF'
{"outcome":"fail","overall":0.75,"verdict":"REVIEW","summary":"ok","dimensions":{"spec_compliance":0.8,"code_quality":0.7,"test_coverage":0.7,"edge_cases":0.7,"security":0.8}}
EOF
RESULT=$(extract_verdict "$WORK_DIR/verdict-review.json" "0.8")
assert_eq "0.75 → REVIEW" "REVIEW" "$RESULT"

# REWORK: overall < 0.7
cat > "$WORK_DIR/verdict-rework.json" << 'EOF'
{"outcome":"fail","overall":0.55,"verdict":"REWORK","summary":"bad","dimensions":{"spec_compliance":0.6,"code_quality":0.5,"test_coverage":0.4,"edge_cases":0.5,"security":0.6}}
EOF
RESULT=$(extract_verdict "$WORK_DIR/verdict-rework.json" "0.8")
assert_eq "0.55 → REWORK" "REWORK" "$RESULT"

# ─── extract_overall tests ───────────────────────────────────

echo "--- extract_overall ---"

RESULT=$(extract_overall "$WORK_DIR/verdict-pass.json")
assert_eq "extract overall from pass verdict" "0.85" "$RESULT"

# Backwards compat: satisfaction field
cat > "$WORK_DIR/verdict-compat.json" << 'EOF'
{"outcome":"pass","satisfaction":0.92,"summary":"great","areas":[]}
EOF
RESULT=$(extract_overall "$WORK_DIR/verdict-compat.json")
assert_eq "extract from satisfaction (compat)" "0.92" "$RESULT"

# ─── log_score_history tests ─────────────────────────────────

echo "--- log_score_history ---"

log_score_history "$WORK_DIR/scores" "1" "$WORK_DIR/verdict-pass.json"
assert_eq "history.json created" "true" "$([[ -f "$WORK_DIR/scores/history.json" ]] && echo true || echo false)"

ENTRY_COUNT=$(python3 -c "import json; print(len(json.load(open('$WORK_DIR/scores/history.json'))['scores']))")
assert_eq "1 score entry after first log" "1" "$ENTRY_COUNT"

log_score_history "$WORK_DIR/scores" "2" "$WORK_DIR/verdict-rework.json"
ENTRY_COUNT=$(python3 -c "import json; print(len(json.load(open('$WORK_DIR/scores/history.json'))['scores']))")
assert_eq "2 score entries after second log" "2" "$ENTRY_COUNT"

# ─── log_evolution tests ─────────────────────────────────────

echo "--- log_evolution ---"

# Create a mock pipeline meta
cat > "$WORK_DIR/pipeline-meta.json" << 'EOF'
{"feature":"test-feature","tier":"medium","holdout_mode":true,"total_calls":5,"distribution":{"SAGE":1,"BUILD":2,"VERIFY":2},"budget_remaining":5}
EOF

log_evolution "$WORK_DIR/evolution" "$WORK_DIR/pipeline-meta.json" "$WORK_DIR/verdict-rework.json" "$WORK_DIR/scores/history.json"
assert_eq "run-summary.json created" "true" "$([[ -f "$WORK_DIR/evolution/run-summary.json" ]] && echo true || echo false)"

RUN_COUNT=$(python3 -c "import json; print(len(json.load(open('$WORK_DIR/evolution/run-summary.json'))['runs']))")
assert_eq "1 run in evolution" "1" "$RUN_COUNT"

MODE=$(python3 -c "import json; print(json.load(open('$WORK_DIR/evolution/run-summary.json'))['runs'][0]['mode'])")
assert_eq "mode is holdout" "holdout" "$MODE"

WEAK=$(python3 -c "import json; print(len(json.load(open('$WORK_DIR/evolution/run-summary.json'))['runs'][0]['weak_dimensions']))")
assert_eq "has weak dimensions" "true" "$([[ "$WEAK" -ge 1 ]] && echo true || echo false)"

# ─── generate_escalation tests ───────────────────────────────

echo "--- generate_escalation ---"

# Copy verdict files into a convergence-like structure
mkdir -p "$WORK_DIR/conv/verdicts"
cp "$WORK_DIR/verdict-rework.json" "$WORK_DIR/conv/verdicts/verdict-1.json"
cp "$WORK_DIR/verdict-review.json" "$WORK_DIR/conv/verdicts/verdict-2.json"
cp "$WORK_DIR/pipeline-meta.json" "$WORK_DIR/conv/pipeline-meta.json"

generate_escalation "$WORK_DIR/conv" "$WORK_DIR/conv/escalation.md"
assert_eq "escalation report created" "true" "$([[ -f "$WORK_DIR/conv/escalation.md" ]] && echo true || echo false)"

# Check report contains score history table
grep -q "Score History" "$WORK_DIR/conv/escalation.md"
assert_eq "escalation has score history" "0" "$?"

grep -q "Call Distribution" "$WORK_DIR/conv/escalation.md"
assert_eq "escalation has call distribution" "0" "$?"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
