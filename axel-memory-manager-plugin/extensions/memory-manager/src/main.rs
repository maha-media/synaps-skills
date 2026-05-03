//! Axel memory-manager extension for Synaps CLI.
//!
//! Speaks JSON-RPC 2.0 over **line-delimited** stdio (one JSON object per
//! line — the Synaps CLI extension protocol).
//!
//! Note: upstream Axel ships its own `axel extension` binary, but it speaks
//! Content-Length framed JSON-RPC (LSP-style). Synaps uses line-delimited
//! framing, so we keep our own loop here and call `AxelBrain` as a library.
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

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) if !l.trim().is_empty() => l,
            Ok(_) => continue,
            Err(e) => {
                eprintln!("axel: stdin read error: {e}");
                break;
            }
        };

        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("axel: bad JSON frame: {e}");
                continue;
            }
        };

        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = req.get("params").cloned().unwrap_or(json!({}));
        let id = req.get("id").cloned();

        let result = dispatch(brain.as_mut(), method, &params);

        if let Some(id) = id {
            let frame = match result {
                Ok(v) => json!({ "jsonrpc": "2.0", "id": id, "result": v }),
                Err(e) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32603, "message": e.to_string() }
                }),
            };
            writeln!(out, "{}", frame)?;
            out.flush()?;
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
                return Ok(json!({ "action": "continue" }));
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

        _ => anyhow::bail!("method not found: {method}"),
    })
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
