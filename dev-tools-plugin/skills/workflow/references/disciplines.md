# Development Disciplines

Detailed procedures for the three disciplines that apply across all workflow phases.

---

## Test-Driven Development

Applies during **all phases**. No production code without a failing test first.

### The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over. No exceptions.

### Red-Green-Refactor

1. **RED** — Write one minimal test. Run it. Watch it fail. Confirm it fails because the feature is missing, not because of typos.
2. **GREEN** — Write the simplest code to make the test pass. Nothing more.
3. **REFACTOR** — Clean up. Remove duplication. Improve names. Keep tests green.
4. **Repeat.**

### Good Tests

- **One behavior per test** — "and" in the name? Split it.
- **Clear names** — describe the behavior, not the implementation
- **Real code** — no mocks unless unavoidable
- **Minimal** — test takes 30 seconds to write for simple code

### Anti-Patterns

| Anti-Pattern | Fix |
|---|---|
| Assert on mock elements | Test real component or unmock it |
| Test-only methods in production | Move to test utilities |
| Mock without understanding deps | Understand first, mock minimally |
| Incomplete mocks (missing fields) | Mirror real API completely |
| Tests as afterthought | TDD — tests first |
| Over-complex mock setup | Consider integration tests instead |

### Common Rationalizations (all wrong)

| Excuse | Reality |
|---|---|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Need to explore first" | Fine. Throw away exploration, start with TDD. |
| "Test hard = skip test" | Hard to test = hard to use. Listen to the test. |
| "TDD will slow me down" | TDD is faster than debugging. |

---

## Git Worktrees

Isolated workspaces sharing the same repo. Use before executing any implementation plan.

### Quick Setup

```bash
# 1. Check for existing directory
ls -d .worktrees 2>/dev/null

# 2. Ensure gitignored
git check-ignore -q .worktrees || (echo ".worktrees/" >> .gitignore && git add .gitignore && git commit -m "chore: gitignore worktrees")

# 3. Create
git worktree add .worktrees/<feature> -b feature/<feature>
cd .worktrees/<feature>

# 4. Install deps + verify baseline
[ -f package.json ] && npm install
[ -f Cargo.toml ] && cargo build
[ -f requirements.txt ] && pip install -r requirements.txt
[ -f go.mod ] && go mod download

# 5. Verify clean baseline
npm test  # or cargo test / pytest / go test ./...
```

### Rules

- **Always verify gitignored** before creating project-local worktrees
- **Always run baseline tests** — can't distinguish new bugs from pre-existing ones
- **Auto-detect setup** — check package.json, Cargo.toml, requirements.txt, go.mod
- **If baseline tests fail:** report and ask, don't proceed silently

### Cleanup

```bash
git worktree remove .worktrees/<feature>
```

---

## Systematic Debugging

Use when encountering **any** bug, test failure, or unexpected behavior. Never guess.

### The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If Phase 1 below is not complete, no fixes may be proposed.

### Phase 1: Root Cause Investigation

1. **Read error messages carefully** — don't skip past them. Read the full stack trace. Note line numbers.
2. **Reproduce consistently** — exact steps, every time. Not reproducible → gather more data, don't guess.
3. **Check recent changes** — `git diff`, recent commits, new deps, config changes.
4. **Trace data flow** — where does the bad value originate? Trace backward through the call chain until the source is found. Fix at source, not at symptom.
5. **Add diagnostic instrumentation** for multi-component systems — log what enters and exits each layer. Run once. Analyze evidence. Then investigate the failing component.

### Phase 2: Pattern Analysis

1. **Find working examples** — locate similar working code in the same codebase
2. **Compare** — what's different between working and broken? List every difference.
3. **Understand dependencies** — what settings, config, environment does it assume?

### Phase 3: Hypothesis and Testing

1. **Form one hypothesis** — "X is the root cause because Y"
2. **Test minimally** — smallest possible change, one variable at a time
3. **Verify** — worked? → fix it. Didn't work? → new hypothesis, don't stack fixes.

### Phase 4: Fix

1. **Write a failing test** reproducing the bug (TDD applies here too)
2. **Implement single fix** — one change, no "while I'm here" improvements
3. **Verify** — test passes, no other tests broken
4. **If 3+ fixes failed:** STOP. Question the architecture. Discuss with user before attempting more.

### Defense in Depth

After finding root cause, validate at every layer data passes through:

| Layer | Purpose | Example |
|---|---|---|
| Entry point | Reject obviously invalid input | `if (!dir) throw new Error('dir required')` |
| Business logic | Ensure data makes sense for operation | Validate not empty, exists, writable |
| Environment guard | Prevent dangerous ops in specific contexts | Refuse `git init` outside tmpdir in tests |
| Debug instrumentation | Capture context for forensics | Log before dangerous operations |

### Condition-Based Waiting (for flaky tests)

Replace arbitrary `sleep`/`setTimeout` with condition polling:

```typescript
// Bad — guessing at timing
await new Promise(r => setTimeout(r, 500));

// Good — waiting for actual condition
await waitFor(() => getResult() !== undefined, 'result ready', 5000);
```

### Red Flags — STOP and Return to Phase 1

- "Quick fix for now, investigate later"
- "Just try changing X and see"
- Proposing fixes before tracing data flow
- "One more fix attempt" (when already tried 2+)
- Each fix reveals a new problem in a different place
