# plugin-maker — design spec

`v0.1.0` — initial release.

## Goal

Replace `skill-maker-plugin/` with a tool that knows the **full** SynapsCLI
plugin surface, not just `plugin.json` + `SKILL.md`. Every field a plugin author
can set should be scaffoldable, validatable, and lintable.

## Source-of-truth crosswalk

`plugin-maker` derives every rule from these CLI source files. When the CLI
bumps versions, `lib/catalog.sh` is the only file we touch.

| Concept | CLI source |
|---|---|
| Plugin manifest schema | `src/skills/manifest.rs::PluginManifest` |
| Command shapes (4) | `src/skills/manifest.rs::ManifestCommand` |
| Settings categories / fields / editor kinds | `src/skills/manifest.rs::ManifestSettings` |
| Sidecar `provides` block + lifecycle | `src/skills/manifest.rs::SidecarManifest` |
| Sidecar wire protocol (v2) | `src/sidecar/protocol.rs` |
| Keybind action kinds | `src/skills/keybinds.rs::ManifestKeybind` |
| Help entries | `src/help.rs::HelpEntry` |
| Extension manifest | `src/extensions/manifest.rs::ExtensionManifest` |
| Permissions (12) | `src/extensions/permissions.rs::Permission` |
| Hooks (7) | `src/extensions/hooks/events.rs::HookKind` |
| Hook→permission map | `HookKind::required_permission` |
| Hook tool-filter rule | `HookKind::allows_tool_filter` |
| Hook actions | `HookKind::allowed_action_names` |

Out of scope for v0.1 (CLI-internal, not author surface):

- `src/watcher/` — autonomous agent supervisor (own `synaps watcher init`)
- `src/events/` — universal event bus (Discord/Slack ingest); no manifest field

## Rule namespaces

| Prefix | Domain | Severity |
|---|---|---|
| `P0xx` | plugin manifest core | error / lint mix |
| `F0xx` | skill frontmatter | error |
| `B0xx` | skill body | lint |
| `X0xx` | extension manifest | error |
| `S0xx` | sidecar (`provides.sidecar`) | error / lint mix |
| `T0xx` | settings (`settings.categories`) | error |
| `K0xx` | keybinds | error |
| `C0xx` | commands | error |
| `H0xx` | help_entries | lint |

Errors fail `validate`. Lint warnings fail `lint --strict` only.

### P — plugin manifest

| ID | Severity | Rule |
|---|---|---|
| P001 | error | `.synaps-plugin/plugin.json` exists and is valid JSON |
| P002 | error | `name` matches `^[a-z0-9][a-z0-9-]*$` |
| P003 | error | `version` is semver (`MAJOR.MINOR.PATCH[-PRERELEASE]`) |
| P004 | lint | `description` ≥ 40 chars |
| P005 | lint | `author` / `repository` / `license` / `category` present |
| P006 | error | parent dir name == `<name>-plugin/` |
| P007 | error | `compatibility.extension_protocol`, if set, equals `"1"` |
| P008 | error | `commands[]` items match exactly one of the 4 shapes |
| P009 | error | no duplicate command names within `commands[]` |
| P010 | error | `provides.sidecar.protocol_version` ∈ `{1, 2}` |

### F — skill frontmatter (port from skill-maker)

| ID | Severity | Rule |
|---|---|---|
| F001 | error | SKILL.md exists, starts with `---`, has `name` + `description` |
| F002 | error | frontmatter `name` equals parent directory name |
| F003 | lint | `description` ≥ 40 chars |
| F004 | lint | `description` ≤ 200 chars |
| F005 | lint | `description` contains a trigger phrase |

### B — skill body (port)

| ID | Severity | Rule |
|---|---|---|
| B001 | lint | body ≤ 300 lines (else: progressive disclosure) |
| B002 | lint | no TODO/FIXME/XXX/`<placeholder>` markers |
| B003 | lint | body has at least one `##` heading when > 30 lines |

### X — extension manifest

| ID | Severity | Rule |
|---|---|---|
| X001 | error | `extension.runtime` == `"process"` |
| X002 | error | `extension.command` non-empty |
| X003 | error | `extension.protocol_version` == `1` |
| X004 | error | every `permissions[]` entry is a known permission (see catalog) |
| X005 | error | reserved permission `tools.override` not granted |
| X006 | error | extension declares ≥1 hook OR holds a register-permission (`tools.register`/`providers.register`/`memory.read`/`memory.write`/`config.write`/`config.subscribe`/`audio.input`/`audio.output`) |
| X007 | error | every `hooks[].hook` is a known hook kind |
| X008 | error | every hook subscription's required permission is in `permissions[]` |
| X009 | error | `hooks[].tool` only set on `before_tool_call` / `after_tool_call` |
| X010 | error | `hooks[].match` only contains `input_contains` / `input_equals` |
| X011 | error | `extension.command` (if relative) resolves under plugin root |
| X012 | error | `config[].key` non-empty + unique |

### S — sidecar (`provides.sidecar`)

| ID | Severity | Rule |
|---|---|---|
| S001 | error | `provides.sidecar.command` non-empty |
| S002 | lint  | command file exists at install-time (resolved against plugin root) |
| S003 | lint  | `setup` script exists (if specified) |
| S004 | error | `protocol_version` ∈ `{1, 2}` |
| S005 | lint  | when `model.required: true`, `model.default_path` is set |
| S006 | lint  | when `lifecycle.command` is set, that command also appears in `commands[]` or a `keybinds[]` entry |
| S007 | lint  | `lifecycle.importance` ∈ `[-100, 100]` (the CLI clamps; we warn) |

### T — settings

| ID | Severity | Rule |
|---|---|---|
| T001 | error | every category has `id` + `label` |
| T002 | error | every field has `key` + `label` + `editor` |
| T003 | error | `editor: cycler` requires non-empty `options[]` |
| T004 | error | `editor: text` + `numeric: true` is the only place `numeric` is meaningful |
| T005 | lint  | `editor: custom` requires the plugin to declare an extension (the editor is rendered by the extension over `settings.editor.*` RPC) |

### K — keybinds

| ID | Severity | Rule |
|---|---|---|
| K001 | error | `key` parses (notation: `[C-][S-][A-]<key>`, where `<key>` is a single char or one of `Space|Tab|Enter|Esc|F1`–`F12`) |
| K002 | error | `action` ∈ `{slash_command, load_skill, inject_prompt, run_script}` |
| K003 | error | action-specific field present (`slash_command`→`command`, `load_skill`→`skill`, `inject_prompt`→`prompt`, `run_script`→`script`) |
| K004 | error | key not in the reserved core set (Ctrl+C, Esc, Enter, Tab, etc.) |
| K005 | lint  | `description` present |

### C — commands (the 4 shapes)

| ID | Severity | Rule |
|---|---|---|
| C001 | error | shell command requires `command` (no `tool`/`skill`/`prompt`/`interactive`) |
| C002 | error | extension-tool command requires `tool` |
| C003 | error | skill-prompt command requires both `skill` and `prompt` |
| C004 | error | interactive command requires `interactive: true` |

### H — help entries

| ID | Severity | Rule |
|---|---|---|
| H001 | lint | every entry has `id` + `command` + `title` + `summary` + `category` |
| H002 | lint | `summary` ≥ 20 chars |

## CLI behaviour

`plugin-maker validate` runs **only error-severity** rules. `plugin-maker lint`
runs lint-severity rules and adds `--strict` to promote to errors.
`plugin-maker doctor` runs both back-to-back and adds an install-readiness
check (binary present, scripts executable, etc.).

## Showcase wiring (the in-TUI bonus)

Beyond the bash CLI, the plugin loads three pieces inside Synaps CLI:

1. **`help_entries[]`** — 7 entries (overview + 6 subcommands) appear in
   `/help find` (the lightbox). Each has `usage`, `examples`, `related`.
2. **`settings.categories[]`** — one `Plugin Maker` category with five fields:
   four declarative (`text`/`cycler`) and one **`custom` editor** rendered
   by `extensions/plugin_maker_ext.py` over the `settings.editor.*` RPC.
   The custom editor is the **Plugin Browser**: a live overlay listing every
   installed plugin with ✓/✗ validate status, lint warning count, and quick
   keys (`v`=validate, `l`=lint, `r`=refresh, `Enter`=info, `Esc`=close).
3. **`extension`** with three hook subscriptions:
   - `on_session_start` — opt-in one-line health summary.
   - `before_tool_call` (bash + `input_contains: plugin.json`) — gentle hint.
   - `after_tool_call` (same filter) — auto-runs `plugin-maker validate` on the
     enclosing plugin and reports any new errors.

## File layout

```
plugin-maker-plugin/
├── .synaps-plugin/plugin.json
├── README.md
├── bin/plugin-maker           # CLI dispatcher
├── lib/
│   ├── catalog.sh             # canonical catalog (single source of truth)
│   ├── common.sh, frontmatter.sh
│   ├── scaffold*.sh           # 6 scaffolders (plugin/skill/ext/sidecar/cmd/kb/settings)
│   ├── validate*.sh           # 6 validators (P/F + X/S/T/K/C)
│   ├── lint.sh                # B + lint-severity rules
│   └── info.sh
├── templates/                 # all .tmpl files
├── extensions/plugin_maker_ext.py  # JSON-RPC 2.0 extension
├── skills/plugin-maker/SKILL.md    # umbrella index
├── docs/                      # progressive-disclosure deep-dives
└── scripts/test.sh
```

## Versioning

Bump `version` in `.synaps-plugin/plugin.json` when:

- adding/removing rule IDs (any letter)
- changing CLI subcommand surface
- bumping the extension protocol contract

Use semver: behavior-breaking changes bump major, additions bump minor.
