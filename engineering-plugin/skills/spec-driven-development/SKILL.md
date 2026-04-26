---
name: spec-driven-development
description: Creates specs before coding. Use when starting a new project, feature, or significant change and no specification exists yet.
---

# Spec-Driven Development

Write a structured specification before writing any code. The spec is the shared source of truth — it defines what we're building, why, and how we'll know it's done. Code without a spec is guessing.

## When to Use

- Starting a new project or feature
- Requirements are ambiguous or incomplete
- The change touches multiple files or modules
- You're about to make an architectural decision
- The task would take more than 30 minutes to implement

## The Gated Workflow

```
SPECIFY ──→ PLAN ──→ [WORKTREE] ──→ TASKS ──→ IMPLEMENT
   │          │           │            │          │
   ▼          ▼           ▼            ▼          ▼
 Human      Human    Worktree       Human      Human
 reviews    reviews   created       reviews    reviews
```

Do not advance to the next phase until the current one is validated.

**The worktree gate is non-negotiable.** SPECIFY and PLAN may happen on the primary checkout. Once the plan is approved — before writing tasks or any code — switch to a dedicated worktree. See **worktrees-by-default**.

## Phase 1: Specify

**Surface assumptions immediately.** Before writing any spec content, list what you're assuming:

```
ASSUMPTIONS I'M MAKING:
1. This is a CLI application (not a web service)
2. Persistence uses JSON on disk (not SQLite)
3. We're targeting Linux primarily
→ Correct me now or I'll proceed with these.
```

Don't silently fill in ambiguous requirements. Assumptions are the most dangerous form of misunderstanding.

**Write a spec covering these six areas:**

1. **Objective** — What are we building? Who is the user? What does success look like?
2. **Commands** — Full build/test/run commands. `cargo build`, `cargo test`, etc.
3. **Project Structure** — Where source lives, where tests go, where docs belong.
4. **Code Style** — One real code snippet showing your style beats three paragraphs describing it.
5. **Testing Strategy** — What framework, where tests live, coverage expectations.
6. **Boundaries** — Three-tier system:
   - **Always do:** Run tests before commits, validate inputs, follow naming conventions
   - **Ask first:** Adding dependencies, schema changes, changing CI config
   - **Never do:** Commit secrets, remove failing tests, skip the spec

**Reframe vague requirements as success criteria:**

```
REQUIREMENT: "Make it fast"

REFRAMED SUCCESS CRITERIA:
- Startup time < 50ms
- Response to input < 16ms (60fps)
- Binary size < 10MB
→ Are these the right targets?
```

## Phase 2: Plan

With the validated spec, generate a technical implementation plan:
1. Identify major components and dependencies
2. Determine implementation order (build foundations first)
3. Note risks and mitigations
4. Identify parallel vs sequential work
5. Define verification checkpoints between phases

> **Surface stakes for the convergence decision.** The spec should call
> out anything that affects the convergence-mode choice: security-critical
> paths, autonomous-merge expectations, blast radius, bias-sensitive
> review needs. The human uses this in **planning-and-task-breakdown**
> Step 1.5 to choose `convergence: none` | `informed` | `holdout`. See
> **convergence-loop** for the pattern itself.

## Phase 3: Tasks

Break the plan into discrete tasks. See the **planning-and-task-breakdown** skill for the full task breakdown process.

> **Worktree required from here on.** Task breakdown is the boundary between thinking and doing. Once tasks exist, code is imminent. Confirm you are inside the dedicated worktree (`git worktree list`, `git branch --show-current`) before continuing. See **worktrees-by-default**.

## Phase 4: Implement

Execute tasks using the **incremental-implementation** and **test-driven-development** skills.

## Keeping the Spec Alive

- **Update when decisions change** — spec first, then implement
- **Update when scope changes** — features added or cut get reflected
- **Commit the spec** — it belongs in version control alongside code
- **Reference the spec** — link back to spec sections in commits/PRs

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "This is simple, I don't need a spec" | Simple tasks don't need *long* specs, but they still need acceptance criteria. Two lines is fine. |
| "I'll write the spec after I code it" | That's documentation, not specification. The spec's value is forcing clarity *before* code. |
| "The spec will slow us down" | A 15-minute spec prevents hours of rework. |
| "Requirements will change anyway" | That's why the spec is a living document. Outdated spec > no spec. |
| "The user knows what they want" | Even clear requests have implicit assumptions. The spec surfaces them. |

## Red Flags

- Starting to write code without any written requirements
- "Should I just start building?" before clarifying what "done" means
- Implementing features not mentioned in any spec
- Making architectural decisions without documenting them
- Skipping the spec because "it's obvious"

## Verification

Before proceeding to implementation:
- [ ] Spec covers all six core areas
- [ ] Human has reviewed and approved
- [ ] Success criteria are specific and testable
- [ ] Boundaries (Always/Ask/Never) are defined
- [ ] Spec is saved to a file in the repository
- [ ] A dedicated worktree exists for the implementation (see **worktrees-by-default**)
