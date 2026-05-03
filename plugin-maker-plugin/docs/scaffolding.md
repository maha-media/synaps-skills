# scaffolding — `plugin-maker new`

Create new plugins and skills from templates. All output is small,
readable, and passes `plugin-maker validate` immediately.

## Commands

```bash
plugin-maker new plugin <name> [flags]    # scaffold a new plugin directory
plugin-maker new skill  <name> [flags]    # add a skill to an existing plugin
```

## `plugin-maker new plugin`

Creates `<name>-plugin/` in the current directory (or `--plugin-dir DIR`).

| Flag             | Effect                                                     |
|------------------|------------------------------------------------------------|
| `--umbrella`     | Index `SKILL.md` + `docs/example.md` (progressive disclosure) |
| `--memory`       | Add `lib/memory.sh` (VelociRAG wrapper) + `docs/self-healing.md` |
| `--desc TEXT`    | Description for both `plugin.json` and `SKILL.md`          |
| `--category CAT` | `category` field in `plugin.json` (default `productivity`) |
| `--plugin-dir DIR` | Parent dir to create the plugin under (default `.`)      |
| `--force`        | Overwrite existing target dir                              |

### Examples

```bash
# Single-skill plugin
plugin-maker new plugin pdf-merger \
  --desc "Use when merging multiple PDFs into one. Streaming, no temp files."

# Umbrella with progressive disclosure
plugin-maker new plugin docs-toolkit --umbrella \
  --desc "Use for converting between document formats. Index + per-format docs."

# Multi-capability plugin with self-healing memory baked in
plugin-maker new plugin scout --umbrella --memory \
  --desc "Use when probing services and you want learned failure patterns."
```

### What you get

```
my-tool-plugin/
├── .synaps-plugin/plugin.json   # filled with git-config-derived defaults
├── README.md
└── skills/my-tool/SKILL.md       # template with section scaffolding
```

With `--umbrella` you also get `docs/example.md`. With `--memory` you also
get `lib/memory.sh` and `docs/self-healing.md`.

## `plugin-maker new skill`

Adds a skill inside an existing plugin.

| Flag             | Effect                                                     |
|------------------|------------------------------------------------------------|
| `--plugin PATH`  | Plugin to add to. Default: walk up from cwd to find it     |
| `--desc TEXT`    | SKILL.md description                                       |
| `--umbrella`     | Use the umbrella SKILL.md template                         |
| `--force`        | Overwrite existing skill                                   |

### Examples

```bash
# Inside a plugin dir — auto-detects
cd my-tool-plugin
plugin-maker new skill validator --desc "Use to verify pdfs are well-formed."

# Outside, explicit
plugin-maker new skill validator --plugin ./my-tool-plugin
```

## Templates

Templates live under `templates/` in this plugin and use `${var}`
substitution via `envsubst`. They're plain files — feel free to edit
them in your local install for project-specific conventions.

| File                                  | Used for                              |
|---------------------------------------|---------------------------------------|
| `plugin.json.tmpl`                    | every plugin                          |
| `README.md.tmpl`                      | every plugin                          |
| `single/SKILL.md.tmpl`                | single-skill default                  |
| `umbrella/SKILL.md.tmpl`              | with `--umbrella`                     |
| `umbrella/example.md.tmpl`            | with `--umbrella`, becomes `docs/`    |
| `memory/memory.sh.tmpl`               | with `--memory`                       |
| `memory/self-healing.md.tmpl`         | with `--memory`                       |

### Template variables

Auto-filled from CLI flags + git config:

- `${NAME}` — kebab-case name from positional arg
- `${DESC}` — from `--desc` (placeholder if omitted)
- `${VERSION}` — `0.1.0`
- `${DATE}` — ISO date
- `${AUTHOR_NAME}` — from `git config user.name` (`Anonymous` fallback)
- `${AUTHOR_URL}` — derived from `git config remote.origin.url`
- `${REPOSITORY}` — `owner/repo` from origin URL
- `${CATEGORY}` — from `--category` (default `productivity`)

---

## Beyond skills — feature scaffolders

`plugin-maker` also scaffolds the **non-skill** plugin surface:

```bash
plugin-maker new extension --plugin PATH --lang python [--hooks h1,h2,…]
plugin-maker new sidecar   --plugin PATH --lang python [--lifecycle-cmd NAME]

plugin-maker new command   <shell|ext-tool|skill-prompt|interactive> <name> --plugin PATH
plugin-maker new keybind   <key> --action <a> --target <t> --plugin PATH

plugin-maker new settings  category <id> --label LABEL --plugin PATH
plugin-maker new settings  field    <category-id> <key> --label LABEL --type <text|cycler|toggle> --plugin PATH
```

Each of these:

1. Validates inputs against the catalog (`plugin-maker catalog hooks`, etc.).
2. Edits `plugin.json` in place using `jq` (atomic, formatting-preserving).
3. Drops any required source stub (`extensions/<name>_ext.py`,
   `sidecars/<name>.py`).
4. Re-runs validate on the affected manifest section.

So the *common* workflow is:

```bash
plugin-maker new plugin foo --umbrella --extension python
cd foo-plugin
plugin-maker new command interactive foo
plugin-maker new keybind C-S-f --action slash_command --target "foo run"
plugin-maker new settings category foo --label "Foo"
plugin-maker new settings field foo theme --label Theme --type cycler --options dark,light
plugin-maker doctor .
```

…and you're done — fully wired, fully validated, ready to install.
