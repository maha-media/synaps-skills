#!/usr/bin/env bash
# tests/test-integration.sh — Smoke tests and optional real end-to-end test
#
# Default mode (no env vars): static smoke tests only — no API calls, no cost.
#
#   Static checks (always run):
#     - synaps CLI is available in PATH
#     - All five agent .md files exist
#     - run-pipeline.sh is executable and --help exits 0
#     - scaffold.sh creates the correct .convergence/ directory tree
#     - pipeline-meta.json contains expected keys
#
#   Real pipeline test (opt-in):
#     Set BBE_INTEGRATION_TEST=1 to run a real synaps call with a toy project.
#     Requires: synaps CLI configured with a valid provider + API key.
#     Cost: a few hundred tokens (uses smallest models via --agent sonnet).
#
# Usage:
#   bash tests/test-integration.sh                   # smoke tests only
#   BBE_INTEGRATION_TEST=1 bash tests/test-integration.sh   # + real API call
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPT_DIR/scripts/common.sh"

PASS=0; FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  ✅ $label"; PASS=$((PASS + 1))
  else
    echo "  ❌ $label (expected '$expected', got '$actual')"; FAIL=$((FAIL + 1))
  fi
}

assert_contains_key() {
  # Assert a JSON file contains a given top-level key
  local label="$1" key="$2" file="$3"
  local result
  result=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('true' if sys.argv[2] in d else 'false')" "$file" "$key" 2>/dev/null || echo false)
  assert_eq "$label" "true" "$result"
}

WORK_DIR="/tmp/bbe-integration-$$"
mkdir -p "$WORK_DIR"
trap "rm -rf $WORK_DIR" EXIT

# ─────────────────────────────────────────────────────────────
# SECTION 1: Synaps CLI availability
# ─────────────────────────────────────────────────────────────

echo "=== 1. synaps CLI ==="

if command -v synaps &>/dev/null; then
  assert_eq "synaps CLI is in PATH" "true" "true"
else
  echo "  ⚠️  synaps CLI not found — some tests will be skipped"
  assert_eq "synaps CLI is in PATH" "true" "false"
fi

# ─────────────────────────────────────────────────────────────
# SECTION 2: Agent .md files
# ─────────────────────────────────────────────────────────────

echo ""
echo "=== 2. Agent files ==="

AGENTS=(orchestrator sage quinn glitch arbiter)
for agent in "${AGENTS[@]}"; do
  AGENT_FILE="$SCRIPT_DIR/agents/$agent.md"
  assert_eq "agents/$agent.md exists" \
    "true" "$([[ -f "$AGENT_FILE" ]] && echo true || echo false)"
done

# Each agent file must have a non-empty frontmatter name field
for agent in "${AGENTS[@]}"; do
  AGENT_FILE="$SCRIPT_DIR/agents/$agent.md"
  if [[ -f "$AGENT_FILE" ]]; then
    NAME_VAL=$(grep "^name:" "$AGENT_FILE" | head -1 | sed 's/^name:[[:space:]]*//')
    assert_eq "agents/$agent.md has a non-empty name" \
      "true" "$([[ -n "$NAME_VAL" ]] && echo true || echo false)"
  fi
done

# Each agent file must have a non-empty frontmatter description field
for agent in "${AGENTS[@]}"; do
  AGENT_FILE="$SCRIPT_DIR/agents/$agent.md"
  if [[ -f "$AGENT_FILE" ]]; then
    DESC_VAL=$(grep "^description:" "$AGENT_FILE" | head -1 | sed 's/^description:[[:space:]]*//')
    assert_eq "agents/$agent.md has a non-empty description" \
      "true" "$([[ -n "$DESC_VAL" ]] && echo true || echo false)"
  fi
done

# ─────────────────────────────────────────────────────────────
# SECTION 3: run-pipeline.sh
# ─────────────────────────────────────────────────────────────

echo ""
echo "=== 3. run-pipeline.sh ==="

PIPELINE="$SCRIPT_DIR/run-pipeline.sh"

assert_eq "run-pipeline.sh exists" \
  "true" "$([[ -f "$PIPELINE" ]] && echo true || echo false)"

assert_eq "run-pipeline.sh is executable" \
  "true" "$([[ -x "$PIPELINE" ]] && echo true || echo false)"

# --help must exit 0 and print usage
set +e
HELP_OUTPUT=$(bash "$PIPELINE" --help 2>&1)
HELP_EXIT=$?
set -e
assert_eq "--help exits with code 0" "0" "$HELP_EXIT"
assert_eq "--help output mentions 'plan-file'" \
  "true" "$([[ "$HELP_OUTPUT" == *"plan-file"* ]] && echo true || echo false)"
assert_eq "--help output mentions '--holdout'" \
  "true" "$([[ "$HELP_OUTPUT" == *"--holdout"* ]] && echo true || echo false)"
assert_eq "--help output mentions '--threshold'" \
  "true" "$([[ "$HELP_OUTPUT" == *"--threshold"* ]] && echo true || echo false)"
assert_eq "--help output mentions '--max-fixes'" \
  "true" "$([[ "$HELP_OUTPUT" == *"--max-fixes"* ]] && echo true || echo false)"
assert_eq "--help output mentions '--agent'" \
  "true" "$([[ "$HELP_OUTPUT" == *"--agent"* ]] && echo true || echo false)"

# Missing required args must exit non-zero (set up a synaps stub so it doesn't
# fail on the synaps check before reaching the arg validation)
STUB_BIN="$WORK_DIR/stub-bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/synaps" << 'STUB'
#!/usr/bin/env bash
echo "stub synaps"
STUB
chmod +x "$STUB_BIN/synaps"

set +e
MISSING_ARG_EXIT=$(PATH="$STUB_BIN:$PATH" bash "$PIPELINE" 2>/dev/null; echo $?)
set -e
assert_eq "run-pipeline.sh exits non-zero when plan+design missing" \
  "true" "$([[ "$MISSING_ARG_EXIT" -ne 0 ]] && echo true || echo false)"

# Only plan file given (design still missing)
touch "$WORK_DIR/dummy-plan.md"
set +e
ONE_ARG_EXIT=$(PATH="$STUB_BIN:$PATH" bash "$PIPELINE" "$WORK_DIR/dummy-plan.md" 2>/dev/null; echo $?)
set -e
assert_eq "run-pipeline.sh exits non-zero when design file missing" \
  "true" "$([[ "$ONE_ARG_EXIT" -ne 0 ]] && echo true || echo false)"

# ─────────────────────────────────────────────────────────────
# SECTION 4: scaffold.sh
# ─────────────────────────────────────────────────────────────

echo ""
echo "=== 4. scaffold.sh ==="

SCAFFOLD="$SCRIPT_DIR/scaffold.sh"

assert_eq "scaffold.sh exists" \
  "true" "$([[ -f "$SCAFFOLD" ]] && echo true || echo false)"

assert_eq "scaffold.sh is executable" \
  "true" "$([[ -x "$SCAFFOLD" ]] && echo true || echo false)"

# Run scaffold in a temp directory — informed mode (no --holdout)
SCAFFOLD_ROOT="$WORK_DIR/scaffold-informed"
mkdir -p "$SCAFFOLD_ROOT"
bash "$SCAFFOLD" "$SCAFFOLD_ROOT"

EXPECTED_DIRS=(
  ".convergence/scenarios"
  ".convergence/reports"
  ".convergence/verdicts"
  ".convergence/prompts"
  ".convergence/scores"
  ".convergence/evolution"
)

for dir in "${EXPECTED_DIRS[@]}"; do
  assert_eq "scaffold creates $dir" \
    "true" "$([[ -d "$SCAFFOLD_ROOT/$dir" ]] && echo true || echo false)"
done

assert_eq "scaffold creates .convergence/.gitignore" \
  "true" "$([[ -f "$SCAFFOLD_ROOT/.convergence/.gitignore" ]] && echo true || echo false)"

GITIGNORE_CONTENT=$(cat "$SCAFFOLD_ROOT/.convergence/.gitignore")
assert_eq ".gitignore content is '*'" "*" "$GITIGNORE_CONTENT"

assert_eq "scaffold creates pipeline-meta.json" \
  "true" "$([[ -f "$SCAFFOLD_ROOT/.convergence/pipeline-meta.json" ]] && echo true || echo false)"

# pipeline-meta.json must be valid JSON
validate_json "$SCAFFOLD_ROOT/.convergence/pipeline-meta.json"
assert_eq "pipeline-meta.json is valid JSON" "0" "$?"

# pipeline-meta.json must contain expected keys
META_FILE="$SCAFFOLD_ROOT/.convergence/pipeline-meta.json"
for key in created holdout_mode tier feature total_calls distribution budget_remaining status phase; do
  assert_contains_key "pipeline-meta.json has '$key'" "$key" "$META_FILE"
done

# Informed mode: holdout_mode must be false
HOLDOUT_VAL=$(python3 -c "import json; print(json.load(open('$META_FILE'))['holdout_mode'])")
assert_eq "informed scaffold: holdout_mode is False" "False" "$HOLDOUT_VAL"

# Run scaffold in holdout mode
SCAFFOLD_HOLDOUT="$WORK_DIR/scaffold-holdout"
mkdir -p "$SCAFFOLD_HOLDOUT"
bash "$SCAFFOLD" "$SCAFFOLD_HOLDOUT" --holdout

validate_json "$SCAFFOLD_HOLDOUT/.convergence/pipeline-meta.json"
assert_eq "holdout scaffold: pipeline-meta.json is valid JSON" "0" "$?"

HOLDOUT_VAL=$(python3 -c "import json; print(json.load(open('$SCAFFOLD_HOLDOUT/.convergence/pipeline-meta.json'))['holdout_mode'])")
assert_eq "holdout scaffold: holdout_mode is True" "True" "$HOLDOUT_VAL"

# Scaffold is idempotent — running twice does not error
bash "$SCAFFOLD" "$SCAFFOLD_ROOT"
assert_eq "scaffold.sh is idempotent (second run succeeds)" "0" "$?"

# ─────────────────────────────────────────────────────────────
# SECTION 5: scripts/common.sh and scripts/score-utils.sh
# ─────────────────────────────────────────────────────────────

echo ""
echo "=== 5. Helper script files ==="

assert_eq "scripts/common.sh exists" \
  "true" "$([[ -f "$SCRIPT_DIR/scripts/common.sh" ]] && echo true || echo false)"

assert_eq "scripts/score-utils.sh exists" \
  "true" "$([[ -f "$SCRIPT_DIR/scripts/score-utils.sh" ]] && echo true || echo false)"

# common.sh must define validate_json and estimate_tokens
assert_eq "common.sh defines validate_json" \
  "true" "$(grep -q "^validate_json()" "$SCRIPT_DIR/scripts/common.sh" && echo true || echo false)"

assert_eq "common.sh defines estimate_tokens" \
  "true" "$(grep -q "^estimate_tokens()" "$SCRIPT_DIR/scripts/common.sh" && echo true || echo false)"

# common.sh must NOT define the deleted functions
for fn in check_synaps check_call_budget call_opus call_qwen; do
  assert_eq "common.sh does not define deleted fn '$fn'" \
    "false" "$(grep -q "^${fn}()" "$SCRIPT_DIR/scripts/common.sh" && echo true || echo false)"
done

# score-utils.sh must define the expected functions
for fn in extract_verdict extract_overall log_score_history log_evolution check_evolution generate_escalation; do
  assert_eq "score-utils.sh defines '$fn'" \
    "true" "$(grep -q "^${fn}()" "$SCRIPT_DIR/scripts/score-utils.sh" && echo true || echo false)"
done

# ─────────────────────────────────────────────────────────────
# SECTION 6: Template and prompt files
# ─────────────────────────────────────────────────────────────

echo ""
echo "=== 6. Templates and prompts ==="

EXPECTED_TEMPLATES=(
  "templates/score-schema.json"
  "templates/design-doc.md"
  "templates/plan-header.md"
  "templates/task-template.md"
  "templates/escalation-report.md"
  "prompts/feedback-schema.json"
  "prompts/task-template.md"
)

for tpl in "${EXPECTED_TEMPLATES[@]}"; do
  assert_eq "$tpl exists" \
    "true" "$([[ -f "$SCRIPT_DIR/$tpl" ]] && echo true || echo false)"
done

# JSON templates must be valid JSON
for json_file in "templates/score-schema.json" "prompts/feedback-schema.json"; do
  validate_json "$SCRIPT_DIR/$json_file"
  assert_eq "$json_file is valid JSON" "0" "$?"
done

# ─────────────────────────────────────────────────────────────
# SECTION 7: Real end-to-end test (opt-in only)
# ─────────────────────────────────────────────────────────────

echo ""
echo "=== 7. Real pipeline test ==="

if [[ "${BBE_INTEGRATION_TEST:-0}" != "1" ]]; then
  echo "  ⏭️  Skipped — set BBE_INTEGRATION_TEST=1 to run real API calls"
  echo "  ⏭️  Cost: a few hundred tokens (uses --agent sonnet)"
else
  echo "  🔄 Running real pipeline test..."

  if ! command -v synaps &>/dev/null; then
    echo "  ❌ synaps CLI not found — cannot run real test"
    FAIL=$((FAIL + 1))
  else
    REAL_WORK="$WORK_DIR/real-project"
    mkdir -p "$REAL_WORK"
    cd "$REAL_WORK"
    git init -q
    git config user.email "test@bbe.local"
    git config user.name "BBE Test"

    # Minimal plan: one trivially simple task
    cat > "$WORK_DIR/toy-plan.md" << 'PLAN'
# Toy Project Plan

## Goal
Create a single-function TypeScript module.

## Architecture
A single file: src/add.ts

## Task 1: Add function
Create `src/add.ts` that exports a function `add(a: number, b: number): number`
that returns `a + b`.
PLAN

    # Minimal design doc
    cat > "$WORK_DIR/toy-design.md" << 'DESIGN'
# Design: add module

## Purpose
A utility module with a single arithmetic function.

## Specification
- Function `add(a, b)` takes two numbers and returns their sum.
- Must be a named export.
- No side effects.
DESIGN

    # Run the pipeline — sonnet models, 1 fix max, low budget
    set +e
    PIPELINE_EXIT=0
    bash "$PIPELINE" \
      "$WORK_DIR/toy-plan.md" \
      "$WORK_DIR/toy-design.md" \
      --workdir "$REAL_WORK" \
      --agent sonnet \
      --max-fixes 1 \
      --max-calls 6 \
      --threshold 0.7 2>&1 | tail -20 || PIPELINE_EXIT=$?
    set -e

    assert_eq "real pipeline exits cleanly" "0" "$PIPELINE_EXIT"

    # Quinn should have written src/add.ts
    assert_eq "Quinn wrote src/add.ts" \
      "true" "$([[ -f "$REAL_WORK/src/add.ts" ]] && echo true || echo false)"

    # .convergence/ should exist
    assert_eq ".convergence/ was created" \
      "true" "$([[ -d "$REAL_WORK/.convergence" ]] && echo true || echo false)"

    # Glitch report should exist
    REPORT_COUNT=$(find "$REAL_WORK/.convergence/reports" -name "run-*.json" 2>/dev/null | wc -l | tr -d ' ')
    assert_eq "at least one Glitch report written" \
      "true" "$([[ "$REPORT_COUNT" -ge 1 ]] && echo true || echo false)"

    # Arbiter verdict should exist
    VERDICT_COUNT=$(find "$REAL_WORK/.convergence/verdicts" -name "verdict-*.json" 2>/dev/null | wc -l | tr -d ' ')
    assert_eq "at least one Arbiter verdict written" \
      "true" "$([[ "$VERDICT_COUNT" -ge 1 ]] && echo true || echo false)"

    # Latest verdict must be valid JSON with required keys
    if [[ "$VERDICT_COUNT" -ge 1 ]]; then
      LAST_VERDICT=$(find "$REAL_WORK/.convergence/verdicts" -name "verdict-*.json" | sort | tail -1)
      validate_json "$LAST_VERDICT"
      assert_eq "final verdict is valid JSON" "0" "$?"

      python3 - "$LAST_VERDICT" << 'PYEOF'
import json, sys
data = json.load(open(sys.argv[1]))
assert 'overall'   in data, "verdict missing 'overall'"
assert 'verdict'   in data, "verdict missing 'verdict'"
assert 'dimensions' in data, "verdict missing 'dimensions'"
assert data['verdict'] in ('PROCEED', 'REVIEW', 'REWORK'), \
    f"verdict value '{data['verdict']}' not in (PROCEED, REVIEW, REWORK)"
assert isinstance(data['overall'], float), \
    f"overall must be float, got {type(data['overall'])}"
assert 0.0 <= data['overall'] <= 1.0, \
    f"overall {data['overall']} out of range [0,1]"
PYEOF
      assert_eq "final verdict has valid structure" "0" "$?"
    fi

    cd "$SCRIPT_DIR"
  fi
fi

# ─────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
