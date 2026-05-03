# validation — `plugin-maker validate` and `plugin-maker lint`

Two read-only commands. **`validate`** catches structural errors that
break plugin loading. **`lint`** catches quality drift that doesn't
break anything but degrades agent UX.

| Command   | Severity         | Exit on issues |
|-----------|------------------|----------------|
| `validate`| errors only      | exit 1         |
| `lint`    | warnings (errors with `--strict`) | exit 0 (or 1 with `--strict`) |

## `plugin-maker validate [PATH]`

Runs the structural checks. `PATH` defaults to `.` and behaves
adaptively:

- If `PATH` is a plugin (has `.synaps-plugin/plugin.json`) — validates that one.
- Otherwise — finds every plugin under `PATH` and validates them all.

### Rules (errors)

| ID    | Rule                                                                  |
|-------|-----------------------------------------------------------------------|
| P001  | `plugin.json` missing or has no `name`/`version`/`description`        |
| P002  | `plugin.json` `name` not lower-kebab-case                             |
| P003  | `plugin.json` `version` not semver (`0.1.0`, `1.0.0-beta`, …)         |
| F001  | `SKILL.md` missing or has no YAML frontmatter                         |
| F002  | Frontmatter `name` doesn't match parent directory                     |

### Examples

```bash
plugin-maker validate                          # plugin (or all under) cwd
plugin-maker validate ./web-tools-plugin       # one plugin
plugin-maker validate ~/Projects/synaps-skills # whole monorepo
```

## `plugin-maker lint [PATH]`

Quality checks. By default warnings only — exit 0 even on issues.
Pass `--strict` to make them fail the build.

### Rules (warnings, or errors with `--strict`)

| ID    | Rule                                                                  |
|-------|-----------------------------------------------------------------------|
| F003  | Description `< 40` chars (too vague)                                  |
| F004  | Description `> 200` chars (too verbose)                               |
| F005  | Description lacks a trigger phrase ("use when", "drives", verb start) |
| B001  | SKILL.md body `> 300` lines (consider progressive disclosure)         |
| B002  | TODO/FIXME/XXX/`<placeholder>` markers in shipped SKILL.md            |
| B003  | No `##` section headings in a body `> 30` lines                       |
| P004  | `plugin.json` description `< 40` chars                                |

### Examples

```bash
plugin-maker lint                              # warnings only, exit 0
plugin-maker lint --strict                     # warnings → errors, exit 1 if any
plugin-maker lint ./web-tools-plugin           # one plugin
```

### Why these rules

- **Description length** — too short = agents can't tell when to use it.
  Too long = the description becomes a paragraph instead of a trigger.
- **Trigger phrase** — Anthropic's loader uses the description to decide
  whether to load the skill. Without "use when …" or a verb-led summary
  the description doesn't carry decision signal.
- **Body length** — bodies > 300 lines are usually a hint that
  progressive disclosure (umbrella + `docs/`) would help. The whole
  body gets read into the agent's context.
- **TODO markers** — placeholder text shipping in a real skill means
  someone forgot to fill in the template. Catches drift fast.
- **Section headings** — long unstructured bodies are hard for agents
  to navigate. `##` sections give them landmarks.

## Pre-flight before opening a PR

```bash
plugin-maker validate .                        # MUST pass
plugin-maker lint --strict .                   # SHOULD pass
```

## Suppressing warnings

There's no inline suppression syntax — fix the warning or accept it.
If a rule is genuinely wrong for your case, edit `lib/lint.sh` in your
local install. Lint is opinionated by design; suppressions tend to
multiply faster than fixes.

---

## Beyond skills

`plugin-maker validate` covers every section of `plugin.json` that a plugin
declares — extension, sidecar, settings, keybinds, commands, help_entries —
each in its own rule namespace (see `conventions.md`).

Run `plugin-maker doctor PATH` for the full picture: validate + lint + a
human summary in one shot.

To dump every rule by ID without leaving the terminal:

```bash
plugin-maker catalog hooks         # 7 hook kinds + required permissions
plugin-maker catalog perms         # 12 permissions
plugin-maker catalog frames        # sidecar v2 wire frames
plugin-maker catalog editors       # settings field/editor kinds
plugin-maker catalog actions       # keybind action types
plugin-maker catalog commands      # the 4 command shapes
```
