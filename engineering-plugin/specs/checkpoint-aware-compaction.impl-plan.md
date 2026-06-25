# Checkpoint-Aware Compaction — Implementation Plan

Spec: `specs/checkpoint-aware-compaction.md`
Slug: checkpoint-aware-compaction
Branch/worktree: `feat/html-plan-ecosystem` (current worktree)
Substrate: Node stdlib only, target Node v24. Reuses the `html-plan-ecosystem`
Plan Inbox / SSE bus and the `engplan/1` plan artifact as the source of truth.

Lineage doctrine (parent §9.1/§9.2 — non-negotiable):
- Every subagent dispatch sets **`agent` OR `system_prompt`** (never neither).
- Omitted `model` resolves to the **session model** (`claude-opus-4-8`), never a
  silent weaker default.
- Builder lineage is the coder. Builder may NOT author `.oracle/**` or
  `test/oracle-harness/**` (the adversarial wall already enforced by
  `tools/oracle/diff_gate.js`). CAC code lives under `lib/cac/**` +
  `test/cac/**` — outside the protected oracle zone.

Every phase ends at a checkpoint with a **red→green proof**, a commit, and a
clean tree (these three are the §11 safe-point precondition — dogfood CAC's own
rule while building CAC).

---

## CAC-0 — resume token + config + state-machine skeleton

Build:
- `lib/cac/state.js` — the §5 state machine: `RUNNING → ARMED → CHECKPOINT_REACHED
  → SUSPENDED → COMPACTING → RESUMING → RUNNING`. Pure, no I/O; transitions are
  guarded functions returning `{state, reason}`.
- `lib/cac/resume_token.js` — read/write `.plans/<slug>.resume.json` (`resume/1`
  schema, §5.1). Atomic write (temp + rename). Validates schema; `loop.continue`
  defaults true.
- `lib/cac/config.js` — load `cac` config block (§9) with the documented defaults;
  env override `CAC_*`.

Tests (`test/cac/state.test.js`, `resume_token.test.js`, `config.test.js`):
- illegal transitions rejected (e.g. RUNNING→COMPACTING without a safe point).
- resume token round-trips; missing `next_action` rejected; atomic write leaves
  no partial file on simulated crash.
- watermark hysteresis defaults present.

**C-CAC-0**: state machine + resume token + config green; commit.

---

## CAC-1 — safe-point detection + pre-compact wall

Build:
- `lib/cac/safepoint.js` — classify an event against the §4 taxonomy
  (`subagent.finished | commit.landed | phase.transition | checkpoint.reached |
  inbox.idle`). `isSafePoint(ctx)` returns false while: dirty tree from current
  step, tool-call in flight, subagent running, or checkpoint gate not asserted.
- `lib/cac/pregate.js` — the `pre-compact` hook (§7): returns `{allow, reason}`.
  `allow` ONLY when `at_safe_point && tree_clean && gate_green`. This is the wall.
- Git probes: `lib/cac/git.js` — `headCommit()`, `treeClean()` via stdlib
  `child_process` (no deps).

Tests:
- **S-CAC-1 (red→green)**: pressure true mid-write (dirty tree) → `pregate`
  denies; flip to clean tree at a safe point → allows.
- gate-not-green → denied even on a safe point.
- each event type classified correctly; non-safe moments rejected.

**C-CAC-1**: pre-compact wall proven to block mid-operation; commit.

---

## CAC-2 — artifact-anchored summary

Build:
- `lib/cac/summary.js` — regenerate the compaction summary (§6) from:
  1. `.plans/<slug>.plan.html` embedded `engplan/1` JSON (reuse the ecosystem's
     existing parser — do NOT re-implement),
  2. `git log --oneline <base>..HEAD`,
  3. latest `*.verdict.json` / open Plan Inbox events,
  4. the resume token.
  Output a structured summary object + a markdown rendering. Transcript summary
  (if provided) appended as secondary; artifacts win on conflict.

Tests:
- **S-CAC-6**: summary built from a fixture plan+log+verdict references the active
  phase + next_action + outstanding items; missing `next_action` → fail closed.
- conflict case: transcript claims phase X, artifacts say phase Y → artifacts win.

**C-CAC-2**: artifact-anchored summary green; commit.

---

## CAC-3 — post-compact continuity + auto re-issue + watchdog

Build:
- `lib/cac/postgate.js` — the `post-compact` hook (§5.2): assert `HEAD ==
  token.head_commit`, tree clean (or matches recorded dirty intent), summary
  references active_phase/next_action/outstanding → else raise
  `continuity-violation` (Plan Inbox note, the only human re-entry point).
  If `loop.continue` → emit the next-task dispatch (the anti-fire-and-forget step).
- `lib/cac/watchdog.js` — timer over SUSPENDED→RUNNING; on `resume_deadline_s`
  expiry, re-issue from the resume token.

Tests:
- **S-CAC-3 (red→green)**: after compaction with `loop.continue:true`, next task
  is auto-issued; with `false`, it halts and waits.
- **S-CAC-4**: HEAD changed between token write and resume → `continuity-violation`
  raised; loop does NOT proceed blindly.
- **S-CAC-5**: RESUMING stalls past deadline → watchdog re-issues from token.

**C-CAC-3**: loop provably survives compaction (no fire-and-forget); commit.

---

## CAC-4 — hook wiring + skill instruction edits

Build:
- Register the three hooks (§7) in `plugin.json` / the ecosystem extension:
  `checkpoint.reached` (producer onto SSE), `pre-compact` (gate), `post-compact`
  (resume). Wire them to `lib/cac/*`.
- Plan Inbox emits `checkpoint.reached {slug, phase, checkpoint, head_commit}` at
  every §4 safe point (extend the existing event emitter; reuse the SSE surface).
- Skill edits (§8):
  - `skills/convergence-loop` + `skills/incremental-implementation`:
    *checkpoint-and-yield* rule + resume-without-human-unless-gated.
  - `skills/verification-before-completion`: a checkpoint is not "reached" until
    gate green + tree clean + resume token written.
  - `skills/planning-and-task-breakdown`: plans MUST declare `checkpoints[]` as
    the compaction schedule.

Tests:
- hook registration validated; `checkpoint.reached` observed on the SSE bus in a
  harness run; skill files contain the mandated rule (lint check).

**C-CAC-4**: hooks wired + skills updated; commit.

---

## CAC-5 — e2e self-test (dogfood)

Build:
- `test/cac/e2e.js` — drive the full cycle through the harness/ActorSim:
  simulate context pressure at a checkpoint, run suspend→compact→resume, assert
  the loop continues to the next task. Cover S-CAC-1..7.
- The CAC build itself should have been executed under CAC's own rule — record in
  a decision note that each C-CAC-n was a real checkpoint-and-yield boundary.

Tests:
- all S-CAC-1..7 green end-to-end.

**C-CAC-5**: e2e green; commit. CAC ships.

---

## PRE-WORK (do this FIRST, before CAC-0) — finish the oracle O5 verdict

The oracle self-play left Mission 1 at `state: not-done` with real findings.
Close them before starting CAC so the build stack is trustworthy:

1. **Triage** the Designer's 3 outstanding mutant survivors + the reveal mismatch
   from `.oracle/verdicts/selfplay.verdict.json`:
   - `bad-request` (status 400→200 on malformed id),
   - `too-many-streams` (SSE cap disable),
   - `write-confinement-violation` (write-confine guard drop),
   - `reveal_verified:false` (commit-reveal ordering / `reveal-mismatch`).
   For each: real build bug the adversary caught, OR over-strict oracle assertion?
2. **Dispatch the Builder sibling lineage** (it gets spec + contract + public +
   `.oracle/hidden/labels.json` labels ONLY; forbidden from `.oracle/**` per
   `diff_gate.js`) to fix any genuine product-code violations under `lib/**`.
3. If a finding is an over-strict oracle assertion, the **Designer** (not Builder)
   adjusts the hidden suite, with a recorded justification — Builder never edits
   its own grade.
4. Re-run `npm run oracle:e2e` self-play to a `ship` verdict (`survived_cleanly:
   true`, `reveal_verified: true`), then commit O5.

**C-O5**: oracle grades the build to `ship`; commit. THEN begin CAC-0.
