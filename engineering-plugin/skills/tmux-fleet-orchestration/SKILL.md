---
name: tmux-fleet-orchestration
description: Use when an orchestrator drives a fleet of coder agents in tmux panes — pane addressing, Plan Inbox polling instead of idle sleeps, precise-prompt dispatch, send-keys gotchas, and running long-lived servers in a dedicated window. The orchestrator plans/reviews/steers/verifies and never writes product code.
---

# Tmux Fleet Orchestration

*Where this fits: spans **implement → verify → review** — the operational layer for running the coder/orchestrator split across live tmux panes.*

One supervising agent (the **orchestrator**) drives one or more coder agents
running in tmux panes. The orchestrator's job is to plan, dispatch, review,
steer, and verify — it is the foreman, not a bricklayer.

## The orchestrator/coder split

- **The orchestrator NEVER writes product code.** It decomposes work, dispatches
  precise tasks, reviews diffs, consumes verdicts, and steers via the **Plan
  Inbox**. The moment the orchestrator edits product files, the separation that
  makes its review trustworthy collapses (see the henhouse rule in
  **automated-test-harness**).
- **The pane agents are the coders.** Each tmux pane runs a coder that owns its
  worktree and writes the actual changes (see **worktrees-by-default**).
- The orchestrator's only writes are to orchestration artifacts: plans, the Plan
  Inbox, review notes, dispatch ledgers.

## Pane addressing

Address panes explicitly as `window:window.pane`. Drive and observe with
`send-keys` and `capture-pane`:

```bash
# send a command to pane 1 of window 27, then Enter as a separate key event
tmux send-keys -t 27:0.1 'node --test test/server/token_gate.test.js' 
tmux send-keys -t 27:0.1 Enter

# read back what the coder produced (the -p flag prints to stdout)
tmux capture-pane -t 27:0.1 -p | tail -40

# list panes to discover addresses
tmux list-panes -t 27 -F '#{pane_index} #{pane_title} #{pane_current_command}'
```

Keep a stable mapping of pane → coder → task so captures are unambiguous.

## Plan Inbox polling, not idle sleeps

Do **not** block the orchestrator on fixed `sleep`s waiting for a coder to
finish. Steer and synchronize through the **Plan Inbox** as explicit, durable,
auditable events:

- Dispatch a task → coder works → coder posts its result/response as an inbox
  event → orchestrator **reconciles** the inbox and reacts.
- Poll with bounded backoff by reading pane state and/or the inbox
  (`GET /api/notes?plan=<slug>`), not by sleeping a guessed duration.
- The Plan Inbox is the *sanctioned steering channel*: corrected context flows
  in as explicit events between dispatches — never by mutating a running agent
  with hidden context. (Mirrors the convergence-loop steering contract.)

## The precise-prompt doctrine

A dispatched coder must **never** have to rediscover the codebase. The
orchestrator pre-provides everything:

- **Exact file paths and line numbers.** "Fix the token gate in
  `extensions/plans_server.js` at ~line 136" — not "find the auth bug."
- **No unbounded discovery.** Tell the coder *not* to run `find`/`grep` to
  rediscover what you already diagnosed; hand it the diagnosis.
- **Scope every search to the repo.** Searches run from the repo root
  (`engineering-plugin/`), never `find /` or `grep -r /` — those waste minutes
  and blow the context window.
- **State the acceptance check.** Give the exact command that proves done
  (`node --test "test/**/*.test.js"` → expect 416/416), so the coder converges
  on a verifiable target.

A precise prompt is the difference between a coder that edits two lines and one
that spends its budget re-deriving your diagnosis.

## send-keys gotchas

`tmux send-keys` is keystroke injection, not a message API. It bites in
specific ways:

- **Multi-line input gets mangled.** Embedded newlines can arrive as literal
  characters or submit the prompt early, splitting one message into several.
  **Send a single-line message, then a separate `Enter`:**
  ```bash
  tmux send-keys -t 27:0.1 'P-V1: serve /_assets/* before the token gate; keep safeRealpath confinement'
  tmux send-keys -t 27:0.1 Enter
  ```
- **Clear a bad draft with `C-u`,** which kills the current input line:
  ```bash
  tmux send-keys -t 27:0.1 C-u
  ```
- **Never send `C-c`.** Ctrl-C quits/interrupts the coder's TUI instead of
  clearing the line — use `C-u` to clear, plain `Enter` to submit.
- Quote the payload so the shell doesn't expand `$`, `!`, backticks, or globs
  before tmux ever sees them.

## Run long-lived servers in a dedicated tmux window

Background jobs started from a one-shot shell (`cmd &`) get **reaped** when that
shell exits — the plans-server dies the moment your tool call returns. Give any
long-lived process its own tmux window so it outlives the dispatch:

```bash
tmux new-window -t 27 -n plans-server
tmux send-keys -t 27:plans-server 'node extensions/plans_server.js --serve' Enter
# later, observe it:
tmux capture-pane -t 27:plans-server -p | tail -20
```

This keeps the live plans-server (and its per-session token) stable across many
coder dispatches and review cycles.

## Related skills

- **automated-test-harness** — the external proof the orchestrator reviews instead of writing code.
- **convergence-loop** — the multi-role scoring loop this orchestration operationalizes.
- **worktrees-by-default** — each pane coder works in its own isolated worktree.
- **verification-before-completion** — the evidence the orchestrator demands before accepting a coder's work.
