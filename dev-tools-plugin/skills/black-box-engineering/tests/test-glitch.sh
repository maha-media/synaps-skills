#!/usr/bin/env bash
# tests/test-glitch.sh — Tests for the Glitch agent and its output contract
#
# Verifies:
#   1. agents/glitch.md exists and has valid YAML frontmatter (name, description)
#   2. The expected Glitch output schema validates correctly via validate_json
#   3. Schema fields are correct: tests_run, passed, failed, results[], status values
#   4. Edge cases: partial failures, all-pass, all-fail, method field, skip status
#
# Does NOT invoke the real agent or make any API calls.
#
# Run: bash tests/test-glitch.sh
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

assert_contains() {
  local label="$1" needle="$2" file="$3"
  if grep -q "$needle" "$file" 2>/dev/null; then
    echo "  ✅ $label"; PASS=$((PASS + 1))
  else
    echo "  ❌ $label (missing '$needle' in $file)"; FAIL=$((FAIL + 1))
  fi
}

WORK_DIR="/tmp/bbe-test-glitch-$$"
mkdir -p "$WORK_DIR"
trap "rm -rf $WORK_DIR" EXIT

GLITCH_MD="$SCRIPT_DIR/agents/glitch.md"

# ─── Agent file existence and frontmatter ────────────────────

echo "--- agents/glitch.md existence and frontmatter ---"

assert_eq "agents/glitch.md exists" "true" "$([[ -f "$GLITCH_MD" ]] && echo true || echo false)"

# Frontmatter must open with "---" on line 1
FIRST_LINE=$(head -1 "$GLITCH_MD")
assert_eq "frontmatter opens with ---" "---" "$FIRST_LINE"

# Must have a name: field in frontmatter
assert_contains "frontmatter has 'name:' field" "^name:" "$GLITCH_MD"

# Must have a description: field in frontmatter
assert_contains "frontmatter has 'description:' field" "^description:" "$GLITCH_MD"

# name must be non-empty (not just "name:")
NAME_VAL=$(grep "^name:" "$GLITCH_MD" | head -1 | sed 's/^name:[[:space:]]*//')
assert_eq "name field is non-empty" "true" "$([[ -n "$NAME_VAL" ]] && echo true || echo false)"

# description must be non-empty
DESC_VAL=$(grep "^description:" "$GLITCH_MD" | head -1 | sed 's/^description:[[:space:]]*//')
assert_eq "description field is non-empty" "true" "$([[ -n "$DESC_VAL" ]] && echo true || echo false)"

# Frontmatter must close with "---" on a subsequent line
CLOSE_COUNT=$(grep -c "^---$" "$GLITCH_MD")
assert_eq "frontmatter has closing ---" "true" "$([[ "$CLOSE_COUNT" -ge 2 ]] && echo true || echo false)"

# ─── Agent content sanity checks ─────────────────────────────

echo ""
echo "--- agents/glitch.md content ---"

# Must document the required output fields
assert_contains "documents 'tests_run' output field"  "tests_run"   "$GLITCH_MD"
assert_contains "documents 'passed' output field"     "passed"      "$GLITCH_MD"
assert_contains "documents 'failed' output field"     "failed"      "$GLITCH_MD"
assert_contains "documents 'results' output field"    "results"     "$GLITCH_MD"
assert_contains "documents 'status' in result items"  "status"      "$GLITCH_MD"

# Must document valid status values
assert_contains "documents 'pass' status value"       "pass"        "$GLITCH_MD"
assert_contains "documents 'fail' status value"       "fail"        "$GLITCH_MD"
assert_contains "documents 'error' status value"      "error"       "$GLITCH_MD"
assert_contains "documents 'skip' status value"       "skip"        "$GLITCH_MD"

# Must instruct agent to write output (not print to stdout)
assert_contains "instructs agent to write output"     "write"       "$GLITCH_MD"

# ─── Mock output: mixed pass/fail ────────────────────────────

echo ""
echo "--- mock output schema: mixed pass/fail ---"

cat > "$WORK_DIR/glitch-mixed.json" << 'JSON'
{
  "tests_run": 4,
  "passed": 2,
  "failed": 1,
  "results": [
    {
      "test": "health endpoint returns 200",
      "status": "pass",
      "output": "HTTP 200 OK",
      "method": "dynamic",
      "duration_ms": 43
    },
    {
      "test": "auth rejects invalid token",
      "status": "fail",
      "output": "HTTP 200",
      "error": "expected 401 got 200",
      "method": "dynamic",
      "duration_ms": 18
    },
    {
      "test": "rate limit enforced after 100 req/min",
      "status": "skip",
      "output": "skipped: no load-testing tools available",
      "method": "static",
      "duration_ms": 0
    },
    {
      "test": "returns JSON content-type header",
      "status": "pass",
      "output": "content-type: application/json",
      "method": "dynamic",
      "duration_ms": 11
    }
  ],
  "environment": {
    "analysis_method": "mixed static+dynamic",
    "timestamp": "2026-01-15T10:00:00Z"
  }
}
JSON

validate_json "$WORK_DIR/glitch-mixed.json"
assert_eq "mixed output is valid JSON" "0" "$?"

python3 - "$WORK_DIR/glitch-mixed.json" << 'PYEOF'
import json, sys

data = json.load(open(sys.argv[1]))

assert 'tests_run'  in data, "missing tests_run"
assert 'passed'     in data, "missing passed"
assert 'failed'     in data, "missing failed"
assert 'results'    in data, "missing results"
assert isinstance(data['results'], list), "results must be a list"
assert data['tests_run'] == 4,  f"tests_run expected 4 got {data['tests_run']}"
assert data['passed']    == 2,  f"passed expected 2 got {data['passed']}"
assert data['failed']    == 1,  f"failed expected 1 got {data['failed']}"
assert len(data['results']) == 4, f"expected 4 result entries got {len(data['results'])}"

valid_statuses = {'pass', 'fail', 'error', 'skip'}
for r in data['results']:
    assert 'test'   in r, f"result missing 'test' key: {r}"
    assert 'status' in r, f"result missing 'status' key: {r}"
    assert r['status'] in valid_statuses, f"invalid status '{r['status']}'"
PYEOF
assert_eq "mixed output structure is correct" "0" "$?"

# ─── Mock output: all-pass ────────────────────────────────────

echo ""
echo "--- mock output schema: all-pass ---"

cat > "$WORK_DIR/glitch-all-pass.json" << 'JSON'
{
  "tests_run": 3,
  "passed": 3,
  "failed": 0,
  "results": [
    {"test": "scenario A", "status": "pass", "output": "ok", "method": "dynamic", "duration_ms": 5},
    {"test": "scenario B", "status": "pass", "output": "ok", "method": "static",  "duration_ms": 0},
    {"test": "scenario C", "status": "pass", "output": "ok", "method": "dynamic", "duration_ms": 22}
  ],
  "environment": {"analysis_method": "dynamic", "timestamp": "2026-01-15T11:00:00Z"}
}
JSON

validate_json "$WORK_DIR/glitch-all-pass.json"
assert_eq "all-pass output is valid JSON" "0" "$?"

TESTS_RUN=$(python3 -c "import json; print(json.load(open('$WORK_DIR/glitch-all-pass.json'))['tests_run'])")
assert_eq "all-pass: tests_run == 3" "3" "$TESTS_RUN"

FAILED=$(python3 -c "import json; print(json.load(open('$WORK_DIR/glitch-all-pass.json'))['failed'])")
assert_eq "all-pass: failed == 0" "0" "$FAILED"

# ─── Mock output: all-fail (crash / blocker) ─────────────────

echo ""
echo "--- mock output schema: all-error (blocker) ---"

cat > "$WORK_DIR/glitch-blocker.json" << 'JSON'
{
  "tests_run": 2,
  "passed": 0,
  "failed": 2,
  "results": [
    {
      "test": "app starts successfully",
      "status": "error",
      "output": "",
      "error": "Cannot find module 'express'",
      "method": "dynamic",
      "duration_ms": 3
    },
    {
      "test": "health endpoint returns 200",
      "status": "error",
      "output": "",
      "error": "app failed to start — all tests blocked",
      "method": "dynamic",
      "duration_ms": 1
    }
  ],
  "environment": {"analysis_method": "dynamic", "timestamp": "2026-01-15T12:00:00Z"}
}
JSON

validate_json "$WORK_DIR/glitch-blocker.json"
assert_eq "blocker output is valid JSON" "0" "$?"

python3 - "$WORK_DIR/glitch-blocker.json" << 'PYEOF'
import json, sys
data = json.load(open(sys.argv[1]))
assert data['passed'] == 0, "blocker: passed should be 0"
assert data['failed'] == 2, "blocker: failed should be 2"
for r in data['results']:
    assert r['status'] == 'error', f"blocker: expected 'error' status got '{r['status']}'"
    assert 'error' in r, "blocker: each result must have an 'error' field"
PYEOF
assert_eq "blocker output structure is correct" "0" "$?"

# ─── Schema rejection: invalid status value ───────────────────

echo ""
echo "--- schema validation rejects bad output ---"

cat > "$WORK_DIR/glitch-bad-status.json" << 'JSON'
{
  "tests_run": 1,
  "passed": 0,
  "failed": 0,
  "results": [
    {"test": "something", "status": "pending"}
  ]
}
JSON

validate_json "$WORK_DIR/glitch-bad-status.json"
assert_eq "structurally valid JSON passes validate_json even with bad status value" "0" "$?"

set +e
python3 - "$WORK_DIR/glitch-bad-status.json" << 'PYEOF' 2>/dev/null
import json, sys
data = json.load(open(sys.argv[1]))
valid_statuses = {'pass', 'fail', 'error', 'skip'}
for r in data['results']:
    assert r['status'] in valid_statuses, f"invalid status: '{r['status']}'"
PYEOF
assert_eq "status 'pending' caught by schema check" "1" "$?"
set -e

# Missing required top-level key
cat > "$WORK_DIR/glitch-missing-key.json" << 'JSON'
{
  "passed": 1,
  "failed": 0,
  "results": [{"test": "x", "status": "pass"}]
}
JSON

validate_json "$WORK_DIR/glitch-missing-key.json"
assert_eq "JSON missing tests_run still passes validate_json" "0" "$?"

set +e
python3 - "$WORK_DIR/glitch-missing-key.json" << 'PYEOF' 2>/dev/null
import json, sys
data = json.load(open(sys.argv[1]))
assert 'tests_run' in data, "missing required key: tests_run"
PYEOF
assert_eq "missing 'tests_run' caught by schema check" "1" "$?"
set -e

# ─── validate_json used on real Glitch output ─────────────────

echo ""
echo "--- validate_json integrates cleanly with Glitch outputs ---"

for fixture in glitch-mixed glitch-all-pass glitch-blocker; do
  validate_json "$WORK_DIR/$fixture.json"
  assert_eq "validate_json accepts $fixture.json" "0" "$?"
done

# ─── Summary ─────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
