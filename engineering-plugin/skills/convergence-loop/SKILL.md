---
name: convergence-loop
description: Drives multi-agent convergence loops — designer, builder, tester, judge — with information walls, scoring, and fix iterations. Use when one agent can't reliably converge on a complex task.
---

# Convergence Loop

Some work is too complex, too biased-toward-the-author, or too consequential for a single agent to verify itself. A convergence loop splits the work across role-specialised agents, isolates them from each other's biases, scores the result against the spec, and iterates until the score crosses a threshold or the loop gives up explicitly.

This skill is **advisory** — it describes the pattern. To run it, an orchestrator dispatches each role as a **fresh, blocking, one-shot subagent** and routes only explicit artifacts between roles. The orchestrator owns the budget, the worktree, the information walls, and the context packet given to each role.

## Critical Dispatch Rule: Sequential Fresh Context Only

Convergence optimizes for context quality and bias control, **not speed**. Run the pipeline one role at a time.

Allowed:

- `subagent` / one-shot blocking dispatch for each role.
- A fresh subagent process/context for every Designer, Builder, Tester, Judge, or fix-loop call.
- The orchestrator waits for the current role to finish, preserves its artifact, then decides the next role's context packet.

Forbidden:

- `subagent_start` for convergence roles.
- Any async/background convergence role.
- Overlapping Builder/Tester/Judge work.
- `subagent_resume` to continue a prior convergence role.
- `subagent_steer` to modify a running convergence role.
- Reusing an old role conversation as the next role's context.

Why: the convergence loop depends on controlled context. Async overlap causes stale assumptions, role bleed, and unsafe concurrent edits. Resuming or steering carries hidden context forward and defeats the information-wall contract. If a role needs correction, stop it, record why the result is invalid, and dispatch a new fresh subagent with a corrected explicit context packet.

## Authorization

This pattern is **invoked by the orchestrator only when the plan
explicitly declares `convergence: informed` or `convergence: holdout`**.
The decision is owned by the human during
**planning-and-task-breakdown**, not by the agent at runtime.

Why the human owns it:

- **Cost** — ~4× single-agent model spend. Budget is a human decision.
- **Stakes** — "is this consequential enough for bias elimination?"
  requires context the agent doesn't always have (security posture,
  blast radius, whether a human will review the output).
- **Policy** — threshold, axis weights, and loop bounds are policy
  choices, not preferences. They must be fixed before the first score is
  seen, otherwise the loop becomes goalpost-moving theatre.

If the plan says `convergence: none`, **do not run this loop** even if
the work feels risky mid-implementation. Surface the risk to the human
and request a plan amendment. Unilaterally escalating to convergence is
unauthorized; unilaterally skipping it when the plan demanded it is also
unauthorized.

## When to Use

Use the criteria below during **planning-and-task-breakdown** to choose
between `convergence: none`, `informed`, or `holdout`. These are
human-evaluated checks, not agent-runtime decisions.

Choose **`informed`** or **`holdout`** when any of these hold:

- Bias matters: the author of code shouldn't grade their own tests
- Medium/large feature work where one agent's quality drifts over a long
  context
- The work is testable behaviourally (you can write scenarios and check
  pass/fail) — convergence requires a target
- You can afford ~4× model cost for higher-confidence convergence
- You want a numeric verdict with axis-level evidence, not a vibe check

Choose **`holdout`** specifically when:

- Security-critical code where the author marking their own homework is
  unacceptable
- The output will ship without human review
- Bias elimination matters more than speed

Choose **`none`** for:

- Trivial changes, refactors confined to one file
- Exploratory work where the spec doesn't yet exist (convergence needs a
  target — without one, the loop has nothing to converge to)
- Anything where human review at the end will catch the same issues
  convergence would catch


## The Pattern

```
       Spec + Plan (inputs)
              │
              ▼
   ┌──────────────────────┐
   │  Designer            │ ← fresh blocking subagent; writes test scenarios
   │  (TDD's RED step)    │   no implementation knowledge
   └──────────┬───────────┘
              │ scenarios artifact recorded by orchestrator
              ▼
   ┌──────────────────────┐
   │  Builder             │ ← fresh blocking subagent; writes code from plan
   │  (incremental impl   │   in a worktree, one task at a time
   │   + worktrees)       │   commits per task
   └──────────┬───────────┘
              │ code/artifact snapshot recorded by orchestrator
              ▼
   ┌──────────────────────┐
   │  Tester              │ ← fresh blocking subagent; runs scenarios
   │  (verification-      │   reports pass/fail with evidence
   │   before-completion) │   no opinions, just outcomes
   └──────────┬───────────┘
              │ test report artifact recorded by orchestrator
              ▼
   ┌──────────────────────┐
   │  Judge               │ ← fresh blocking subagent; scores vs spec
   │  (code-review +      │   produces verdict + structured feedback
   │   security-review)   │
   └──────────┬───────────┘
              │
              ▼
       score ≥ threshold ?
        │              │
       YES             NO ──→ Fix loop (fresh Builder subagent ← feedback)
        │                     bounded by max_iterations
        ▼
       SHIP
```

## Orchestrator Protocol

For each role call:

1. Ensure no convergence subagent is already running.
2. Build a minimal explicit context packet from durable artifacts:
   - spec and plan excerpts
   - convergence mode and policy
   - allowed role inputs under the information-wall mode
   - current worktree path and branch, if the role may touch files
   - prior role artifacts that are allowed for this role
3. Dispatch exactly one fresh blocking subagent.
4. Wait for it to finish.
5. Save its output as an artifact in the worktree or session log.
6. Verify the worktree state before dispatching the next role.
7. If the result is invalid or incomplete, do **not** steer/resume it; dispatch a new fresh subagent with corrected explicit context.

## Roles → Engineering Skills

Each role enacts a discipline this plugin already describes. The convergence loop's value is in the *composition*, not in inventing new disciplines.

| Role | What it does | Discipline it enacts |
|---|---|---|
| **Designer** | Writes behavioural test scenarios from the spec. Sees the design, not the implementation. | `test-driven-development` — the RED step, written by someone who can't peek at the code |
| **Builder** | Writes code in a worktree, one task at a time, commits per task, follows feedback. | `incremental-implementation` + `worktrees-by-default` |
| **Tester** | Runs the scenarios against the code. Reports pass/fail with evidence. Adds zero interpretation. | `verification-before-completion` — evidence before any claim |
| **Judge** | Scores the result against the spec on multiple axes. Renders verdict and structured feedback. | `code-review` (multi-axis review) + `security-review` (the security axis) |
| **Fix loop** | When the verdict is REWORK, structured feedback drives Builder's next iteration; root-cause focused. | `systematic-debugging` — fix the cause the feedback points at, not the symptom |
| **Spec + Plan inputs** | Required before the loop runs. | `spec-driven-development` + `planning-and-task-breakdown` |

If you find yourself writing role behaviour that diverges from the linked skill, fix the divergence — don't fork the discipline.

## Information Walls

Two modes. Pick one before the loop starts.

### Informed (default)

Agents share selected artifacts, not conversation history. The Builder may see scenario *names* (not specs). The Judge may see source code. Quality comes from numeric scoring, not isolation.

Use for: most work. Faster, cheaper, collaborative.

### Holdout (strict)

Information walls between every role. Concretely:

```
Designer NEVER sees the code.
Builder NEVER sees the test specs.
Tester NEVER sees the design rationale (only scenarios + code).
Judge NEVER sees the source code (only spec + test report).
```

Use for: high-stakes work where bias elimination matters more than speed. Security-critical code, work being shipped without human review, anything where "the author would mark their own homework favourably."

The walls only hold if **you** enforce them at dispatch time. The orchestrator controls what each role sees by controlling its task input. Double-check before every dispatch. Conversation history is also context: do not pass it unless the role is explicitly allowed to see it.

## Scoring

The Judge produces a numeric overall score with axis-level breakdown. The exact axes should match `code-review`:

| Axis | What it measures | Default weight |
|---|---|---|
| Spec compliance | Does it do what the spec asked? | 0.35 |
| Code quality | Readable, simple, idiomatic? | 0.20 |
| Test coverage | Are the right things tested? | 0.20 |
| Edge cases | Failure modes, boundaries handled? | 0.15 |
| Security | Per `security-review` checklist | 0.10 |

Weights sum to 1.0. Adjust per project, but keep spec compliance dominant — it's the only axis the user actually asked for.

### Verdict bands

| Score | Verdict | Action |
|---|---|---|
| ≥ threshold (default 0.8) | **PROCEED** | Ship |
| 0.7 – threshold | **REVIEW** | Human decides — automation cannot adjudicate this band |
| < 0.7 | **REWORK** | Fix loop |

Two-stage gate: if spec_compliance < 0.7, stop scoring further axes. Build the right thing before optimising for the right way.

## The Fix Loop

When verdict = REWORK, route structured feedback back to the Builder:

```
{
  "behavior_gap":     "what the spec says should happen",
  "observed_behavior": "what actually happened",
  "axis":             "which scoring axis this affects",
  "severity":         "high | medium | low"
}
```

Feedback describes **behaviour**, not test internals. The Builder fixes the behaviour gap, then the loop returns to Tester → Judge. Each fix-loop Builder, Tester, and Judge call is still a fresh blocking subagent; never resume the previous role.

### Loop bounds (non-negotiable)

| Limit | Default | Why it exists |
|---|---|---|
| `max_fix_iterations` | 2 | If two attempts at structured feedback don't converge, the loop won't. Stop and escalate. |
| `max_total_calls` | 10 | Hard cap across all fresh role calls to prevent runaway cost. |
| Stagnation detection | Last 3 scores within 0.05 | If the score isn't moving, more iterations won't help. Try a fundamentally different approach or escalate. |

When any limit trips: produce an escalation report (current score, structured feedback, stagnation status) and **stop**. Do not silently continue.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I can review my own code carefully" | The Judge role exists because authors don't catch their own blind spots. That's not a weakness — it's a property. |
| "Holdout walls slow things down" | Walls only matter when bias would have changed the outcome. Skip them when speed dominates. Don't skip them and call it speed when bias would have caught the bug. |
| "Async is faster" | Speed is not the convergence objective. Async overlap corrupts context, creates stale assumptions, and risks concurrent worktree edits. |
| "I'll resume the Builder with more instructions" | Resume imports hidden context. Start a fresh Builder with an explicit corrected context packet. |
| "Numeric scoring is fake precision" | The score's value isn't the decimal — it's forcing the Judge to commit to per-axis evidence. "Looks good" doesn't decompose. |
| "Just one more fix iteration" | The bound exists because at iteration 3+ you're tweaking, not converging. Escalate. |
| "We don't have time for four agents" | Single-agent ship → bug found by user → debugging cycle. The loop's cost is paid once; the alternative is paid forever. |

## Red Flags

- Loop invoked without `convergence: informed` or `convergence: holdout`
  declared in the plan — unauthorized escalation
- Plan amended mid-run to enable convergence after a single-agent attempt
  produced bad output (retroactive justification — the threshold no
  longer means anything)
- Threshold or axis weights changed after the first score (goalpost
  moving)
- Any convergence role launched with `subagent_start`
- Any convergence role running while another convergence role is active
- Use of `subagent_resume` or `subagent_steer` in the convergence run
- Roles bleeding into each other (Builder reading test specs in holdout mode; Judge sees the code that implemented its own scenarios)
- Hidden context passed via prior conversation history instead of explicit artifacts
- No threshold defined before the loop runs (you'll move the goalposts after seeing the first score)
- Iterating past `max_fix_iterations` "because it was almost there"
- Score moving in 0.01 increments across iterations — that's noise, not progress
- The Judge's axes drift from `code-review`'s five — invent new axes only when you mean it
- Feedback describing test names instead of behaviour gaps — leaks holdout information
- Builder operating outside a worktree (see `worktrees-by-default`)
- Loop runs with no plan input — you're brainstorming with subagents, not converging

## Verification

Before declaring a convergence run complete:

- [ ] Plan declared `convergence: informed` or `convergence: holdout` *before* the loop ran (not amended after a bad single-agent result)
- [ ] Threshold was fixed before the loop started (not adjusted to match the score it produced)
- [ ] Every role dispatch was a fresh blocking one-shot subagent
- [ ] No convergence role used async start, resume, or steering
- [ ] No two convergence roles overlapped in time
- [ ] Final verdict is PROCEED *or* the loop stopped explicitly at a documented bound
- [ ] Structured feedback from any rejected iteration is preserved (audit trail)
- [ ] In holdout mode: information walls held for every dispatch (re-check the inputs of each role)
- [ ] Spec_compliance ≥ 0.7 before any other axis was used to lift the overall score
- [ ] Builder's commits live on a worktree branch, not the integration branch
- [ ] The loop was not silently extended past `max_fix_iterations` or `max_total_calls`
