# Settings categories

Plugins extend the `/settings` menu via `settings.categories[]` in
`plugin.json`. Each category contains one or more **fields**, and each field
has an **editor** that picks its UI widget.

> Source: `SynapsCLI/src/skills/manifest.rs::ManifestSettingsField` + `ManifestEditorKind`.

## Category shape

```jsonc
{
  "id": "plugin-maker",
  "label": "Plugin Maker",
  "fields": [ /* see below */ ]
}
```

`id` must be globally unique (rule `T001`) — by convention, prefix with your
plugin name.

## Field shape

```jsonc
{
  "key":      "default_layout",         // unique within the category (T002)
  "label":    "Default scaffold layout",
  "editor":   "cycler",                 // one of: text, cycler, picker, custom
  "options":  ["single", "umbrella"],   // required for cycler (T003)
  "default":  "single",                 // optional; type follows editor
  "numeric":  false,                    // text-only — restrict to numbers
  "help":     "Layout used by `plugin-maker new plugin`."
}
```

## The 4 editors

| Editor   | UI                                          | Required keys |
|----------|---------------------------------------------|---------------|
| `text`   | freeform input (numbers if `numeric:true`)  | — |
| `cycler` | left/right cycles through `options[]`       | `options[]` |
| `picker` | opens a list — options supplied at runtime by your extension | extension RPC |
| `custom` | extension renders the panel itself          | extension RPC |

### `text`

```json
{ "key": "default_author_name",
  "label": "Default author name",
  "editor": "text",
  "default": "Maha Media" }
```

### `cycler`

```json
{ "key": "default_layout",
  "label": "Default layout",
  "editor": "cycler",
  "options": ["single", "umbrella", "memory"],
  "default": "single" }
```

A two-option cycler (`["off","on"]`) is the idiomatic toggle.

### `picker` and `custom`

Both delegate to your extension via this RPC quartet:

| RPC | Direction | Purpose |
|---|---|---|
| `settings.editor.open`   | Synaps → ext | `{ field }` — extension allocates state |
| `settings.editor.render` | Synaps → ext | returns `{ text }` (current panel content) |
| `settings.editor.key`    | Synaps → ext | `{ key: "up"/"enter"/… }` — return new render |
| `settings.editor.commit` | Synaps → ext | user accepted; persist if needed |

The difference: `picker` is a list-of-options widget where Synaps owns the
list rendering, while `custom` is a free-form full-panel overlay where your
extension owns every pixel.

See `extensions/plugin_maker_ext.py` (field `browse_plugins`) for a working
**Plugin Browser** custom editor.

## Validation rules

| Rule | Check |
|---|---|
| `T001` | category `id` unique within the manifest |
| `T002` | field `key` unique within its category, `editor` set |
| `T002` | `editor` ∈ `{text, cycler, picker, custom}` |
| `T003` | `cycler` has non-empty `options[]` |
| `T004` | `numeric:true` only valid on `text` fields |

## Reading settings from your extension

Synaps writes user choices to `~/.synaps-cli/config/<plugin>.json`. With
`config.subscribe` permission your extension receives a `config.changed`
notification on update. Without the permission, just read the file lazily.

## Scaffolding

```bash
plugin-maker new settings category demo --label "Demo Settings" --plugin .
plugin-maker new settings field    demo theme \
  --label "Theme" --type cycler --options light,dark --default dark --plugin .
```

The scaffolder accepts `--type` and `--editor` interchangeably.
