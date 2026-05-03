# AGENTS.md — synaps-skills Developer & Agent Guide

This is the onboarding doc for any agent (Claude Code, Cursor, Aider, or Synaps CLI itself) working in this repo. Read this first.

`synaps-skills` is the **plugin marketplace** for [Synaps CLI](https://github.com/maha-media/SynapsCLI). It is *not* a Rust codebase — it's a collection of agent plugins (skills + scripts) consumed by Synaps' `/plugins` UI. Six plugins ship today: `web-tools`, `engineering`, `memkoshi`, `tmux-tools`, `plugin-maker`, `local-voice`.

---

## 🚫 Hard rule — `docs/plans/`

**NEVER read files under `docs/plans/*` unless one of the following is true:**

1. The user has explicitly asked you to read a specific plan file (e.g. "look at `docs/plans/2026-04-08-bbe-multi-agent-plan.md`").
2. You are actively authoring or editing a plan file that lives in `docs/plans/` (e.g. drafting a new spec, updating an in-progress plan).

This directory contains historical and in-progress design docs. Reading them by default pollutes your context with stale designs, alternative paths that were rejected, and detail that is rarely relevant to the current task. The same rule applies to per-plugin `docs/specs/` directories (e.g. `web-tools-plugin/docs/specs/`, `plugin-maker-plugin/docs/specs/`).

If you find yourself wanting to read a plan file because "it might have context" — don't. Ask the user if it's relevant first.

---

## Repo layout

```
synaps-skills/
├── README.md                       — user-facing entry point
├── AGENTS.md                       — this file
├── install.sh                      — repo-level installer (wires skills into Claude Code / verifies deps)
├── LICENSE
├── .synaps-plugin/
│   └── marketplace.json            — registers all plugins for Synaps' marketplace fetcher
├── docs/
│   └── plans/                      — ⚠️  see hard rule above
├── <name>-plugin/                  — one directory per plugin (convention: kebab-case + "-plugin" suffix)
│   ├── .synaps-plugin/plugin.json  — plugin manifest (name, version, description, optional keybinds)
│   ├── README.md                   — user-facing plugin docs
│   ├── skills/<skill-name>/
│   │   └── SKILL.md                — agent-facing skill doc (loaded via load_skill)
│   ├── scripts/<scope>/            — executable helpers invoked by skills via bash
│   ├── lib/                        — shared shell libraries (sourced, not invoked)
│   └── docs/                       — per-plugin user docs (specs/ subdirs follow plans rule)
```

The `marketplace.json` at the repo root is what Synaps fetches over HTTPS. Each plugin entry has `source: "./<name>-plugin"` so the installer knows which subdirectory to snapshot.

---

## Build & test

There is no compile step. Validation is per-plugin and lightweight:

```bash
# Repo-level installer / health check
bash install.sh --check

# Per-plugin smoke (plugin-maker provides a generic linter)
bash plugin-maker-plugin/scripts/test.sh

# Memkoshi plugin has its own setup verifier
bash memkoshi-plugin/scripts/memkoshi/setup.sh --check

# Sync an installed plugin from main (after pushing)
~/.synaps-cli/plugins/tmux-tools/scripts/tmux/synaps.sh sync <plugin-name>
```

Shell scripts are bash 4+. Use `set -euo pipefail` at the top of every new script. Run `bash -n script.sh` for syntax check before committing. JSON files: validate with `python3 -c "import json; json.load(open('PATH'))"`.

---

## The lifecycle (edit → push → install)

This is the model. Memorize it.

```
1. Edit in repo working tree    →  git commit + push
2. PR + merge to main          →  origin/main advances
3. Sync the installed copy:
   • From the Synaps TUI:   /plugins → pick plugin → "u" to update
   • From the command line: ~/.synaps-cli/plugins/tmux-tools/scripts/tmux/synaps.sh sync NAME
```

**There is no symlink mirroring.** The `~/.synaps-cli/plugins/<name>/` directories are git-snapshot copies, taken at install time and updated only when the user explicitly requests it. This is intentional — it keeps installed plugins reproducible and lets the user defer breaking changes. If you find a symlink in `~/.synaps-cli/plugins/`, that's a development artifact and should be replaced with a real snapshot (the `synaps.sh` driver does this automatically).

**Marketplace state lives in `~/.synaps-cli/plugins.json`:**
- `marketplaces[].cached_plugins[]` — what's *available* (refreshed from `marketplace.json`)
- `installed[]` — what's *installed* (with frozen `installed_commit` SHA)
- A plugin in `cached_plugins` but missing from `installed` shows as "available, not installed" in the `/plugins` UI.

---

## Working in this repo — use git worktrees

The primary working tree is shared across panes/sessions. When two flows need different branches, **always create a worktree** instead of `git checkout`-flipping the primary. We learned this the hard way: branch flips in the primary tree dangle symlinks, lose unstaged WIP, and cause two agents to clobber each other's commits.

Convention:

```bash
mkdir -p ~/Projects/Maha-Media/.worktrees
git worktree add ~/Projects/Maha-Media/.worktrees/synaps-skills-<purpose> <branch>

# Work happens in the worktree:
cd ~/Projects/Maha-Media/.worktrees/synaps-skills-<purpose>
# git, gh, edits, etc.

# When done, remove cleanly:
git worktree remove ~/Projects/Maha-Media/.worktrees/synaps-skills-<purpose>
```

Rules:
- The primary tree (`~/Projects/Maha-Media/synaps-skills`) belongs to whoever is on it. Never `git checkout` something else there.
- A branch can only be checked out in one worktree at a time (git enforces this).
- When `gh pr merge --delete-branch` runs, fetch+pull the worktree's branch before removing it, so origin's deletion is mirrored locally.

---

## Adding a new plugin

1. **Create the directory:** `mkdir -p my-plugin/{.synaps-plugin,skills/my-skill,scripts/my-scope,docs}`
2. **Write `my-plugin/.synaps-plugin/plugin.json`** — at minimum: `name`, `version`, `description`, `author`, `repository`, `license`, `category`. Match the style of `memkoshi-plugin/.synaps-plugin/plugin.json`.
3. **Register in `.synaps-plugin/marketplace.json`** — append a `plugins[]` entry. The `source` must be `./my-plugin` (relative). Bump the marketplace's own `version` if this is a notable release.
4. **Write `skills/my-skill/SKILL.md`** with frontmatter:
   ```markdown
   ---
   name: my-skill
   description: One-sentence agent-facing summary that goes in the skill registry.
   ---

   # body — when to use, how to use, gotchas
   ```
5. **Write `README.md`** in the plugin root (user-facing).
6. **If it has runtime deps** (Python packages, npm modules, OS utilities): write `scripts/<scope>/setup.sh` that installs them idempotently. See `memkoshi-plugin/scripts/memkoshi/setup.sh` as the reference. Support `--check` (status only) and document `setup.sh` as the install path in your README/SKILL.md.
7. **Bump `.synaps-plugin/marketplace.json`** version, commit, push, PR.

When editing JSON via Python, **always** pass `ensure_ascii=False` to `json.dump` or unicode arrows (`→`) get mangled to `\u2192`.

---

## Adding a new skill to an existing plugin

```bash
# Use the plugin-maker plugin if it's installed:
~/.synaps-cli/plugins/plugin-maker/bin/plugin-maker new skill <skill-name> --plugin <plugin-name>-plugin

# Otherwise, manually:
mkdir -p <plugin>-plugin/skills/<skill-name>
$EDITOR <plugin>-plugin/skills/<skill-name>/SKILL.md     # frontmatter + body
```

Each `SKILL.md` is consumed by Synaps' `load_skill` tool. The frontmatter `description` is what the agent sees in the skill registry — keep it under ~150 chars and action-oriented.

---

## Plugin manifest reference

Minimum `plugin.json`:

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "...",
  "author":     { "name": "...", "url": "..." },
  "repository": "maha-media/synaps-skills",
  "license":    "MIT",
  "category":   "productivity"
}
```

Optional fields (all opt-in):

| Field | Purpose |
|---|---|
| `keybinds[]` | Plugin-defined keybinds. See SynapsCLI/AGENTS.md "Adding a Plugin Keybind". |
| `agents[]` | Custom agent personas. Resolved by `subagent` tool via `plugin:agent` syntax. |

The marketplace entry mirrors most of these fields — keep them in sync (description, version, author).

---

## Common pitfalls

1. **Branch flips in the shared working tree dangle symlinks and clobber WIP.** Use `git worktree add` for any non-trivial branch work. See "Working in this repo" above.
2. **`docs/plans/*` will pull stale design context into your reasoning.** Don't read it unless explicitly working on it. Same for per-plugin `docs/specs/`.
3. **`json.dump` without `ensure_ascii=False` mangles unicode.** Always pass `ensure_ascii=False, indent=2` and add a trailing newline.
4. **Marketplace re-fetch ≠ plugin update.** Refreshing the marketplace updates `cached_plugins[]` (what's available) but doesn't touch `installed[]`. The user must explicitly trigger an update for installed plugins to advance their `installed_commit`.
5. **Updating one plugin via marketplace bumps everyone's "available" SHA.** When you update plugin A, the marketplace's HEAD SHA advances, so all *other* installed plugins now show "update available" even if their content is unchanged. This is cosmetic — a no-op sync brings them current.
6. **Symlinks in `~/.synaps-cli/plugins/` are dev artifacts.** They bypass the install registry and break when the underlying branch flips. Convert them to real snapshots before opening a PR (the `synaps.sh sync` flow handles this automatically).
7. **`gh pr merge --squash`** rewrites history. The local feature branch's tip won't be a parent of main after merge — pull main into the worktree, then delete the local branch.
8. **`memkoshi`'s `stelline` extra is git-only**, not on PyPI. `pip install memkoshi[stelline]` fails. The plugin's `setup.sh` handles this via `pipx inject`. If you write similar plugins with git-only optional deps, follow the same pattern.
9. **`memkoshi review` is interactive-only.** For agent automation use `approve.sh --all|--id|--reject` (the plugin ships this helper because upstream lacks a non-interactive path).
10. **`memkoshi boot` reports `Total: 0` even when memories exist** — upstream bug. Use `memkoshi stats` for the real count.
11. **Plugin discovery is by directory presence**, not by `installed[]`. Synaps walks `~/.synaps-cli/plugins/*/` looking for `.synaps-plugin/plugin.json`. A plugin with a manifest but no entry in `installed[]` still loads — it just shows as "external" in `/plugins`.
12. **Tmux pane names use tmux pane *titles*, not state files.** `pane.sh spawn NAME` calls `tmux select-pane -T NAME`. This means pane names are scoped to the tmux server (cross-window-safe) but lost across server restarts.

---

## Reference: where things live

| Need to… | Look at… |
|---|---|
| Add a plugin to the marketplace | `.synaps-plugin/marketplace.json` |
| See what's installed locally | `~/.synaps-cli/plugins.json` (`installed[]`) |
| Understand the install flow | `~/Projects/Maha-Media/SynapsCLI/src/skills/install.rs` and `chatui/plugins/actions.rs` |
| Drive `/plugins` UI from a script | `tmux-tools-plugin/scripts/tmux/synaps.sh` (subcommands: `refresh`, `install`, `update`, `sync`, `status`) |
| Spawn / drive a worker pane | `tmux-tools-plugin/scripts/tmux/pane.sh` (subcommands: `spawn`, `run`, `send`, `keys`, `poll`, `wait`, `close`, `list`, `id`) |
| Persistent agent memory CLI | `~/.local/bin/memkoshi` (pipx-managed venv at `~/.local/share/pipx/venvs/memkoshi/`) |
| Generic skill linter / scaffolder | `plugin-maker-plugin/lib/{lint,validate,scaffold}.sh` |
| User-facing repo docs | `README.md` (top-level), `<plugin>-plugin/README.md` (per-plugin) |
| Agent-facing behaviour | `<plugin>-plugin/skills/<skill>/SKILL.md` |

---

## Workflow checklist for a new change

1. Create a worktree off `main`: `git worktree add ../.worktrees/synaps-skills-<purpose> -b feat/<name>`
2. `cd` into it. Make edits.
3. If the change is more than 1 file: load the `engineering:incremental-implementation` skill.
4. Sanity-check: `bash -n` any modified shell scripts; `python3 -c "import json; json.load(open(P))"` any JSON.
5. Commit with a clear message. Push.
6. `gh pr create --base main` with a body that explains *why*, not just *what*.
7. After merge: `git fetch && git checkout main && git pull && git worktree remove <path>`.
8. If the change touched an installed plugin's contents: run `~/.synaps-cli/plugins/tmux-tools/scripts/tmux/synaps.sh sync <name>` to bring the local snapshot up to date.

---

## Identity

This repo's commits are authored as `J.R. Morton <jr@mahamedia.us>`. The git config is per-repo — don't override it.

---

*If a rule is missing from this doc, add it. The doc is the contract.*
