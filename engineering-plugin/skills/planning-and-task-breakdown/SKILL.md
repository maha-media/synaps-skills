---
name: planning-and-task-breakdown
description: Breaks work into ordered tasks. Use when you have a spec or clear requirements and need to break work into implementable tasks.
---

# Planning and Task Breakdown

Decompose work into small, verifiable tasks with explicit acceptance criteria. Every task should be small enough to implement, test, and verify in a single focused session.

## The Planning Process

### Step 1: Plan Mode (Read-Only)

Before writing any code:
- Read the spec and relevant codebase
- Identify existing patterns and conventions
- Map dependencies between components
- Note risks and unknowns

**Do NOT write code during planning.** Output is a plan document, not implementation.

### Step 1.5: Convergence Decision

Before decomposing tasks, decide whether the work warrants a multi-agent convergence loop. See **convergence-loop** for the pattern. In autonomous mode, make the smallest safe choice from the available task/spec context; do not pause for approval unless the user explicitly asked for a checkpoint.

The plan must commit to one of:

| Mode | When | Cost |
|---|---|---|
| `convergence: none` | Trivial, exploratory, low-stakes work | 1× |
| `convergence: informed` | Medium/large feature work, bias matters but speed dominates | ~4× |
| `convergence: holdout` | Security-critical code, high blast radius, or work where author/tester bias is unacceptable | ~4× + walls overhead |

If `informed` or `holdout`, the plan also fixes — **before any code is
written** — these parameters:

- `threshold` (default `0.8`)
- `axis_weights` (default per `code-review`)
- `max_fix_iterations` (default `2`)
- `max_total_calls` (default `10`)

**Do not change these mid-run.** Adjusting threshold or axis weights
after seeing the first score is goalpost-moving and defeats the loop.

If during implementation the chosen mode appears wrong, do not silently change it. Record the risk, continue with the declared mode when safe, and stop only if a required safety decision cannot be inferred.

### Step 2: Dependency Graph

Map what depends on what. Implementation order follows the graph bottom-up — build foundations first.

```
Data types / models
    ├── Core logic
    │       ├── API / interface layer
    │       │       └── UI / presentation
    │       └── Validation
    └── Persistence / storage
```

### Step 3: Slice Vertically

Build one complete feature path at a time, not one layer at a time.

**Bad (horizontal):**
```
Task 1: Build all data models
Task 2: Build all logic
Task 3: Build all UI
Task 4: Connect everything
```

**Good (vertical):**
```
Task 1: User can create an item (model + logic + UI)
Task 2: User can list items (query + logic + UI)
Task 3: User can edit an item (update + logic + UI)
```

Each vertical slice delivers working, testable functionality.

### Step 4: Write Tasks

Each task follows this structure:

```markdown
## Task [N]: [Short descriptive title]

**Description:** What this task accomplishes.

**Acceptance criteria:**
- [ ] [Specific, testable condition]
- [ ] [Specific, testable condition]

**Verification:**
- [ ] Tests pass: [project test command]
- [ ] Build/check succeeds: [project build/check command]
- [ ] Manual check: [what to verify]

**Dependencies:** [Task numbers or "None"]
**Files likely touched:** [list]
**Scope:** [XS | S | M | L]
```

### Step 5: Order and Checkpoint
Arrange tasks so that:
1. Dependencies are satisfied (foundations first)
2. Each task leaves the system in a working state
3. Checkpoints occur every 2-3 tasks
4. High-risk tasks are early (fail fast)

```markdown
## Checkpoint: After Tasks 1-3
- [ ] All tests pass
- [ ] Application builds without errors
- [ ] Core flow works end-to-end
```

### Step 6: Switch to a Worktree

The plan exists. Tasks exist. **Code is next.** Before any task runs:

```bash
cd ~/Projects/<org>/<repo>
git fetch origin --prune
git worktree add -b feat/<slug> ../.worktrees/<repo>-<slug> origin/main
cd ../.worktrees/<repo>-<slug>
```

The primary checkout stays clean on the integration branch. All implementation happens in the worktree. This is non-negotiable — see **worktrees-by-default** for the full discipline.

### Step 7: Mandatory Harness Task Set

**Every plan must include an automated build+test harness task set — a plan
without it is incomplete.** This is not optional padding; it is the artifact
that lets a machine rebuild and re-verify the feature unattended.

The harness task set must:

- Build and run the feature end-to-end with **no human in the loop**.
- **Headlessly simulate any human-in-the-loop interactions** (approvals,
  inbox steering, browser clicks) so the whole flow runs unattended.
- Prove red→green for the feature's acceptance criteria.

If the feature has any human-in-the-loop step, the plan names a task that
simulates it programmatically. A plan that relies on a human to exercise the
feature does not satisfy this rule.

## HTML Plan Ecosystem integration

When the HTML Plan Ecosystem is in use (schema `engplan/1`), planning emits a
durable plan artifact:

- The plan is published as `<slug>.plan.html` — a self-contained `engplan/1`
  document. The `<slug>` is the one identity shared with the spec
  (`<slug>.spec.html`), the branch, and the worktree (see
  **worktrees-by-default**).
- **Each task is a `type:"task"` section** carrying a `state`
  (`todo | doing | done`) and an `acceptance[]` array of testable criteria. The
  task structure in Step 4 maps directly onto these section fields.
- The **convergence mode** chosen in Step 1.5 (`none | informed | holdout`),
  plus its fixed `threshold`, `axis_weights`, and loop bounds, are recorded on
  the plan document itself — not just in prose.
- The harness task set from Step 7 appears as `type:"task"` sections too, so
  the unattended rebuild+re-verify path is part of the plan, not an afterthought.
- Steering flows through the **Plan Inbox** as explicit events; reconcile the
  inbox at the defined checkpoints. Do not bind any server to `0.0.0.0` and do
  not load assets from a CDN — artifacts are self-contained and served on
  loopback only.

## Subagent dispatch + coder/model doctrine

Planning decides *who* will write the code. Encode these invariants so the
orchestrator dispatches correctly:

- **Subagents are the coders.** The orchestrator delegates coding to subagents
  working in their own worktrees rather than editing ship code itself. Plan the
  work as tasks a coder subagent can pick up.
- **Dispatch rule (hard).** Every subagent dispatch must include either an
  `agent` name or an inline `system_prompt` — **never neither**. Dispatching
  with neither raises:
  `Must provide either 'agent' (name) or 'system_prompt' (inline). Got neither.`
- **Model inheritance.** When dispatching a coder, `model = explicit ?? session`
  — i.e. `model = explicit_model ?? session_model`. Inherit the **session model**
  rather than a silent weaker default; overrides require recorded justification.
- **Poll-and-steer over sleep.** The orchestrator polls subagent status and
  steers via the Plan Inbox; it does not insert long blocking sleeps.

## Task Sizing

| Size | Files | Example |
|------|-------|---------|
| **XS** | 1 | Add a validation rule, config change |
| **S** | 1-2 | Add a new endpoint, single component |
| **M** | 3-5 | One feature slice end-to-end |
| **L** | 5-8 | Multi-component feature |
| **XL** | 8+ | **Too large — break it down** |

If a task is L or larger, break it down further. Agents perform best on S and M tasks.

**Break down further when:**
- You can't describe acceptance criteria in ≤3 bullet points
- It touches two+ independent subsystems
- You find yourself writing "and" in the title (it's two tasks)

## Slicing Strategies

**Risk-First:** Tackle the riskiest piece first. If it fails, you learn before investing in downstream work.

**Contract-First:** Define interfaces/types first, then implement both sides in parallel.

**Parallelization rules:**
- **Safe to parallelize:** Independent feature slices, tests for existing code, documentation
- **Must be sequential:** Shared state changes, dependency chains, migrations
- **Needs coordination:** Features sharing an API contract (define contract first)

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll figure it out as I go" | That's how you get tangles and rework. 10 minutes of planning saves hours. |
| "The tasks are obvious" | Write them down anyway. Explicit tasks surface hidden dependencies. |
| "Planning is overhead" | Planning IS the task. Implementation without a plan is just typing. |
| "I can hold it all in my head" | Context windows are finite. Written plans survive session boundaries. |

## Red Flags

- Starting implementation without a written task list
- Tasks that say "implement the feature" without acceptance criteria
- No verification steps in the plan
- All tasks are XL-sized
- No checkpoints between tasks
- Dependency order not considered
- Plan exists but no worktree was created before implementation (see **worktrees-by-default**)
- Convergence mode not declared — the agent will either skip the loop or invoke it gratuitously
- Threshold or axis weights adjusted after the first score (goalpost
  moving — defeats the loop)
- Agent silently changed `convergence: none` → `informed`/`holdout` mid-run

## Verification

Before starting implementation:
- [ ] Every task has acceptance criteria
- [ ] Every task has a verification step
- [ ] Dependencies are identified and ordered
- [ ] No task touches more than ~5 files
- [ ] Checkpoints exist between major phases
- [ ] Convergence mode declared (`none` | `informed` | `holdout`)
- [ ] If not `none`: threshold, axis weights, and loop bounds fixed
- [ ] Dedicated worktree created and active (`git worktree list` shows it; `pwd` is inside it)
