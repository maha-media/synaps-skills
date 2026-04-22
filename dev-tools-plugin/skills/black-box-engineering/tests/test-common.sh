#!/usr/bin/env bash
# tests/test-common.sh — unit tests for scripts/common.sh
#
# Tests only what actually exists in common.sh:
#   - validate_json: accepts valid JSON, rejects invalid/missing files
#   - estimate_tokens: rough char/4 calculation
#
# Run: bash tests/test-common.sh
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

# ─── Cleanup ─────────────────────────────────────────────────
WORK_DIR="/tmp/bbe-test-common-$$"
mkdir -p "$WORK_DIR"
trap "rm -rf $WORK_DIR" EXIT

# ─── validate_json ───────────────────────────────────────────

echo "--- validate_json ---"

# Happy path: minimal valid object
echo '{}' > "$WORK_DIR/empty-obj.json"
validate_json "$WORK_DIR/empty-obj.json"
assert_eq "empty object is valid JSON" "0" "$?"

# Happy path: object with array
echo '{"files":[]}' > "$WORK_DIR/files-array.json"
validate_json "$WORK_DIR/files-array.json"
assert_eq "object with empty array is valid JSON" "0" "$?"

# Happy path: nested structure
python3 -c "
import json
data = {
  'tests_run': 3,
  'passed': 2,
  'failed': 1,
  'results': [
    {'test': 'a', 'status': 'pass'},
    {'test': 'b', 'status': 'fail', 'error': 'expected 0 got 1'}
  ]
}
print(json.dumps(data))
" > "$WORK_DIR/nested.json"
validate_json "$WORK_DIR/nested.json"
assert_eq "nested glitch-shaped object is valid JSON" "0" "$?"

# Happy path: valid array at root
echo '[1, 2, 3]' > "$WORK_DIR/array.json"
validate_json "$WORK_DIR/array.json"
assert_eq "JSON array at root is valid" "0" "$?"

# Failure: file does not exist
set +e
validate_json "$WORK_DIR/nonexistent.json" 2>/dev/null
assert_eq "nonexistent file returns non-zero" "1" "$?"

# Failure: file contains bare text
echo 'not json at all' > "$WORK_DIR/bare-text.json"
validate_json "$WORK_DIR/bare-text.json" 2>/dev/null
assert_eq "bare text returns non-zero" "1" "$?"

# Failure: truncated object (missing closing brace)
echo '{"key": "value"' > "$WORK_DIR/truncated.json"
validate_json "$WORK_DIR/truncated.json" 2>/dev/null
assert_eq "truncated JSON returns non-zero" "1" "$?"

# Failure: JSON with trailing comma (Python rejects it)
echo '{"a":1,"b":2,}' > "$WORK_DIR/trailing-comma.json"
validate_json "$WORK_DIR/trailing-comma.json" 2>/dev/null
assert_eq "trailing comma returns non-zero" "1" "$?"

# Failure: empty file
touch "$WORK_DIR/empty.json"
validate_json "$WORK_DIR/empty.json" 2>/dev/null
assert_eq "empty file returns non-zero" "1" "$?"

# Failure: only whitespace
echo '   ' > "$WORK_DIR/whitespace.json"
validate_json "$WORK_DIR/whitespace.json" 2>/dev/null
assert_eq "whitespace-only file returns non-zero" "1" "$?"
set -e

# ─── estimate_tokens ─────────────────────────────────────────

echo ""
echo "--- estimate_tokens ---"

# "hello world 1234" is 16 chars + 1 newline = 17 bytes → floor(17/4) = 4
echo "hello world 1234" > "$WORK_DIR/small.txt"
CHARS=$(wc -c < "$WORK_DIR/small.txt" | tr -d ' ')
EXPECTED=$(( CHARS / 4 ))
TOKENS=$(estimate_tokens "$WORK_DIR/small.txt")
assert_eq "small file: estimate matches char/4 formula" "$EXPECTED" "$TOKENS"

# 40-char string: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + newline = 41 bytes → 10
printf '%0.s a' {1..20} | tr -d ' ' > "$WORK_DIR/forty.txt"
# Use a precise known content instead
printf 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn\n' > "$WORK_DIR/forty.txt"
CHARS=$(wc -c < "$WORK_DIR/forty.txt" | tr -d ' ')
EXPECTED=$(( CHARS / 4 ))
TOKENS=$(estimate_tokens "$WORK_DIR/forty.txt")
assert_eq "40-char line: estimate matches char/4 formula" "$EXPECTED" "$TOKENS"

# Multi-line file: 3 lines of 10 chars each = 33 bytes (30 chars + 3 newlines) → 8
printf 'abcdefghij\nabcdefghij\nabcdefghij\n' > "$WORK_DIR/multiline.txt"
CHARS=$(wc -c < "$WORK_DIR/multiline.txt" | tr -d ' ')
EXPECTED=$(( CHARS / 4 ))
TOKENS=$(estimate_tokens "$WORK_DIR/multiline.txt")
assert_eq "multi-line file: estimate matches char/4 formula" "$EXPECTED" "$TOKENS"

# Empty file: 0 bytes → 0 tokens
touch "$WORK_DIR/zero.txt"
TOKENS=$(estimate_tokens "$WORK_DIR/zero.txt")
assert_eq "empty file returns 0 tokens" "0" "$TOKENS"

# Larger file: ~1000 chars → ~250 tokens
python3 -c "print('x' * 1000)" > "$WORK_DIR/large.txt"
CHARS=$(wc -c < "$WORK_DIR/large.txt" | tr -d ' ')
EXPECTED=$(( CHARS / 4 ))
TOKENS=$(estimate_tokens "$WORK_DIR/large.txt")
assert_eq "1000-char file: estimate matches char/4 formula" "$EXPECTED" "$TOKENS"

# Verify it returns a plain integer (no whitespace, no decimals)
echo "test content here" > "$WORK_DIR/int-check.txt"
TOKENS=$(estimate_tokens "$WORK_DIR/int-check.txt")
[[ "$TOKENS" =~ ^[0-9]+$ ]]
assert_eq "estimate_tokens returns a plain integer" "0" "$?"

# ─── Summary ─────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
