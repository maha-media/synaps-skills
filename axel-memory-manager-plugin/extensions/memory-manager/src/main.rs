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

use serde_json::{json, Value};

use axel::AxelBrain;

const PROTOCOL_VERSION: u32 = 1;
const NAME: &str = "memory-manager";
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Importance score for memories captured automatically from chat turns.
const AUTO_IMPORTANCE: f64 = 0.5;

/// Min length (chars) of an assistant message before we bother consolidating it.
const MIN_CONSOLIDATE_LEN: usize = 80;

/// Max search results to retrieve for `before_message` recall.
const RECALL_LIMIT: usize = 5;

fn main() -> anyhow::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut out = stdout.lock();

    let brain_path = resolve_brain_path();
    let mut brain = match AxelBrain::open_or_create(&brain_path, Some("synaps")) {
        Ok(b) => Some(b),
        Err(e) => {
            eprintln!(
                "axel: failed to open brain at {}: {e} — extension will run in passthrough mode",
                brain_path.display()
            );
            None
        }
    };

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

        // Prewarm the embedding model during `initialize` so the first
        // `before_message` hook (capped at 5s by Synaps) doesn't hit a
        // model download. `initialize` has no Synaps-side timeout, so we
        // can take as long as we need (~minutes on first run for the
        // 86 MB model download; instant once cached).
        if method == "initialize" {
            if let Some(b) = brain.as_mut() {
                prewarm_brain(b);
            }
        }

        let result = dispatch(brain.as_mut(), method, &params);

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

        if method == "shutdown" {
            if let Some(b) = brain.as_mut() {
                let _ = b.flush();
            }
            break;
        }
    }

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

fn dispatch(
    brain: Option<&mut AxelBrain>,
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

        // Synaps dispatches every hook through a single "hook.handle" RPC,
        // with the actual kind in `params.kind`. The hook-kind strings are
        // never sent as method names directly.
        "hook.handle" => {
            let kind = params.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            handle_hook(brain, kind, params)
        }

        _ => anyhow::bail!("method not found: {method}"),
    })
}

fn handle_hook(brain: Option<&mut AxelBrain>, kind: &str, params: &Value) -> Value {
    match kind {
        "on_session_start" => {
            // Inject Tier-0 handoff + Tier-1 memories as a system preamble.
            if let Some(b) = brain {
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
            }
        }

        "on_session_end" => {
            if let Some(b) = brain {
                let _ = b.flush();
            }
            json!({ "action": "continue" })
        }

        "before_message" => {
            // VolciRAG contextual recall on the user's incoming message.
            let user_text = extract_text(params);
            if user_text.trim().len() < 5 {
                return json!({ "action": "continue" });
            }
            if let Some(b) = brain {
                match b.contextual_recall(&user_text, RECALL_LIMIT) {
                    Ok(ctx) if !ctx.formatted.trim().is_empty() => json!({
                        "action": "modify",
                        "content": format!("{}\n\n{}", ctx.formatted, user_text)
                    }),
                    Ok(_) => json!({ "action": "continue" }),
                    Err(e) => {
                        eprintln!("axel: contextual_recall failed: {e}");
                        json!({ "action": "continue" })
                    }
                }
            } else {
                json!({ "action": "continue" })
            }
        }

        "on_message_complete" => {
            // Lightweight online consolidation: capture the assistant turn as
            // an Events memory if it's substantial. The full Consolidation
            // pipeline (reindex → strengthen → reorganize → prune) runs on
            // session end / on a schedule, not per message.
            if let Some(b) = brain {
                let text = extract_text(params);
                if text.len() >= MIN_CONSOLIDATE_LEN {
                    if let Err(e) = b.remember(&text, "Events", AUTO_IMPORTANCE) {
                        eprintln!("axel: remember failed: {e}");
                    }
                }
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
    if let Some(s) = params.get("content").and_then(|v| v.as_str()) {
        return s.to_string();
    }
    if let Some(s) = params
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
    {
        return s.to_string();
    }
    String::new()
}
