# skill-maker — Spec

## Assumptions

1. **Target:** Synaps CLI plugins (matches `engineering-plugin/`, `web-tools-plugin/`, `tmux-tools-plugin/`, `memkoshi-plugin/`).
2. **Audience:** Future-me / future-agents starting new plugins.
3. **Scope of "basic":** MVP — scaffold + validate + lint. Not a publishing pipeline, not a test runner.
4. **Distribution:** Lives in `synaps-skills` monorepo, ships via existing `install.sh`.
5. **Runtime:** **Bash** as the host language. Standard Unix tools only:
   - `bash 4+` — main scripting
   - `jq` — JSON parsing/writing (universally installed; install.sh checks)
   - `envsubst` — `${var}` template substitution (gettext-base, universal)
   - `grep` / `sed` / `awk` / `find` — text processing
6. **No memory layer** — pure tooling, no VelociRAG hooks.

→ Confirmed by user.

## Objective

Lower the friction of creating new Synaps plugins/skills. One command produces a valid skeleton with the conventions baked in, an inline guidance doc, and a validator that catches drift.

**Success criteria:**

- `skill new plugin foo` → produces a plugin that passes `skill validate` immediately.
- `skill validate` against the existing 4 plugins returns clean.
- `skill lint` flags real issues (missing description, missing trigger phrase, stale TODOs).
- Total scaffolded plugin is < 100 lines per file.
- No runtime deps beyond what install.sh already checks for.

## Commands

```bash
skill new plugin <name> [--umbrella] [--memory] [--desc TEXT]
skill new skill <name>  [--plugin PATH] [--desc TEXT]
skill validate [PATH]
skill lint [PATH]
skill list [PATH]
skill --help
```

`PATH` defaults to `.` (current directory). When run inside a plugin or the monorepo root, behaviour adapts (auto-detect `*-plugin/` siblings).

## Project structure

```
skill-maker-plugin/
├── .synaps-plugin/plugin.json
├── README.md
├── skills/
│   └── skill-maker/SKILL.md           # umbrella index
├── docs/
│   ├── scaffolding.md
│   ├── validation.md
│   ├── conventions.md
│   ├── patterns.md
│   └── specs/skill-maker.md           # this file
├── bin/
│   └── skill                          # main CLI (bash, executable)
├── lib/
│   ├── common.sh                      # logging, color, arg parsing helpers
│   ├── validate.sh                    # validation rules
│   ├── lint.sh                        # opinionated rules
│   ├── scaffold.sh                    # plugin/skill creation
│   └── frontmatter.sh                 # YAML frontmatter parsing (sed/awk)
└── templates/
    ├── plugin.json.tmpl
    ├── README.md.tmpl
    ├── single/SKILL.md.tmpl
    ├── umbrella/SKILL.md.tmpl
    ├── umbrella/example.md.tmpl       # goes into docs/
    └── memory/                        # opt-in scaffolding
        ├── memory.sh.tmpl             # pure-bash velocirag wrapper
        └── self-healing.md.tmpl
```

## Code style

```bash
#!/usr/bin/env bash
# One feature per file. set -euo pipefail at top. Functions verb-like.

set -euo pipefail

validate_plugin_json() {
  local file="$1"
  local errs=0

  if ! jq -e '.name' "$file" >/dev/null; then
    err "P001: plugin.json missing 'name'"
    ((errs++))
  fi

  local name
  name=$(jq -r '.name // empty' "$file")
  if [[ -n "$name" && ! "$name" =~ ^[a-z0-9-]+$ ]]; then
    err "P002: plugin.json 'name' must be lower-kebab-case (got '$name')"
    ((errs++))
  fi

  return $errs
}
```

Conventions:
- `set -euo pipefail` in every script
- Functions return non-zero on validation failure (caller increments error counter)
- Logging via `info`/`warn`/`err`/`ok` helpers in `common.sh` with TTY-aware color
- All paths handled with `"$var"` quoting; no `eval`
- `mktemp -d` for any scratch space; trap cleanup

## Templating

`envsubst` with explicit variable allowlist (so we don't accidentally expand `$PATH` etc.):

```bash
NAME="foo" DESC="..." DATE="2026-04-26" \
  envsubst '$NAME $DESC $DATE' < templates/plugin.json.tmpl > out/plugin.json
```

Variables exported by scaffold:
- `$NAME` — plugin/skill name (kebab-case)
- `$DESC` — description (from `--desc` or generic placeholder)
- `$AUTHOR_NAME` — `git config user.name` fallback `"Anonymous"`
- `$AUTHOR_URL` — derived from `git config remote.origin.url` if present
- `$DATE` — ISO date
- `$VERSION` — initial `0.1.0`

## Testing strategy

A `scripts/test.sh` smoke harness:

```bash
# All known-good plugins must pass validation
for p in engineering-plugin web-tools-plugin tmux-tools-plugin memkoshi-plugin; do
  bin/skill validate "$REPO/$p" || exit 1
done

# Scaffold + validate roundtrip
tmp=$(mktemp -d)
bin/skill new plugin demo --umbrella --plugin-dir "$tmp"
bin/skill validate "$tmp/demo-plugin"
rm -rf "$tmp"
```

Invoke from CI as `bash scripts/test.sh`.

## Boundaries

**Always do:**
- `set -euo pipefail` everywhere
- Quote all variable expansions
- Use `mktemp -d` and `trap` for cleanup
- Validate frontmatter exactly as Anthropic's loader does (name + description required, name == dir)
- Keep generated output small (<100 lines per file)

**Ask first:**
- Adding any non-stdlib tool dep beyond `jq` + `envsubst`
- Auto-modifying existing plugins (out of MVP)
- Auto-pushing/PR/tag

**Never do:**
- Overwrite existing dir without `--force`
- `eval` user input
- Embed user-specific values in shipped templates
- Generate code requiring `npm install` / `pip install` (templates produce zero-install output)

## Linter rules

| ID    | Severity | Check                                                               |
|-------|----------|---------------------------------------------------------------------|
| F001  | error    | Frontmatter missing `name` or `description`                         |
| F002  | error    | `name` doesn't match parent directory                               |
| F003  | warn     | `description` < 40 chars (too vague)                                |
| F004  | warn     | `description` > 200 chars (too verbose)                             |
| F005  | warn     | `description` lacks trigger phrase ("use when", "for ", "drives ")  |
| B001  | warn     | SKILL.md body > 300 lines (consider progressive disclosure)         |
| B002  | warn     | TODO / FIXME / XXX / placeholder text                               |
| B003  | warn     | No section headings (`##`) in body                                  |
| P001  | error    | plugin.json missing required field                                  |
| P002  | error    | plugin.json `name` not lower-kebab-case                             |
| P003  | error    | plugin.json `version` not semver                                    |
| P004  | warn     | plugin.json `description` < 40 chars                                |

`error` → exit 1. `warn` → exit 0 with stderr warnings. `--strict` promotes warnings to errors.

## Phase plan (incremental slices)

| # | Slice                     | Deliverable                                                  |
|---|---------------------------|--------------------------------------------------------------|
| 1 | read-only                 | plugin skeleton + `bin/skill` skeleton + `validate` + `list` |
| 2 | scaffold                  | `new plugin` (single + umbrella) + smoke script              |
| 3 | scaffold                  | `new skill` within existing plugin                           |
| 4 | quality                   | `lint` with all rules                                        |
| 5 | docs + install            | umbrella SKILL.md + per-docs + install.sh integration + PR   |

Each slice ends in a working commit.

## Out of scope (MVP)

- `skill bump <major|minor|patch>`
- `skill convert single→umbrella`
- `skill publish`
- `skill test` (running install.sh --check)
- `skill diff` (drift detection)
- Marketplace integration
