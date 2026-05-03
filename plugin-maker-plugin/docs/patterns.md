# patterns — Picking a layout

Three common shapes for a Synaps plugin. Pick based on how the user
will discover and use the capabilities.

## 1. Single-skill plugin

```
my-tool-plugin/
├── .synaps-plugin/plugin.json
└── skills/my-tool/SKILL.md          # everything here
```

**Choose this when:**
- You have one focused capability
- The whole story fits in < 200 lines of `SKILL.md`
- There are no separate sub-tools to invoke

**Example:** `tmux-tools-plugin` — one job (drive a tmux pane).

**Scaffold:**
```bash
plugin-maker new plugin my-tool --desc "Use when …"
```

---

## 2. Umbrella plugin (progressive disclosure)

```
my-tool-plugin/
├── .synaps-plugin/plugin.json
├── skills/my-tool/SKILL.md          # short index, points to docs/
└── docs/
    ├── capability-a.md
    ├── capability-b.md
    └── capability-c.md
```

**Choose this when:**
- You have ≥3 distinct capabilities
- Total content is > 300 lines (otherwise it stays inline)
- Capabilities have separate flag sets / failure modes
- Loading the whole thing would waste context

**The pattern:** `SKILL.md` is a small index with a "pick a capability"
table. The agent reads only the relevant `docs/` file when it picks
one. Saves context tokens.

**Example:** `web-tools-plugin` — `fetch`, `browser`, `search`,
`youtube`, `scholar`, `transcribe`, `pdf`, `docs`, `github`, `wiki`,
`status`. Index is ~80 lines; per-capability docs are 100-200 lines each.

**Scaffold:**
```bash
plugin-maker new plugin my-tool --umbrella --desc "Use for …"
```

The scaffolded `SKILL.md` already has the "pick a capability" table
template. Add rows as you add capabilities.

---

## 3. Multi-skill plugin (independent skills)

```
my-tool-plugin/
├── .synaps-plugin/plugin.json
└── skills/
    ├── skill-a/SKILL.md             # independent
    ├── skill-b/SKILL.md             # independent
    └── skill-c/SKILL.md             # independent
```

**Choose this when:**
- You have several skills that share a domain but aren't co-invoked
- Each one stands fully on its own
- There's no common entry-point story

**The difference from umbrella:** No index. Each skill loads
independently. The agent invokes `plugin-maker-a` or `plugin-maker-c` directly based
on its own description.

**Example:** `engineering-plugin` — `code-review`, `tdd`, `spec-driven-development`,
`systematic-debugging`, etc. Each one a complete methodology on its own.

**Scaffold:** start with one skill, add more as you go:
```bash
plugin-maker new plugin discipline --desc "Use when …"
cd discipline-plugin
plugin-maker new skill code-review --desc "Use when reviewing code."
plugin-maker new skill tdd          --desc "Use when implementing logic."
```

---

## Decision tree

```
How many capabilities?
├── 1                                → single
└── 2+
    ├── Same trigger context?
    │   ├── Yes (one front-door)     → umbrella
    │   └── No (independent triggers) → multi-skill
    └── Total content > 300 lines?
        └── Yes                       → umbrella
```

## Adding scripts / `lib/`

Any of the three layouts can have a `scripts/` (or `bin/`, `lib/`)
sibling next to `skills/`. Conventions:

- **`bin/`** — executables on PATH (one file per command)
- **`scripts/<capability>/`** — capability-specific scripts (matches docs/ name)
- **`lib/`** — shared helpers (sourced by scripts, not run directly)

The web-tools plugin uses all three: `bin/` for nothing, `scripts/<cap>/` for
each capability, `scripts/_lib/` for memory + hooks helpers. The
plugin-maker plugin uses `bin/plugin-maker` + `lib/*.sh` since there's only one
command.

## Adding self-healing memory

Pass `--memory` to `plugin-maker new plugin`. You get:

- `lib/memory.sh` — minimal VelociRAG wrapper (best-effort, never throws)
- `docs/self-healing.md` — protocol reference

The wrapper writes to `~/.synaps-cli/memory/<plugin-name>/`:

```
~/.synaps-cli/memory/<plugin>/
  notes/         markdown source of truth
  db/            VelociRAG index (derived)
  failures.jsonl raw operational log
```

See `web-tools-plugin/docs/self-healing.md` for the full pattern,
including PRE/ACT/POST hooks, tag conventions, and the
`web-status` / `web-consolidate` style of review-gated curation.
