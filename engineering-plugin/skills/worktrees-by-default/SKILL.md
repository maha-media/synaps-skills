---
name: worktrees-by-default
description: Isolates every implementation in a dedicated git worktree. Use when an implementation plan exists, code is about to be written, or a bug fix is starting. Never implement on the primary checkout.
---

# Worktrees By Default

Every implementation, fix, or refactor happens inside a dedicated `git worktree`. The primary clone stays clean and on the integration branch. This is non-negotiable for any work that mutates files in the repository.

## The Iron Rule

```
THE MOMENT EITHER OF THESE IS TRUE → YOU MUST BE IN A WORKTREE

1. An implementation plan has been written
2. You are about to write or modify code, configs, or specs that ship
```

Spec drafting, exploration, reading, and planning may happen on the primary checkout. **Implementation may not.**

If you catch yourself about to edit a file on the primary checkout: stop, create a worktree, move the change there.

## Why Worktrees, Not Branches

A worktree is a branch *plus* its own working directory. Same `.git` data, separate filesystem.

| Property | Branch on primary | Branch in worktree |
|---|---|---|
| Switch cost | `git stash` + `git checkout` (loses focus) | `cd` to other path |
| Parallel work | Impossible (one tree at a time) | Trivial (N trees, N branches) |
| Crash safety | Broken state blocks all work | Primary stays clean |
| Multi-agent | Agents collide on shared tree | Agents own separate trees |
| Build artifacts | Mixed across branches | Per-tree, no contamination |
| Background ops | Switching branches mid-build = corruption | Build keeps running, you move on |

If another process (an agent, a CI hook, a watcher) might switch branches under you, **worktrees are the only safe option**.

## The Layout

Convention used in this repo and recommended elsewhere:

```
~/Projects/<org>/<repo>/                       ← primary clone, stays on `main`
~/Projects/<org>/.worktrees/<repo>-<slug>/     ← per-task worktree
```

- One sibling `.worktrees/` directory per organization (or per project parent)
- Worktree name = `<repo>-<short-slug>` describing the work
- Branch name = `feat/<slug>` or `fix/<slug>` matching the worktree slug

Example:
```
~/Projects/Maha-Media/synaps-skills/                                  → main
~/Projects/Maha-Media/.worktrees/synaps-skills-engineering-worktrees/ → feat/engineering-worktrees
~/Projects/Maha-Media/.worktrees/synaps-skills-fetch-fix/             → fix/fetch-redirects
```

## The Gate Function

Before any edit, run this check:

```bash
# Where am I?
git rev-parse --show-toplevel

# Is this a worktree (not the primary clone)?
git worktree list
```

```
On primary clone, branch is main or integration?
├── YES → Plan/spec only. NO IMPLEMENTATION HERE.
│         → Create a worktree before editing anything.
└── NO (already in a worktree)?
    └── Verify branch is the right feature branch → proceed.
```

## Creating a Worktree

From the primary clone:

```bash
cd ~/Projects/<org>/<repo>           # primary clone
git fetch origin --prune             # ensure base is fresh
git worktree add -b feat/<slug> ../.worktrees/<repo>-<slug> origin/main
cd ../.worktrees/<repo>-<slug>
```

Verify:

```bash
git worktree list                    # should show new entry
git branch --show-current            # should match feat/<slug>
git rev-parse --show-toplevel        # should be the worktree path
```

## Slug Naming

| Pattern | When | Example |
|---|---|---|
| `feat/<feature-slug>` | New capability | `feat/web-pdf-extraction` |
| `fix/<bug-slug>` | Bug fix | `fix/fetch-redirect-loop` |
| `refactor/<area>` | Internal restructuring | `refactor/memory-api` |
| `docs/<topic>` | Doc-only changes | `docs/skill-conventions` |

Keep slugs short, hyphenated, lowercase, and describe the *outcome* not the activity.

## Cleanup Is Mandatory

A worktree's job ends when its PR merges. The moment the PR is merged, **the cleanup runs immediately** — same session, no deferral.

```
PR merged → cleanup → primary clone on main, worktree gone, branch gone
```

Leftover worktrees and local branches accumulate fast across sessions and across agents. They cause:
- Stale checkouts that drift from `origin/main`
- Branch-name collisions on the next task
- Confusion about which worktree is "real"
- Disk bloat from per-tree build artifacts
- Multi-agent collisions on abandoned trees

### The Cleanup Sequence

Run all four steps. Do not skip any.

```bash
# 1. Leave the worktree before deleting it
cd ~/Projects/<org>/<repo>           # primary clone

# 2. Make sure local main reflects the merge
git checkout main
git pull origin main                 # fast-forward to merged state

# 3. Remove the worktree directory
git worktree remove ../.worktrees/<repo>-<slug>

# 4. Delete the local branch and prune remote refs
git branch -d feat/<slug>            # -d (safe) since merged
git fetch origin --prune             # drops origin/feat/<slug>
```

Verify clean state:

```bash
git worktree list                    # only the primary entry remains
git branch                           # only main (and other active work)
git status                           # clean
```

### Edge Cases

**Worktree directory was force-deleted before `git worktree remove`:**
```bash
git worktree prune                   # drop the orphaned admin entry
git branch -D feat/<slug>            # -D since the merge ref may be gone
```

**Branch was squash-merged (so `-d` refuses to delete):**
```bash
git branch -D feat/<slug>            # safe: PR is merged on the remote
```

**Uncommitted changes in the worktree at merge time:**
That's a process bug — those changes should have been on the PR. Investigate before deleting; do not silently discard work.

## Multi-Agent Safety

When multiple agents (or processes) operate on the same repo:

- Each agent owns one worktree. Never share.
- Never `git checkout` a branch another agent has checked out — git will refuse anyway, but assume nothing.
- The primary clone is the integration anchor; only the human (or a merge agent) moves it.
- If you find your worktree has been mutated by another process, treat it like a merge conflict: stash, sync, replay.
- **After your PR merges, clean up your worktree even if other agents are still running.** Their worktrees are independent.

## Rationalizations

| Excuse | Reality |
|---|---|
| "It's a one-line change" | Worktrees cost 2 seconds. The discipline is the value. |
| "I'll just commit on main and rebase later" | One forced push later, history is wrong and reviewers are angry. |
| "Branches are good enough" | Until another process switches branches mid-edit. |
| "This is just a quick fix" | Quick fixes are how broken main happens. Worktree it. |
| "Setting up a worktree is overhead" | `git worktree add` is one command. The overhead is the rule, not the tooling. |
| "Plans don't need worktrees" | Correct — but the moment the plan exists and implementation is next, you do. |
| "I'll clean up the worktree later" | Later is when collisions happen. Cleanup is part of merge, not a future task. |
| "The branch will get auto-deleted on the remote" | Remote auto-delete doesn't touch your local worktree, local branch, or disk. |

## Red Flags

- Editing files while `git worktree list` shows only the primary entry
- `git status` on the primary clone shows uncommitted changes
- Running tests on the primary clone (build artifacts contaminate it)
- "I'll move it to a worktree once it works"
- Two agents reporting work on the same path
- Branch name does not match worktree slug
- **PR merged but the worktree directory still exists**
- **PR merged but the local feature branch still exists**
- Multiple `feat/*` or `fix/*` branches lingering after their PRs merged
- Disk usage in `.worktrees/` growing across sessions

## Verification

Before declaring "ready to implement":

- [ ] `git worktree list` shows the dedicated worktree for this task
- [ ] `pwd` is inside that worktree, not the primary clone
- [ ] `git branch --show-current` matches the planned `feat/` or `fix/` slug
- [ ] Primary clone is on the integration branch with a clean working tree
- [ ] Branch is created from a fresh `origin/<integration-branch>`

After PR merges (cleanup gate — run before claiming the task is done):

- [ ] Primary clone is on `main` with `git pull` complete (fast-forwarded to merged state)
- [ ] `git worktree list` shows only the primary entry
- [ ] `git branch` no longer lists the merged feature branch
- [ ] `git fetch --prune` has dropped the remote tracking ref
- [ ] `~/Projects/<org>/.worktrees/<repo>-<slug>/` directory no longer exists on disk
