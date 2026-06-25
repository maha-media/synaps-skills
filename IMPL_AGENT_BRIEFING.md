# IMPL AGENT BRIEFING — HTML Plan Ecosystem

You are the **Impl Agent** spawned by an Orchestrator (Synaps pane `27:0.0`) into
your own tmux pane. You have a fresh context window. Build the feature described
in the spec, end to end, **autonomously, until completely finished and ready**,
using a **convergence loop**.

## Your working directory / isolation
- You are already in the dedicated worktree:
  `/home/jr/Projects/Maha-Media/.worktrees/synaps-skills-html-plan-ecosystem`
- Branch: `feat/html-plan-ecosystem`. Do all work here. Commit per task.
- Never edit the primary checkout. (`worktrees-by-default`)

## What to build — read these first (by reference)
1. `engineering-plugin/specs/html-plan-ecosystem.md` — the full specification.
2. `engineering-plugin/specs/html-plan-ecosystem.impl-plan.md` — the ordered
   implementation plan (Phases P0→P5, Addenda A–E, tasks, checkpoints, harness).

Build **all phases P0→P5** and the **headless test harness** (Addendum A + the
FleetSim/OrchestratorSim additions). The build is only "ready" when
`npm run e2e` (the full headless harness, no human) passes and every checkpoint
(C0–C5) is green.

## Mandatory disciplines (from the engineering plugin skills)
- **convergence-loop**: run the work as Designer → Builder → Tester → Judge with
  bounded fix iterations. Authorize `convergence: informed` (threshold 0.8,
  default axis weights, max_fix_iterations 2, max_total_calls 10) and DO NOT move
  the goalposts after the first score.
- **test-driven-development**: every behavior gets a failing test first (red),
  then code (green). Prove red→green for harness scenarios (`--prove`).
- **incremental-implementation**: thin vertical slices; commit each; keep build green.
- **verification-before-completion**: NO completion claims without fresh command
  output. Run the actual verification each time.
- **type-driven-design**: parse untrusted input into validated types at the boundary.
- **security-review**: the local server + tmux fleet are a real threat surface —
  implement the controls in spec §7 and assert them in the fault tests.
- **The harness mandate (Addendum A/C)**: every feature is only done when its
  headless harness scenario + applicable fault pass. `npm run e2e` is the merge gate.

## Subagent / model doctrine (spec §9.1, §9.2, §3.7, §4.6)
- **You are an orchestrator too.** Delegate coding to subagents; you review,
  reconcile, and steer. You may also spawn grandchild tmux pane agents (bounded
  by `max_depth`, `max_impl_agents`).
- **Every dispatch carries `agent` or `system_prompt` — never neither.**
- **Model inheritance:** if a subagent's model is unspecified, use the session
  model (`claude-opus-4-8`). Never silently downgrade.
- **Poll, don't sleep.** Supervise via status polling + steering, not long sleeps.

## Open decisions — resolve pragmatically and record
The plan flags open decisions (runtime/language #4 #7, server location, etc.).
Per the plan's own assumptions, default to **Node.js stdlib-only** for the
server/harness and **vanilla JS** for the renderer (no network install), keep the
server **inside the engineering plugin**, use **SSE**, **one server per repo**,
`.plans/` **committed** (registry `agents.json` gitignored). Record any deviation.

## Definition of done
- All P0–P5 tasks complete; checkpoints C0–C5 green.
- `npm run e2e` passes headless (no human): scenarios S1–S21 incl. fault tests,
  with recorded red→green proofs.
- Security controls (spec §7) implemented and fault-tested.
- Skills updated per §9 (incl. §9.1/§9.2 dispatch + model doctrine).
- Everything committed on `feat/html-plan-ecosystem`. Then summarize and stop.

## How to report progress
The Orchestrator is polling you. Keep working autonomously. When you reach a
checkpoint or finish, print a clear status line starting with `IMPL-AGENT STATUS:`
so it is easy to grep from the pane.

Begin now: read both spec files, set up the project skeleton + harness (P0-0/H-0),
and proceed through the convergence loop until the whole plan is finished and
`npm run e2e` is green.
