# memkoshi-plugin

Persistent memory for Synaps agents. Wraps the [Memkoshi](https://github.com/HaseebKhalid1507/memkoshi) memory system — staging gate, 4-layer search (vector + BM25 + graph + metadata), pattern detection, evolution scoring. Local-first, no cloud required.

## What it gives the agent

- **Recall** — search prior decisions, preferences, and facts before answering
- **Commit** — extract and stage memories from session text (regex-free or LLM-quality)
- **Approve** — non-interactive batch/single approval (the plugin fills a gap in upstream's interactive-only `memkoshi review`)
- **Handoff** — state transfer between sessions
- **Boot context** — token-budgeted memory primer for `synaps -s` injection
- **Patterns & evolution** — detect behavioural trends, score session quality

## Installation

```bash
# Add the plugin
synaps plugins install memkoshi --marketplace synaps-skills

# Install the underlying memkoshi runtime (one-time)
pipx install git+https://github.com/HaseebKhalid1507/memkoshi.git
# or:
pip install --user --break-system-packages git+https://github.com/HaseebKhalid1507/memkoshi.git

# Initialise storage
memkoshi init
```

## Usage

The agent loads the `memkoshi` skill on demand via `load_skill memkoshi`, which teaches it when and how to recall, commit, approve, and hand off.

For session-start memory injection:

```bash
synaps -s <(${CLAUDE_PLUGIN_ROOT}/scripts/memkoshi/boot-context.sh 2048)
```

See `skills/memkoshi/SKILL.md` for the full agent-facing playbook.

## Files

```
memkoshi-plugin/
├── .synaps-plugin/plugin.json          # plugin manifest
├── scripts/memkoshi/
│   ├── approve.py                       # non-interactive approve/reject
│   ├── approve.sh                       # shell wrapper
│   └── boot-context.sh                  # boot-context for `synaps -s` injection
├── skills/memkoshi/
│   └── SKILL.md                         # agent-facing skill doc
└── README.md
```

## Why a plugin instead of MCP?

Memkoshi exposes itself via three surfaces: Python API, CLI, and an MCP server. Synaps doesn't run MCP servers natively — it calls external tools via the agent's `bash` tool. So this plugin wraps the CLI and ships a small Python helper to fill the one gap (non-interactive approval), then teaches the agent the workflow via SKILL.md. Simpler and more direct than running a sidecar MCP server.

## License

MIT
