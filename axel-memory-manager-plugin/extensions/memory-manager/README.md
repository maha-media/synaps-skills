# memory-manager (Rust extension)

Synaps CLI extension that wires **Axel** portable agent intelligence into the
chat loop.

- Upstream: https://github.com/maha-media/axel
- Brain file: a single `.r8` containing VelociRAG + Memkoshi + Consolidation
  state. One file is your agent's entire brain.

## Continuous memory (0.3.0)

Continuous memory is **OFF by default**. Installing or starting the extension
does not grant recall, capture, or history-import authority. Synaps owns the
session policy and activates these capabilities only from explicit controls.
Subagents start with memory off and do not inherit a parent session's lease.

The continuous-memory integration adds:

- **`memory_context` control tool** — the matching Synaps host exposes a
  built-in control tool with `status`, `disable`, `recall_once`, and
  `index_history` actions. A model may inspect status, disable memory, request
  one bounded recall, or obtain a metadata-only history preview. It cannot
  enable a durable mode or confirm an import; those require an explicit
  `/memory` command from the user.
- **Context-provider recall** — while a host-minted recall lease is active, the
  extension handles `context_provider.recall` with bounded, project-scoped
  retrieval from the local `.r8` brain. Returned memory is labeled
  lower-authority historical data, constrained by host budgets, and filtered
  by disclosure policy. Without a valid lease, no per-prompt recall runs.
- **Capture** — in a capture-enabled mode, Synaps submits bounded terminal chat
  turns through `context_provider.capture`. Writes are project-scoped,
  idempotent, and durably flushed; duplicate capture IDs do not create duplicate
  memories. Capture is inactive until explicitly enabled.
- **History import** — `/memory index-history` first computes a metadata-only
  disclosure preview. Session content is read and submitted in bounded batches
  only after `/memory index-history confirm`; `/memory index-history decline`
  cancels the pending import without reading session content or writing Axel
  data.
- **Deterministic `/memory` commands** — all frontends share the same host-owned
  controls:

  | Command | Effect |
  |---|---|
  | `/memory status` | Show the current session mode and lease state. |
  | `/memory on` | Enable capture and recall for this session. |
  | `/memory recall` | Enable recall on each prompt. |
  | `/memory capture` | Enable capture without per-prompt recall. |
  | `/memory once` | Authorize one bounded recall. |
  | `/memory why` | Explain the most recently accepted recall using metadata, not hidden content. |
  | `/memory off` | Revoke the session memory lease immediately. |
  | `/memory index-history` | Preview a possible history import without reading session content. |
  | `/memory index-history confirm` | Confirm and run the previewed bounded import. |
  | `/memory index-history decline` | Cancel the pending import. |

The existing `memory_search`, `memory_fetch`, `memory_store`, and
`memory_forget` tools remain deferred, project-scoped tools. Their availability
does not turn continuous recall or capture on.

## Build

The Cargo manifest pins an Axel revision that has not been published to the
remote yet. Until a human approves that push/publication, build against the
local Axel worktree using Cargo patches:

```bash
cd extensions/memory-manager
AX=/home/jr/Projects/Maha-Media/.worktrees/axel-continuous-memory
CARGO_BUILD_JOBS=8 cargo build --release --jobs 8 \
  --config "patch.\"https://github.com/maha-media/axel\".axel.path=\"$AX/crates/axel\"" \
  --config "patch.\"https://github.com/maha-media/axel\".axel-memkoshi.path=\"$AX/crates/memkoshi\"" \
  --config "patch.\"https://github.com/maha-media/axel\".velocirag.path=\"$AX/crates/velocirag\""
```

See [`../../docs/continuous-memory-build.md`](../../docs/continuous-memory-build.md)
for the interim build strategy and publication guard. The release binary at
`target/release/memory-manager` is what `plugin.json`'s `extension.command`
points at. Synaps spawns it on activation and shuts it down on session end.

## Wire protocol

JSON-RPC 2.0 with **LSP-style Content-Length framing** on stdio (the actual
Synaps protocol — *not* the line-delimited framing the public docs describe).
Continuous recall and capture use the host-leased `context_provider.recall` and
`context_provider.capture` methods. Tool calls use `tool.call`.

A legacy `hook.handle` adapter remains for compatibility with explicitly eager
older hosts, but the 0.3.0 manifest registers no hooks and does not activate it.

## Brain file location

Resolved in order:

1. `$AXEL_BRAIN` (explicit path)
2. `$PLUGIN_DIR/axel.r8`
3. `$SYNAPS_DATA_DIR/axel.r8`
4. `~/.config/axel/axel.r8` (upstream default)

## Status

This is a working **JSON-RPC adapter** around `axel::AxelBrain`, with deferred
project-memory tools plus lease-gated continuous recall and capture. The
upstream multi-phase Consolidation pipeline (reindex → strengthen → reorganize
→ prune) operates over source directories and remains outside automatic chat
capture; run consolidation explicitly where configured.
