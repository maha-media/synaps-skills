---
name: verification-before-completion
description: Use before claiming work is complete, fixed, or passing, or before committing/creating PRs — run verification commands and confirm output before any success claim; evidence before assertions.
---

# Verification Before Completion

*Where this fits: the **verify** stage of plan → implement → verify → review — and the canonical owner of the evidence-before-claims rule the other skills reference.*

## Overview

Claiming work is complete without fresh verification evidence is invalid. Evidence before claims.

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = unverified. Report actual uncertainty instead of claiming success
```

## Verification Command Selection

Choose commands that match the project. Run the strongest configured checks available; if a tool is missing, report that explicitly instead of pretending it passed.

| Project type | Minimum useful verification |
|---|---|
| Rust | `cargo fmt --check`, `cargo test`, `cargo clippy --all-targets --all-features -- -D warnings` when clippy is available |
| Node/JS | `npm test`; `npm run lint` or `npm run typecheck` if defined |
| Python | `pytest`; `ruff`, `mypy`, or project-configured checks if present |
| Shell | `bash -n script.sh`; `shellcheck` if available |
| Docs/skills | frontmatter/manifest validation, link/path sanity, grep for corrupted characters |
| Synaps plugin | manifest validation plus plugin setup/test scripts when present |
| Mixed repo | run checks for every touched subsystem, not just the easiest one |

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |
| Working in isolation | `git worktree list` + `git rev-parse --show-toplevel` confirm dedicated worktree | "I created a branch" |
| Worktree cleaned up | `git worktree list` shows only primary; merged branch deleted locally; disk dir gone | "PR merged" alone |

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "I'm confident" | Confidence ≠ evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter ≠ compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion ≠ excuse |
| "Partial check is enough" | Partial proves nothing |
| "Different words so rule doesn't apply" | If it implies success, it needs evidence. |

## Key Patterns

**Tests:**
```
✅ [Run test command] [See: 34/34 pass] "All tests pass"
❌ "Should pass now" / "Looks correct"
```

**Regression tests (TDD Red-Green):**
```
✅ Write → Run (pass) → Revert fix → Run (MUST FAIL) → Restore → Run (pass)
❌ "I've written a regression test" (without red-green verification)
```

**Build:**
```
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
```

**Requirements:**
```
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
```

**Agent delegation:**
```
✅ Agent reports success → Check VCS diff → Verify changes → Report actual state
❌ Trust agent report
```

## Why This Matters

From 24 failure memories:
- unverified success claims broke trust
- Undefined functions shipped - would crash
- Missing requirements shipped - incomplete features
- Time wasted on false completion → redirect → rework
- Trust depends on precise status reporting.

## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**
- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness

## HTML Plan Ecosystem integration

When the HTML Plan Ecosystem is in use (schema `engplan/1`):

- **Evidence attaches to `type:"evidence"` sections.** Fresh verification
  output (test runs, build exit codes, red→green proofs) is recorded as
  `type:"evidence"` sections on the `<slug>.plan.html` artifact, linked to the
  task it verifies. Claims live next to their evidence, auditable.
- **Reconcile the Plan Inbox before any completion claim.** This is checkpoint
  3 of the reconcile loop. Acknowledge and resolve every open event
  (incorporate / reject / defer / block) before asserting "done". An
  unreconciled inbox means the claim is premature.
- **"Done" means a machine can rebuild + re-verify unattended.** A task is not
  complete until a machine can rebuild the artifact and re-run verification
  with no human present — **including simulated human actions** (approvals,
  inbox steering, UI interactions driven headlessly by the automated harness).
  If completion depends on a human re-running something by hand, it is not done.
- Do not bind any server to `0.0.0.0` and do not load assets from a CDN.

## The Bottom Line

**No shortcuts for verification.**

Run the command. Read the output. THEN claim the result.

This is non-negotiable.

## Checkpoint-and-yield (CAC)

A checkpoint is **not "reached"** until all three of these hold (the safe-point
precondition, per checkpoint-aware-compaction §8):

1. its gate is asserted **green**, AND
2. the working **tree is clean**, AND
3. the **resume token is written** to disk.

Until that triad is true, do not emit `checkpoint.reached` and do not permit
compaction — the boundary is not durable yet.

## Related skills

- **test-driven-development** — supplies the red→green proofs that are core verification evidence.
- **code-review** — consumes this verified evidence at the merge gate.
- **systematic-debugging** — the loop you enter when verification surfaces a failure.
