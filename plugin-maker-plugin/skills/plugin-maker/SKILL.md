---
name: plugin-maker
description: Use when creating, validating, linting, or inspecting Synaps CLI plugins — covers the full surface (manifests, skills, extensions, sidecars, settings, keybinds, commands).
---

# plugin-maker — Index

`plugin-maker` is the canonical scaffolder, validator, linter, and inspector
for **Synaps CLI plugins**. It knows the full plugin surface as defined in
`SynapsCLI/src/`:

- `.synaps-plugin/plugin.json` (manifest)
- `skills/<name>/SKILL.md` + supporting docs (the skills surface)
- `extensions/<name>` (long-running JSON-RPC 2.0 extension processes)
- `provides.sidecar` (line-JSON v2 sidecar adapters)
- `settings.categories` (TUI `/settings` menu)
- `keybinds[]` (chat input keybindings)
- `commands[]` (slash commands — 4 shapes: shell, ext-tool, skill-prompt, interactive)

Read this index first, then load **only** the doc you need.

## When to use

| Trigger | Doc |
|---|---|
| Starting a new plugin | [`scaffolding.md`](../../docs/scaffolding.md) |
| Adding extension/sidecar/command/keybind/settings to existing plugin | [`scaffolding.md`](../../docs/scaffolding.md) |
| Need to know which permission a hook requires | [`permissions-and-hooks.md`](../../docs/permissions-and-hooks.md) |
| Writing the manifest by hand | [`manifest-reference.md`](../../docs/manifest-reference.md) |
| Designing an extension (hooks, RPC methods) | [`extension-system.md`](../../docs/extension-system.md) |
| Designing a sidecar (frame protocol v2) | [`sidecar-protocol.md`](../../docs/sidecar-protocol.md) |
| Adding settings categories / fields | [`settings-categories.md`](../../docs/settings-categories.md) |
| Picking a keybind that won't conflict | [`keybinds.md`](../../docs/keybinds.md) |
| CI / pre-merge gate | [`validation.md`](../../docs/validation.md) |
| What "good" looks like | [`conventions.md`](../../docs/conventions.md), [`patterns.md`](../../docs/patterns.md) |

## CLI cheat-sheet

```bash
plugin-maker new plugin <name> [--umbrella] [--memory] [--extension python] [--sidecar python]
plugin-maker new skill <name> [--plugin PATH] [--umbrella]
plugin-maker new extension --plugin PATH [--lang python] [--hooks h1,h2,…]
plugin-maker new sidecar   --plugin PATH [--lang python]
plugin-maker new command   <shell|ext-tool|skill-prompt|interactive> <name> --plugin PATH
plugin-maker new keybind   <key>   --action <a> --target <t> --plugin PATH
plugin-maker new settings  category <id> --label LABEL --plugin PATH
plugin-maker new settings  field    <category-id> <key> --label LABEL --type <text|cycler|toggle> --plugin PATH

plugin-maker validate [PATH …]      # error-severity rules only (exit ≠ 0 on fail)
plugin-maker lint     [PATH …]      # warning-severity rules
plugin-maker info     [PATH]        # rich summary table
plugin-maker doctor   [PATH]        # validate + lint + summary
plugin-maker list     [PATH]        # list all plugins under PATH
plugin-maker catalog  <perms|hooks|commands|keybinds|editors|frames>
```

## Quick rules

- Plugin folder name **must** end in `-plugin`. The `name` in `plugin.json` does **not**.
- Every hook needs its matching permission; `plugin-maker catalog hooks` shows the map.
- Settings field types: `text`, `toggle` (cycler with on/off), `cycler` (custom options), `editor` (custom JSON-RPC editor).
- A plugin must provide at least one of: skills, extension, sidecar.

## Don't do this

- Don't hand-edit `plugin.json` and forget to re-run `plugin-maker validate`.
- Don't add a hook without its permission — Synaps will refuse to load.
- Don't pick a keybind in the reserved list (see `plugin-maker catalog keybinds`).
- Don't use the legacy `skill-maker` CLI — it's been replaced by `plugin-maker`.
