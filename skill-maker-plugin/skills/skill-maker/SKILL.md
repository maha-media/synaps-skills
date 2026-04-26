---
name: skill-maker
description: Scaffolds, validates, and lints Synaps CLI plugins. Use when starting a new plugin, adding a skill to an existing one, or auditing existing plugins for convention drift.
---

# skill-maker — Index

Bash-based tooling that encodes the conventions used across the
synaps-skills monorepo. One CLI, three jobs:

| Need                         | Doc                       |
|------------------------------|---------------------------|
| Scaffold a plugin or skill   | `docs/scaffolding.md`     |
| Check structure (errors)     | `docs/validation.md`      |
| Check quality (warnings)     | `docs/validation.md`      |
| Naming, tags, layout rules   | `docs/conventions.md`     |
| Single vs multi vs umbrella  | `docs/patterns.md`        |
| Full design + scope          | `docs/specs/skill-maker.md` |

## Quick start

```bash
# Add to PATH (or run via full path)
export PATH="$CLAUDE_PLUGIN_ROOT/bin:$PATH"

# Scaffold a new plugin
skill new plugin my-tool --desc "Use when …"
skill new plugin my-tool --umbrella                 # progressive-disclosure layout
skill new plugin my-tool --memory                   # add VelociRAG hooks

# Add a skill to an existing plugin
skill new skill helper --plugin ./my-tool-plugin
cd my-tool-plugin && skill new skill helper        # auto-detects plugin

# Validate (errors → exit 1)
skill validate ./my-tool-plugin
skill validate .                                    # all plugins under cwd

# Lint (warnings; --strict promotes to errors)
skill lint ./my-tool-plugin
skill lint --strict .

# List
skill list                                          # plugins
skill list ./web-tools-plugin                       # skills inside one plugin
```

## What it generates

Every scaffold produces a plugin that **passes `skill validate` immediately**.
Three layouts:

- **single** — one `skills/<name>/SKILL.md`, all content inline
- **umbrella** — index `SKILL.md` + `docs/` for progressive disclosure
- **memory** — adds `lib/memory.sh` (VelociRAG wrapper) + `docs/self-healing.md`

See `docs/patterns.md` for which layout to pick.

## Why bash

- Zero install footprint beyond what `install.sh` already requires
- Templates are plain files (no logic) — easy to edit, easy to read
- `jq` for JSON, `envsubst` for `${var}` substitution
- ~700 lines total of pure stdlib bash

## Self-improvement

After you create something with this plugin, run `skill lint` on the result.
Most warnings will be in your own SKILL.md descriptions — they're a
checklist for writing good agent-facing copy.

## See also

- The reference implementations this plugin learned from:
  - `engineering-plugin/` — multi-skill with no scripts
  - `web-tools-plugin/` — umbrella + scripts + memory
  - `tmux-tools-plugin/` — single-skill with scripts
