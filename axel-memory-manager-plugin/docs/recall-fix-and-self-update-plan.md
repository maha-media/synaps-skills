# Axel Memory Manager — Recall Fix & Self-Update Plan

> Branch: `fix/axel-recall-and-self-update`  
> Worktree: `.worktrees/synaps-skills-axel-recall-and-self-update`  
> Extension crate: `axel-memory-manager-plugin/extensions/memory-manager/`

---

## 1. Summary

The axel-memory-manager Synaps CLI extension has been running in every active Synaps session (PIDs 27824, 41657, 283801 are confirmed live at time of diagnosis) yet has never written a single memory to the brain. The root cause is a two-layer wire-shape mismatch: `extract_text()` in `src/main.rs` looks for fields that Synaps does not send, so every call to `b.remember(...)` is gated behind a length check that is never satisfied. Separately, `before_message` returns `{"action":"modify","content":"..."}` which Synaps' runtime deserialization rejects (the valid variant for that hook is `Inject { content }`, not `Modify { input }`), causing the runtime to fall back to `HookResult::Block` — silently discarding recall context on every message.

The upstream `axel` crate (`github.com/HaseebKhalid1507/axel`) has advanced four days beyond the pinned commit (`c71f76a1` → `cdfe7344`). The Cargo.toml already uses `branch = "main"` so bumping is a single `cargo update -p axel` invocation. The bump is Phase 2 and is intentionally kept separate from the recall fix in Phase 1 so the two concerns bisect cleanly.

Phase 3 closes the self-update loop with a nightly CI workflow that opens PRs for upstream bumps automatically, ties those PRs into the existing release pipeline, drives axel's consolidation engine on session-end and on a configurable hourly schedule (currently the extension only calls `b.flush()` on `on_session_end`), and adds an `--update` flag to `setup.sh` for users who want to pull a newer prebuilt outside of CI.

---

## 2. Root Cause

### 2a. Wire-shape mismatch in `extract_text` (bug 1 — no memories written)

**Synaps host** (`SynapsCLI/src/extensions/runtime/process.rs:1785-1786`):

```rust
async fn handle(&self, event: &HookEvent) -> HookResult {
    let params = serde_json::to_value(event).unwrap_or(Value::Null);
```

`HookEvent` is defined at `SynapsCLI/src/extensions/hooks/events.rs:134-159`:

```rust
pub struct HookEvent {
    pub kind: HookKind,          // line 136
    pub tool_name: Option<String>,
    pub tool_runtime_name: Option<String>,
    pub tool_input: Option<Value>,
    pub tool_output: Option<String>,
    pub message: Option<String>, // line 149 — plain string
    pub session_id: Option<String>,
    pub transcript: Option<Vec<Value>>,
    pub data: Value,             // line 158
}
```

`HookEvent::on_message_complete` (events.rs:226-239) sets `message: Some(message.to_string())`. So the JSON on the wire is:

```json
{
  "kind": "on_message_complete",
  "message": "The assistant's full response text goes here …",
  "tool_name": null,
  "tool_input": null,
  "tool_output": null,
  "session_id": null,
  "transcript": null,
  "data": null
}
```

**Extension** (`src/main.rs:312-323`):

```rust
fn extract_text(params: &Value) -> String {
    // Branch 1: looks for params["content"]        → absent, falls through
    if let Some(s) = params.get("content").and_then(|v| v.as_str()) {
        return s.to_string();
    }
    // Branch 2: looks for params["message"]["content"] → params["message"] IS the
    //           string itself, not an object, so .get("content") returns None
    if let Some(s) = params
        .get("message")
        .and_then(|m| m.get("content"))  // ← fails: Value::String has no .get()
        .and_then(|v| v.as_str())
    {
        return s.to_string();
    }
    String::new()   // ← always reached; "" never meets MIN_CONSOLIDATE_LEN=80
}
```

`b.remember(...)` at `src/main.rs:289` is therefore never called. Brain stays at its initial empty state.

### 2b. Wrong `HookResult` action for `before_message` (bug 2 — recall context silently blocked)

`HookKind::BeforeMessage` only allows `["continue", "inject"]` (events.rs:79). `HookResult` is a serde-tagged enum (events.rs:310-322):

```
Inject { content: String } → {"action":"inject","content":"..."}
Modify  { input:   Value  } → {"action":"modify","input":{...}}
```

The extension currently returns (src/main.rs:267-269):

```rust
json!({
    "action": "modify",
    "content": format!("{}\n\n{}", ctx.formatted, user_text)
})
```

`serde_json::from_value` on this produces `Err` because `Modify` requires an `input` key, not `content`. The runtime's deserialization fallback at `process.rs:1795-1803` then checks `if value.get("action") == Some("modify")` and returns `HookResult::Block { reason: "Extension returned malformed modify result" }` — which means recall output is **blocked**, not injected, every single time even after bug 1 is fixed.

Both bugs must be fixed together in Phase 1.

---

## 3. Out of Scope

- Modifying anything in `SynapsCLI/` — the host is correct; only the extension changes.
- Changing the `.r8` brain schema or memory category definitions.
- Redesigning the consolidation algorithm (four-phase pipeline is upstream's concern).
- Adding multi-agent coordination between the three concurrent memory-manager processes sharing `~/.config/axel/axel.r8` — that is tracked as a follow-up risk in §8.
- Adding new hook types (e.g. `before_tool_call` memory capture) — out of scope for this PR.
- Changing `AxelBrain::remember_with_ttl` TTL defaults — current `None` (no expiry) is fine.

---

## 4. Phase 1 — Recall Fix (TDD)

### 4.1 Unit tests for `extract_text`

Add a `#[cfg(test)] mod tests` block at the bottom of `src/main.rs` (currently the file ends at line 324 with no test module). Three cases must all pass before touching production code:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── extract_text ──────────────────────────────────────────────────────────

    /// Canonical Synaps wire shape: top-level "message" is a plain string.
    /// This is what HookEvent serialises to for before_message / on_message_complete.
    #[test]
    fn extract_text_synaps_wire_shape() {
        let params = json!({
            "kind": "on_message_complete",
            "message": "The assistant explained the difference between TCP and UDP.",
            "data": null
        });
        assert_eq!(
            extract_text(&params),
            "The assistant explained the difference between TCP and UDP."
        );
    }

    /// Legacy shape 1: top-level "content" string (extension-internal convention).
    #[test]
    fn extract_text_legacy_content_field() {
        let params = json!({ "content": "some legacy payload" });
        assert_eq!(extract_text(&params), "some legacy payload");
    }

    /// Legacy shape 2: nested "message.content" object (OpenAI message shape).
    #[test]
    fn extract_text_legacy_nested_message_content() {
        let params = json!({ "message": { "content": "nested content" } });
        assert_eq!(extract_text(&params), "nested content");
    }

    /// Empty / missing — should return empty string, not panic.
    #[test]
    fn extract_text_empty_params() {
        assert_eq!(extract_text(&json!({})), "");
    }

    // ── before_message response shape ─────────────────────────────────────────

    /// Verify that when a non-empty contextual_recall result is available the
    /// dispatcher emits action:"inject" (not "modify"). Tested via handle_hook
    /// directly so we don't need a live brain — we can use the passthrough path
    /// (brain = None) to verify the continue case, and a mock for inject.
    /// Full inject-path coverage requires the integration test (§4.2).
    #[test]
    fn before_message_passthrough_when_no_brain() {
        let params = json!({
            "kind": "before_message",
            "message": "What is Rust's borrow checker?",
        });
        let result = handle_hook(None, "before_message", &params);
        assert_eq!(result["action"], "continue");
    }

    /// on_message_complete with short text (< MIN_CONSOLIDATE_LEN) → continue.
    #[test]
    fn on_message_complete_short_text_no_brain() {
        let params = json!({ "kind": "on_message_complete", "message": "ok" });
        let result = handle_hook(None, "on_message_complete", &params);
        assert_eq!(result["action"], "continue");
    }
}
```

Run `cargo test --manifest-path axel-memory-manager-plugin/extensions/memory-manager/Cargo.toml` — expect `extract_text_synaps_wire_shape` and `extract_text_legacy_nested_message_content` to **FAIL** before the fix, confirming red.

### 4.2 Integration test

Create `axel-memory-manager-plugin/extensions/memory-manager/tests/integration_wire.rs`.

The test must:

1. Locate the built binary at `../target/debug/memory-manager` (use `env!("CARGO_BIN_EXE_memory-manager")` or construct path via `env!("CARGO_MANIFEST_DIR")`).
2. Create a temp dir; set `AXEL_BRAIN=<tmpdir>/test.r8`.
3. Spawn the binary with `Command::new(bin).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).env("AXEL_BRAIN", brain_path)`.
4. Write the `initialize` frame and drain its response.
5. Write an `on_message_complete` hook frame using the canonical Synaps wire shape. The `message` field must be ≥ 80 characters:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "hook.handle",
  "params": {
    "kind": "on_message_complete",
    "message": "Rust's ownership system ensures memory safety without a garbage collector by enforcing borrow rules at compile time.",
    "data": null
  }
}
```

6. Drain and discard the `hook.handle` response (expect `{"action":"continue"}`).
7. Write a `shutdown` frame; wait for process exit.
8. **Assert memory written**: open the SQLite file at `<tmpdir>/test.r8` with `rusqlite` (add as `[dev-dependencies]`); run `SELECT COUNT(*) FROM memories` and assert `> 0`.

Second sub-test in the same file:

1. Repeat steps 1-6 above to plant a memory.
2. Send a `before_message` frame:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "hook.handle",
  "params": {
    "kind": "before_message",
    "message": "Tell me about Rust's ownership model"
  }
}
```

3. Read and parse the response frame.
4. **Assert** `response["result"]["action"] == "inject"` (not `"modify"`, not `"continue"`).
5. **Assert** `response["result"]["content"]` is a non-empty string.

> **Note on timing**: `before_message` runs `contextual_recall` which loads the ONNX embedding model on first use (~86 MB, may download). In CI this test must either skip if `AXEL_BRAIN_SKIP_EMBED_TEST=1` is set, or use a pre-seeded `.r8` fixture. Flag this as a [verify] item for the implementing agent: confirm whether the embedding model is cached in CI runners or if a fixture brain is required.

Helper: write a `fn frame(value: &Value) -> Vec<u8>` that produces `Content-Length: N\r\n\r\n<body>` bytes, and a `fn read_frame(reader: &mut impl BufRead) -> Value` that consumes one framed response. These mirror the production framing in `src/main.rs:128-171`.

### 4.3 Implementation diff

Two surgical edits to `src/main.rs`:

**Fix 1 — `extract_text` (lines 312-323):** Add the canonical Synaps branch as the first check:

```diff
 fn extract_text(params: &Value) -> String {
+    // Canonical Synaps wire shape: HookEvent serialises `message` as a top-level
+    // plain string (see SynapsCLI/src/extensions/hooks/events.rs:149).
+    if let Some(s) = params.get("message").and_then(|v| v.as_str()) {
+        return s.to_string();
+    }
+    // Legacy shape 1: top-level "content" string.
     if let Some(s) = params.get("content").and_then(|v| v.as_str()) {
         return s.to_string();
     }
+    // Legacy shape 2: nested "message.content" object (OpenAI message format).
     if let Some(s) = params
         .get("message")
         .and_then(|m| m.get("content"))
         .and_then(|v| v.as_str())
     {
         return s.to_string();
     }
     String::new()
 }
```

> The new branch for the canonical shape is placed **first** so it short-circuits before the nested `message.get("content")` branch (which would also fall through harmlessly since `Value::String` returns `None` for `.get()`).

**Fix 2 — `before_message` result (lines 265-270):** Change `"modify"` → `"inject"` and remove `user_text` from the content field (inject prepends context; it does not replace the user's message):

```diff
-                    Ok(ctx) if !ctx.formatted.trim().is_empty() => json!({
-                        "action": "modify",
-                        "content": format!("{}\n\n{}", ctx.formatted, user_text)
-                    }),
+                    Ok(ctx) if !ctx.formatted.trim().is_empty() => json!({
+                        "action": "inject",
+                        "content": ctx.formatted
+                    }),
```

`HookResult::Inject { content }` maps to `{"action":"inject","content":"..."}` (events.rs:317). `BeforeMessage` allows `Inject` (events.rs:96). The runtime accumulates inject results and prepends them to the system prompt — the user's message is not modified, only augmented.

### 4.4 Verification

```bash
cd axel-memory-manager-plugin/extensions/memory-manager

# Run all tests (unit + integration)
cargo test -j 8 -- --test-threads=8

# Smoke: drive the binary manually with the Synaps wire shape
LONG_MSG='Rust ownership prevents use-after-free by enforcing single-ownership and borrow rules at compile time, verified against a borrow checker.'
BRAIN=$(mktemp -d)/smoke.r8

cargo build 2>/dev/null
BIN=./target/debug/memory-manager

python3 - <<'EOF'
import subprocess, json, struct

def frame(obj):
    body = json.dumps(obj).encode()
    return f"Content-Length: {len(body)}\r\n\r\n".encode() + body

def read_frame(proc):
    hdr = b""
    while b"\r\n\r\n" not in hdr:
        hdr += proc.stdout.read(1)
    length = int([l for l in hdr.decode().splitlines() if "Content-Length" in l][0].split(":")[1])
    return json.loads(proc.stdout.read(length))

import os
brain = os.environ["BRAIN"]
bin_ = os.environ["BIN"]

p = subprocess.Popen([bin_], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     env={**os.environ, "AXEL_BRAIN": brain})
p.stdin.write(frame({"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}))
p.stdin.flush()
print("initialize:", read_frame(p))

msg = os.environ["LONG_MSG"]
p.stdin.write(frame({"jsonrpc":"2.0","id":1,"method":"hook.handle",
    "params":{"kind":"on_message_complete","message":msg,"data":None}}))
p.stdin.flush()
print("on_message_complete:", read_frame(p))

p.stdin.write(frame({"jsonrpc":"2.0","id":2,"method":"hook.handle",
    "params":{"kind":"before_message","message":"What do you know about Rust ownership?"}}))
p.stdin.flush()
resp = read_frame(p)
print("before_message:", resp)
assert resp["result"]["action"] in ("inject","continue"), f"unexpected: {resp}"

p.stdin.write(frame({"jsonrpc":"2.0","id":99,"method":"shutdown","params":{}}))
p.stdin.flush()
p.wait(timeout=5)
print("PASS")
EOF
```

---

## 5. Phase 2 — Upstream axel Bump

### 5.1 Update Cargo.lock

```bash
cd axel-memory-manager-plugin/extensions/memory-manager
cargo update -p axel
```

`Cargo.toml` already specifies `branch = "main"` (not a pinned `rev`), so this is sufficient. Verify the lock file now references `cdfe73449e3c0bd67808d68eac686501ae9da936`:

```bash
grep -A 3 'name = "axel"' Cargo.lock
# Expected:
# source = "git+https://github.com/HaseebKhalid1507/axel?branch=main#cdfe73449e3c0bd67808d68eac686501ae9da936"
```

### 5.2 Build and test

```bash
cargo build --release --locked   # --locked validates nothing else drifted
cargo test -j 8 -- --test-threads=8
```

> `--release --locked` matches the CI build (`axel-memory-manager-release.yml:46`). Running it locally catches link-time issues (LTO=thin, strip=true in the release profile) before CI.

### 5.3 API break handling

[verify]: The implementing agent must inspect the upstream diff between `c71f76a` and `cdfe7344` before merging. The most likely breaking surface areas are:

- `AxelBrain::contextual_recall` signature (return type or parameter changes)
- `InjectionContext` field additions/removals
- `consolidate::consolidate` `ConsolidateOptions` struct fields

If `cargo build` succeeds without errors, treat the bump as non-breaking and proceed. If the compiler errors, document each broken call site in a `## API Break Notes` section of the PR description and open a follow-up issue rather than fixing upstream API changes in this PR (they belong in a dedicated `chore(axel): adapt to upstream API vX.Y` commit).

### 5.4 Verification

```bash
# Confirm lock SHA
grep 'cdfe73' axel-memory-manager-plugin/extensions/memory-manager/Cargo.lock

# Full test pass
cd axel-memory-manager-plugin/extensions/memory-manager && cargo test

# Binary size sanity (release strip=true; < 35 MB is expected)
cargo build --release && ls -lh target/release/memory-manager
```

---

## 6. Phase 3 — Self-Update Pipeline

### 3a. Nightly upstream-bump CI

Create `.github/workflows/axel-upstream-bump.yml` with the following specification. Do **not** modify the existing `axel-memory-manager-release.yml` — this is a separate pre-release automation concern.

**Spec:**

```
name: axel-upstream-bump
on:
  schedule:
    - cron: "0 7 * * *"          # 07:00 UTC daily
  workflow_dispatch: {}           # manual trigger, no inputs required

concurrency:
  group: axel-upstream-bump
  cancel-in-progress: false       # never cancel a running bump; let it finish

permissions:
  contents: write
  pull-requests: write

jobs:
  bump:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: axel-memory-manager-plugin/extensions/memory-manager

    steps:
      - uses: actions/checkout@v4
        with:
          ref: main
          fetch-depth: 0            # needed for git log range in PR body

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: axel-memory-manager-plugin/extensions/memory-manager

      - name: Capture old SHA
        id: old
        run: |
          OLD=$(grep -A2 'name = "axel"' Cargo.lock | grep 'source' | grep -oP '#\K[a-f0-9]+')
          echo "sha=$OLD" >> "$GITHUB_OUTPUT"

      - name: cargo update -p axel
        run: cargo update -p axel

      - name: Capture new SHA
        id: new
        run: |
          NEW=$(grep -A2 'name = "axel"' Cargo.lock | grep 'source' | grep -oP '#\K[a-f0-9]+')
          echo "sha=$NEW" >> "$GITHUB_OUTPUT"

      - name: Abort if SHA unchanged (already current)
        if: steps.old.outputs.sha == steps.new.outputs.sha
        run: |
          echo "axel is already at ${{ steps.old.outputs.sha }}; nothing to do."
          exit 0

      - name: Run test suite
        run: cargo test -j 4

      - name: Build release binary (compile check)
        run: cargo build --release

      - name: Compute upstream commit log
        id: log
        run: |
          # Fetch the upstream repo to get the log range
          git -C $(cargo metadata --no-deps --format-version 1 \
            | python3 -c "import json,sys; \
              pkgs=json.load(sys.stdin)['packages']; \
              print([p for p in pkgs if p['name']=='axel'][0]['manifest_path'].rsplit('/',2)[0])") \
            log --oneline ${{ steps.old.outputs.sha }}..${{ steps.new.outputs.sha }} \
            > /tmp/axel_log.txt 2>/dev/null || echo "(git log unavailable)" > /tmp/axel_log.txt
          # Truncate to avoid PR body limits
          head -40 /tmp/axel_log.txt > /tmp/axel_log_trunc.txt
          {
            echo 'text<<EOF'
            cat /tmp/axel_log_trunc.txt
            echo 'EOF'
          } >> "$GITHUB_OUTPUT"

      - name: Open PR
        uses: peter-evans/create-pull-request@v6
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          branch: chore/axel-upstream-bump-${{ steps.new.outputs.sha }}
          base: main
          title: "chore(axel): bump upstream axel to ${{ steps.new.outputs.sha }}"
          body: |
            ## Automated upstream axel bump

            | | SHA |
            |---|---|
            | **Before** | `${{ steps.old.outputs.sha }}` |
            | **After**  | `${{ steps.new.outputs.sha }}` |

            ### Upstream commits included

            ```
            ${{ steps.log.outputs.text }}
            ```

            ### Checklist
            - [x] `cargo update -p axel` ran cleanly
            - [x] `cargo test` passed
            - [x] `cargo build --release` succeeded
            - [ ] Reviewer: verify no API surface changes in the diff above
            - [ ] Reviewer: merge when satisfied; release workflow publishes binaries on the next tag

          commit-message: "chore(axel): bump upstream axel to ${{ steps.new.outputs.sha }}"
          delete-branch: true
          labels: "dependencies,axel"
```

**Path filter note**: This workflow does not use `paths:` filtering on the push trigger (it only runs on schedule/dispatch), so no filter is needed. The `concurrency` group prevents two simultaneous bumps from producing conflicting PRs.

**Secret**: `GITHUB_TOKEN` (auto-provided) needs `pull-requests: write` — declared in `permissions`. No additional PAT is required unless branch protection rules prevent bot pushes to `chore/*` branches, in which case a `GH_PAT` secret with `repo` scope is needed.

**No-op guarantee**: The `Abort if SHA unchanged` step exits 0 (not 1) so the workflow is green when axel is already current.

[verify]: Confirm that `peter-evans/create-pull-request@v6` is available and not blocked by org policy. Alternative: `gh pr create` using the `gh` CLI pre-installed on `ubuntu-latest`, which avoids the third-party action dependency.

### 3b. Release pipeline tie-in

The existing release workflow at `.github/workflows/axel-memory-manager-release.yml` is triggered by **tags** matching `axel-memory-manager-v*` (line 6) or manual `workflow_dispatch` with an explicit tag (lines 7-12). It builds and publishes prebuilt binaries for linux-x86_64, linux-aarch64, macos-aarch64, and windows-x86_64 as GitHub release assets (lines 68-84).

The bump PR created in §3a **does not** auto-trigger a release. The release lifecycle remains manual: after merging a bump PR, a human (or future automation) must push a tag like `axel-memory-manager-v0.1.1` (or dispatch the release workflow with a tag name). This is intentional — shipping a new binary because of a dependency bump should require an explicit version decision.

[verify]: **Required verification before assuming anything about the release pipeline**: the parent agent has not confirmed that the `maha-media/synaps-skills` GitHub releases page actually has assets named `memory-manager-linux-x86_64`, etc. Run the following before shipping Phase 3:

```bash
# Check for any existing releases
gh release list --repo maha-media/synaps-skills --limit 10

# If any exist, confirm asset naming matches setup.sh expectations
gh release view <tag> --repo maha-media/synaps-skills --json assets
```

`setup.sh` downloads from `https://github.com/maha-media/synaps-skills/releases/latest/download/memory-manager-<platform>` (lines 132-137). The release workflow uploads `memory-manager-linux-x86_64`, `memory-manager-linux-aarch64`, `memory-manager-macos-aarch64`, `memory-manager-windows-x86_64.exe` (lines 25-31). **These names match** — no change needed to `setup.sh`'s download URL logic assuming a release has been published.

If no release exists yet, the implementing agent must publish one manually (`gh release create axel-memory-manager-v0.1.0 --repo maha-media/synaps-skills --title "Axel Memory Manager v0.1.0"` and dispatch the release workflow) to seed the `latest` download path before §3b can be tested end-to-end.

### 3c. Runtime consolidation

The `on_session_end` handler at `src/main.rs:251-255` currently calls only `b.flush()`. The full consolidation pipeline (`axel::consolidate::consolidate`) is available via `brain.search_mut()` and the public `consolidate` module (`axel/src/lib.rs:9`, `axel/src/consolidate/mod.rs:127`).

**Three consolidation surfaces to add:**

#### (i) `on_session_end` consolidation (env-gated)

In `handle_hook` for `"on_session_end"`:

```diff
 "on_session_end" => {
     if let Some(b) = brain {
         let _ = b.flush();
+        if std::env::var("AXEL_CONSOLIDATE_ON_END").as_deref().unwrap_or("1") == "1" {
+            run_consolidation(b, "session_end");
+        }
     }
     json!({ "action": "continue" })
 }
```

Where `run_consolidation` is a new function:

```rust
fn run_consolidation(brain: &mut AxelBrain, trigger: &str) {
    use axel::consolidate::{consolidate, ConsolidateOptions};
    use std::collections::HashSet;
    let opts = ConsolidateOptions {
        sources: vec![],         // no file-system reindex; memories-only pass
        phases: HashSet::new(),  // empty = run all phases
        dry_run: false,
        verbose: false,
    };
    let started = std::time::Instant::now();
    match consolidate(brain.search_mut(), &opts) {
        Ok(stats) => eprintln!(
            "axel: consolidation ({trigger}) done in {:.1}s — reindexed={} strengthened={} pruned={}",
            started.elapsed().as_secs_f32(),
            stats.reindex.reindexed,
            stats.strengthen.strengthened,  // [verify]: confirm field name on ConsolidateStats
            stats.prune.pruned,
        ),
        Err(e) => eprintln!("axel: consolidation ({trigger}) failed: {e}"),
    }
}
```

[verify]: The `StrengthenStats` field name (`strengthened`) must be confirmed against `axel/src/consolidate/strengthen.rs`. Similarly confirm `PruneStats.pruned` and `ReindexStats.reindexed` field names before writing this code.

#### (ii) Hourly background consolidation timer

In `main()`, after a successful `AxelBrain::open_or_create` and before entering the dispatch loop, spawn a background thread if `AXEL_CONSOLIDATE_INTERVAL_SECS` is not `"0"`:

```rust
let interval_secs: u64 = std::env::var("AXEL_CONSOLIDATE_INTERVAL_SECS")
    .ok()
    .and_then(|v| v.parse().ok())
    .unwrap_or(3600);

if interval_secs > 0 {
    // Brain must be Arc<Mutex<AxelBrain>> for sharing with the timer thread.
    // This requires refactoring the brain ownership from Option<AxelBrain> to
    // Arc<Mutex<Option<AxelBrain>>> — see implementation note below.
    // ...
}
```

**Implementation note**: The current `brain: Option<AxelBrain>` is moved into the dispatch loop. Sharing it with a timer thread requires wrapping it in `Arc<Mutex<Option<AxelBrain>>>`. This is a non-trivial refactor of the main loop. The timer thread wakes every `interval_secs`, locks the mutex, and calls `run_consolidation`. The implementing agent should weigh whether this complexity is worth it for Phase 1 scope or should be deferred to a follow-up. If deferred, leave a `// TODO(consolidation-timer): ...` comment at the `on_session_end` handler.

[verify]: The background thread approach introduces WAL contention with other running memory-manager processes (currently 3). Confirm with the axel upstream whether `AxelBrain` / the underlying SQLite connection is safe to use from a timer thread while the main thread is actively calling `remember()`. The underlying rusqlite connection is single-threaded; `Arc<Mutex>` provides the required serialization, but upstream must not internally use thread-locals that break across threads.

#### (iii) Manual `consolidate` JSON-RPC method

Add to the `dispatch` match in `src/main.rs:199-226`:

```rust
"consolidate" => {
    if let Some(b) = brain {
        run_consolidation(b, "manual_rpc");
        json!({ "ok": true })
    } else {
        json!({ "ok": false, "reason": "no brain" })
    }
}
```

This allows Synaps skills and scripts to call `memory-manager consolidate` via `axel-memory-manager`'s JSON-RPC channel on demand.

**Environment variable summary:**

| Variable | Default | Effect |
|---|---|---|
| `AXEL_CONSOLIDATE_ON_END` | `"1"` | Run consolidation on `on_session_end`; set to `"0"` to disable |
| `AXEL_CONSOLIDATE_INTERVAL_SECS` | `"3600"` | Background timer interval; `"0"` disables the timer entirely |
| `AXEL_BRAIN` | (path fallback chain) | Brain file path |

### 3d. `setup.sh --update` flag

Add `--update` to `scripts/setup.sh`'s argument parser (currently lines 27-49). The flag re-runs the `install_prebuilt` path (download from `releases/latest`) regardless of whether a binary already exists. If `install_prebuilt` fails (no release or wrong platform), it falls through to `cargo_build` exactly as the default path does.

```diff
     --from-source) FROM_SOURCE=1 ;;
     --check)       CHECK=1 ;;
+    --update)      UPDATE=1 ;;
     --version=*)   VERSION="${arg#--version=}" ;;
```

And in the main dispatch block:

```diff
+if [[ "${UPDATE:-0}" == "1" ]]; then
+  echo "→ axel-memory-manager: checking for newer prebuilt binary"
+  if install_prebuilt; then
+    exit 0
+  fi
+  echo "⚠ no newer prebuilt available; falling back to local Cargo build" >&2
+  cargo_build
+  exit $?
+fi
+
 if [[ "$FROM_SOURCE" == "1" ]]; then
```

Also update the usage comment at lines 2-13 to document `--update`.

The `--update` flag is distinct from `--version TAG`: `--update` always pulls `latest`; `--version` pins a specific tag. Both can coexist: `--update --version axel-memory-manager-v0.2.0` should be treated as `--version` taking precedence (the `VERSION` var is already set by `--version` handling before the dispatch block).

---

## 7. Phase 4 — Deploy & Verify on Live System

### 7.1 Pre-deploy backup

```bash
LIVE_BIN="/home/jr/.synaps-cli/plugins/axel-memory-manager/extensions/memory-manager/target/release/memory-manager"
cp -v "$LIVE_BIN" "${LIVE_BIN}.bak.pre-recall-fix"
ls -lh "${LIVE_BIN}.bak.pre-recall-fix"
```

The currently installed binary is 33 MB (confirmed at `ls -la` output: `33075808`, dated `May  3 11:26`).

### 7.2 Build and copy

```bash
cd /home/jr/Projects/Maha-Media/.worktrees/synaps-skills-axel-recall-and-self-update
cd axel-memory-manager-plugin/extensions/memory-manager
cargo build --release
ls -lh target/release/memory-manager  # should be newer mtime

cp target/release/memory-manager "$LIVE_BIN"
chmod 0755 "$LIVE_BIN"
```

### 7.3 Restart live sessions

**Three memory-manager processes are currently running** (PIDs 27824, 41657, 283801 at time of diagnosis). Each is a child of a Synaps CLI session. The cleanest restart is to close and reopen each Synaps session. The binary is loaded at session start, so already-running processes will continue using the old binary until their session is closed — the new binary takes effect on next session launch.

```bash
# Confirm old processes are gone after session restart
ps aux | grep memory-manager | grep -v grep
```

### 7.4 Watch memory growth

After restarting sessions and having a few real chat turns:

```bash
# Method 1: check WAL size growth (WAL accumulates writes before checkpoint)
watch -n 5 'ls -lh ~/.config/axel/axel.r8 ~/.config/axel/axel.r8-wal'

# Method 2: query memories table directly
sqlite3 ~/.config/axel/axel.r8 "SELECT COUNT(*) FROM memories;"
# Expect > 0 after a substantial assistant response (>= 80 chars)

# Method 3: check memory content
sqlite3 ~/.config/axel/axel.r8 "SELECT id, category, substr(content,1,80) FROM memories ORDER BY rowid DESC LIMIT 5;"
```

The `.r8-wal` is currently 1.28 MB (`axel.r8-wal` at `May  8 09:44`) despite `axel.r8` being only 4 KB. This suggests the old binary **is** writing something to the WAL (likely empty-string attempts or flush operations) — the WAL is not empty. After the fix, expect actual `memories` rows.

### 7.5 Roll-back

```bash
LIVE_BIN="/home/jr/.synaps-cli/plugins/axel-memory-manager/extensions/memory-manager/target/release/memory-manager"
cp -v "${LIVE_BIN}.bak.pre-recall-fix" "$LIVE_BIN"
# Restart sessions to pick up the restored binary
```

---

## 8. Risks & Mitigations

- **Upstream API break at bump time.** `cargo update -p axel` from `c71f76a` to `cdfe7344` is a 4-day diff on an actively developed crate. If `contextual_recall`, `InjectionContext`, or `ConsolidateOptions` changed, the build breaks. _Mitigation_: Phase 2 is explicitly isolated from Phase 1. The CI build step in §3a runs tests and fails the PR rather than merging silently. §5.3 prescribes leaving breakage as a flagged follow-up rather than bundling it into this PR.

- **Multi-process WAL contention.** Three memory-manager processes share `~/.config/axel/axel.r8` via SQLite WAL mode. After the fix, all three will actively write `remember()` and potentially run concurrent consolidations. SQLite WAL supports concurrent readers with one writer, but write contention causes `SQLITE_BUSY` errors. _Mitigation_: `axel::brain::remember_with_ttl` should handle retry logic — [verify]: confirm this with the upstream source. For consolidation, the `AXEL_CONSOLIDATE_ON_END` env var defaults to `"1"` which means all three sessions will attempt consolidation on end. If they overlap, the second consolidation log row will be written while the first is still running (finished_at = NULL). This is cosmetic, not data-destroying. Long-term mitigation: a lock file or advisory lock per brain path, deferred to a follow-up.

- **`HookResult::Block` was silently discarding recall on every message.** The `before_message` → `"modify"` → Block fallback in `process.rs:1795-1803` means that every single `before_message` call was returning Block, not Continue. This means the user's messages may have been suppressed in some execution paths. _Mitigation_: The fix in §4.3 (fix 2) corrects this to `"inject"`. Verify after deploy that chat messages are not blocked (watch for sessions where the user sends a message and gets no response — that would indicate Block is still firing somehow).

- **Consolidation runtime cost.** The four-phase consolidation (reindex → strengthen → reorganize → prune) on a large brain could take seconds to minutes. Running it synchronously on `on_session_end` blocks the session teardown handler. _Mitigation_: `on_session_end` is a fire-and-forget hook (`OnSessionEnd` only allows `"continue"` result per events.rs:80), so Synaps does not wait for its response beyond the 5-second timeout. If consolidation takes >5s, Synaps kills the handler. For large brains, consolidation must run in a background thread. This is flagged in §3c as a deferred concern. For Phase 3, leave `on_session_end` consolidation on by default but with a 4-second wall-clock deadline that aborts and logs a warning.

- **Nightly CI bot loop.** If the bump PR is opened but not reviewed/merged for weeks, each nightly run will re-open an equivalent PR (different branch name `chore/axel-upstream-bump-<sha>`). If axel moves daily, this generates PR spam. _Mitigation_: The `peter-evans/create-pull-request` action is idempotent when the branch name is stable — but here the branch name includes the SHA, so each new SHA creates a new PR. Implement one of: (a) use a stable branch name `chore/axel-upstream-bump` (the action will force-push and update the existing PR), or (b) close stale bump PRs older than 7 days via a `stale` workflow. Option (a) is recommended: change the branch to `chore/axel-upstream-bump` and let the action update the existing PR in place.

- **`--update` flag re-downloading on every `setup.sh --update` call.** If called in a CI loop without checking whether a newer release exists, it re-downloads the binary unconditionally. _Mitigation_: Add a version-check step: compare the currently installed binary's embedded version (via `$BIN --version` or a `$BIN version` subcommand if one exists — [verify]: confirm memory-manager binary exposes a `--version` flag) against the release's latest tag before downloading. This is a nice-to-have; the basic `--update` flag works correctly without it.

---

## 9. Verification Checklist

The implementing agent must run all of the following in order before marking the PR ready for review:

```bash
# ── Phase 1 ────────────────────────────────────────────────────────────────────

# 1. Unit tests RED before fix (extract_text_synaps_wire_shape must FAIL)
cd axel-memory-manager-plugin/extensions/memory-manager
cargo test 2>&1 | grep -E "FAILED|test result"

# 2. Apply fixes (§4.3 diff 1 and diff 2)

# 3. Unit tests GREEN after fix
cargo test -j 8 -- --test-threads=8
# Expected: test result: ok. N passed; 0 failed

# 4. Integration test GREEN (may require network for ONNX model on first run)
cargo test --test integration_wire -- --nocapture

# 5. Smoke test (manual, per §4.4 shell script)

# ── Phase 2 ────────────────────────────────────────────────────────────────────

# 6. Bump
cargo update -p axel
grep -A3 'name = "axel"' Cargo.lock | grep cdfe73

# 7. Build release
cargo build --release --locked

# 8. Tests still green
cargo test -j 8 -- --test-threads=8

# ── Phase 3 ────────────────────────────────────────────────────────────────────

# 9. Validate new workflow YAML syntax
cd /home/jr/Projects/Maha-Media/.worktrees/synaps-skills-axel-recall-and-self-update
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/axel-upstream-bump.yml'))"

# 10. Dry-run the bump workflow logic manually
cd axel-memory-manager-plugin/extensions/memory-manager
OLD=$(grep -A2 'name = "axel"' Cargo.lock | grep source | grep -oP '#\K[a-f0-9]+')
echo "Current SHA: $OLD"

# 11. Verify setup.sh --update works
cd axel-memory-manager-plugin
bash scripts/setup.sh --update 2>&1 | head -20

# 12. setup.sh --check passes
bash scripts/setup.sh --check

# ── Phase 4 ────────────────────────────────────────────────────────────────────

# 13. Backup and deploy (per §7.1-7.2)
LIVE_BIN="/home/jr/.synaps-cli/plugins/axel-memory-manager/extensions/memory-manager/target/release/memory-manager"
cp "$LIVE_BIN" "${LIVE_BIN}.bak.pre-recall-fix"
cp axel-memory-manager-plugin/extensions/memory-manager/target/release/memory-manager "$LIVE_BIN"

# 14. After restarting sessions and a few chat turns:
sqlite3 ~/.config/axel/axel.r8 "SELECT COUNT(*) FROM memories;"
# Must be > 0

# 15. Verify no accidental Block behaviour (watch for action in before_message responses)
# Run the smoke test again against the live binary with AXEL_BRAIN pointing at axel.r8
# and confirm before_message returns action:"inject" or action:"continue", never "block"
```

---

## 10. Commit + PR Plan

**Branch**: `fix/axel-recall-and-self-update` (already exists).

### Commit sequence

```
# Phase 1
git add axel-memory-manager-plugin/extensions/memory-manager/src/main.rs
git commit -m "fix(memory-manager): extract_text reads params.message string (Synaps wire shape)

Synaps serialises HookEvent.message as a top-level plain string
(SynapsCLI/src/extensions/hooks/events.rs:149). extract_text was only
checking params.content and params.message.content (nested object).
Result: every call to b.remember() was gated behind an 80-char threshold
that was never reached; brain stayed empty; recall found nothing.

Also fix before_message to return action:inject (not action:modify).
Modify without an 'input' field fails HookResult deserialization and
triggers Block in the Synaps runtime (process.rs:1795-1803).

Fixes: recall always returning empty; recall context being silently blocked."

# Phase 1 tests
git add axel-memory-manager-plugin/extensions/memory-manager/src/main.rs \
        axel-memory-manager-plugin/extensions/memory-manager/tests/
git commit -m "test(memory-manager): add unit + integration tests for wire-shape fix

Unit tests pin all three extract_text shapes (canonical Synaps wire,
legacy content field, legacy message.content nested object).
Integration test drives the binary with LSP-framed JSON-RPC and asserts
a memory row appears in the .r8 SQLite file after on_message_complete."

# Phase 2
git add axel-memory-manager-plugin/extensions/memory-manager/Cargo.lock
git commit -m "chore(axel): bump upstream axel c71f76a → cdfe7344 (2026-05-05)"

# Phase 3a
git add .github/workflows/axel-upstream-bump.yml
git commit -m "ci: add nightly axel upstream-bump workflow

Opens a PR automatically when HaseebKhalid1507/axel/main advances.
Runs cargo update -p axel, full test suite, and release build before
opening the PR. No-op when SHA is already current."

# Phase 3c+3d
git add axel-memory-manager-plugin/extensions/memory-manager/src/main.rs \
        axel-memory-manager-plugin/scripts/setup.sh
git commit -m "feat(memory-manager): consolidation on session-end + setup --update flag

- Run axel::consolidate on on_session_end (gated by AXEL_CONSOLIDATE_ON_END=1)
- Surface 'consolidate' JSON-RPC method for manual triggering
- Add AXEL_CONSOLIDATE_INTERVAL_SECS for background timer (default 3600, 0=off)
- setup.sh --update: re-download prebuilt from latest release, fallback to Cargo"
```

### PR

**Title**: `fix(axel-memory-manager): recall fix, upstream bump, consolidation pipeline`

**Body skeleton**:

```markdown
## What

Fixes two bugs that caused the axel-memory-manager extension to silently
discard all hook payloads since its initial deployment:

1. **extract_text wire-shape mismatch** — Synaps sends `{"message":"<text>"}`;
   the extension looked for `{"content":"..."}` and `{"message":{"content":"..."}}`.
   Brain was always empty; recall always returned nothing.

2. **before_message returned wrong action** — `{"action":"modify","content":"..."}` 
   was returned for `before_message`, but Synaps only accepts `inject` for that
   hook. The runtime deserialized it as `HookResult::Block`, discarding recall
   context silently on every message.

Also bumps the upstream axel crate from `c71f76a` (2026-05-01) to `cdfe7344`
(2026-05-05), adds a nightly CI bump workflow, drives consolidation on session
end, and adds `setup.sh --update`.

## Test plan

- Unit tests cover all three extract_text shapes (red→green)
- Integration test drives the binary end-to-end, asserts SQLite memory row written
- Integration test asserts before_message returns action:inject after memory is planted
- Smoke test on live system: sqlite3 ~/.config/axel/axel.r8 "SELECT COUNT(*) FROM memories" > 0 after a few chat turns

## Risk

- Multi-process WAL contention (3 concurrent sessions) — tracked in §8
- Upstream API break on bump — no breakage found; log in PR if any

## API break notes (Phase 2)

[verify]: Fill in if `cargo build` produces any errors after the bump.
```

---

*End of plan.*
