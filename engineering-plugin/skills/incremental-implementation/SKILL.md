---
name: incremental-implementation
description: Delivers changes incrementally. Use when implementing any feature or change that touches more than one file.
---

# Incremental Implementation

Build in thin vertical slices — implement one piece, test it, verify it, then expand. Each increment leaves the system in a working, testable state.

## The Increment Cycle

```
Implement ──→ Test ──→ Verify ──→ Commit ──→ Next slice
```

For each slice:
1. **Implement** the smallest complete piece of functionality
2. **Test** — run the test suite or write a test if none exists
3. **Verify** — tests pass, build succeeds, manual check if needed
4. **Commit** — descriptive message, one logical change
5. **Next slice** — carry forward, don't restart

## Slicing Strategies

### Vertical Slices (Preferred)
```
Slice 1: User can create a task (model + logic + basic UI)
    → Tests pass, feature works end-to-end
Slice 2: User can list tasks (query + logic + UI)
    → Tests pass, both features work
Slice 3: User can edit a task (update + logic + UI)
    → Tests pass, full CRUD
```

### Risk-First Slicing
Tackle the riskiest piece first:
```
Slice 1: Prove the WebSocket connection works (highest risk)
Slice 2: Build real-time updates on the proven connection
Slice 3: Add offline support and reconnection
```

## Implementation Rules

### Rule 0: Be in a Worktree

Before the first edit, verify:

```bash
git worktree list                    # dedicated worktree present
git rev-parse --show-toplevel        # current path is that worktree
git branch --show-current            # branch is feat/<slug> or fix/<slug>
```

If any check fails — **stop and create the worktree first.** Implementation never happens on the primary checkout. See **worktrees-by-default**.

### Rule 1: Simplicity First

Before writing any code: "What is the simplest thing that could work?"

After writing code:
- Can this be done in fewer lines?
- Are abstractions earning their complexity?
- Would a senior engineer say "why didn't you just..."?
- Am I building for hypothetical future requirements or the current task?

```
SIMPLICITY CHECK:
✗ Generic EventBus with middleware for one notification
✓ Simple function call

✗ Abstract factory for two similar components  
✓ Two straightforward components with shared utils

✗ Config-driven builder for three forms
✓ Three components
```

Three similar lines of code is better than a premature abstraction. Implement the naive, obviously-correct version first. Optimize only after correctness is proven with tests.

### Rule 2: Scope Discipline

Touch only what the task requires. Do NOT:
- "Clean up" adjacent code
- Refactor imports in files you're not modifying
- Remove comments you don't fully understand
- Add features not in the spec because they "seem useful"

If you notice something worth improving outside scope, note it:
```
NOTICED BUT NOT TOUCHING:
- src/utils.rs has dead code (unrelated to this task)
- The auth module needs better error messages (separate task)
→ Want me to create tasks for these?
```

### Rule 3: One Thing at a Time

Each increment changes one logical thing. Don't mix concerns. Bad: one commit adding a component, refactoring another, and updating config. Good: three separate commits.

### Rule 4: Keep It Compilable

After each increment, `cargo build` succeeds and `cargo test` passes. Don't leave the codebase broken between slices.

### Rule 5: Feature Flags for Incomplete Features

```rust
// Feature flag for work-in-progress
const ENABLE_MULTIPLAYER: bool = false;

if ENABLE_MULTIPLAYER {
    // New multiplayer UI
}
```

Merge small increments without exposing incomplete work.

### Rule 6: Rollback-Friendly

Each increment should be independently revertable:
- Additive changes (new files, new functions) are easy to revert
- Modifications to existing code should be minimal and focused
- Don't delete and replace in the same commit — separate them

## Increment Checklist

After each increment:
- [ ] Change does one thing and does it completely
- [ ] All existing tests still pass (`cargo test`)
- [ ] Build succeeds (`cargo build`)
- [ ] Linting passes (`cargo clippy`)
- [ ] New functionality works as expected
- [ ] Change is committed with a descriptive message

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll test it all at the end" | Bugs compound. A bug in Slice 1 makes Slices 2-5 wrong. Test each slice. |
| "It's faster to do it all at once" | Feels faster until something breaks and you can't find which of 500 lines caused it. |
| "These changes are too small to commit separately" | Small commits are free. Large commits hide bugs and make rollbacks painful. |
| "This refactor is small enough to include" | Refactors mixed with features make both harder to review and debug. Separate them. |

## Red Flags

- 100+ lines written without running tests
- Multiple unrelated changes in a single increment
- "Let me just quickly add this too" scope expansion
- Skipping test/verify to move faster
- Build or tests broken between increments
- Building abstractions before the third use case demands it
- Touching files outside task scope "while I'm here"
- Editing files on the primary checkout instead of the worktree

## Verification

After completing all increments for a task:
- [ ] Each increment was individually tested and committed
- [ ] Full test suite passes
- [ ] Build is clean (`cargo build`, `cargo clippy`)
- [ ] Feature works end-to-end as specified
- [ ] No uncommitted changes remain
- [ ] All commits live on the worktree branch, not on the integration branch directly
