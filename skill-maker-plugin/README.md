# skill-maker

Bash-based scaffolder, validator, and linter for Synaps CLI plugins.
Encodes the conventions used across the
[synaps-skills](https://github.com/maha-media/synaps-skills) monorepo.

## Why

Creating a new plugin used to mean re-learning the structure (`.synaps-plugin/plugin.json`,
`skills/<name>/SKILL.md` frontmatter, dir-name=plugin-name conventions, etc.).
This plugin captures all of that as templates + checks so you can:

```bash
skill new plugin my-tool --desc "Use when …"
skill validate
skill lint
```

…and end up with a plugin that already passes both checks.

## Install

This plugin lives in the `synaps-skills` monorepo. After `install.sh`,
the `bin/skill` entrypoint is available at:

```bash
~/.synaps-cli/plugins/skill-maker/bin/skill
```

Add it to your `PATH` to use the bare `skill` command.

## Commands

| Command                              | Purpose                                     |
|--------------------------------------|---------------------------------------------|
| `skill new plugin <name>`            | Scaffold a plugin (single / umbrella / memory) |
| `skill new skill <name>`             | Add a skill to an existing plugin           |
| `skill validate [PATH]`              | Structural checks (errors → exit 1)         |
| `skill lint [PATH]`                  | Quality checks (warnings; --strict for errors)|
| `skill list [PATH]`                  | Enumerate plugins or skills                 |

See `skills/skill-maker/SKILL.md` for the agent-facing index, and
`docs/` for per-topic deep dives (`scaffolding`, `validation`,
`conventions`, `patterns`).

## Dependencies

- `bash 4+`
- `jq`
- `envsubst` (gettext-base)

All three are present on every reasonable Linux. `install.sh` checks
for them.

## Status

`0.1.0` — initial release. Validates and lints all 6 plugins in the
monorepo cleanly (with intentional warnings flagging real drift).
