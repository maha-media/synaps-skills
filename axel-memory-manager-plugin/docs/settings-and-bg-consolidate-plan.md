# Axel Memory Manager — Settings Module & Background Consolidation Plan

Branch: `feat/axel-settings-and-bg-consolidate`
Worktree: `.worktrees/synaps-skills-axel-settings-and-bg-consolidate`
Status: PLAN ONLY — no production code in this run.

---

## 1. Summary

This plan covers **two paired features** for `axel-memory-manager-plugin`:

1. **Settings module** — declare a `plugin.json` `settings` block, subscribe to host-pushed
   `config.update` JSON-RPC notifications, and promote currently-hardcoded knobs
   (notably `MIN_CONSOLIDATE_LEN`, plus a new `consolidate_interval_secs`) to
   runtime-mutable fields on a `Settings` struct.
2. **Background consolidation timer** — a worker thread that periodically calls the
   existing `consolidate` flow without requiring a host-initiated RPC.

**Why paired:** the background timer's interval is meaningless without a way to
configure it, and the settings module is hard to demo without at least one
consumer that reacts to live updates. Shipping them together gives a single
end-to-end story: *the user opens the Axel settings panel, changes the
consolidation interval, and the running plugin's timer re-arms without restart.*
Both features also share the same lifetime/ownership refactor (the brain must be
reachable from both the JSON-RPC dispatch loop and the timer thread), so doing
them in one branch avoids two consecutive churny refactors of `main.rs`.

[verify]: confirm both features are listed together in the parent feature
ticket / TODO and not split across milestones — `rg -n 'settings|background|consolidate' axel-memory-manager-plugin/README.md docs/`.

---

## 2. Root Cause / Current State

### 2.1 Settings are not wired

- `plugin.json` currently declares no `settings` array, so the host has nothing
  to render in its plugin-settings UI.
  [verify]: `jq '.settings' axel-memory-manager-plugin/plugin.json` returns `null`.
- The plugin does not request the `config.subscribe` permission, so even if
  the host pushed a `config.update` notification it would be filtered upstream.
  [verify]: `jq '.permissions' axel-memory-manager-plugin/plugin.json` lacks `config.subscribe`.
- The JSON-RPC dispatch loop in `src/main.rs` only matches request methods
  (`recall`, `consolidate`, `remember`, …); there is no notification arm for
  `config.update`, so even a delivered notification would be dropped.
  [verify]: `rg -n '"config\.update"|notification' axel-memory-manager-plugin/src/main.rs`
  returns no hits.
- `MIN_CONSOLIDATE_LEN` is a `const usize` baked into `src/brain.rs` (or
  wherever consolidation thresholding lives). To make it user-tunable it must
  move onto a value the dispatch loop holds and can mutate.
  [verify]: `rg -n 'MIN_CONSOLIDATE_LEN' axel-memory-manager-plugin/src/`
  shows a single `const` definition and one read site.

### 2.2 Background timer needs shared ownership of the brain

- Today `AxelBrain` is owned exclusively by the dispatch loop's stack frame in
  `main()` and borrowed `&mut` per request. A worker thread cannot hold a
  reference into a stack frame.
- To share it between the dispatch loop and a timer thread we need
  `Arc<Mutex<Option<AxelBrain>>>` (the `Option` lets `Drop`/shutdown take the
  brain out and close SQLite cleanly; the `Mutex` serialises writes so the
  timer's `consolidate` cannot race a `remember`).
  [verify]: `rg -n 'AxelBrain::new|let mut brain' axel-memory-manager-plugin/src/main.rs`
  shows current ownership pattern.
- Settings must also be shared (dispatch loop writes, timer reads) — same
  pattern: `Arc<Mutex<Settings>>` (or `Arc<RwLock<Settings>>` if read traffic
  on the timer side dominates; default to `Mutex` for simplicity).

### 2.3 Manifest constraints (host side)

The host's manifest schema only accepts these editor kinds for a setting field:

- `text`
- `cycler` (enum-like ring of values)
- `picker` (dropdown)
- `custom` (renders a host-side widget keyed by a string id)

[verify]: confirmed from `SynapsCLI/src/skills/manifest.rs:141` (per parent
context). Re-check with `sed -n '120,170p' SynapsCLI/src/skills/manifest.rs`
before drafting `plugin.json`.

There is **no native** `boolean`, `integer`, `slider`, or `button` kind. Numeric
inputs must be `text` (validated plugin-side) or `picker` (discrete choices),
and any action-style "Run X now" button must be implemented as a `custom`
editor whose handler issues an RPC to the plugin.

---

## 3. Out of Scope

- Per-conversation or per-agent setting overrides (single global scope only).
- Migration of *other* hardcoded constants beyond `MIN_CONSOLIDATE_LEN` and the
  new `consolidate_interval_secs`. Anything else stays `const` in this branch.
- Changing the on-disk SQLite schema.
- Authoring the host-side `custom` widget for the "Run consolidation now"
  button — this branch only declares the `custom` kind and wires the RPC the
  widget will call. Host UI work is tracked separately.
- Async/Tokio rewrite. Timer uses `std::thread` + `Condvar` (or `mpsc` with
  `recv_timeout`) to keep the diff small.
- Telemetry / metrics for consolidation runs.

---

## 4. Phase 1 — Settings Module (manifest + plumbing)

### 4.1 `plugin.json` settings declaration

Add a top-level `"settings"` array. Use only `text`, `cycler`, `picker`,
`custom` editor kinds.

Proposed fields:

| key                         | kind   | default | notes                                                               |
| --------------------------- | ------ | ------- | ------------------------------------------------------------------- |
| `min_consolidate_len`       | text   | `"40"`  | Plugin parses to `usize`; reject < 1 with an error log + keep prev. |
| `consolidate_interval_secs` | picker | `"0"`   | Choices: `"0"` (disabled), `"60"`, `"300"`, `"900"`, `"3600"`.      |
| `run_consolidate_now`       | custom | n/a     | `custom_id: "axel.run_consolidate"`; widget calls `consolidate` RPC. |

Also add to the manifest:

```jsonc
"permissions": [ "...existing...", "config.subscribe" ]
```

[verify]: re-read `SynapsCLI/src/skills/manifest.rs` around line 141 to confirm
field names (`kind`, `default`, `choices`, `custom_id`) match the host's
deserializer exactly. Mismatched keys silently drop the field.

### 4.2 `config.subscribe` permission + `config.update` notification handler

In `src/main.rs` dispatch loop, add a notification arm. JSON-RPC notifications
have no `id`; the handler must return nothing on the wire.

Sketch:

```rust
// Notification (no id) — config.update
match req.method.as_str() {
    "config.update" => {
        let patch: ConfigUpdateParams = serde_json::from_value(req.params)?;
        let mut s = settings.lock().unwrap();
        s.apply_patch(&patch);   // logs + ignores unknown keys
        // Re-arm timer if interval changed:
        timer_tx.send(TimerCmd::Rearm(s.consolidate_interval_secs)).ok();
    }
    // ...existing request arms...
}
```

`ConfigUpdateParams` shape (per host convention — [verify] against
`SynapsCLI/src/skills/host_rpc.rs` or wherever `config.update` is emitted):

```rust
#[derive(Deserialize)]
struct ConfigUpdateParams {
    /// Map of setting key -> stringified value (text/picker/cycler all arrive as strings).
    values: HashMap<String, String>,
}
```

Validation rules per field:

- `min_consolidate_len`: `parse::<usize>()`, must be `>= 1`. On failure: log
  warning, keep previous value.
- `consolidate_interval_secs`: `parse::<u64>()`, must be one of the picker
  choices. `0` means *disabled* (timer thread parks indefinitely until next
  re-arm).

### 4.3 Promote `MIN_CONSOLIDATE_LEN` to a `Settings` field

New module `src/settings.rs`:

```rust
pub struct Settings {
    pub min_consolidate_len: usize,
    pub consolidate_interval_secs: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self { min_consolidate_len: 40, consolidate_interval_secs: 0 }
    }
}

impl Settings {
    pub fn apply_patch(&mut self, p: &ConfigUpdateParams) { /* per-key parse + clamp */ }
}
```

Refactor:

- Delete the `const MIN_CONSOLIDATE_LEN: usize = …` in `brain.rs`.
- Change the consolidation function signature to take `min_len: usize` (or
  `&Settings`) as a parameter — do **not** make it read a global.
- Dispatch loop holds `let settings = Arc::new(Mutex::new(Settings::default()));`
  and passes the locked-and-cloned numeric value into `consolidate`.

[verify]: `rg -n 'MIN_CONSOLIDATE_LEN' axel-memory-manager-plugin/src/` —
ensure exactly one read site to migrate.

### 4.4 "Run consolidation now" custom editor

- `plugin.json` declares the field with `kind: "custom"`,
  `custom_id: "axel.run_consolidate"`.
- The host widget (out of scope here) is expected to invoke the existing
  `consolidate` JSON-RPC method when clicked.
- **Plugin-side change required:** none beyond declaring the field, *provided*
  the existing `consolidate` request is still callable while the timer thread
  exists. Verify the `Arc<Mutex<…>>` refactor (Phase 2) doesn't deadlock when
  a host-initiated `consolidate` lands while the timer also wants the lock —
  see §5.1.
- Document the contract in `docs/settings-and-bg-consolidate-plan.md` (this
  file) and in a short `## Settings` section of the plugin README.

### 4.5 Tests for Phase 1

Unit (in `src/settings.rs`):

- `apply_patch` parses valid `min_consolidate_len`.
- `apply_patch` rejects `"0"` and `"abc"` for `min_consolidate_len` and keeps
  previous value.
- `apply_patch` rejects out-of-set values for `consolidate_interval_secs`.
- Unknown keys in patch are ignored (logged), not an error.

Integration (`tests/settings_roundtrip.rs`, spawn the plugin binary over
stdio — pattern mirrored from existing recall-fix integration test
[verify]: `ls axel-memory-manager-plugin/tests/`):

1. Send `initialize`.
2. Send `config.update` notification with `min_consolidate_len = "10"`.
3. Send `remember` for a short message (length between 10 and 40).
4. Send `consolidate`.
5. Assert the short message *was* consolidated (would have been skipped under
   default 40).

---

## 5. Phase 2 — Background Consolidation Timer

### 5.1 Refactor main loop ownership

Change `main.rs` from:

```rust
let mut brain = AxelBrain::new(...)?;
loop { dispatch(&mut brain, ...) }
```

to:

```rust
let brain = Arc::new(Mutex::new(Some(AxelBrain::new(...)?)));
let settings = Arc::new(Mutex::new(Settings::default()));
let (timer_tx, timer_rx) = mpsc::channel::<TimerCmd>();
let timer_handle = spawn_consolidation_timer(brain.clone(), settings.clone(), timer_rx);

loop {
    // dispatch acquires brain.lock() per-request; releases before reply write.
}

// On EOF / shutdown:
timer_tx.send(TimerCmd::Shutdown).ok();
timer_handle.join().ok();
brain.lock().unwrap().take(); // explicit drop -> SQLite close
```

Lock discipline: **never hold the brain lock across a stdio write.** Take lock,
do DB work, drop lock, then write the JSON-RPC reply. This prevents the timer
thread from being blocked behind a slow stdout flush and vice versa.

[verify]: existing dispatch handlers do not return guards — `rg -n 'MutexGuard|lock\\(\\)' axel-memory-manager-plugin/src/`.

### 5.2 Timer thread

```rust
enum TimerCmd { Rearm(u64), Shutdown }

fn spawn_consolidation_timer(
    brain: Arc<Mutex<Option<AxelBrain>>>,
    settings: Arc<Mutex<Settings>>,
    rx: mpsc::Receiver<TimerCmd>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut interval = settings.lock().unwrap().consolidate_interval_secs;
        loop {
            let wait = if interval == 0 { Duration::from_secs(3600 * 24) } // effectively parked
                       else { Duration::from_secs(interval) };
            match rx.recv_timeout(wait) {
                Ok(TimerCmd::Shutdown) => break,
                Ok(TimerCmd::Rearm(n)) => { interval = n; continue; }
                Err(RecvTimeoutError::Timeout) => {
                    if interval == 0 { continue; } // disabled — re-park
                    let min_len = settings.lock().unwrap().min_consolidate_len;
                    if let Some(b) = brain.lock().unwrap().as_mut() {
                        if let Err(e) = b.consolidate(min_len) {
                            log::warn!("bg consolidate failed: {e}");
                        }
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    })
}
```

Notes:

- Re-arm is delivered via channel from the `config.update` handler (§4.2).
- `interval == 0` ⇒ disabled. Implementation parks on a long timeout and only
  wakes for channel messages; on `Rearm(0)` it loops back and parks again.
- All settings reads inside the thread re-lock per tick — never cache across
  ticks, so live updates take effect on the *next* fire.

### 5.3 SQLite WAL contention

Per the prior recall-fix plan §8, the SQLite file may now have **three**
concurrent writers/readers in the worst case:

1. Dispatch-loop `remember` / `consolidate` (host-initiated).
2. Timer-thread `consolidate`.
3. The companion `synapse` indexer process if it shares the DB
   [verify]: `rg -n 'axel.*\\.db|memory\\.db' SynapsCLI/ axel-memory-manager-plugin/`.

Mitigations:

- Connection is opened with `journal_mode=WAL` and `busy_timeout=5000ms`
  already [verify]: `rg -n 'journal_mode|busy_timeout' axel-memory-manager-plugin/src/`.
- The in-process `Mutex<Option<AxelBrain>>` already serialises **(1)** vs
  **(2)** — the WAL only has to handle **(3)** vs us, which is the same
  scenario as today.
- Timer's `consolidate` should be a single transaction; if it grows, split it
  so each commit is bounded (< 100ms typical) to avoid starving the dispatch
  loop.
- Add a debug log line `"bg consolidate: start/end ms=N rows=N"` to make
  contention visible during manual testing.

### 5.4 Tests for Phase 2

Integration (`tests/bg_timer.rs`):

1. **Timer fires consolidation.** Set `consolidate_interval_secs = 1` via
   `config.update`. Insert messages via `remember`. Sleep ~2.5s. Open the DB
   read-only and assert consolidation rows exist *without* having sent a
   `consolidate` RPC.
2. **`interval = 0` disables timer.** Default config; insert messages; sleep
   2s; assert no consolidation rows. Then patch to `1`, sleep, assert rows
   appear.
3. **Re-arm without restart.** Start with `60`; patch to `1`; assert
   consolidation fires within 2s (proves channel re-arm path).
4. **Shutdown joins thread.** Close stdin → main exits → process terminates
   within (e.g.) 2s; assert no zombie thread (test-side: process exit code
   observed before timeout).

Unit:

- `TimerCmd::Rearm(0)` followed by `Rearm(1)` in quick succession leaves the
  thread armed at 1s (no logic regression on rapid reconfig). Use a fake
  channel + bounded loop.

---

## 6. Phase 3 — Verification

### 6.1 Manual smoke

1. `cargo build -p axel-memory-manager-plugin --release`.
2. Start the host CLI with the plugin loaded.
3. Open plugin settings panel, confirm three fields render
   (`min_consolidate_len` text, `consolidate_interval_secs` picker, "Run
   consolidation now" custom button).
4. Set interval to 60s, change `min_consolidate_len` to 10. Send a few short
   chat messages. Wait ~70s. Confirm log line `bg consolidate: start … rows=N`
   with `N>0`.
5. Click "Run consolidation now" — confirm an immediate consolidation log
   line, regardless of timer phase.
6. Set interval back to 0. Wait 2 minutes. Confirm no further bg consolidation
   logs.
7. `Ctrl-C` host. Confirm clean shutdown (no SQLite "database is locked"
   warnings on next launch).

### 6.2 Automated

```
cargo test -p axel-memory-manager-plugin
cargo test -p axel-memory-manager-plugin --test settings_roundtrip
cargo test -p axel-memory-manager-plugin --test bg_timer
cargo clippy -p axel-memory-manager-plugin -- -D warnings
cargo fmt --check
```

---

## 7. Risks & Mitigations

| Risk                                                                          | Likelihood | Impact | Mitigation                                                                                                                  |
| ----------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| Manifest field shape doesn't match host deserializer; settings silently dropped. | Med        | High   | [verify] manifest schema before merging plugin.json change; add an integration test that asserts the host parses our manifest. |
| Lock held across stdout write → deadlock with timer thread.                   | Med        | High   | Code-review rule: handlers must `drop(guard)` before reply. Add a doc-comment on the dispatch fn.                            |
| SQLite "database is locked" under three-writer contention.                    | Low-Med    | Med    | WAL + 5s busy_timeout (already in place); bounded transactions in timer; surface errors as warn-log not panic.               |
| Timer thread keeps process alive after stdin EOF.                             | Low        | Med    | Explicit `TimerCmd::Shutdown` + `join()` in main's exit path; integration test #4 above.                                    |
| User sets `min_consolidate_len = 0` and consolidation churns on every char.   | Low        | Low    | `apply_patch` clamps to `>= 1` and logs a warning.                                                                          |
| `config.update` arrives before `initialize` reply.                            | Low        | Low    | Settings struct exists from process start with defaults; `apply_patch` is safe pre-init.                                    |
| Host emits values as JSON numbers/bools instead of strings.                   | Med        | Med    | [verify] against host emitter; if so, accept `serde_json::Value` and string-coerce in `apply_patch`.                        |

---

## 8. Verification Checklist

- [ ] `jq '.settings | length' plugin.json` == 3.
- [ ] `jq '.permissions' plugin.json` contains `"config.subscribe"`.
- [ ] `rg 'MIN_CONSOLIDATE_LEN' src/` returns 0 hits after refactor.
- [ ] `rg 'const .*CONSOLIDATE' src/` returns 0 hits.
- [ ] Dispatch loop has explicit `"config.update"` arm.
- [ ] `Arc<Mutex<Option<AxelBrain>>>` appears exactly once (constructed in `main`).
- [ ] No `MutexGuard` is returned from a handler fn.
- [ ] Timer thread is joined on shutdown (grep `timer_handle.join`).
- [ ] All tests in §4.5 and §5.4 pass.
- [ ] `cargo clippy -- -D warnings` clean.
- [ ] Manual smoke §6.1 steps 1–7 all pass.

---

## 9. Commit + PR plan

Suggested commit sequence on `feat/axel-settings-and-bg-consolidate`:

1. `refactor(axel): extract Settings struct, replace MIN_CONSOLIDATE_LEN const`
   — pure refactor, no behaviour change, default value preserved.
2. `feat(axel): declare settings + config.subscribe in plugin.json`
   — manifest only.
3. `feat(axel): handle config.update notifications and apply patches live`
   — wires the runtime side of settings; includes unit + integration tests
   from §4.5.
4. `refactor(axel): wrap brain in Arc<Mutex<Option<…>>> for shared ownership`
   — ownership change only; dispatch loop continues to work single-threaded.
5. `feat(axel): background consolidation timer thread with re-arm channel`
   — adds `spawn_consolidation_timer`, channel, shutdown join; tests from §5.4.
6. `docs(axel): settings & background consolidation README section`.

PR description should:

- Link this plan file.
- Include the manual smoke checklist (§6.1) for the reviewer to tick.
- Call out the SQLite three-writer scenario (§5.3) explicitly so reviewers
  know to think about it.
- Note that the host-side `custom` widget for "Run consolidation now" is
  **not** in this PR and tracked separately.

**Do not push.** Local commits only; parent agent will handle remote.
