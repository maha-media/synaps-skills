# conventions — Naming and structure rules

Based on the patterns used across the synaps-skills monorepo. The
validator and linter enforce these.

## Plugin

```
my-tool-plugin/                        # dir name = <plugin-name>-plugin
├── .synaps-plugin/
│   └── plugin.json                    # required
├── README.md                          # human-facing description
├── skills/                            # required (at least one skill)
│   └── <skill-name>/SKILL.md          # one per skill
├── docs/                              # optional, for progressive disclosure
└── scripts/ or bin/ or lib/           # optional, for executables
```

### Naming

- **Plugin dir:** `<name>-plugin/` (kebab-case + `-plugin` suffix)
- **Plugin name** (in `plugin.json`): just `<name>`, no `-plugin`
  - Example: dir `web-tools-plugin/`, name `"web-tools"`
- **Skill name** (frontmatter + dir): identical, lower-kebab-case
- **All names:** match `^[a-z0-9][a-z0-9-]*$`

## `plugin.json`

Required:

```json
{
  "name": "kebab-case-name",
  "version": "0.1.0",
  "description": "…",
  "author": { "name": "…", "url": "…" },
  "repository": "owner/repo",
  "license": "MIT",
  "category": "productivity"
}
```

- `version` must be semver: `MAJOR.MINOR.PATCH[-PRERELEASE]`
- `description` ≥ 40 chars (agents and humans both read it)

## `SKILL.md` frontmatter

Required:

```yaml
---
name: my-skill
description: Use when … (trigger phrase + 1-line summary).
---
```

- `name` must equal the parent directory name (Anthropic's loader checks)
- `description` should:
  - Be 40-200 chars (≥40 to be useful, ≤200 to fit a triage decision)
  - Lead with a trigger phrase ("Use when …", "Drives …", "Validates …")
  - Mention the verb and the trigger condition

### Bad descriptions

| Bad                                  | Why                          |
|--------------------------------------|------------------------------|
| `Tooling.`                           | < 40 chars, no trigger       |
| `A skill.`                           | tells agent nothing          |
| `This skill provides comprehensive…` | passive, no trigger          |

### Good descriptions

| Good                                                                                    |
|-----------------------------------------------------------------------------------------|
| `Use when fetching a single URL — lightweight HTML→markdown without launching a browser.` |
| `Drives systematic root-cause debugging when tests fail or behavior is unexpected.`     |
| `Scaffolds, validates, and lints Synaps CLI plugins. Use when starting a new plugin.`   |

## Tags (for memory-using plugins)

Hyphenated, lowercase. Standard prefixes:

- `kind-fix` — verified fix
- `kind-runbook` — procedure
- `kind-caveat` — known gotcha
- `domain-<host-with-dashes>` (e.g. `domain-github-com`)
- `op-<operation>` (e.g. `op-fetch`)
- `err-<class>` (e.g. `err-http_403`)

## Directory layouts (which to choose)

See `patterns.md` for the full discussion. Short version:

- **single** — one focused capability, < 200 lines of SKILL.md
- **umbrella** — multiple capabilities, index + `docs/`
- **multi-skill** — independent skills sharing a plugin (no umbrella index)

## Forbidden in templates / scaffolded output

- User-specific values hard-coded (use git config or placeholders)
- Code requiring `npm install` / `pip install` to run
- References to specific human authors
- Secrets, tokens, keys
