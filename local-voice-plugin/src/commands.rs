//! Phase 2/3 command and task handling for the voice plugin.
//!
//! Implements the `command.invoke` request and corresponding
//! `command.output` / `task.*` notifications used by Synaps CLI to drive
//! interactive plugin commands.
//!
//! Notifications are written through a caller-supplied frame sink so the
//! same logic can be exercised from unit tests without spawning the
//! plugin process. Long-running side effects (model downloads, backend
//! rebuilds) are mocked out by default; setting `SYNAPS_VOICE_REAL_TASKS=1`
//! at runtime is reserved for real behaviour but is currently treated as a
//! controlled error so default tests remain deterministic.

use serde_json::{json, Value};

use crate::build_info;

/// Trait implemented by anything that can receive an outgoing JSON-RPC
/// frame (request response or notification body).
pub trait FrameSink {
    fn send(&mut self, payload: &Value) -> std::io::Result<()>;
}

fn notify(method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "method": method, "params": params})
}

fn output(request_id: &Value, event: Value) -> Value {
    notify(
        "command.output",
        json!({"request_id": request_id, "event": event}),
    )
}

fn task_event(method: &str, request_id: &Value, task_id: &str, body: Value) -> Value {
    let mut params = json!({"request_id": request_id, "task_id": task_id});
    if let Value::Object(extra) = body {
        for (k, v) in extra {
            params[k] = v;
        }
    }
    notify(method, params)
}

/// Static catalog of models the plugin knows about. Mirrors `info.get`
/// but with a richer description used by `voice models`.
pub fn known_models() -> Vec<Value> {
    vec![
        json!({"id": "ggml-tiny.en.bin",   "display_name": "Tiny English",   "size_mb":  75, "installed": false}),
        json!({"id": "ggml-base.en.bin",   "display_name": "Base English",   "size_mb": 142, "installed": false}),
        json!({"id": "ggml-small.en.bin",  "display_name": "Small English",  "size_mb": 466, "installed": false}),
        json!({"id": "ggml-medium.en.bin", "display_name": "Medium English", "size_mb": 1500, "installed": false}),
    ]
}

/// Supported rebuild backends.
pub fn known_backends() -> Vec<&'static str> {
    vec!["cpu", "cuda", "metal", "vulkan", "openblas"]
}

/// Result returned to the request `id` after streaming notifications.
pub struct CommandResult {
    pub result: Value,
}

/// Top-level entry: dispatch a `command.invoke` for `voice`.
///
/// `command_name` is the top-level command (we currently only accept
/// `"voice"`). `args` is the positional argv after the command. Streams
/// notifications through `sink` and returns the JSON-RPC `result` value
/// to send back as the response.
pub fn handle_command_invoke<S: FrameSink>(
    sink: &mut S,
    command_name: &str,
    args: &[String],
    request_id: &Value,
) -> std::io::Result<CommandResult> {
    if command_name != "voice" {
        return Ok(CommandResult {
            result: json!({"ok": false, "error": format!("unknown command: {command_name}")}),
        });
    }

    let sub = args.first().map(String::as_str).unwrap_or("help");
    let rest = if args.is_empty() { &[][..] } else { &args[1..] };

    match sub {
        "help" => run_help(sink, request_id),
        "models" => run_models(sink, request_id),
        "download" => run_download(sink, request_id, rest),
        "rebuild" => run_rebuild(sink, request_id, rest),
        other => {
            sink.send(&output(
                request_id,
                json!({"kind": "text", "text": format!("unknown subcommand: {other}")}),
            ))?;
            sink.send(&output(request_id, json!({"kind": "done"})))?;
            Ok(CommandResult {
                result: json!({"ok": false, "error": format!("unknown subcommand: {other}")}),
            })
        }
    }
}

fn run_help<S: FrameSink>(sink: &mut S, request_id: &Value) -> std::io::Result<CommandResult> {
    let lines = [
        "voice help                 — show this help",
        "voice models               — list available Whisper models",
        "voice download <model-id>  — download a Whisper model",
        "voice rebuild <backend>    — rebuild the sidecar against a backend (cpu|cuda|metal|vulkan|openblas)",
    ];
    for line in lines {
        sink.send(&output(request_id, json!({"kind": "text", "text": line})))?;
    }
    sink.send(&output(request_id, json!({"kind": "done"})))?;
    Ok(CommandResult { result: json!({"ok": true}) })
}

fn run_models<S: FrameSink>(sink: &mut S, request_id: &Value) -> std::io::Result<CommandResult> {
    let models = known_models();
    let columns = json!(["id", "display_name", "size_mb", "installed"]);
    let rows: Vec<Value> = models
        .iter()
        .map(|m| {
            json!([
                m["id"], m["display_name"], m["size_mb"], m["installed"],
            ])
        })
        .collect();
    sink.send(&output(
        request_id,
        json!({"kind": "table", "columns": columns, "rows": rows}),
    ))?;
    sink.send(&output(request_id, json!({"kind": "done"})))?;
    Ok(CommandResult {
        result: json!({"ok": true, "models": models}),
    })
}

fn run_download<S: FrameSink>(
    sink: &mut S,
    request_id: &Value,
    rest: &[String],
) -> std::io::Result<CommandResult> {
    let Some(model_id) = rest.first().cloned() else {
        sink.send(&output(
            request_id,
            json!({"kind": "text", "text": "usage: voice download <model-id>"}),
        ))?;
        sink.send(&output(request_id, json!({"kind": "done"})))?;
        return Ok(CommandResult {
            result: json!({"ok": false, "error": "missing model id"}),
        });
    };
    let known = known_models();
    if !known.iter().any(|m| m["id"] == Value::String(model_id.clone())) {
        sink.send(&output(
            request_id,
            json!({"kind": "text", "text": format!("unknown model: {model_id}")}),
        ))?;
        sink.send(&output(request_id, json!({"kind": "done"})))?;
        return Ok(CommandResult {
            result: json!({"ok": false, "error": format!("unknown model: {model_id}")}),
        });
    }

    let task_id = format!("download-{model_id}");
    let label = format!("Downloading {model_id}");
    sink.send(&task_event(
        "task.start",
        request_id,
        &task_id,
        json!({"label": label, "kind": "download"}),
    ))?;

    let mock = std::env::var("SYNAPS_VOICE_REAL_TASKS").ok().as_deref() != Some("1");
    if mock {
        // Deterministic mock: emit a couple of progress updates and a log line.
        for pct in [0u32, 50, 100] {
            sink.send(&task_event(
                "task.update",
                request_id,
                &task_id,
                json!({"progress": pct, "message": format!("{pct}% downloaded")}),
            ))?;
        }
        sink.send(&task_event(
            "task.log",
            request_id,
            &task_id,
            json!({"stream": "stdout", "line": format!("[mock] would download {model_id}")}),
        ))?;
        sink.send(&task_event(
            "task.done",
            request_id,
            &task_id,
            json!({"ok": true, "summary": "mocked"}),
        ))?;
        sink.send(&output(
            request_id,
            json!({"kind": "text", "text": format!("Downloaded (mock): {model_id}")}),
        ))?;
        sink.send(&output(request_id, json!({"kind": "done"})))?;
        return Ok(CommandResult {
            result: json!({"ok": true, "model_id": model_id, "task_id": task_id, "mock": true}),
        });
    }

    // Real downloads are not implemented in this phase.
    sink.send(&task_event(
        "task.done",
        request_id,
        &task_id,
        json!({"ok": false, "error": "real downloads not implemented"}),
    ))?;
    sink.send(&output(request_id, json!({"kind": "done"})))?;
    Ok(CommandResult {
        result: json!({"ok": false, "error": "real downloads not implemented"}),
    })
}

fn run_rebuild<S: FrameSink>(
    sink: &mut S,
    request_id: &Value,
    rest: &[String],
) -> std::io::Result<CommandResult> {
    let Some(backend) = rest.first().cloned() else {
        sink.send(&output(
            request_id,
            json!({"kind": "text", "text": "usage: voice rebuild <backend>"}),
        ))?;
        sink.send(&output(request_id, json!({"kind": "done"})))?;
        return Ok(CommandResult {
            result: json!({"ok": false, "error": "missing backend"}),
        });
    };
    if !known_backends().iter().any(|b| *b == backend.as_str()) {
        sink.send(&output(
            request_id,
            json!({"kind": "text", "text": format!("unknown backend: {backend}")}),
        ))?;
        sink.send(&output(request_id, json!({"kind": "done"})))?;
        return Ok(CommandResult {
            result: json!({"ok": false, "error": format!("unknown backend: {backend}")}),
        });
    }

    let task_id = format!("rebuild-{backend}");
    let label = format!("Rebuilding voice plugin with backend={backend}");
    sink.send(&task_event(
        "task.start",
        request_id,
        &task_id,
        json!({"label": label, "kind": "rebuild"}),
    ))?;

    let mock = std::env::var("SYNAPS_VOICE_REAL_TASKS").ok().as_deref() != Some("1");
    if mock {
        for (pct, message) in [
            (0u32, "scheduling cargo build"),
            (50, "compiling whisper-rs"),
            (100, "linked sidecar binary"),
        ] {
            sink.send(&task_event(
                "task.update",
                request_id,
                &task_id,
                json!({"progress": pct, "message": message}),
            ))?;
        }
        sink.send(&task_event(
            "task.log",
            request_id,
            &task_id,
            json!({"stream": "stdout", "line": format!("[mock] would invoke: cargo build --release --features {backend}")}),
        ))?;
        let current = build_info::current();
        sink.send(&task_event(
            "task.done",
            request_id,
            &task_id,
            json!({"ok": true, "summary": "mocked", "current_backend": current.backend}),
        ))?;
        sink.send(&output(
            request_id,
            json!({"kind": "text", "text": format!("Rebuild (mock) done: {backend}")}),
        ))?;
        sink.send(&output(request_id, json!({"kind": "done"})))?;
        return Ok(CommandResult {
            result: json!({"ok": true, "backend": backend, "task_id": task_id, "mock": true}),
        });
    }

    sink.send(&task_event(
        "task.done",
        request_id,
        &task_id,
        json!({"ok": false, "error": "real rebuilds not implemented"}),
    ))?;
    sink.send(&output(request_id, json!({"kind": "done"})))?;
    Ok(CommandResult {
        result: json!({"ok": false, "error": "real rebuilds not implemented"}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct VecSink(Vec<Value>);
    impl FrameSink for VecSink {
        fn send(&mut self, payload: &Value) -> std::io::Result<()> {
            self.0.push(payload.clone());
            Ok(())
        }
    }

    fn methods(sink: &VecSink) -> Vec<&str> {
        sink.0.iter().map(|v| v["method"].as_str().unwrap_or("")).collect()
    }

    #[test]
    fn help_streams_text_then_done() {
        let mut sink = VecSink::default();
        let id = json!(7);
        let res = handle_command_invoke(&mut sink, "voice", &["help".into()], &id).unwrap();
        assert_eq!(res.result, json!({"ok": true}));
        let ms = methods(&sink);
        assert!(ms.iter().all(|m| *m == "command.output"), "{ms:?}");
        // last must be done
        let last = sink.0.last().unwrap();
        assert_eq!(last["params"]["event"]["kind"], "done");
        assert_eq!(last["params"]["request_id"], id);
        // must contain at least one text line
        assert!(sink.0.iter().any(|v| v["params"]["event"]["kind"] == "text"));
    }

    #[test]
    fn models_streams_table_then_done() {
        let mut sink = VecSink::default();
        let res = handle_command_invoke(&mut sink, "voice", &["models".into()], &json!(1)).unwrap();
        assert_eq!(res.result["ok"], true);
        let kinds: Vec<&str> = sink
            .0
            .iter()
            .map(|v| v["params"]["event"]["kind"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(kinds, vec!["table", "done"]);
        let table = &sink.0[0]["params"]["event"];
        assert_eq!(table["columns"][0], "id");
        assert!(table["rows"].as_array().unwrap().len() >= 4);
    }

    #[test]
    fn download_emits_task_lifecycle() {
        let mut sink = VecSink::default();
        let res = handle_command_invoke(
            &mut sink,
            "voice",
            &["download".into(), "ggml-tiny.en.bin".into()],
            &json!(2),
        )
        .unwrap();
        assert_eq!(res.result["ok"], true);
        let ms = methods(&sink);
        assert_eq!(ms.first().copied(), Some("task.start"));
        assert!(ms.iter().any(|m| *m == "task.update"));
        assert!(ms.iter().any(|m| *m == "task.log"));
        assert!(ms.iter().any(|m| *m == "task.done"));
        assert_eq!(ms.last().copied(), Some("command.output"));
    }

    #[test]
    fn download_unknown_model_fails() {
        let mut sink = VecSink::default();
        let res = handle_command_invoke(
            &mut sink,
            "voice",
            &["download".into(), "nope".into()],
            &json!(3),
        )
        .unwrap();
        assert_eq!(res.result["ok"], false);
    }

    #[test]
    fn rebuild_mock_lifecycle() {
        let mut sink = VecSink::default();
        let res = handle_command_invoke(
            &mut sink,
            "voice",
            &["rebuild".into(), "cpu".into()],
            &json!(4),
        )
        .unwrap();
        assert_eq!(res.result["ok"], true);
        let ms = methods(&sink);
        assert_eq!(ms.first().copied(), Some("task.start"));
        assert!(ms.iter().any(|m| *m == "task.done"));
    }

    #[test]
    fn rebuild_unknown_backend() {
        let mut sink = VecSink::default();
        let res = handle_command_invoke(
            &mut sink,
            "voice",
            &["rebuild".into(), "wat".into()],
            &json!(5),
        )
        .unwrap();
        assert_eq!(res.result["ok"], false);
    }

    #[test]
    fn unknown_top_level_command() {
        let mut sink = VecSink::default();
        let res = handle_command_invoke(&mut sink, "other", &[], &json!(6)).unwrap();
        assert_eq!(res.result["ok"], false);
    }
}
