# axel-memory-manager

Synaps CLI plugin wrapping **[Axel](https://github.com/HaseebKhalid1507/axel)** —
portable agent intelligence (search, memory, self-organizing knowledge) backed
by VolciRAG, Memkoshi, and Consolidation. **One `.r8` file is the agent's
entire brain.** It searches, remembers, and gets smarter the more you use it.

## Install

The plugin ships **source-only** through the marketplace; the Rust extension
binary is built locally on first install (the upstream Axel stack pulls in
ONNX Runtime, usearch HNSW, and tokenizers — ~33 MB stripped binary).

1. Install via Synaps `/plugins` (or `synaps-skills` marketplace).
2. Build the extension:

   ```bash
   cd ~/.synaps-cli/plugins/axel-memory-manager
   ./scripts/setup.sh
   ```

   First build is ~1–2 minutes (mostly fetching the Axel git workspace and
   compiling its dependency tree). Subsequent rebuilds are seconds.

3. Restart Synaps. The extension will load with 5 hooks registered.

### Requirements

- Rust toolchain (`cargo` ≥ 1.75 — install via [rustup.rs](https://rustup.rs))
- An internet connection on first run — the embedding model (~86 MB
  `model.onnx` for VolciRAG search) downloads on first use and is cached
  under `~/.cache/velocirag/models/`.

### What gets created

- Brain file: `~/.config/axel/axel.r8` (SQLite WAL — the entire agent brain
  in one file). Override with `$AXEL_BRAIN`, `$PLUGIN_DIR/axel.r8`, or
  `$SYNAPS_DATA_DIR/axel.r8` (first match wins).
- Embedding cache: `~/.cache/velocirag/models/` and `~/.cache/axel/embeddings/`.

## How it works

| Hook | Behaviour |
|---|---|
| `on_session_start`    | `boot_context()` → injects Tier-0 handoff + Tier-1 memories as a system preamble (≤700 token budget). |
| `before_message`      | `contextual_recall(user_text, 5)` → VolciRAG search; modifies the user message with retrieved context. |
| `on_message_complete` | `remember(text, "Events", 0.5)` → online consolidation of substantial assistant turns. |
| `after_tool_call`     | Reserved for selective tool-output capture (currently a no-op). |
| `on_session_end`      | `flush()` → persist the .r8. |

The full multi-phase Consolidation pipeline (reindex → strengthen → reorganize
→ prune) lives upstream in the `axel` crate and isn't run per-message — it
operates over source directories and should be invoked on a schedule.

## Skills

- **axel-memory-manager** — `Use when the agent needs durable, portable memory — VolciRAG search, Memkoshi storage, and Consolidation backed by a single .r8 brain file.`

## Upstream

- Axel: https://github.com/HaseebKhalid1507/axel
- Crates: `axel` (brain handle), `axel-memkoshi` (memory storage), `velocirag` (4-layer RAG search)

## Status

`0.1.0` — initial release, 2026-05-03.

The extension speaks the Synaps JSON-RPC 2.0 wire format (LSP-style
Content-Length framing on stdio, single `hook.handle` dispatch with
`params.kind`). Online consolidation is a simple `remember()` per turn;
the heavier `consolidate::run` pipeline is left unwired pending a config
decision on source-dir scope.
