---
name: workflow
description: End-to-end development workflow — brainstorm designs, write plans, execute in batches, finish branches. Includes TDD, git worktrees, and systematic debugging. Use for any creative or implementation work from idea to merge.
---

# Development Workflow

Complete workflow from idea to shipped code. Four phases, plus disciplines that apply throughout.

1. **Brainstorm** — explore the idea, design the solution
2. **Plan** — break into bite-sized tasks with tests and verification
3. **Execute** — run tasks in batches with review checkpoints
4. **Finish** — verify, merge/PR/keep/discard

**Disciplines** (apply during all phases):
- **TDD** — no production code without a failing test first
- **Worktrees** — isolated workspaces for feature work
- **Debugging** — systematic root cause investigation, never guess

Jump to any phase. If a plan already exists, skip to Execute. If a bug is encountered, switch to the Debugging discipline. For detailed discipline procedures, consult `references/disciplines.md`.

---

## Phase 1: Brainstorm

Turn ideas into designs through collaborative dialogue.

**Hard gate:** Do NOT write code until a design is presented and approved. Even "simple" tasks get a short design (a few sentences is fine).

### Process

1. **Explore context** — check files, docs, recent commits
2. **Ask questions** — one at a time, prefer multiple choice
3. **Propose 2–3 approaches** — with trade-offs and a recommendation
4. **Present design** — section by section, get approval incrementally
5. **Save design** — write to `docs/plans/YYYY-MM-DD-<topic>-design.md`, commit

### Black-Box Engineering Check

Before presenting the design, evaluate whether the problem fits the **Black-Box Engineering pipeline** — a multi-agent loop that designs, builds, blind-tests, scores, and refines until convergence. See the `black-box-engineering` skill for full details.

**Offer it when ALL of these apply:**
- Multiple interacting components
- Testable requirements (assertions, expected behaviors)
- Enough complexity that iteration improves results
- Complexity tier is Medium or Large (≥30 min)

**Two modes:**
- **Informed** (default) — agents share context, faster iteration
- **Holdout** (`--holdout`) — full information walls between agents, bias elimination

**Don't offer it for:** simple edits, config changes, research tasks, anything Tiny tier.

If accepted: design → Plan → `black-box-engineering` skill runs `run-pipeline.sh` (skips Phase 3 Execute here).

### Principles

- One question at a time
- YAGNI ruthlessly — cut unnecessary features
- Explore alternatives before settling
- Validate incrementally — approval after each design section

---

## Phase 2: Plan

Write an implementation plan assuming the engineer has zero context. Every file path, code block, test, and verification command must be explicit.

**Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`

### Plan Header

```markdown
# [Feature Name] Implementation Plan

**Goal:** One sentence
**Architecture:** 2–3 sentences
**Design Doc:** `docs/plans/YYYY-MM-DD-<topic>-design.md`
**Estimated Tasks:** N tasks
**Complexity:** Tiny | Medium | Large
```

### Task Structure

Each task is one action (2–5 minutes). Every task follows TDD:

````markdown
### Task N: [Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py`
- Test: `tests/exact/path/to/test.py`

**Step 1: Write failing test**
```python
def test_behavior():
    assert function(input) == expected
```

**Step 2: Verify it fails**
Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL — "function not defined"

**Step 3: Implement**
```python
def function(input):
    return expected
```

**Step 4: Verify it passes**
Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

**Step 5: Commit**
```bash
git add -A && git commit -m "feat: add feature"
```
````

### Principles

- Exact file paths always
- Complete code — not "add validation"
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

---

## Phase 3: Execute

Load the plan, execute tasks in batches, pause for review between batches.

### Setup: Git Worktree (recommended)

Before executing, set up an isolated workspace:

```bash
# Check for existing worktree directory
ls -d .worktrees 2>/dev/null || ls -d worktrees 2>/dev/null

# Ensure it's gitignored
git check-ignore -q .worktrees 2>/dev/null || echo ".worktrees/" >> .gitignore

# Create worktree
git worktree add .worktrees/<feature> -b feature/<feature>
cd .worktrees/<feature>

# Install deps (auto-detect)
[ -f package.json ] && npm install
[ -f Cargo.toml ] && cargo build
[ -f requirements.txt ] && pip install -r requirements.txt
[ -f go.mod ] && go mod download

# Verify clean baseline
npm test / cargo test / pytest / go test ./...
```

If baseline tests fail: report and ask before proceeding.

### Execution Process

1. **Load and review** — read the plan, raise concerns before starting
2. **Execute batch** — first 3 tasks by default
   - Follow TDD: write test → watch it fail → implement → watch it pass
   - Run verifications as specified
   - Mark completed
3. **Report** — show what was done + verification output, say "Ready for feedback."
4. **Continue** — apply feedback, execute next batch, repeat

### When to Stop

**STOP immediately when:**
- Blocker mid-batch (missing dependency, test fails, unclear instruction)
- Plan has critical gaps
- Verification fails repeatedly — switch to Debugging discipline

Ask for help — don't guess.

---

## Phase 4: Finish

Verify tests → present options → execute → clean up.

### Process

**1. Run tests**
```bash
npm test / cargo test / pytest / go test ./...
```
If tests fail: stop, report, cannot proceed.

**2. Present options**
```
Implementation complete. What would you like to do?

1. Merge back to <base-branch> locally
2. Push and create a Pull Request
3. Keep the branch as-is (I'll handle it later)
4. Discard this work
```

**3. Execute choice**

| Option | Action |
|--------|--------|
| **Merge** | `git checkout main && git merge <branch> && git branch -d <branch>` |
| **PR** | `git push -u origin <branch> && gh pr create` |
| **Keep** | Report branch/worktree location, done |
| **Discard** | Confirm first, then `git branch -D <branch>` |

**4. Clean up worktree** (if applicable):
```bash
git worktree remove .worktrees/<feature>
```
Keep for "as-is", remove for merge/PR/discard.

### Red Flags

- Proceeding with failing tests
- Merging without post-merge test verification
- Deleting work without confirmation
- Force-pushing without explicit request

---

# Disciplines

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
npm test  # or cargo test / pytest / etc.
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

If you haven't completed Phase 1 below, you cannot propose fixes.

### Phase 1: Root Cause Investigation

1. **Read error messages carefully** — don't skip past them. Read the full stack trace. Note line numbers.
2. **Reproduce consistently** — exact steps, every time. Not reproducible → gather more data, don't guess.
3. **Check recent changes** — `git diff`, recent commits, new deps, config changes.
4. **Trace data flow** — where does the bad value originate? Trace backward through the call chain until you find the source. Fix at source, not at symptom.
5. **Add diagnostic instrumentation** for multi-component systems — log what enters and exits each layer. Run once. Analyze evidence. Then investigate the failing component.

### Phase 2: Pattern Analysis

1. **Find working examples** — locate similar working code in the same codebase
2. **Compare** — what's different between working and broken? List every difference.
3. **Understand dependencies** — what settings, config, environment does it assume?

### Phase 3: Hypothesis and Testing

1. **Form one hypothesis** — "I think X is the root cause because Y"
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
// ❌ Guessing at timing
await new Promise(r => setTimeout(r, 500));

// ✅ Waiting for actual condition
await waitFor(() => getResult() !== undefined, 'result ready', 5000);
```

### Red Flags — STOP and Return to Phase 1

- "Quick fix for now, investigate later"
- "Just try changing X and see"
- Proposing fixes before tracing data flow
- "One more fix attempt" (when already tried 2+)
- Each fix reveals a new problem in a different place
