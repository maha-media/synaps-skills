---
name: convergence-loop
description: Drives multi-agent convergence loops — designer, builder, tester, judge — with information walls, scoring, and fix iterations. Use when one agent can't reliably converge on a complex task.
---

# Convergence Loop

Some work is too complex, too biased-toward-the-author, or too consequential for a single agent to verify itself. A convergence loop splits the work across role-specialised agents, isolates them from each other's biases, scores the result against the spec, and iterates until the score crosses a threshold or the loop gives up explicitly.

This skill is **advisory** — it describes the pattern. To run it, an orchestrator (typically the top-level TUI agent, since only that level has `subagent_start`/`subagent_collect`) dispatches each role as a subagent and routes structured feedback between iterations. The orchestrator owns the budget, the worktree, and the information walls.

## When to Use

- A task is large enough that one agent's quality drifts (medium/large feature work)
- Bias matters: the author of code shouldn't grade their own tests
- The work is testable behaviourally (you can write scenarios and check pass/fail)
- You can afford 4× model cost for higher-confidence convergence
- You want a numeric verdict, not a vibe check

**Skip it for:** trivial changes, exploratory work, anything where a clean spec doesn't yet exist. Convergence requires a target — without one, the loop has nothing to converge to.

## The Pattern

```
       Spec + Plan (inputs)
              │
              ▼
   ┌──────────────────────┐
   │  Designer            │ ← writes test scenarios from spec
   │  (TDD's RED step)    │   no implementation knowledge
   └──────────┬───────────┘
              │ scenarios
              ▼
   ┌──────────────────────┐
   │  Builder             │ ← writes code from plan
   │  (incremental impl   │   in a worktree, one task at a time
   │   + worktrees)       │   commits per task
   └──────────┬───────────┘
              │ code
              ▼
   ┌──────────────────────┐
   │  Tester              │ ← runs the scenarios against the code
   │  (verification-      │   reports pass/fail with evidence
   │   before-completion) │   no opinions, just outcomes
   └──────────┬───────────┘
              │ test report
              ▼
   ┌──────────────────────┐
   │  Judge               │ ← scores result vs spec on N axes
   │  (code-review +      │   produces verdict + structured feedback
   │   security-review)   │
   └──────────┬───────────┘
              │
              ▼
       score ≥ threshold ?
        │              │
       YES             NO ──→ Fix loop (Builder ← feedback)
        │                     bounded by max_iterations
        ▼
       SHIP
```

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
Agents share context. The Builder may see scenario *names* (not specs). The Judge may see source code. Quality comes from numeric scoring, not isolation.

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

The walls only hold if **you** enforce them at dispatch time. The orchestrator controls what each role sees by controlling its task input. Double-check before every dispatch.

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

Feedback describes **behaviour**, not test internals. The Builder fixes the behaviour gap, then the loop returns to Tester → Judge.

### Loop bounds (non-negotiable)

| Limit | Default | Why it exists |
|---|---|---|
| `max_fix_iterations` | 2 | If two attempts at structured feedback don't converge, the loop won't. Stop and escalate. |
| `max_total_calls` | 10 | Hard cap across all roles to prevent runaway cost. |
| Stagnation detection | Last 3 scores within 0.05 | If the score isn't moving, more iterations won't help. Try a fundamentally different approach or escalate. |

When any limit trips: produce an escalation report (current score, structured feedback, stagnation status) and **stop**. Do not silently continue.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I can review my own code carefully" | The Judge role exists because authors don't catch their own blind spots. That's not a weakness — it's a property. |
| "Holdout walls slow things down" | Walls only matter when bias would have changed the outcome. Skip them when speed dominates. Don't skip them and call it speed when bias would have caught the bug. |
| "Numeric scoring is fake precision" | The score's value isn't the decimal — it's forcing the Judge to commit to per-axis evidence. "Looks good" doesn't decompose. |
| "Just one more fix iteration" | The bound exists because at iteration 3+ you're tweaking, not converging. Escalate. |
| "We don't have time for four agents" | Single-agent ship → bug found by user → debugging cycle. The loop's cost is paid once; the alternative is paid forever. |

## Red Flags

- Roles bleeding into each other (Builder reading test specs in holdout mode; Judge sees the code that implemented its own scenarios)
- No threshold defined before the loop runs (you'll move the goalposts after seeing the first score)
- Iterating past `max_fix_iterations` "because it was almost there"
- Score moving in 0.01 increments across iterations — that's noise, not progress
- The Judge's axes drift from `code-review`'s five — invent new axes only when you mean it
- Feedback describing test names instead of behaviour gaps — leaks holdout information
- Builder operating outside a worktree (see `worktrees-by-default`)
- Loop runs with no plan input — you're brainstorming with subagents, not converging

## Verification

Before declaring a convergence run complete:

- [ ] Threshold was fixed before the loop started (not adjusted to match the score it produced)
- [ ] Final verdict is PROCEED *or* the loop stopped explicitly at a documented bound
- [ ] Structured feedback from any rejected iteration is preserved (audit trail)
- [ ] In holdout mode: information walls held for every dispatch (re-check the inputs of each role)
- [ ] Spec_compliance ≥ 0.7 before any other axis was used to lift the overall score
- [ ] Builder's commits live on a worktree branch, not the integration branch
- [ ] The loop was not silently extended past `max_fix_iterations` or `max_total_calls`
