# axel-memory-manager

Synaps CLI plugin wrapping **[Axel](https://github.com/HaseebKhalid1507/axel)** —
portable agent intelligence (search, memory, self-organizing knowledge) backed
by VolciRAG, Memkoshi, and Consolidation. **One `.r8` file is the agent's
entire brain.** It searches, remembers, and gets smarter the more you use it.

## Install

The plugin installs a prebuilt Rust extension binary by default; users do **not**
need a Rust toolchain for supported platforms. Current release assets are named:

- `memory-manager-linux-x86_64`
- `memory-manager-linux-aarch64`
- `memory-manager-macos-aarch64`
- `memory-manager-windows-x86_64.exe`

1. Install via Synaps `/plugins` (or `synaps-skills` marketplace).
2. Install/verify the extension binary:

   ```bash
   cd ~/.synaps-cli/plugins/axel-memory-manager
   ./scripts/setup.sh
   ```

   `setup.sh` downloads the matching binary from the latest GitHub release into
   `extensions/memory-manager/target/release/memory-manager`, which is the path
   declared in the plugin manifest. If no matching prebuilt binary exists and
   Cargo is installed, it falls back to a local release build.

3. Restart Synaps. The extension will load with 5 hooks registered.

### Requirements

- Supported platform with a published prebuilt binary, or Rust/Cargo only for
  `./scripts/setup.sh --from-source` fallback builds.
- **No network needed at runtime by default.** Memory search is lexical
  (SQLite FTS5) and fully offline. The optional ~86 MB embedding model is
  only downloaded when you explicitly run the `axel download-embeddings`
  command AND turn the `embeddings` setting on. Nothing is fetched
  implicitly.

### Maintainer: publishing prebuilts

Push a tag matching `axel-memory-manager-v*` or run the
`axel-memory-manager release binaries` GitHub Actions workflow manually. It
builds release binaries and attaches them to the GitHub release. Example:

```bash
git tag axel-memory-manager-v0.1.0
git push origin axel-memory-manager-v0.1.0
```

### What gets created

- Brain file: `~/.config/axel/axel.r8` (SQLite WAL — the entire agent brain
  in one file). Override with `$AXEL_BRAIN`, `$PLUGIN_DIR/axel.r8`, or
  `$SYNAPS_DATA_DIR/axel.r8` (first match wins).
- Embedding cache: `~/.cache/velocirag/models/` and `~/.cache/axel/embeddings/`.

### Building against a local axel checkout

The extension pins axel to commit `562e6508f5de…` (branch
`feat/project-memory-t32-t36`). Until that commit is pushed to
`github.com/maha-media/axel`, build with a local patch:

```bash
AX=/path/to/axel-worktree
cargo build --release \
  --config "patch.\"https://github.com/maha-media/axel\".axel.path=\"$AX/crates/axel\"" \
  --config "patch.\"https://github.com/maha-media/axel\".axel-memkoshi.path=\"$AX/crates/memkoshi\"" \
  --config "patch.\"https://github.com/maha-media/axel\".velocirag.path=\"$AX/crates/velocirag\""
```

Once the axel branch lands on the remote, a plain `cargo build --release`
resolves the pinned rev directly.

## How it works

| Hook | Behaviour |
|---|---|
| `on_session_start`    | **OFF by default** (`boot_injection` setting). When on: bounded, project-scoped, lower-authority memory summary. |
| `before_message`      | **OFF by default** (`auto_recall` setting). When on: bounded, project-scoped, lower-authority lexical recall block. |
| `on_message_complete` | Auto-captures substantial assistant turns **into the trusted project scope** (provenance `synaps:auto_capture`). Skipped when no trusted project scope exists. |
| `after_tool_call`     | Reserved for selective tool-output capture (currently a no-op). |
| `on_session_end`      | `flush()` → persist the .r8. |

## Memory tools (T32–T36)

The extension registers four model-callable tools (declared passively in the
manifest and identically in the live `initialize` response, so a
deferred-activation host never has to spawn the process to advertise them):

| Tool | Contract |
|---|---|
| `memory_search` | Project-scoped offline lexical search. Bounded descriptors + stable IDs + short snippets; hard cap 25 results; lower-authority banner + per-entry provenance. Secret bodies are never indexed or snippeted. |
| `memory_fetch`  | Exact-ID fetch with project + sensitivity checks. Bodies are bounded; `secret` and restricted retention classes are withheld with a reason. |
| `memory_store`  | Requires **explicit project confirmation** (`project` = the canonical key). Supports category, tags, sensitivity, retention class, and `expires_hours`. `retention=never_persist` is refused and never enters the `.r8`. |
| `memory_forget` | Exact, project-scoped tombstone + delete. A forgotten id can never be re-inserted and never re-surfaces in search. |

### Trusted project scope

The **model never chooses the project.** The canonical project key
(`proj_` + 16 hex of SHA-256 of the canonicalized root) is derived only from:

1. `SYNAPS_PROJECT_ROOT` (set by the host), or
2. `AXEL_PROJECT_ROOT` (local override), or
3. the host-owned `project_root` plugin setting.

Without any of these, every memory tool **fails closed** with an explicit
error. A model-supplied `project` argument may only confirm the derived key.

### Retention / disclosure classes

`standard` (model-visible), `local_only`, `visible_after_consent`,
`persist_never_transmit` (persisted, body withheld at the model-visibility
boundary), `never_persist` (refused — never written). Expiry via
`expires_hours`. Inspect counts per class with the `axel retention` command.

The full multi-phase Consolidation pipeline (reindex → strengthen → reorganize
→ prune) lives upstream in the `axel` crate and isn't run per-message — it
operates over source directories and should be invoked on a schedule.

## Skills

- **axel-memory-manager** — `Use when the agent needs durable, portable memory — VolciRAG search, Memkoshi storage, and Consolidation backed by a single .r8 brain file.`

## Upstream

- Axel: https://github.com/HaseebKhalid1507/axel
- Crates: `axel` (brain handle), `axel-memkoshi` (memory storage), `velocirag` (4-layer RAG search)

## Status

`0.2.0` — T32–T36: extension memory tools (`memory_search` / `memory_fetch`
/ `memory_store` / `memory_forget`), trusted project scoping (fail closed),
sensitivity + retention classes, tombstoned forget, offline-lexical default
(no implicit model download), opt-in recall/boot injection.

Requires axel with the project-memory layer (branch
`feat/project-memory-t32-t36`, commit `562e6508f5de0cdc0bbc803b2448aeb7431a6bed`).

`0.1.0` — initial release, 2026-05-03.

The extension speaks the Synaps JSON-RPC 2.0 wire format (LSP-style
Content-Length framing on stdio, single `hook.handle` dispatch with
`params.kind`). Online consolidation is a simple `remember()` per turn;
the heavier `consolidate::run` pipeline is left unwired pending a config
decision on source-dir scope.
