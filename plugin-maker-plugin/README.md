# plugin-maker

Bash-based scaffolder, validator, linter, and inspector for **Synaps CLI plugins** —
covering the full plugin surface: manifests, skills, extensions, sidecars,
settings, keybinds, commands, hooks, and the `/help` lightbox.

This plugin replaces the older `skill-maker-plugin`. Where `skill-maker` only
understood `plugin.json` + `SKILL.md`, `plugin-maker` understands every surface
SynapsCLI exposes:

| Surface | What we generate / validate |
|---|---|
| **Plugin manifest** (`.synaps-plugin/plugin.json`) | full schema: `compatibility`, `commands` (4 shapes), `keybinds`, `help_entries`, `provides.sidecar`, `settings.categories`, `extension` block |
| **Skills** | frontmatter `name`/`description`, dir-name match, body lint |
| **Extensions** (`extensions/*.py`) | JSON-RPC 2.0 stub, 12 permissions × 7 hooks × tool-filter rules |
| **Sidecars** (`bin/<plugin>-sidecar`) | line-JSON v2 frame protocol stub, lifecycle wiring |
| **Slash commands** | shell / extension-tool / skill-prompt / interactive |
| **Keybinds** | 4 action kinds, reserved-key collision detection |
| **Settings** | text / cycler / picker / custom editors |

## Why this is a flagship plugin

It's also a working showcase of the SynapsCLI extension system. Loading the
plugin gives you:

- **`/help` lightbox** — every subcommand searchable in `/help find` with examples & related links.
- **`/settings` Plugin Maker category** — defaults for layout/license, plus a **custom Plugin Browser overlay** (rendered by the extension over `settings.editor.*` RPC) listing every installed plugin with live validate/lint status.
- **Slash command** `/plugin-maker …` — interactive, streamed through the extension.
- **Keybind** `Ctrl-Shift-P` → `/plugin-maker doctor .` for instant health check.
- **Three hooks**:
  - `on_session_start` — one-line health summary if any installed plugin fails to validate.
  - `before_tool_call` (bash, matches `plugin.json`) — gentle reminder.
  - `after_tool_call` (bash, matches `plugin.json`) — auto-validate on edit.

The bash CLI (`bin/plugin-maker`) is the canonical core and works standalone.
The Python extension (`extensions/plugin_maker_ext.py`) is a thin RPC adapter
that shells out to it, so the in-TUI experience is rich while keeping zero
runtime cost when used outside Synaps.

## Install

This plugin lives in the `synaps-skills` monorepo. After repo `install.sh`:

```bash
~/.synaps-cli/plugins/plugin-maker/bin/plugin-maker --help
```

Add `~/.synaps-cli/plugins/plugin-maker/bin/` to your `PATH` to use the bare
`plugin-maker` command (or symlink it to `pm`).

## Commands

```bash
plugin-maker new plugin <name> [--umbrella] [--memory] [--extension python] [--sidecar python] [--desc "Use when …"]
plugin-maker new skill <name>           [--plugin PATH] [--umbrella]
plugin-maker new extension              [--plugin PATH] [--lang python|node] [--hooks h1,h2] [--perms p1,p2]
plugin-maker new sidecar                [--plugin PATH] [--lifecycle-cmd NAME] [--lang python|rust]
plugin-maker new command <kind> <name>  [--plugin PATH] ...     # kind: shell|extension|skill|interactive
plugin-maker new keybind <key>          --action <slash_command|load_skill|inject_prompt|run_script> [--plugin PATH]
plugin-maker new settings <id>          --label LABEL [--plugin PATH]
plugin-maker new field <cat> <key>      --label L --editor <text|cycler|picker|custom> [--options ...]

plugin-maker validate [PATH]
plugin-maker lint     [PATH] [--strict]
plugin-maker doctor   [PATH]                 # validate + lint + install-readiness
plugin-maker info     [PATH]
plugin-maker list     [PATH]
plugin-maker catalog  <hooks|permissions|hook-permissions|sidecar-frames|editor-kinds|action-types>
```

See `skills/plugin-maker/SKILL.md` for the agent-facing index and `docs/` for
per-topic deep dives.

## Dependencies

- `bash` 4+
- `jq`
- `envsubst` (gettext-base)
- `python3` (only for the in-TUI extension)

## Status

`0.1.0` — initial release. Replaces `skill-maker-plugin/` (deleted).
