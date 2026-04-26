---
name: test-driven-development
description: Drives development with tests. Use when implementing any logic, fixing any bug, or changing any behavior. Write failing test first, then implementation.
---

# Test-Driven Development

Write a failing test before writing the code that makes it pass. For bug fixes, reproduce the bug with a test before attempting a fix. Tests are proof — "seems right" is not done.

## The TDD Cycle

```
    RED                GREEN              REFACTOR
 Write a test    Write minimal code    Clean up the
 that fails  ──→  to make it pass  ──→  implementation  ──→  (repeat)
      │                  │                    │
      ▼                  ▼                    ▼
   Test FAILS        Test PASSES         Tests still PASS
```

The full cycle runs inside a dedicated worktree. Tests are code; writing them outside an isolated branch contaminates the integration tree. See **worktrees-by-default**.

### Step 1: RED — Write a Failing Test
Write the test first. It must fail. A test that passes immediately proves nothing.

```rust
#[test]
fn creates_task_with_default_status() {
    let task = Task::new("Buy groceries");
    assert_eq!(task.title, "Buy groceries");
    assert_eq!(task.status, Status::Pending);
    assert!(task.created_at.elapsed().unwrap().as_secs() < 1);
}
```

### Step 2: GREEN — Make It Pass
Write the **minimum** code to make the test pass. Don't over-engineer.

### Step 3: REFACTOR — Clean Up
With tests green, improve the code without changing behavior. Run tests after every refactor step.

## The Prove-It Pattern (Bug Fixes)

When a bug is reported, **do not start by trying to fix it.** Start by reproducing it with a test.

```
Bug report → Write test that demonstrates bug → Test FAILS (bug confirmed)
→ Implement fix → Test PASSES (fix proven) → Run full suite (no regressions)
```

## The Test Pyramid

```
          ╱╲
         ╱  ╲         E2E Tests (~5%)
        ╱    ╲        Full user flows
       ╱──────╲
      ╱        ╲      Integration Tests (~15%)
     ╱          ╲     Component interactions, boundaries
    ╱────────────╲
   ╱              ╲   Unit Tests (~80%)
  ╱                ╲  Pure logic, isolated, milliseconds each
 ╱──────────────────╲
```

**The Beyonce Rule:** If you liked it, you should have put a test on it.

### Test Sizes

| Size | Constraints | Speed | Example |
|------|------------|-------|---------|
| **Small** | Single process, no I/O | Milliseconds | Pure function tests |
| **Medium** | Localhost OK, no external services | Seconds | API tests with test DB |
| **Large** | External services allowed | Minutes | E2E, performance benchmarks |

## Writing Good Tests

### Test State, Not Interactions
Assert on the *outcome*, not which methods were called internally.

```rust
// Good: Tests what the function does
#[test]
fn sorts_tasks_by_date_newest_first() {
    let tasks = list_tasks(SortBy::CreatedAt, Order::Desc);
    assert!(tasks[0].created_at > tasks[1].created_at);
}

// Bad: Tests internal implementation details
#[test]
fn calls_sort_with_correct_comparator() { /* brittle */ }
```

### DAMP Over DRY in Tests
**DAMP** (Descriptive And Meaningful Phrases) > DRY in tests. Each test should read like a specification — self-contained and independently understandable. Duplication in tests is acceptable.

### Arrange-Act-Assert
```rust
#[test]
fn marks_overdue_when_deadline_passed() {
    // Arrange
    let task = Task::with_deadline("Test", date(2025, 1, 1));
    // Act
    let result = check_overdue(&task, date(2025, 1, 2));
    // Assert
    assert!(result.is_overdue);
}
```

### One Assertion Per Concept
```rust
// Good: Each test verifies one behavior
#[test] fn rejects_empty_titles() { ... }
#[test] fn trims_whitespace_from_titles() { ... }
#[test] fn enforces_max_title_length() { ... }

// Bad: Everything in one test
#[test] fn validates_titles_correctly() { /* 10 asserts */ }
```

### Name Tests Descriptively
```rust
// Good: reads like a specification
mod complete_task {
    fn sets_status_and_records_timestamp() { ... }
    fn returns_error_for_nonexistent_task() { ... }
    fn is_idempotent_on_already_completed() { ... }
}
```

## Test Anti-Patterns

| Anti-Pattern | Problem | Fix |
|---|---|---|
| Testing implementation details | Breaks on refactor even if behavior unchanged | Test inputs → outputs |
| Flaky tests (timing, order) | Erodes trust in test suite | Deterministic assertions, isolate state |
| Testing framework code | Wastes time testing third-party behavior | Test YOUR code only |
| No test isolation | Pass alone, fail together | Each test owns its setup/teardown |
| Mocking everything | Tests pass, production breaks | Real > fake > stub > mock |

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll write tests after the code works" | You won't. Tests written after test implementation, not behavior. |
| "This is too simple to test" | Simple code gets complicated. The test documents expected behavior. |
| "Tests slow me down" | Tests slow you down now. They speed you up every time you change code later. |
| "I tested it manually" | Manual testing doesn't persist. Tomorrow's change might break it with no warning. |
| "It's just a prototype" | Prototypes become production code. Test debt compounds. |

## Red Flags

- Writing code without any corresponding tests
- Tests that pass on first run (may not test what you think)
- "All tests pass" but no tests were actually run
- Bug fixes without reproduction tests
- Test names that don't describe expected behavior
- Skipping tests to make the suite pass

## Verification

After completing any implementation:
- [ ] Every new behavior has a corresponding test
- [ ] All tests pass: `cargo test`
- [ ] Bug fixes include a reproduction test that failed before the fix
- [ ] Test names describe the behavior being verified
- [ ] No tests were skipped or disabled
- [ ] Coverage hasn't decreased
- [ ] Tests and implementation live on the worktree branch (see **worktrees-by-default**)
