#!/usr/bin/env bash
# tests/test-quinn.sh — Tests for the Quinn agent and its file-writing contract
#
# Verifies:
#   1. agents/quinn.md exists and has valid YAML frontmatter (name, description)
#   2. Quinn's contract: it writes files directly to disk (no JSON intermediary)
#   3. Simulated file writes match expected patterns (path, content, existence)
#   4. validate_json works on any JSON files Quinn might incidentally produce
#
# Quinn's architecture change: Quinn now writes source files directly via the
# `write` tool. It does NOT produce a JSON output file. Tests simulate and
# verify this disk-write behavior pattern.
#
# Does NOT invoke the real agent or make any API calls.
#
# Run: bash tests/test-quinn.sh
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

assert_not_contains() {
  local label="$1" needle="$2" file="$3"
  if grep -q "$needle" "$file" 2>/dev/null; then
    echo "  ❌ $label (found '$needle' in $file)"; FAIL=$((FAIL + 1))
  else
    echo "  ✅ $label"; PASS=$((PASS + 1))
  fi
}

WORK_DIR="/tmp/bbe-test-quinn-$$"
mkdir -p "$WORK_DIR"
trap "rm -rf $WORK_DIR" EXIT

QUINN_MD="$SCRIPT_DIR/agents/quinn.md"

# ─── Agent file existence and frontmatter ────────────────────

echo "--- agents/quinn.md existence and frontmatter ---"

assert_eq "agents/quinn.md exists" "true" "$([[ -f "$QUINN_MD" ]] && echo true || echo false)"

# Frontmatter must open with "---" on line 1
FIRST_LINE=$(head -1 "$QUINN_MD")
assert_eq "frontmatter opens with ---" "---" "$FIRST_LINE"

# Must have a name: field in frontmatter
assert_contains "frontmatter has 'name:' field" "^name:" "$QUINN_MD"

# Must have a description: field in frontmatter
assert_contains "frontmatter has 'description:' field" "^description:" "$QUINN_MD"

# name must be non-empty
NAME_VAL=$(grep "^name:" "$QUINN_MD" | head -1 | sed 's/^name:[[:space:]]*//')
assert_eq "name field is non-empty" "true" "$([[ -n "$NAME_VAL" ]] && echo true || echo false)"

# description must be non-empty
DESC_VAL=$(grep "^description:" "$QUINN_MD" | head -1 | sed 's/^description:[[:space:]]*//')
assert_eq "description field is non-empty" "true" "$([[ -n "$DESC_VAL" ]] && echo true || echo false)"

# Frontmatter must close with "---" on a subsequent line
CLOSE_COUNT=$(grep -c "^---$" "$QUINN_MD")
assert_eq "frontmatter has closing ---" "true" "$([[ "$CLOSE_COUNT" -ge 2 ]] && echo true || echo false)"

# ─── Agent content sanity checks ─────────────────────────────

echo ""
echo "--- agents/quinn.md content ---"

# Quinn uses write/edit tools — not producing a JSON output file
assert_contains "instructs agent to use 'write' tool"  "write"  "$QUINN_MD"
assert_contains "instructs agent to use 'edit' tool"   "edit"   "$QUINN_MD"

# Quinn should verify its work
assert_contains "instructs agent to verify files"      "verify" "$QUINN_MD"

# Must NOT instruct Quinn to produce a JSON output with a 'files' array
# (that was the old architecture — Quinn now writes directly)
assert_not_contains "does not describe old 'files' JSON output schema" '"files"' "$QUINN_MD"
assert_not_contains "does not describe 'call_opus' pattern"            "call_opus" "$QUINN_MD"

# ─── Simulate Quinn writing a single new file ─────────────────

echo ""
echo "--- simulate Quinn creating a new file ---"

# Simulate what Quinn does: write a source file directly to disk
mkdir -p "$WORK_DIR/project/src"
cat > "$WORK_DIR/project/src/hello.ts" << 'EOF'
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
EOF

# Verify the file exists on disk
assert_eq "created file exists on disk" \
  "true" "$([[ -f "$WORK_DIR/project/src/hello.ts" ]] && echo true || echo false)"

# Verify content is non-empty
BYTE_COUNT=$(wc -c < "$WORK_DIR/project/src/hello.ts" | tr -d ' ')
assert_eq "created file is non-empty" \
  "true" "$([[ "$BYTE_COUNT" -gt 0 ]] && echo true || echo false)"

# Verify content contains what we expect
assert_contains "created file has export function" \
  "export function greet" "$WORK_DIR/project/src/hello.ts"

assert_contains "created file has return statement" \
  "return" "$WORK_DIR/project/src/hello.ts"

# ─── Simulate Quinn modifying an existing file ────────────────

echo ""
echo "--- simulate Quinn modifying an existing file ---"

# Start: existing index file
cat > "$WORK_DIR/project/src/index.ts" << 'EOF'
import express from 'express';
const app = express();
app.listen(3000);
EOF

BEFORE_LINES=$(wc -l < "$WORK_DIR/project/src/index.ts" | tr -d ' ')

# Quinn edits the file (e.g. adds a health route)
cat > "$WORK_DIR/project/src/index.ts" << 'EOF'
import express from 'express';
const app = express();

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(3000);
EOF

AFTER_LINES=$(wc -l < "$WORK_DIR/project/src/index.ts" | tr -d ' ')

assert_eq "modified file exists on disk" \
  "true" "$([[ -f "$WORK_DIR/project/src/index.ts" ]] && echo true || echo false)"

assert_eq "modified file has more lines than original" \
  "true" "$([[ "$AFTER_LINES" -gt "$BEFORE_LINES" ]] && echo true || echo false)"

assert_contains "modified file has health route" \
  "/health" "$WORK_DIR/project/src/index.ts"

# ─── Simulate Quinn writing multiple files across a task ──────

echo ""
echo "--- simulate Quinn completing a multi-file task ---"

mkdir -p "$WORK_DIR/project/src/middleware"

EXPECTED_FILES=(
  "$WORK_DIR/project/src/auth.ts"
  "$WORK_DIR/project/src/middleware/jwt.ts"
  "$WORK_DIR/project/src/types.ts"
)

# Simulate Quinn writing each file
cat > "$WORK_DIR/project/src/auth.ts" << 'EOF'
export function authenticate(token: string): boolean {
  return token.length > 0;
}
EOF

cat > "$WORK_DIR/project/src/middleware/jwt.ts" << 'EOF'
import { Request, Response, NextFunction } from 'express';
export function jwtMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization ?? '';
  if (!token) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}
EOF

cat > "$WORK_DIR/project/src/types.ts" << 'EOF'
export interface User {
  id: string;
  email: string;
}
EOF

for f in "${EXPECTED_FILES[@]}"; do
  BASENAME=$(basename "$f")
  assert_eq "multi-file: $BASENAME exists on disk" \
    "true" "$([[ -f "$f" ]] && echo true || echo false)"
done

# All files should be non-empty
ALL_NON_EMPTY=true
for f in "${EXPECTED_FILES[@]}"; do
  [[ -s "$f" ]] || ALL_NON_EMPTY=false
done
assert_eq "all multi-file outputs are non-empty" "true" "$ALL_NON_EMPTY"

# Count how many files exist
FILE_COUNT=$(find "$WORK_DIR/project/src" -type f -name "*.ts" | wc -l | tr -d ' ')
assert_eq "project/src has at least 5 .ts files" \
  "true" "$([[ "$FILE_COUNT" -ge 5 ]] && echo true || echo false)"

# ─── No JSON output file is part of Quinn's contract ──────────

echo ""
echo "--- Quinn does not produce a JSON output intermediary ---"

# Quinn's working directory should contain only source files, not a
# call_opus-style JSON output file.
JSON_COUNT=$(find "$WORK_DIR/project" -name "output.json" -o -name "quinn-output.json" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "no output.json file in Quinn's work tree" "0" "$JSON_COUNT"

# If Quinn does write a JSON (e.g. a config file), it must be valid
cat > "$WORK_DIR/project/tsconfig.json" << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "strict": true,
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
EOF

validate_json "$WORK_DIR/project/tsconfig.json"
assert_eq "any JSON Quinn writes (e.g. tsconfig) must be valid" "0" "$?"

# ─── validate_json works on JSON Quinn might write ────────────

echo ""
echo "--- validate_json on Quinn-generated JSON files ---"

cat > "$WORK_DIR/package.json" << 'EOF'
{
  "name": "my-app",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "jest"
  },
  "dependencies": {
    "express": "^4.18.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
EOF

validate_json "$WORK_DIR/package.json"
assert_eq "package.json Quinn might write is valid JSON" "0" "$?"

# ─── Summary ─────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
