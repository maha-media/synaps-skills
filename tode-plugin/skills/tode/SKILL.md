---
name: tode
description: Use when Synaps runs inside terminal-code (tode) to keep edits visible, open files and diffs in the current workbench, and diagnose the shared editor runtime.
---

# Synaps + tode

`tode` is VS Code rendered in the terminal: one shared code-server is served
through a loopback injector, while terminal-browser owns the outer terminal
pane. Synaps normally runs in that workbench's integrated terminal. Use the
`tode` CLI as the supported bridge back into the editor rather than editing
profile internals or talking to code-server directly.

## Detect and refresh context

Do this before assuming the session is in tode:

```bash
if [ -n "${TODE_IPC:-}" ] && [ -S "$TODE_IPC" ]; then
  printf 'inside tode: %s\n' "$TODE_IPC"
else
  printf 'not connected to a live tode window\n'
fi
if command -v tode >/dev/null 2>&1; then
  tode --version
  tode --skill
else
  printf 'tode is not installed or not on PATH\n'
fi
```

`TODE_IPC` identifies the current workbench window and is inherited by Synaps
and its child commands. `tode --skill` is the authoritative, live description
of this machine's install: paths, daemon state, profile, extensions, logs, and
which files are generated. Re-run it after an upgrade or when debugging; do not
hard-code its paths from an earlier run.

## Default collaboration loop

When Synaps creates or changes something the user may want to inspect, keep the
work visible in the existing workbench:

```bash
tode path/to/file
tode --goto path/to/file:42:7
tode --diff /tmp/before path/to/file
tode --review
```

Operational rules:

1. Use paths relative to the current working directory or absolute paths.
2. Prefer `tode <file>` over printing a long file into chat when visual review
   helps. Use `--goto` for findings and failures with a known line.
3. Use `tode --diff <before> <after>` when a real comparison is more useful
   than opening the changed file alone. Both arguments must be files.
4. Use `tode --review` after a coherent change to focus Source Control.
5. Keep normal command/test output in Synaps. Opening a file supplements the
   report; it does not replace verification or a concise summary.
6. Quote paths containing spaces.

Inside a live tode terminal, file opens, gotos, diffs, and `--review` are sent
to that same window over `TODE_IPC`. They should not create another terminal
pane. If `TODE_IPC` is absent or stale, `tode` may start a new window instead;
check before invoking it when layout preservation matters.

## Workspace and pane control

Use the current window deliberately:

```bash
tode -a ../another-folder       # add a folder to this workspace
tode -r /absolute/project       # replace this window's workspace
tode --split right --size 0.35 /absolute/project
```

- `-a/--add` and `-r/--reuse-window` target the current window.
- A plain folder argument opens a pane; it does not behave like a file open.
- `--split` accepts `right`, `left`, `down`, or `up`; `--size` is a fraction
  from `0.2` to `0.95` and only applies with `--split`.
- Do not use `-n/--new-window` or a split by default. New outer panes are
  disruptive and should be requested by the user or clearly useful.
- `-w/--wait` is for a human-in-the-loop file edit: it returns when the tab is
  closed. Because it can block indefinitely, only use it when waiting is the
  intended workflow and the command has a suitable interactive/long timeout.

`tode --split` creates an outer terminal/terminal-browser pane. It is not the
same as a VS Code editor group or integrated-terminal split.

## Synaps terminal ergonomics

Synaps is an interactive TUI inside VS Code's integrated terminal, inside
terminal-browser. Preserve that nesting:

- Do not run `tode` with no arguments from the active Synaps terminal; it can
  take over or create a pane without adding useful context.
- Do not run `tode --shutdown`, `tode --uninstall`, or an upgrade while relying
  on the current window unless the user explicitly asks. Shutdown affects the
  shared code-server/injector, not just this Synaps process.
- Do not send raw tmux keys to the pane hosting the tode Electron process to
  control Synaps. Synaps is a child of an integrated terminal, not the tmux
  pane's foreground process. Use Synaps tools and the `tode` CLI bridge.
- If `$TMUX` is set, load the tmux skill only for separate worker panes or
  visible long-running/interactive work. `tode --split` is for another editor
  window; tmux worker panes are for commands.
- A Synaps shell opened from tode normally also has `TERM_PROGRAM=vscode` and
  VS Code environment variables, but `TODE_IPC` is the decisive signal.

## Shortcut setup

There are three shortcut layers: the outer terminal/tmux, terminal-browser,
and VS Code/code-server. If a chord never reaches the editor, use the supported
wizard:

```bash
tode --shortcut-setup
tode --shortcut-setup --undo
```

Do not guess by hand-editing terminal override files. The wizard records user
choices and reconciles terminal and editor bindings. Run it interactively—the
user must choose which layer owns contested shortcuts.

## Profile and extensions

Ask the live skill for resolved profile paths, then use supported operations:

```bash
tode --list-extensions
tode --list-extensions --show-versions
tode --install-extension publisher.extension
tode --install-extension ./extension.vsix
tode --uninstall-extension publisher.extension
```

Use these commands instead of a bare `code-server --install-extension`; tode
forces its single shared user-data and extension directories. Reload/open the
window after an extension change.

From `tode --skill`, classify profile files before modifying them:

- User keybindings, snippets, tasks, and non-owned settings are safe.
- Some settings are rewritten on every open.
- The bridge extension, generated theme extension, injected CSS, daemon state,
  and startup-open marker are tode-owned. Do not hand-edit them.

## Theme and display

```bash
tode --theme                    # rebuild from the terminal palette
tode --theme ./theme.json       # apply a VS Code theme document
tode --timing                   # explain the last page load
tode --upgrade --check
```

Open windows follow a theme change without reload. If colors, fonts, image
rendering, or startup behavior look wrong, run `tode --skill` and inspect the
reported cache/profile/log paths before changing anything.

## Troubleshooting sequence

Use the least destructive step first:

```bash
tode --skill
test -n "${TODE_IPC:-}" && test -S "$TODE_IPC" && echo 'window bridge is live'
tode --timing
tode --upgrade --check
```

Then follow the live skill's resolved paths to inspect the combined
code-server/injector log and daemon state. Common cases:

| Symptom | Check | Action |
|---|---|---|
| File opens in a new pane | `TODE_IPC` missing or not a socket | Run from the tode integrated terminal; do not invent a socket path |
| Current window does not answer | stale bridge/socket | Reload the tode workbench, then open a new integrated terminal so it inherits fresh `TODE_IPC` |
| Extension is absent | wrong profile or no reload | Install with `tode --install-extension`, then reload/open tode |
| Shortcut is swallowed | outer terminal owns the chord | Run `tode --shortcut-setup` interactively |
| Rendering/theme is wrong | palette/cache/generated theme | Run `tode --theme`; use paths from `tode --skill` for deeper diagnosis |
| Editor fails to load | daemon/injector error | Read the reported combined log; use `tode --shutdown` only for an intentional clean restart |

Never browse directly to the underlying code-server port. Windows load the
injector URL so terminal styling, scripts, timing, and the bridge work.

## Command summary

```text
tode [file|folder]            open a target
tode -g file:line:column      open at a location
tode -d a b                   compare two files
tode -a folder                add to current workspace
tode -r folder                reuse current window
tode --review                 focus Source Control
tode --split DIR --size N P   open P in an outer split
tode --skill                  print live machine/install knowledge
tode --shortcut-setup         reconcile shortcut ownership
tode --theme [theme.json]     update theme
tode --timing                 report last load timing
tode --upgrade --check        check without upgrading
```

## Related skills

- `engineering:verification-before-completion` — prove work before reporting it.
- `engineering:worktrees-by-default` — keep implementation isolated while the
  tode workbench displays the selected worktree.
- `tmux-tools:tmux` — visible worker panes for long-running or interactive
  commands when `$TMUX` is set.
