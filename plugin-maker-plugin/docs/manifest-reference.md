# `plugin.json` — manifest reference

The manifest at `<plugin>/.synaps-plugin/plugin.json` is the single declaration
point for everything Synaps knows about a plugin. This page documents every
top-level key.

> **Source of truth:** `SynapsCLI/src/skills/manifest.rs::PluginManifest`.

## Required top-level keys

| Key | Type | Notes |
|---|---|---|
| `name`        | string  | kebab-case, **without** the `-plugin` suffix |
| `version`     | string  | semver (`MAJOR.MINOR.PATCH`) |
| `description` | string  | ≥ 40 chars, starts with a capital, ends with `.` |
| `author.name` | string  | required |
| `author.url`  | string  | required (use a stable URL) |
| `repository`  | string  | git/https URL |
| `license`     | string  | SPDX identifier |
| `category`    | string  | freeform tag, e.g. `developer-tools` |

## Optional top-level keys

| Key | Type | Purpose |
|---|---|---|
| `compatibility`         | object  | `{ synaps: ">=0.1.0", extension_protocol: 1 }` |
| `provides`              | object  | `{ skills: [...], sidecar: {...} }` |
| `commands`              | array   | slash commands — see below |
| `keybinds`              | array   | chat-input keybindings |
| `settings.categories`   | array   | `/settings` menu categories |
| `extension`             | object  | long-running extension process |
| `help_entries`          | array   | `/help` lightbox entries |
| `skill_dirs`            | array   | extra skill roots (default: `["skills"]`) |

## `commands[]` (4 shapes)

| Shape | Required keys | Optional |
|---|---|---|
| **shell**         | `name`, `command`         | `description`, `args[]` |
| **ext-tool**      | `name`, `tool`            | `description`, `input` |
| **skill-prompt**  | `name`, `skill`, `prompt` | `description` |
| **interactive**   | `name`, `interactive: true`, `subcommands[]` | `description` |

A command is detected by which discriminator key it carries — `command`,
`tool`, `skill`, or `interactive`. Mixing them is an error (`C002`).

## `keybinds[]`

```json
{
  "key": "C-S-p",
  "action": "slash_command",
  "command": "plugin-maker doctor .",
  "description": "Run plugin-maker doctor on the current directory."
}
```

`action` is one of: `slash_command`, `load_skill`, `inject_prompt`, `run_script`.
The payload field name depends on the action:

| `action`        | required field |
|-----------------|----------------|
| `slash_command` | `command`      |
| `load_skill`    | `skill`        |
| `inject_prompt` | `prompt`       |
| `run_script`    | `script`       |

Reserved keys (Esc, Enter, plain arrows, …) are listed in
`plugin-maker catalog keybinds`.

## `settings.categories[]`

```json
{
  "id": "plugin-maker",
  "label": "Plugin Maker",
  "fields": [
    { "key": "default_layout", "label": "Default layout", "editor": "cycler",
      "options": ["single", "umbrella", "memory"], "default": "single" },
    { "key": "browse_plugins", "label": "Browse plugins…", "editor": "custom" }
  ]
}
```

Field `editor` ∈ `{text, cycler, picker, custom}`. A `custom` field is rendered
by your extension via the `settings.editor.{open,render,key,commit}` RPC
quartet. Set `numeric: true` on a `text` field to restrict input to numbers.

## `extension` block

```json
{
  "extension": {
    "name": "plugin-maker",
    "command": "python3",
    "args": ["${PLUGIN_DIR}/extensions/plugin_maker_ext.py"],
    "permissions": ["tools.intercept", "session.lifecycle"],
    "hooks": [
      { "kind": "before_tool_call", "tool_filter": ["bash"] },
      { "kind": "on_session_start" }
    ]
  }
}
```

Every hook needs the matching permission — see `permissions-and-hooks.md`.
`${PLUGIN_DIR}` is expanded to the install dir at load time.

## `provides.sidecar`

```json
{
  "provides": {
    "sidecar": {
      "command": "python3",
      "args": ["${PLUGIN_DIR}/sidecars/foo.py"],
      "lifecycle": "on_command",
      "lifecycle_command": "foo-start",
      "model": "stream"
    }
  }
}
```

`lifecycle`: `always`, `on_command`, `on_demand`.
`model`: `stream`, `oneshot`.

## `help_entries[]`

```json
{
  "id": "plugin-maker:new",
  "category": "Plugin Maker",
  "topic": "/plugin-maker new",
  "summary": "Scaffold a new plugin or skill.",
  "keywords": ["scaffold", "plugin", "skill"],
  "examples": ["/plugin-maker new plugin foo --umbrella"]
}
```

Help entries auto-populate the `/help find` lightbox.

## Validation cheat-sheet

| Rule prefix | Coverage |
|---|---|
| `P###` | top-level manifest |
| `F###` | folder layout, frontmatter, files |
| `B###` | author/repo/license sanity |
| `X###` | extension block |
| `S###` | sidecar block |
| `T###` | settings categories/fields |
| `K###` | keybinds |
| `C###` | commands |

Run `plugin-maker catalog hooks` (or `perms`, `frames`, …) to dump any
catalog. Every rule is listed in `docs/specs/plugin-maker.md`.
