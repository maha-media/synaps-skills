# Keybinds

Plugins can register chat-input keybindings via `keybinds[]` in `plugin.json`.
Synaps dispatches them when the chat input is focused and not in a modal.

## Shape

```json
{
  "key": "C-S-p",
  "action": "slash_command",
  "command": "plugin-maker doctor .",
  "description": "Run plugin-maker doctor on the current directory."
}
```

The **payload field** depends on `action`:

| `action`        | required field | Effect |
|-----------------|----------------|--------|
| `slash_command` | `command`      | runs the slash command (no leading `/`) |
| `load_skill`    | `skill`        | loads the named skill into context |
| `inject_prompt` | `prompt`       | inserts text at cursor |
| `run_script`    | `script`       | runs script (relative to plugin dir) and inserts stdout |

`description` is recommended — it shows up in `/help`.

## Key syntax

> Source: `SynapsCLI/src/skills/keybinds.rs::parse_key`.

A key string is `MOD-MOD-…-CODE`, e.g. `C-S-p`, `A-Enter`, `F5`.

| Modifier | Meaning |
|---|---|
| `C-` | Ctrl  |
| `S-` | Shift |
| `A-` | Alt   |

| Code class | Examples |
|---|---|
| Letters    | `a` … `z` (case-insensitive) |
| Digits     | `0` … `9` |
| Function   | `F1` … `F12` |
| Named      | `Enter`, `Esc`, `Tab`, `Space`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `Backspace`, `Delete`, `Insert` |

## Reserved keys

These cannot be remapped (rule `K003`):

```
Esc  Enter  Tab  Space  Backspace  Delete
Up  Down  Left  Right          (without modifiers)
PageUp  PageDown  Home  End    (without modifiers)
F1                              (reserved for /help)
```

A modifier (`C-`, `A-`, …) makes any of these available again.

## Validation

| Rule | Check |
|---|---|
| `K001` | `key` parses (modifiers + code) |
| `K002` | `action` ∈ the 4 valid actions |
| `K003` | required payload field present for chosen `action` |
| `K004` | `key` is not in the reserved list |
| `K005` | duplicate key within the same plugin |

`plugin-maker lint` (rule `K101`) also warns when two **different** plugins
register the same key — Synaps loads them in install order, so the second
silently loses.

## Scaffolding

```bash
plugin-maker new keybind C-S-p \
  --action slash_command \
  --command "plugin-maker doctor ." \
  --description "Run doctor on cwd." \
  --plugin .
```

The scaffolder picks the right field flag for you — `--command`, `--skill`,
`--prompt`, or `--script` — and rejects mismatched combinations.

