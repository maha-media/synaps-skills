# memory-manager (Rust extension)

Synaps CLI extension that wires the **Axel** portable agent intelligence
into the chat loop.

- Upstream: https://github.com/HaseebKhalid1507/axel
- Brain file: a single `.r8` containing VolciRAG + Memkoshi + Consolidation state.
  One file is your agent's entire brain.

## Build

From the plugin root:

```bash
./scripts/setup.sh
```

Or directly:

```bash
cd extensions/memory-manager
cargo build --release
```

The release binary at `target/release/memory-manager` is what `plugin.json`'s
`extension.command` points at. Synaps spawns it on session start and shuts
it down on session end.

## Wire protocol

JSON-RPC 2.0 with **LSP-style Content-Length framing** on stdio (the actual
Synaps protocol — *not* the line-delimited framing the public docs describe).
All hooks are dispatched through a single `hook.handle` RPC method; the kind
arrives in `params.kind` (per the plugin-maker reference extension).

## Hooks

| Hook | Purpose |
|---|---|
| `on_session_start`    | Load brain, inject "what I recall" system preamble. |
| `before_message`      | VolciRAG recall — modify user message with retrieved context. |
| `on_message_complete` | Online consolidation — `remember()` substantial assistant turns. |
| `after_tool_call`     | Reserved (no-op for now). |
| `on_session_end`      | Final flush of the `.r8` brain. |

## Brain file location

Resolved in order:

1. `$AXEL_BRAIN` (explicit path)
2. `$PLUGIN_DIR/axel.r8`
3. `$SYNAPS_DATA_DIR/axel.r8`
4. `~/.config/axel/axel.r8` (upstream default)

## Status

This is a working **JSON-RPC adapter** wrapping `axel::AxelBrain`. The
upstream multi-phase Consolidation pipeline (reindex → strengthen →
reorganize → prune) is intentionally unwired — it operates over source
directories and needs a config decision on scope.
