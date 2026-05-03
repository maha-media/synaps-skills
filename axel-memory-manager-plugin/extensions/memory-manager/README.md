# memory-manager (Rust extension)

Synaps CLI extension that wires the **Axel** portable agent intelligence
into the chat loop.

- Upstream: https://github.com/HaseebKhalid1507/axel
- Brain file: a single `.r8` containing VolciRAG + Memkoshi + Consolidation state.
  One file is your agent's entire brain.

## Build

```bash
cd extensions/memory-manager
cargo build --release
```

The release binary at `target/release/memory-manager` is the path
`plugin.json` points to. Synaps spawns it on session start and shuts it
down on session end.

## Hooks

| Hook | Purpose |
|---|---|
| `on_session_start`    | Load brain, optionally inject a "what I recall" system preamble. |
| `before_message`      | VolciRAG recall — modify the user message with retrieved context. |
| `on_message_complete` | Consolidation — extract durable memories from the assistant turn. |
| `after_tool_call`     | Observe tool outputs that may be memory-worthy. |
| `on_session_end`      | Final consolidation pass + flush brain to `.r8`. |

## Brain file location

Resolved in order:

1. `$AXEL_BRAIN` (explicit path)
2. `$PLUGIN_DIR/axel.r8`
3. `$SYNAPS_DATA_DIR/axel.r8`

## Status

This is a working **JSON-RPC skeleton**. The `axel` module is stubbed —
actual VolciRAG / Memkoshi / Consolidation integration is the next step.
