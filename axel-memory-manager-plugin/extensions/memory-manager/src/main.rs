//! Axel memory-manager extension for Synaps CLI.
//!
//! Speaks JSON-RPC 2.0 with **LSP-style Content-Length framing** over stdio
//! (the actual Synaps CLI extension wire format — the public docs incorrectly
//! call it "line-delimited"; the working plugin-maker extension confirms
//! Content-Length is what Synaps sends/expects).
//!
//! Hooks: before_message, on_message_complete, after_tool_call,
//!        on_session_start, on_session_end.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use axel::AxelBrain;

mod settings;
mod timer;
use settings::Settings;
use timer::{spawn_consolidation_timer, TimerCmd};

const PROTOCOL_VERSION: u32 = 1;
const NAME: &str = "memory-manager";
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Importance score for memories captured automatically from chat turns.
const AUTO_IMPORTANCE: f64 = 0.5;

/// Max search results to retrieve for `before_message` recall.
const RECALL_LIMIT: usize = 5;

fn main() -> anyhow::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut out = stdout.lock();

    // Settings — shared between the dispatch loop and the background
    // consolidation timer. Loaded from
    // `$SYNAPS_BASE_DIR/plugins/axel-memory-manager/config` if present.
    let settings = Arc::new(Mutex::new(Settings::load_or_default()));

    let brain_path = resolve_brain_path();
    // Brain is shared between the dispatch loop and the background
    // consolidation timer. `Option` lets shutdown explicitly take + drop the
    // brain so SQLite closes cleanly. `Mutex` serialises concurrent writes
    // so the timer's `consolidate` cannot race a `remember`.
    let initial_brain = match AxelBrain::open_or_create(&brain_path, Some("synaps")) {
        Ok(b) => Some(b),
        Err(e) => {
            eprintln!(
                "axel: failed to open brain at {}: {e} — extension will run in passthrough mode",
                brain_path.display()
            );
            None
        }
    };
    let brain: Arc<Mutex<Option<AxelBrain>>> = Arc::new(Mutex::new(initial_brain));

    // Background consolidation timer. The channel is the single point of
    // truth for re-arm + shutdown signals; the file-watcher (below) sends
    // `Rearm` after applying changes, and `main` sends `Shutdown` on EOF.
    let (timer_tx, timer_rx) = mpsc::channel::<TimerCmd>();
    let timer_handle = spawn_consolidation_timer(brain.clone(), settings.clone(), timer_rx);

    // Spawn the file-watcher BEFORE we block on stdin. The watcher logs to
    // stderr only — stdout is reserved for JSON-RPC frames. The watcher
    // sends `TimerCmd::Rearm(new_interval)` to the timer after applying
    // any config change so interval edits take effect immediately.
    let watcher_guard = settings::spawn_watcher(settings.clone(), Some(timer_tx.clone()));

    loop {
        let frame = match read_frame(&mut reader) {
            Ok(Some(v)) => v,
            Ok(None) => break, // EOF — parent closed stdin
            Err(e) => {
                eprintln!("axel: frame read error: {e}");
                continue;
            }
        };

        // Empty object = malformed frame; skip without crashing the loop.
        if frame.as_object().map(|o| o.is_empty()).unwrap_or(true) {
            continue;
        }

        let method = frame.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = frame.get("params").cloned().unwrap_or(json!({}));
        let id = frame.get("id").cloned();

        // A frame with no `method` is a JSON-RPC response — almost certainly
        // the host's reply to our outbound `config.subscribe` request. Log
        // and skip; we don't pipeline outgoing requests so there's nothing
        // to correlate.
        if method.is_empty() {
            if frame.get("error").is_some() {
                eprintln!("axel: outbound request errored: {frame}");
            }
            continue;
        }

        // Prewarm the embedding model during `initialize` so the first
        // `before_message` hook (capped at 5s by Synaps) doesn't hit a
        // model download. `initialize` has no Synaps-side timeout, so we
        // can take as long as we need (~minutes on first run for the
        // 86 MB model download; instant once cached).
        if method == "initialize" {
            let mut g = brain.lock().expect("brain lock");
            if let Some(b) = g.as_mut() {
                prewarm_brain(b);
            }
            drop(g);
        }

        let result = dispatch(&brain, &settings, method, &params);

        if let Some(id) = id {
            let response = match result {
                Ok(v) => json!({ "jsonrpc": "2.0", "id": id, "result": v }),
                Err(e) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32603, "message": e.to_string() }
                }),
            };
            write_frame(&mut out, &response)?;
        }

        // Send `config.subscribe` immediately after our `initialize` reply so
        // the host knows we want push-style config updates (currently a stub
        // ACK on the host side — see SynapsCLI/src/extensions/runtime/
        // process.rs — but cheap and forward-compatible). Fire-and-forget:
        // the response is correlated by id and dropped in the dispatch loop.
        if method == "initialize" {
            let req = json!({
                "jsonrpc": "2.0",
                "id": "axel.config-subscribe",
                "method": "config.subscribe",
                "params": { "namespace": settings::PLUGIN_ID }
            });
            if let Err(e) = write_frame(&mut out, &req) {
                eprintln!("axel: WARN config.subscribe write failed: {e}");
            }
        }

        if method == "shutdown" {
            let mut g = brain.lock().expect("brain lock");
            if let Some(b) = g.as_mut() {
                let _ = b.flush();
            }
            drop(g);
            break;
        }
    }

    // ── Shutdown sequence ────────────────────────────────────────────────
    // 1. Tell the timer to break its loop.
    let _ = timer_tx.send(TimerCmd::Shutdown);
    // 2. Drop the watcher (its companion thread becomes joinable when the
    //    notify channel disconnects).
    let watcher_handle = watcher_guard.map(|(h, w)| {
        drop(w);
        h
    });
    // 3 + 4. Bounded join: spawn a watchdog that force-exits the process
    //    after 2 s if any helper thread is wedged. The normal path joins
    //    well under that.
    std::thread::Builder::new()
        .name("axel-shutdown-watchdog".into())
        .spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(2));
            eprintln!("axel: shutdown watchdog tripped — exiting");
            std::process::exit(0);
        })
        .ok();
    let _ = timer_handle.join();
    if let Some(h) = watcher_handle {
        let _ = h.join();
    }
    // 5. Take the brain out of the Arc<Mutex<…>> and drop it explicitly so
    //    SQLite's WAL is checkpointed and the file handle closes before
    //    `main` returns.
    let _ = brain.lock().expect("brain lock").take();

    Ok(())
}

/// Force the embedding model to load by issuing a tiny dummy search.
///
/// Why: `before_message` runs `contextual_recall`, which lazily loads (and
/// on first run, downloads) the 86 MB ONNX embedding model. Synaps caps
/// every hook handler at 5 s, so a cold first message would always time
/// out. `initialize` has no Synaps-side timeout — we move the cost there.
///
/// Errors are non-fatal: the extension still works in passthrough mode if
/// warm-up fails (network down, disk full, etc.).
fn prewarm_brain(brain: &mut AxelBrain) {
    eprintln!("axel: prewarming embedding model (may download ~86 MB on first run)");
    let started = std::time::Instant::now();
    match brain.search("warmup", 1) {
        Ok(_) => eprintln!("axel: brain warm in {:.1}s", started.elapsed().as_secs_f32()),
        Err(e) => eprintln!(
            "axel: prewarm failed after {:.1}s: {e} — recall will be a no-op",
            started.elapsed().as_secs_f32()
        ),
    }
}

/// Read one LSP-style Content-Length-framed JSON-RPC message.
/// Returns Ok(None) on EOF before any frame, Ok(Some({})) on a malformed frame
/// the caller should skip, Ok(Some(value)) on success.
fn read_frame<R: BufRead>(reader: &mut R) -> io::Result<Option<Value>> {
    let mut content_length: Option<usize> = None;

    // Header section — lines terminated with CRLF or LF, ends on blank line.
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None); // EOF before any header
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break; // end of header section
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
    }

    let len = match content_length {
        Some(n) => n,
        None => return Ok(Some(json!({}))), // malformed: skip
    };

    let mut body = vec![0u8; len];
    std::io::Read::read_exact(reader, &mut body)?;
    match serde_json::from_slice::<Value>(&body) {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            eprintln!("axel: bad JSON body: {e}");
            Ok(Some(json!({})))
        }
    }
}

/// Write one Content-Length-framed JSON-RPC message.
fn write_frame<W: Write>(out: &mut W, value: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(value).expect("serialize JSON-RPC frame");
    write!(out, "Content-Length: {}\r\n\r\n", body.len())?;
    out.write_all(&body)?;
    out.flush()
}

/// Resolve the .r8 brain file path. First match wins:
/// 1. `$AXEL_BRAIN`
/// 2. `$PLUGIN_DIR/axel.r8`
/// 3. `$SYNAPS_DATA_DIR/axel.r8`
/// 4. `~/.config/axel/axel.r8` (upstream default)
fn resolve_brain_path() -> PathBuf {
    if let Some(p) = std::env::var_os("AXEL_BRAIN") {
        return PathBuf::from(p);
    }
    if let Some(d) = std::env::var_os("PLUGIN_DIR") {
        return PathBuf::from(d).join("axel.r8");
    }
    if let Some(d) = std::env::var_os("SYNAPS_DATA_DIR") {
        return PathBuf::from(d).join("axel.r8");
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".config/axel/axel.r8")
}

/// JSON-RPC dispatch.
///
/// **Lock discipline:** any handler that needs the brain must acquire
/// `brain.lock()` for the minimum window required to do its DB work, then
/// **drop the guard before returning** (i.e. before the caller writes the
/// JSON-RPC reply to stdout). Holding the brain lock across a stdout write
/// would deadlock the background consolidation timer behind a slow flush —
/// and vice versa. As a corollary, no function in this crate returns a
/// `MutexGuard`.
fn dispatch(
    brain: &Arc<Mutex<Option<AxelBrain>>>,
    settings: &Arc<Mutex<Settings>>,
    method: &str,
    params: &Value,
) -> anyhow::Result<Value> {
    Ok(match method {
        "initialize" => json!({
            "name": NAME,
            "version": VERSION,
            "protocol_version": PROTOCOL_VERSION,
            "capabilities": {
                "hooks": [
                    "before_message",
                    "on_message_complete",
                    "after_tool_call",
                    "on_session_start",
                    "on_session_end"
                ]
            }
        }),

        "shutdown" => json!({ "ok": true }),

        // Manual consolidation trigger — callable by Synaps skills/scripts.
        // No wall-clock cap here; manual RPC can run as long as needed.
        "consolidate" => {
            let mut g = brain.lock().expect("brain lock");
            let result = if let Some(b) = g.as_mut() {
                let stats = run_consolidation(b, "manual_rpc");
                json!({ "ok": true, "stats": stats })
            } else {
                json!({ "ok": false, "reason": "no brain" })
            };
            drop(g);
            result
        }

        // Custom editor for the `run_consolidate_now` action button. Opening
        // the editor IS the action — we run consolidation synchronously and
        // render the result; Esc dismisses. There is no committable value.
        // See SynapsCLI/src/extensions/settings_editor.rs for payload shape.
        "settings.editor.open" => {
            let field = params
                .get("field")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if field != "run_consolidate_now" {
                anyhow::bail!("settings.editor.open: unknown field {field:?}");
            }
            let mut g = brain.lock().expect("brain lock");
            let label = match g.as_mut() {
                Some(b) => {
                    let stats = run_consolidation(b, "settings_editor");
                    let n = stats.unwrap_or(0);
                    format!("✓ Consolidated {n} memories")
                }
                None => "⚠ No brain available — consolidation skipped".to_string(),
            };
            drop(g);
            json!({
                "rows": [{
                    "label": label,
                    "selectable": false
                }],
                "cursor": null,
                "footer": "Press Esc to close"
            })
        }

        // Per-keypress notification dispatched as a request by the host.
        // We only care about Esc (close); everything else is a no-op.
        "settings.editor.key" => {
            let _ = params; // key text in params.key — we don't branch on it
            json!({})
        }

        // No committable value for an action-only editor; ACK and move on.
        "settings.editor.commit" => json!({}),

        // Synaps dispatches every hook through a single "hook.handle" RPC,
        // with the actual kind in `params.kind`. The hook-kind strings are
        // never sent as method names directly.
        "hook.handle" => {
            let kind = params.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            handle_hook(brain, settings, kind, params)
        }

        _ => anyhow::bail!("method not found: {method}"),
    })
}

/// Run the full axel consolidation pipeline (reindex → strengthen →
/// reorganize → prune) and log timing/stats to stderr.
///
/// `trigger` is a short label for log messages (e.g. `"session_end"`,
/// `"manual_rpc"`).
///
/// Returns `Some(reindexed_count)` on success so callers (e.g. the
/// `settings.editor.open` handler for `run_consolidate_now`) can surface a
/// number to the user; `None` on consolidation error.
///
/// Verified upstream field names (cdfe734):
///   `ConsolidateStats.reindex`   → `ReindexStats   { checked, reindexed, new_files, pruned, skipped }`
///   `ConsolidateStats.strengthen`→ `StrengthenStats { boosted, decayed, extinction_signals }`
///   `ConsolidateStats.prune`     → `PruneStats      { removed, flagged, misaligned }`
///   `ConsolidateOptions`         — no Default derive; all four fields must be specified.
fn run_consolidation(brain: &mut AxelBrain, trigger: &str) -> Option<u64> {
    use axel::consolidate::{consolidate, ConsolidateOptions};
    use std::collections::HashSet;
    let opts = ConsolidateOptions {
        sources: vec![],         // no filesystem reindex; memory-only pass
        phases: HashSet::new(),  // empty = run all phases
        dry_run: false,
        verbose: false,
    };
    let started = std::time::Instant::now();
    match consolidate(brain.search_mut(), &opts) {
        Ok(stats) => {
            eprintln!(
                "axel: consolidation ({trigger}) done in {:.1}s \
                 — reindexed={} boosted={} decayed={} removed={} flagged={}",
                started.elapsed().as_secs_f32(),
                stats.reindex.reindexed,
                stats.strengthen.boosted,
                stats.strengthen.decayed,
                stats.prune.removed,
                stats.prune.flagged,
            );
            Some(stats.reindex.reindexed as u64)
        }
        Err(e) => {
            eprintln!("axel: consolidation ({trigger}) failed: {e}");
            None
        }
    }
}

fn handle_hook(
    brain: &Arc<Mutex<Option<AxelBrain>>>,
    settings: &Arc<Mutex<Settings>>,
    kind: &str,
    params: &Value,
) -> Value {
    match kind {
        "on_session_start" => {
            // Inject Tier-0 handoff + Tier-1 memories as a system preamble.
            let mut g = brain.lock().expect("brain lock");
            let result = if let Some(b) = g.as_mut() {
                match b.boot_context() {
                    Ok(ctx) if !ctx.formatted.trim().is_empty() => json!({
                        "action": "inject_message",
                        "role": "system",
                        "content": ctx.formatted
                    }),
                    Ok(_) => json!({ "action": "continue" }),
                    Err(e) => {
                        eprintln!("axel: boot_context failed: {e}");
                        json!({ "action": "continue" })
                    }
                }
            } else {
                json!({ "action": "continue" })
            };
            drop(g);
            result
        }

        "on_session_end" => {
            // Flush, then optionally run consolidation under a 4-second cap.
            {
                let mut g = brain.lock().expect("brain lock");
                if let Some(b) = g.as_mut() {
                    let _ = b.flush();
                }
                drop(g);
            }
            if std::env::var("AXEL_CONSOLIDATE_ON_END").as_deref().unwrap_or("1") == "1" {
                // Hard 4-second wall-clock deadline: on_session_end has a
                // 5-second Synaps budget. Spawn the consolidation on a
                // dedicated thread (clones the Arc — no unsafe needed now)
                // and wait at most 4 s for it.
                let brain_for_thread = brain.clone();
                let (tx, rx) = std::sync::mpsc::channel::<()>();
                let handle = std::thread::spawn(move || {
                    let mut g = brain_for_thread.lock().expect("brain lock");
                    if let Some(b) = g.as_mut() {
                        run_consolidation(b, "session_end");
                    }
                    drop(g);
                    let _ = tx.send(());
                });
                match rx.recv_timeout(std::time::Duration::from_secs(4)) {
                    Ok(()) => { let _ = handle.join(); }
                    Err(_) => {
                        eprintln!(
                            "axel: consolidation (session_end) exceeded 4 s deadline — \
                             aborting wait; Synaps hook budget preserved"
                        );
                        // Do not join — let the thread finish in the background.
                    }
                }
            }
            json!({ "action": "continue" })
        }

        "before_message" => {
            // VolciRAG contextual recall on the user's incoming message.
            let user_text = extract_text(params);
            if user_text.trim().len() < 5 {
                return json!({ "action": "continue" });
            }
            let mut g = brain.lock().expect("brain lock");
            let result = if let Some(b) = g.as_mut() {
                match b.contextual_recall(&user_text, RECALL_LIMIT) {
                    Ok(ctx) if !ctx.formatted.trim().is_empty() => json!({
                        "action": "inject",
                        "content": ctx.formatted
                    }),
                    Ok(_) => json!({ "action": "continue" }),
                    Err(e) => {
                        eprintln!("axel: contextual_recall failed: {e}");
                        json!({ "action": "continue" })
                    }
                }
            } else {
                json!({ "action": "continue" })
            };
            drop(g);
            result
        }

        "on_message_complete" => {
            // Lightweight online consolidation: capture the assistant turn as
            // an Events memory if it's substantial. The full Consolidation
            // pipeline (reindex → strengthen → reorganize → prune) runs on
            // session end / on a schedule, not per message.
            let text = extract_text(params);
            let min_len = settings.lock().expect("settings lock").min_consolidate_len;
            if text.len() >= min_len {
                let mut g = brain.lock().expect("brain lock");
                if let Some(b) = g.as_mut() {
                    if let Err(e) = b.remember(&text, "Events", AUTO_IMPORTANCE) {
                        eprintln!("axel: remember failed: {e}");
                    }
                }
                drop(g);
            }
            json!({ "action": "continue" })
        }

        "after_tool_call" => {
            // Tool outputs are noisy; for now we just observe and skip.
            // Future: filter on tool name (file edits, web fetches) and store
            // selectively via brain.remember with category="Entities".
            let _ = (brain, params);
            json!({ "action": "continue" })
        }

        // Unknown hook kind — return continue so we don't break the session.
        _ => json!({ "action": "continue" }),
    }
}

/// Pull a text payload out of hook params. Synaps passes message content under
/// `content`; some shapes nest it under `message.content`.
fn extract_text(params: &Value) -> String {
    // Canonical Synaps wire shape: HookEvent serialises `message` as a top-level
    // plain string (see SynapsCLI/src/extensions/hooks/events.rs:149).
    if let Some(s) = params.get("message").and_then(|v| v.as_str()) {
        return s.to_string();
    }
    // Legacy shape 1: top-level "content" string.
    if let Some(s) = params.get("content").and_then(|v| v.as_str()) {
        return s.to_string();
    }
    // Legacy shape 2: nested "message.content" object (OpenAI message format).
    if let Some(s) = params
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
    {
        return s.to_string();
    }
    String::new()
}

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

    fn test_settings() -> Arc<Mutex<Settings>> {
        Arc::new(Mutex::new(Settings::default()))
    }

    fn empty_brain() -> Arc<Mutex<Option<AxelBrain>>> {
        Arc::new(Mutex::new(None))
    }

    /// on_message_complete with short text (< min_consolidate_len) → continue.
    #[test]
    fn before_message_passthrough_when_no_brain() {
        let params = json!({
            "kind": "before_message",
            "message": "What is Rust's borrow checker?",
        });
        let result = handle_hook(&empty_brain(), &test_settings(), "before_message", &params);
        assert_eq!(result["action"], "continue");
    }

    /// on_message_complete with short text (< min_consolidate_len) → continue.
    #[test]
    fn on_message_complete_short_text_no_brain() {
        let params = json!({ "kind": "on_message_complete", "message": "ok" });
        let result = handle_hook(&empty_brain(), &test_settings(), "on_message_complete", &params);
        assert_eq!(result["action"], "continue");
    }

    // ── consolidate RPC ───────────────────────────────────────────────────────

    /// When `dispatch` is called with method "consolidate" and brain is None,
    /// it must return `{"ok": false, "reason": "no brain"}` — no panic.
    #[test]
    fn consolidate_rpc_no_brain_returns_ok_false() {
        let result = dispatch(&empty_brain(), &test_settings(), "consolidate", &json!({}))
            .expect("dispatch must not error for consolidate method");
        assert_eq!(result["ok"], false, "expected ok=false when no brain");
        let reason = result["reason"].as_str().expect("reason field must be a string");
        assert!(!reason.is_empty(), "reason must be non-empty");
        assert_eq!(reason, "no brain");
    }
}
