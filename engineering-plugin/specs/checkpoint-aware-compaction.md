# Checkpoint-Aware Compaction (CAC)

Status: drafting
Slug: checkpoint-aware-compaction
Schema target: encodes into skills + Synaps hooks; consumes the `engplan/1` plan + Plan Inbox event bus from `html-plan-ecosystem.md`.

---

## 1. Problem

During long-running plan execution an agent's context window fills. Today the
human babysits it: they watch the context meter, wait until the agent is *finishing
a checkpoint* (a subagent returns, a commit lands), then hand-steer:

> `when the subagent finishes please pause for a break.`

…and run a manual compaction before letting it continue. This works because the
human is acting as a **checkpoint-aware compaction governor**. It is a hack that
should be system behavior.

Two failure modes the hack avoids, and that naive autocompaction does NOT:

1. **Mid-operation compaction corrupts in-flight state.** Firing at a raw token
   threshold can trigger inside a multi-file write, a tool call, or an
   un-committed edit. The transcript is severed while the working set is still
   only in the model's head → the resumed agent has lost the thread.
2. **Fire-and-forget compaction kills the loop.** A compaction that summarizes and
   stops, with no resume contract, ends the run. The human then has to notice,
   re-orient, and re-launch. The loop must survive compaction.

## 2. Core principle

> **Compact only when `context_pressure AND at_safe_point`. Compaction is a
> suspend → compact → resume cycle that preserves the execution loop. Never on a
> token threshold alone; never mid-operation; never fire-and-forget.**

Both signals must be true:

- **`context_pressure`** — cheap runtime signal: context utilization above a high
  watermark (default `θ:high` / ≥ 85%). Hysteresis: re-arm only below a low
  watermark (default ≤ 60%) to prevent thrash.
- **`at_safe_point`** — a checkpoint boundary where durable state already lives on
  disk, so the transcript is no longer the source of truth.

## 3. Why this is safe *here*

The HTML Plan Ecosystem makes the **recovery state the artifacts, not the
transcript**:

- `.plans/<slug>.plan.html` — the plan, its sections, checkpoints, statuses.
- `git log --oneline` — what has landed.
- latest `*.verdict.json` / Plan Inbox events — the last grade and outstanding work.

Therefore a checkpoint compaction can **regenerate its summary from artifacts**
rather than trusting the conversation tail. This is strictly higher fidelity than
generic compaction, because it is anchored to ground truth that cannot drift.

## 4. Safe points (the compaction schedule)

A safe point is any of these Plan Inbox / runtime events:

| Event | Emitted when |
|---|---|
| `subagent.finished` | a dispatched subagent (any lineage) returns its result |
| `commit.landed` | a git commit is created on the working branch |
| `phase.transition` | the active plan phase advances (Pn → Pn+1, On → On+1) |
| `checkpoint.reached(Cn)` | a plan checkpoint passes its gate |
| `inbox.idle` | the agent has flushed work and is awaiting input |

The plan's `checkpoints[]` array (C0…C5, C-O0…C-O5) **is** the compaction
schedule. A safe point is not "any quiet moment" — it is a declared boundary
where the plan invariant holds: everything before it is durably recorded.

A safe point is *invalid* (compaction refused) while any of these hold:
- an uncommitted edit / dirty tree from the current step is pending its commit,
- a tool call is in flight,
- a subagent is still running,
- the current checkpoint's gate has not yet been asserted.

## 5. The resume contract (do not break the loop)

Compaction is a **state-machine transition, not a stop**. The loop must continue
on the other side without human relaunch.

```
RUNNING
  └─(context_pressure becomes true)──> ARMED
ARMED
  └─(next safe point reached)─────────> CHECKPOINT_REACHED
CHECKPOINT_REACHED
  ├─ persist resume token (§5.1)
  ├─ assert tree clean + checkpoint gate green
  └────────────────────────────────────> SUSPENDED
SUSPENDED
  └─(pre-compact hook ok)─────────────> COMPACTING
COMPACTING
  ├─ build artifact-anchored summary (§6)
  └────────────────────────────────────> RESUMING
RESUMING
  ├─ rehydrate from resume token + summary
  ├─ post-compact hook verifies continuity (§5.2)
  └────────────────────────────────────> RUNNING (next task)
```

### 5.1 Resume token

Written to disk *before* SUSPENDED so it survives the compaction (and a crash):

```jsonc
// .plans/<slug>.resume.json   (runtime, gitignored)
{
  "schema": "resume/1",
  "slug": "html-plan-ecosystem",
  "branch": "feat/html-plan-ecosystem",
  "worktree": "/abs/path/.worktrees/...",
  "active_phase": "O5",
  "last_checkpoint": "C-O4",
  "next_action": "fix oracle survivors: bad-request, too-many-streams, write-confinement-violation; re-run self-play",
  "head_commit": "b344bf1",
  "outstanding": ["selfplay state=not-done, outstanding_finds=3, reveal_verified=false"],
  "pending_subagents": [],
  "loop": { "kind": "convergence", "continue": true },
  "issued_at": "2026-06-25T14:46:00Z"
}
```

`loop.continue: true` is the anti-fire-and-forget flag. RESUMING reads it and
**re-issues the next task automatically**. The agent does not wait for a human
unless `next_action` is explicitly a human-gated step (e.g. plan approval).

### 5.2 Continuity verification (post-compact)

After RESUMING, before declaring RUNNING, the post-compact hook asserts:

1. `git HEAD == resume_token.head_commit` (no work lost or silently added).
2. working tree clean (or matches the recorded dirty intent).
3. the rehydrated summary references `active_phase`, `next_action`, and the
   outstanding items — fail closed if absent.
4. `loop.continue == true` → the next task is dispatched; the run continues.

If any assertion fails, the loop does **not** silently die: it raises a
`continuity-violation` to the orchestrator (Plan Inbox note), which is the only
sanctioned place a human is pulled back in.

### 5.3 Watchdog

A timer covers the SUSPENDED→RUNNING window. If RESUMING does not reach RUNNING
within `resume_deadline` (default 120 s), the watchdog re-issues from the resume
token. Compaction can never leave the loop parked.

## 6. Artifact-anchored summary

The compaction summary is **regenerated**, not excerpted from scrollback:

1. Parse `.plans/<slug>.plan.html` → embedded `engplan/1` JSON: title, status,
   sections, `checkpoints[]` with pass/fail, decision records.
2. `git log --oneline <base>..HEAD` → what landed.
3. Latest verdict(s) / open Plan Inbox events → outstanding work + grades.
4. The resume token → active phase + next action + loop intent.

The generic transcript summary is appended as *secondary* context only. Ground
truth wins on conflict.

## 7. Hook contracts (Synaps)

Three hooks, registered by the engineering plugin:

| Hook | Fires | Contract |
|---|---|---|
| `checkpoint.reached` | producer | emitted onto the Plan Inbox SSE bus at every §4 safe point; carries `{slug, phase, checkpoint, head_commit}` |
| `pre-compact` | gate | runtime MUST call before compacting; returns `{allow: bool, reason}`. Returns `allow:false` unless `at_safe_point && tree_clean && gate_green`. This is the wall that makes mid-operation compaction physically impossible. |
| `post-compact` | resume | runtime MUST call after compacting; performs §5.2 continuity verification and, if `loop.continue`, re-issues the next task. |

The harness/Plan Inbox from `html-plan-ecosystem.md` is the reference producer;
the same SSE surface humans and orchestrators already use carries these events.

## 8. Skill instruction changes

- **`convergence-loop`** and **`incremental-implementation`** gain a rule:
  > When context is tight, do **not** push through a checkpoint. *Checkpoint-and-
  > yield*: land the commit, write the verdict, emit `checkpoint.reached`, write the
  > resume token, then suspend. Compaction happens *between* checkpoints, never
  > inside one. After compaction, continue from the resume token without waiting
  > for a human unless `next_action` is human-gated.
- **`verification-before-completion`**: a checkpoint is not "reached" until its
  gate is asserted green AND the tree is clean AND the resume token is written.
  These three are the safe-point precondition.
- **`planning-and-task-breakdown`**: every plan must declare `checkpoints[]`;
  checkpoints are the compaction schedule, so phases must be sized to land a
  durable artifact at each one.

## 9. Configuration

```jsonc
{
  "cac": {
    "high_watermark": 0.85,      // arm compaction
    "low_watermark": 0.60,       // re-arm hysteresis
    "resume_deadline_s": 120,    // watchdog
    "require_clean_tree": true,
    "require_gate_green": true,
    "summary_source": "artifacts-first"
  }
}
```

## 10. Failure modes & guarantees

| Risk | Guarantee |
|---|---|
| Compact mid-write/tool-call | `pre-compact` returns `allow:false` off a safe point — physically blocked |
| Lost work across compaction | resume token persisted before SUSPENDED; HEAD asserted in post-compact |
| Loop dies silently (fire-and-forget) | `loop.continue:true` re-issues next task; watchdog re-issues on stall |
| Summary drift / hallucinated state | artifact-anchored regeneration; transcript is secondary |
| Compaction thrash | high/low watermark hysteresis |
| Resume into wrong repo/branch | resume token records branch+worktree+HEAD; verified before RUNNING |

## 11. Test scenarios

- **S-CAC-1**: pressure true mid-write → `pre-compact` denies; no compaction until commit lands.
- **S-CAC-2**: pressure true at `subagent.finished` + clean tree + gate green → compaction proceeds.
- **S-CAC-3**: after compaction, `loop.continue:true` → next task auto-issued; no human input.
- **S-CAC-4**: HEAD changed between token write and resume → `continuity-violation` raised to inbox, loop does not proceed blindly.
- **S-CAC-5**: RESUMING stalls past `resume_deadline_s` → watchdog re-issues from token.
- **S-CAC-6**: summary regenerated from `plan.html` + git log + verdict matches active phase; missing `next_action` → fail closed.
- **S-CAC-7**: pressure oscillates around watermark → hysteresis prevents repeated compaction.

## 12. Relationship to current run (worked example)

What the human did by hand on the oracle mission maps 1:1:

```
manual:   "when the subagent finishes please pause for a break"
CAC:      on subagent.finished, if θ:high
            → checkpoint.reached(C-O5)
            → pre-compact{allow:true}  (tree clean, gate green)
            → artifact-anchored recompaction
            → post-compact: loop.continue → re-issue "fix 3 survivors + reveal"
            → RUNNING
```

The human is hand-emulating a hook that should fire itself — and the resume
contract is what guarantees the impl agent keeps going once compaction finishes.
