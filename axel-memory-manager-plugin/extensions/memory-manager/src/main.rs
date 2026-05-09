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
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use axel::AxelBrain;

mod enricher;
mod gliner;
mod settings;
mod timer;
use gliner::GlinerSession;
use settings::{GlinerEnabled, Settings};
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

    // GLiNER session — lazy-loaded on first chat turn that needs it (or eagerly
    // after a successful `axel download`). `attempted` guards against repeated
    // load attempts within a single plugin run; restart re-attempts.
    let gliner: Arc<Mutex<Option<GlinerSession>>> = Arc::new(Mutex::new(None));
    let gliner_load_attempted: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));

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

        let result = dispatch(&brain, &settings, &gliner, &gliner_load_attempted, method, &params);

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
    gliner: &Arc<Mutex<Option<GlinerSession>>>,
    gliner_load_attempted: &Arc<AtomicBool>,
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

        // Synaps interactive command surface — `axel help / models / download / consolidate`.
        // Mirrors `local-voice-plugin/src/extension_rpc.rs::handle_command_invoke`:
        // params is `{ command: "axel", args: [...], request_id: "..." }`.
        "command.invoke" => {
            let command = params.get("command").and_then(|v| v.as_str()).unwrap_or("");
            if command != "axel" {
                anyhow::bail!("unknown command: {command:?}");
            }
            let args: Vec<String> = params
                .get("args")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()
                })
                .unwrap_or_default();
            let sub = args.first().map(String::as_str).unwrap_or("help");
            handle_axel_command(brain, gliner, sub)
        }

        // Synaps dispatches every hook through a single "hook.handle" RPC,
        // with the actual kind in `params.kind`. The hook-kind strings are
        // never sent as method names directly.
        "hook.handle" => {
            let kind = params.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            handle_hook(brain, settings, gliner, gliner_load_attempted, kind, params)
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
    gliner: &Arc<Mutex<Option<GlinerSession>>>,
    gliner_load_attempted: &Arc<AtomicBool>,
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
            // a Memory if it's substantial. Two paths:
            //   * enrichment_trigger=Off       → legacy `remember()` (Events).
            //   * enrichment_trigger=OnComplete → heuristic + GLiNER enrichment
            //     via `remember_full(Memory)` (Track A API).
            //   * enrichment_trigger=OnSessionEnd → v1 logs once and behaves
            //     like OnComplete; batched enrichment is a follow-up.
            let text = extract_text(params);
            let (min_len, trigger) = {
                let g = settings.lock().expect("settings lock");
                (g.min_consolidate_len, g.enrichment_trigger)
            };
            if text.len() >= min_len {
                // Lazy-load GLiNER on first qualifying turn so the heuristic
                // enricher can be promoted to entity-aware extraction.
                {
                    let s = settings.lock().expect("settings lock");
                    ensure_gliner(gliner, gliner_load_attempted, &s);
                }
                let mut g = brain.lock().expect("brain lock");
                if let Some(b) = g.as_mut() {
                    if let Err(e) = remember_with_trigger(b, &text, trigger, gliner) {
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

/// Apply a chat-turn `text` to the brain via the path selected by the user's
/// `enrichment_trigger` setting:
///
///   * `Off` — legacy `remember()` (single Events row).
///   * `OnComplete` — heuristic + (lazy) GLiNER enrichment, persisted via
///     `remember_full(Memory)` (Track A API).
///   * `OnSessionEnd` — same as `OnComplete` in v1 (batched enrichment is a
///     planned follow-up; we log a one-shot warning on first hit and use the
///     same path).
fn remember_with_trigger(
    brain: &mut AxelBrain,
    text: &str,
    trigger: settings::EnrichmentTrigger,
    gliner: &Arc<Mutex<Option<GlinerSession>>>,
) -> anyhow::Result<()> {
    use settings::EnrichmentTrigger;
    match trigger {
        EnrichmentTrigger::Off => {
            brain.remember(text, "Events", AUTO_IMPORTANCE)?;
        }
        EnrichmentTrigger::OnSessionEnd => {
            log_session_end_stub_once();
            // Fall through to OnComplete behaviour.
            remember_enriched(brain, text, gliner)?;
        }
        EnrichmentTrigger::OnComplete => {
            remember_enriched(brain, text, gliner)?;
        }
    }
    Ok(())
}

fn log_session_end_stub_once() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static LOGGED: AtomicBool = AtomicBool::new(false);
    if !LOGGED.swap(true, Ordering::Relaxed) {
        eprintln!(
            "axel: WARN enrichment_trigger=on_session_end batched enrichment \
             not yet implemented; falling back to per-turn (on_complete) behaviour"
        );
    }
}

/// Enrich `text` with the heuristic enricher (and GLiNER if loaded), build a
/// `Memory`, then persist via Track A's `remember_full`.
///
/// `axel_memkoshi::pipeline::ValidationStage` enforces:
///   * `content.chars().count() >= 50`
///   * `title.chars().count() >= 10`
///   * `topic.chars().count() >= 5`
///   * `importance` in `[0.0, 1.0]`
///
/// Short content is dropped (returns Ok with a stderr log). Short title /
/// topic are amended into compliance via [`amend_to_validation_min`] so a
/// well-classified turn isn't lost to a trivially-short title or a single-word
/// GLiNER span.
fn remember_enriched(
    brain: &mut AxelBrain,
    text: &str,
    gliner: &Arc<Mutex<Option<GlinerSession>>>,
) -> anyhow::Result<()> {
    use axel_memkoshi::memory::{Memory, MemoryCategory};

    // Skip turns shorter than axel's content minimum. The plugin's
    // `min_consolidate_len` setting can be lower than 50 (heuristic-only
    // enrichment of short turns is still useful for tag extraction tests),
    // but the brain itself rejects short content — drop without writing.
    if text.chars().count() < 50 {
        eprintln!(
            "axel: remember: skipping turn ({} chars < 50, axel content min)",
            text.chars().count()
        );
        return Ok(());
    }

    // Hold the GLiNER lock only for the duration of the enrich() call —
    // brain I/O happens after the guard is dropped.
    let g = gliner.lock().expect("gliner lock");
    let patch = enricher::enrich(text, g.as_ref());
    drop(g);
    let category = patch.category.unwrap_or(MemoryCategory::Events);
    let topic_raw = patch.topic.clone().unwrap_or_else(|| category.as_str().to_string());
    let title_raw = patch
        .title
        .clone()
        .unwrap_or_else(|| text.lines().next().unwrap_or(text).chars().take(80).collect());
    let (title, topic) = amend_to_validation_min(&title_raw, &topic_raw, category);

    let mut memory = Memory::new(category, topic, title, text);
    apply_patch_to_memory(&mut memory, patch);
    // Re-amend after apply_patch — apply_patch_to_memory may overwrite topic
    // with a still-short patch.topic (now filtered upstream by enricher, but
    // belt-and-braces), and won't touch title.
    if memory.topic.chars().count() < 5 {
        memory.topic = category.as_str().to_string();
    }
    if memory.title.chars().count() < 10 {
        memory.title = format!("{}: {}", category.as_str(), memory.title);
    }
    let _ = brain.remember_full(memory)?;
    Ok(())
}

/// Bring `(title, topic)` up to axel's `>= 10` / `>= 5` minimums while
/// preserving as much of the heuristic/GLiNER output as possible. Padding
/// uses the `category` label since that's the most semantically meaningful
/// fallback.
fn amend_to_validation_min(
    title: &str,
    topic: &str,
    category: axel_memkoshi::memory::MemoryCategory,
) -> (String, String) {
    let cat_str = category.as_str();
    let title_out = if title.chars().count() >= 10 {
        title.to_string()
    } else if title.is_empty() {
        // Fallback: "<Category> note" padded to >= 10.
        let mut s = format!("{cat_str} note");
        while s.chars().count() < 10 {
            s.push('.');
        }
        s
    } else {
        // Prefix with category; pad with periods if still short.
        let mut s = format!("{cat_str}: {title}");
        while s.chars().count() < 10 {
            s.push('.');
        }
        s
    };
    let topic_out = if topic.chars().count() >= 5 {
        topic.to_string()
    } else {
        // Pad with category — axel categories ("events", "cases", "entities",
        // "preferences") are all >= 5 chars so this always satisfies.
        cat_str.to_string()
    };
    (title_out, topic_out)
}

/// Apply the optional fields of a `MemoryPatch` to a freshly-constructed
/// `Memory`. Mirrors the shape of `AxelBrain::update_memory_full` but for the
/// "create new" path.
fn apply_patch_to_memory(m: &mut axel_memkoshi::memory::Memory, p: axel::MemoryPatch) {
    if let Some(c) = p.category { m.category = c; }
    if let Some(t) = p.topic { m.topic = t; }
    if let Some(t) = p.title { m.title = t; }
    if let Some(a) = p.abstract_text { m.abstract_text = a; }
    if let Some(c) = p.content { m.content = c; }
    if let Some(c) = p.confidence { m.confidence = c; }
    if let Some(i) = p.importance { m.importance = i.clamp(0.0, 1.0); }
    if let Some(t) = p.tags { m.tags = t; }
    if let Some(r) = p.related_topics { m.related_topics = r; }
    if let Some(s) = p.source_sessions { m.source_sessions = s; }
    if let Some(t) = p.trust_level { m.trust_level = t.clamp(0.0, 1.0); }
    if let Some(e) = p.expires_at { m.expires_at = e; }
}

/// Handle `axel <subcommand>` dispatched via `command.invoke`.
///
/// Subcommands:
///   * `help` — usage text.
///   * `models` — list cached models with sizes (`~/.cache/velocirag/models/`).
///   * `download` — eagerly fetch the GLiNER model so first chat turn doesn't pay the wait.
///   * `consolidate` — invoke the existing `consolidate` RPC for parity with the bg timer.
fn handle_axel_command(
    brain: &Arc<Mutex<Option<AxelBrain>>>,
    gliner: &Arc<Mutex<Option<GlinerSession>>>,
    sub: &str,
) -> Value {
    match sub {
        "help" | "" => {
            let text = "axel — Synaps memory & enrichment helper\n\n\
                Usage: axel <subcommand>\n\n\
                Subcommands:\n  \
                help          Show this help.\n  \
                models        List cached models in $XDG_CACHE_HOME/velocirag/models/.\n  \
                download      Eagerly download the GLiNER model (~165 MB) so the\n                first chat turn doesn't block.\n  \
                consolidate   Run a consolidation pass (reindex → strengthen → prune).";
            json!({ "ok": true, "output": text })
        }
        "models" => {
            let dir = velocirag::download::models_cache_dir();
            let mut entries: Vec<Value> = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for e in rd.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    let size = dir_size_bytes(&e.path()).unwrap_or(0);
                    entries.push(json!({ "name": name, "size_bytes": size }));
                }
            }
            json!({
                "ok": true,
                "cache_dir": dir.display().to_string(),
                "models": entries,
            })
        }
        "download" => {
            let started = std::time::Instant::now();
            eprintln!("axel: download: ensuring GLiNER small model is cached");
            match velocirag::download::ensure_model(&gliner::GLINER_SMALL_SPEC) {
                Ok(p) => {
                    let elapsed = started.elapsed().as_secs_f32();
                    eprintln!("axel: download: ready at {} ({:.1}s)", p.display(), elapsed);
                    // Eagerly load so the freshly-downloaded model is usable
                    // in the same plugin session without a restart.
                    match GlinerSession::load(&p) {
                        Ok(s) => {
                            *gliner.lock().expect("gliner lock") = Some(s);
                            eprintln!("axel: gliner: loaded after download");
                        }
                        Err(e) => {
                            eprintln!(
                                "axel: gliner: post-download load failed: {e} \
                                 — next session will retry"
                            );
                        }
                    }
                    json!({ "ok": true, "path": p.display().to_string(), "elapsed_secs": elapsed })
                }
                Err(e) => {
                    eprintln!("axel: download: failed: {e}");
                    json!({ "ok": false, "error": e.to_string() })
                }
            }
        }
        "consolidate" => {
            let mut g = brain.lock().expect("brain lock");
            let result = if let Some(b) = g.as_mut() {
                let stats = run_consolidation(b, "axel_command");
                json!({ "ok": true, "stats": stats })
            } else {
                json!({ "ok": false, "reason": "no brain" })
            };
            drop(g);
            result
        }
        other => json!({
            "ok": false,
            "error": format!("unknown subcommand: {other:?}; try `axel help`")
        }),
    }
}

/// Best-effort recursive size of a directory, in bytes.
fn dir_size_bytes(path: &std::path::Path) -> std::io::Result<u64> {
    let mut total = 0u64;
    if path.is_file() {
        return Ok(path.metadata()?.len());
    }
    for e in std::fs::read_dir(path)? {
        let e = e?;
        let m = e.metadata()?;
        total += if m.is_dir() {
            dir_size_bytes(&e.path()).unwrap_or(0)
        } else {
            m.len()
        };
    }
    Ok(total)
}

/// Resolve the directory we expect the GLiNER model to live in.
///
/// `$AXEL_GLINER_MODEL_DIR` wins (used by tests + power users); otherwise we
/// fall back to velocirag's standard cache layout
/// (`$XDG_CACHE_HOME/velocirag/models/gliner-small-v2.1`, which honours
/// `$HOME` via the `dirs` crate on Linux).
fn gliner_model_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("AXEL_GLINER_MODEL_DIR") {
        return PathBuf::from(p);
    }
    velocirag::download::models_cache_dir().join(gliner::GLINER_SMALL_SPEC.local_dir)
}

/// Are the two ONNX/tokenizer files required by `GlinerSession::load`
/// present in `dir`?
fn gliner_model_cached(dir: &Path) -> bool {
    dir.join("onnx/model.onnx").is_file() && dir.join("tokenizer.json").is_file()
}

/// One-shot lazy load. Sets `attempted=true` regardless of outcome and logs
/// to stderr only. **Refuses to download** — if the model isn't cached, we
/// log a hint pointing at `axel download` and stay in heuristic-only mode.
///
/// Idempotent: subsequent calls within the same plugin run early-return on
/// the `attempted` flag. A plugin restart is required to re-attempt (e.g.
/// after the user runs `axel download`).
fn ensure_gliner(
    gliner: &Arc<Mutex<Option<GlinerSession>>>,
    attempted: &AtomicBool,
    settings: &Settings,
) {
    if attempted.load(Ordering::Relaxed) {
        return;
    }
    if !matches!(settings.gliner_enabled, GlinerEnabled::On) {
        eprintln!("axel: gliner: disabled by setting (gliner_enabled=off); skipping load");
        attempted.store(true, Ordering::Relaxed);
        return;
    }
    let model_dir = gliner_model_dir();
    if !gliner_model_cached(&model_dir) {
        eprintln!(
            "axel: gliner: model not cached at {} — run `axel download` to enable entity enrichment",
            model_dir.display()
        );
        attempted.store(true, Ordering::Relaxed);
        return;
    }
    let started = std::time::Instant::now();
    eprintln!("axel: gliner: lazy-loading from {}", model_dir.display());
    match GlinerSession::load(&model_dir) {
        Ok(s) => {
            *gliner.lock().expect("gliner lock") = Some(s);
            eprintln!(
                "axel: gliner: loaded in {:.1}s",
                started.elapsed().as_secs_f32()
            );
        }
        Err(e) => {
            eprintln!("axel: gliner: load failed: {e}");
        }
    }
    attempted.store(true, Ordering::Relaxed);
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

    fn empty_gliner() -> Arc<Mutex<Option<GlinerSession>>> {
        Arc::new(Mutex::new(None))
    }

    fn fresh_attempted() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    /// on_message_complete with short text (< min_consolidate_len) → continue.
    #[test]
    fn before_message_passthrough_when_no_brain() {
        let params = json!({
            "kind": "before_message",
            "message": "What is Rust's borrow checker?",
        });
        let result = handle_hook(
            &empty_brain(),
            &test_settings(),
            &empty_gliner(),
            &fresh_attempted(),
            "before_message",
            &params,
        );
        assert_eq!(result["action"], "continue");
    }

    /// on_message_complete with short text (< min_consolidate_len) → continue.
    #[test]
    fn on_message_complete_short_text_no_brain() {
        let params = json!({ "kind": "on_message_complete", "message": "ok" });
        let result = handle_hook(
            &empty_brain(),
            &test_settings(),
            &empty_gliner(),
            &fresh_attempted(),
            "on_message_complete",
            &params,
        );
        assert_eq!(result["action"], "continue");
    }

    // ── consolidate RPC ───────────────────────────────────────────────────────

    /// When `dispatch` is called with method "consolidate" and brain is None,
    /// it must return `{"ok": false, "reason": "no brain"}` — no panic.
    #[test]
    fn consolidate_rpc_no_brain_returns_ok_false() {
        let result = dispatch(
            &empty_brain(),
            &test_settings(),
            &empty_gliner(),
            &fresh_attempted(),
            "consolidate",
            &json!({}),
        )
        .expect("dispatch must not error for consolidate method");
        assert_eq!(result["ok"], false, "expected ok=false when no brain");
        let reason = result["reason"].as_str().expect("reason field must be a string");
        assert!(!reason.is_empty(), "reason must be non-empty");
        assert_eq!(reason, "no brain");
    }

    // ── ensure_gliner lazy-load ───────────────────────────────────────────────

    /// `gliner_enabled=Off` must short-circuit: no load attempt, but the
    /// `attempted` flag still flips so we don't poll the disk every turn.
    #[test]
    fn ensure_gliner_skips_when_disabled() {
        let mut s = Settings::default();
        s.gliner_enabled = GlinerEnabled::Off;
        let gliner = empty_gliner();
        let attempted = fresh_attempted();

        ensure_gliner(&gliner, &attempted, &s);

        assert!(gliner.lock().unwrap().is_none(), "no session should be loaded when disabled");
        assert!(attempted.load(Ordering::Relaxed), "attempted must be set even when disabled");
    }

    /// When the model files aren't cached on disk we must log a hint and
    /// stay in heuristic-only mode (gliner=None, attempted=true).
    #[test]
    fn ensure_gliner_skips_when_model_not_cached() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        // Point the helper at an empty dir via the env override hook.
        std::env::set_var("AXEL_GLINER_MODEL_DIR", tmp.path().join("nope-not-here"));
        let s = Settings::default(); // gliner_enabled defaults to On
        let gliner = empty_gliner();
        let attempted = fresh_attempted();

        ensure_gliner(&gliner, &attempted, &s);

        assert!(gliner.lock().unwrap().is_none(), "no session when files missing");
        assert!(attempted.load(Ordering::Relaxed), "attempted must be set");
        std::env::remove_var("AXEL_GLINER_MODEL_DIR");
    }

    /// Calling `ensure_gliner` twice must not double-log or re-attempt the
    /// load. The early return on `attempted` is the contract.
    #[test]
    fn ensure_gliner_idempotent_on_second_call() {
        let mut s = Settings::default();
        s.gliner_enabled = GlinerEnabled::Off;
        let gliner = empty_gliner();
        let attempted = fresh_attempted();

        ensure_gliner(&gliner, &attempted, &s);
        ensure_gliner(&gliner, &attempted, &s);

        assert!(gliner.lock().unwrap().is_none());
        assert!(attempted.load(Ordering::Relaxed));
    }

    // ── amend_to_validation_min ────────────────────────────────────────────
    //
    // axel_memkoshi::pipeline::ValidationStage requires:
    //   * topic.chars().count() >= 5
    //   * title.chars().count() >= 10
    //
    // amend_to_validation_min must always return strings satisfying those
    // bounds for any input + valid MemoryCategory.

    use axel_memkoshi::memory::MemoryCategory;

    #[test]
    fn amend_passes_through_long_enough() {
        let (t, p) = amend_to_validation_min(
            "Discussed Rust ownership rules",
            "Rust ownership",
            MemoryCategory::Events,
        );
        assert_eq!(t, "Discussed Rust ownership rules");
        assert_eq!(p, "Rust ownership");
    }

    #[test]
    fn amend_pads_short_topic_with_category() {
        // GLiNER returned a 4-char span ("Rust") — should be replaced by
        // the category string ("events" = 6 chars >= 5).
        let (_t, p) =
            amend_to_validation_min("A long enough title here", "Rust", MemoryCategory::Events);
        assert_eq!(p, "events");
        assert!(p.chars().count() >= 5);
    }

    #[test]
    fn amend_prefixes_short_title_with_category() {
        let (t, _p) = amend_to_validation_min("OK", "valid topic", MemoryCategory::Cases);
        assert!(t.chars().count() >= 10, "title was {t:?}");
        assert!(t.contains("OK"));
        assert!(t.starts_with("cases"));
    }

    #[test]
    fn amend_handles_empty_title() {
        let (t, _p) = amend_to_validation_min("", "valid topic", MemoryCategory::Preferences);
        assert!(t.chars().count() >= 10, "title was {t:?}");
    }

    #[test]
    fn amend_works_for_all_categories() {
        for cat in [
            MemoryCategory::Events,
            MemoryCategory::Cases,
            MemoryCategory::Entities,
            MemoryCategory::Preferences,
        ] {
            let (t, p) = amend_to_validation_min("x", "y", cat);
            assert!(
                t.chars().count() >= 10,
                "title for {:?} was {t:?}",
                cat.as_str()
            );
            assert!(
                p.chars().count() >= 5,
                "topic for {:?} was {p:?}",
                cat.as_str()
            );
        }
    }
}
