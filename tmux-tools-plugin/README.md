# tmux-tools-plugin

Worker-pane patterns for Synaps agents inside tmux. When the agent is running in a tmux session, this plugin teaches it to spawn named side panes, drive long-running and interactive commands there, and let the user watch + intervene in real time.

## Why

The default agent loop runs commands via the `bash` tool: blocking, hidden, with a tool-result timeout. That's fine for quick deterministic stuff. It breaks down for:

- **Sudo / interactive prompts** — agent can't enter passwords; user can't either, because it's not visible
- **Long installs / builds** — block the agent's turn, hit timeouts
- **Streaming output** — log tails are a dead loss
- **Parallel work** — sequential by construction

If the agent is in tmux, all of those become trivial: spawn a pane, drive it, the user sees everything, can intervene, and the agent can poll progress without blocking.

## What it gives the agent

A single helper script with subcommands that wrap the right `tmux` invocations:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh spawn  NAME [--size PCT] [--side ...]
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh run    NAME "CMD" [--timeout S]
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh send   NAME "INPUT"
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh keys   NAME C-c
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh poll   NAME [--lines N]
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh wait   NAME [--timeout S]
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh close  NAME
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh list
```

Plus a SKILL.md teaching when and how to use each — six concrete patterns (sudo, long install, log tail, parallel build/test, REPL, interrupt).

## Naming model

Panes are addressed by **name** (tmux pane title), not by `%id`. `spawn install` is idempotent — if the `install` pane exists, it returns its current id. Names are scoped to the tmux server, work cross-window, and survive pane id renumbering when other panes close.

## Installation

```bash
synaps plugins install tmux-tools --marketplace synaps-skills
# or symlink for local dev:
ln -s ~/path/to/tmux-tools-plugin ~/.synaps-cli/plugins/tmux-tools
```

The agent loads the skill on demand via `load_skill tmux`.

## Auto-suggestion (future)

Synapscli currently has zero tmux awareness. Ideally, when synaps starts inside tmux it should auto-suggest this skill. See [`docs/synapscli-tmux-detect.md`](./docs/synapscli-tmux-detect.md) for the proposed core change (small Rust patch).

## Files

```
tmux-tools-plugin/
├── .synaps-plugin/plugin.json
├── README.md
├── docs/synapscli-tmux-detect.md         # proposed core enhancement
├── scripts/tmux/pane.sh                   # the workhorse
└── skills/tmux/SKILL.md                   # agent-facing playbook
```

## License

MIT
