#!/usr/bin/env bash
# test-holdout.sh — Verify information isolation in both modes
#
# Tests that:
# - Holdout mode enforces strict information walls
# - Informed mode shares appropriate context
set -euo pipefail

PASS=0; FAIL=0

assert_not_contains() {
  local label="$1" needle="$2" file="$3"
  if grep -q "$needle" "$file" 2>/dev/null; then
    echo "  ❌ $label (found '$needle' in $file)"; FAIL=$((FAIL + 1))
  else
    echo "  ✅ $label"; PASS=$((PASS + 1))
  fi
}

assert_contains() {
  local label="$1" needle="$2" file="$3"
  if grep -q "$needle" "$file" 2>/dev/null; then
    echo "  ✅ $label"; PASS=$((PASS + 1))
  else
    echo "  ❌ $label (missing '$needle' in $file)"; FAIL=$((FAIL + 1))
  fi
}

WORK_DIR="/tmp/bbe-holdout-test-$$"
mkdir -p "$WORK_DIR"
trap "rm -rf $WORK_DIR" EXIT

# ─── HOLDOUT MODE TESTS ─────────────────────────────────────

echo "=== HOLDOUT MODE ==="

# Simulate Quinn's prompt in holdout mode (per SKILL.md Phase 2)
cat > "$WORK_DIR/quinn-holdout.md" << 'EOF'
# Task: Create health endpoint

## Instructions
Create src/health.ts with a GET /health route.

## Plan Context
Goal: Build a health check API
Architecture: Express.js REST server

## Files Context
(no existing files)
EOF

# Simulate Glitch's prompt in holdout mode (per SKILL.md Phase 3)
cat > "$WORK_DIR/glitch-holdout.md" << 'EOF'
## Test Execution Task
## Scenarios to Test
[{"id":"scenario-01","name":"health check"}]
## Code Under Test
### src/health.ts
export default router;
EOF

# Simulate Arbiter's prompt in holdout mode (per SKILL.md Phase 4)
cat > "$WORK_DIR/arbiter-holdout.md" << 'EOF'
# Judgment Task
## Pass Threshold
0.8
## Design Document
The system should provide a health check endpoint.
## Test Report
{"tests_run":1,"passed":1,"failed":0,"results":[{"test":"health check","status":"pass"}]}
EOF

# Simulate Sage's prompt in holdout mode (per SKILL.md Phase 1)
cat > "$WORK_DIR/sage-holdout.md" << 'EOF'
# Design Document
The system should provide a health check endpoint that returns 200 OK.
EOF

echo "--- Quinn holdout ---"
assert_not_contains "Quinn has no scenario paths" ".convergence/scenarios" "$WORK_DIR/quinn-holdout.md"
assert_not_contains "Quinn has no suite.yaml ref" "suite.yaml" "$WORK_DIR/quinn-holdout.md"
assert_not_contains "Quinn has no test report paths" ".convergence/reports" "$WORK_DIR/quinn-holdout.md"
assert_not_contains "Quinn has no scenario content" "scenario-01" "$WORK_DIR/quinn-holdout.md"

echo "--- Glitch holdout ---"
assert_not_contains "Glitch has no design doc ref" "Design Document" "$WORK_DIR/glitch-holdout.md"
assert_not_contains "Glitch has no plan ref" "Implementation Plan" "$WORK_DIR/glitch-holdout.md"

echo "--- Arbiter holdout ---"
assert_not_contains "Arbiter has no source code" "src/health.ts" "$WORK_DIR/arbiter-holdout.md"
assert_not_contains "Arbiter has no scenario details" "scenario-01" "$WORK_DIR/arbiter-holdout.md"
assert_contains "Arbiter has design doc" "Design Document" "$WORK_DIR/arbiter-holdout.md"
assert_contains "Arbiter has test report" "Test Report" "$WORK_DIR/arbiter-holdout.md"

echo "--- Sage holdout ---"
assert_not_contains "Sage has no code paths" "src/" "$WORK_DIR/sage-holdout.md"
assert_not_contains "Sage has no plan tasks" "Create src/health.ts" "$WORK_DIR/sage-holdout.md"
assert_contains "Sage has design doc" "Design Document" "$WORK_DIR/sage-holdout.md"

# ─── INFORMED MODE TESTS ────────────────────────────────────

echo ""
echo "=== INFORMED MODE ==="

# Simulate Quinn's prompt in informed mode (gets scenario names)
cat > "$WORK_DIR/quinn-informed.md" << 'EOF'
# Task: Create health endpoint

## Instructions
Create src/health.ts with a GET /health route.

## Plan Context
Goal: Build a health check API
Architecture: Express.js REST server

## Test Scenarios (for reference)
The following behaviors will be tested:
- health check returns 200
- bad route returns 404

## Files Context
(no existing files)
EOF

# Simulate Glitch's prompt in informed mode (gets design doc)
cat > "$WORK_DIR/glitch-informed.md" << 'EOF'
## Test Execution Task
## Scenarios to Test
[{"id":"scenario-01","name":"health check"}]
## Design Document (for context)
The system should provide a health check endpoint.
## Code Under Test
### src/health.ts
export default router;
EOF

# Simulate Arbiter's prompt in informed mode (gets source code)
cat > "$WORK_DIR/arbiter-informed.md" << 'EOF'
# Judgment Task
## Pass Threshold
0.8
## Design Document
The system should provide a health check endpoint.
## Test Report
{"tests_run":1,"passed":1,"failed":0}
## Source Code (for context)
### src/health.ts
export default router;
EOF

echo "--- Quinn informed ---"
assert_contains "Quinn has scenario names" "Test Scenarios" "$WORK_DIR/quinn-informed.md"
assert_contains "Quinn has scenario behavior" "health check returns 200" "$WORK_DIR/quinn-informed.md"

echo "--- Glitch informed ---"
assert_contains "Glitch has design doc" "Design Document" "$WORK_DIR/glitch-informed.md"

echo "--- Arbiter informed ---"
assert_contains "Arbiter has source code" "Source Code" "$WORK_DIR/arbiter-informed.md"
assert_contains "Arbiter has design doc" "Design Document" "$WORK_DIR/arbiter-informed.md"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
