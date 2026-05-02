//! Minimal JSON-RPC 2.0 extension runtime for Synaps CLI.
//!
//! The voice sidecar line-JSON protocol remains the runtime path for dictation.
//! This module exposes the plugin to Synaps as a first-class extension and
//! implements the Phase 2/3 surface (`command.invoke` plus streaming
//! `command.output` / `task.*` notifications).

use std::io::{self, Write};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

use crate::commands::{self, FrameSink};

fn frame(payload: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(payload)?;
    let mut stdout = io::stdout().lock();
    write!(stdout, "Content-Length: {}\r\n\r\n", body.len())?;
    stdout.write_all(&body)?;
    stdout.flush()
}

struct StdoutSink;

impl FrameSink for StdoutSink {
    fn send(&mut self, payload: &Value) -> io::Result<()> {
        frame(payload)
    }
}

fn response(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

fn info_result() -> Value {
    let build = crate::build_info::current();
    json!({
        "build": build,
        "capabilities": [
            {"kind": "voice", "name": "Local Whisper STT", "modes": ["stt"]},
            {"kind": "models", "name": "Whisper model manager"},
            {"kind": "backend", "name": "Whisper backend rebuild"}
        ],
        "models": [
            {"id": "ggml-tiny.en.bin", "display_name": "Tiny English", "installed": false},
            {"id": "ggml-base.en.bin", "display_name": "Base English", "installed": false},
            {"id": "ggml-small.en.bin", "display_name": "Small English", "installed": false},
            {"id": "ggml-medium.en.bin", "display_name": "Medium English", "installed": false}
        ]
    })
}

fn initialize_result() -> Value {
    // Keep the existing `protocol_version` and `capabilities.tools` shape so
    // downstream consumers (and tests) that only check those fields keep
    // working. Additionally advertise interactive capabilities for Phase 2/3.
    json!({
        "protocol_version": 1,
        "capabilities": {
            "tools": [],
            "commands": ["voice"],
            "tasks": true,
            "command_output": true,
        }
    })
}

async fn read_frame(reader: &mut BufReader<tokio::io::Stdin>) -> io::Result<Option<Value>> {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Ok(None);
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = Some(value.trim().parse::<usize>().map_err(|err| {
                    io::Error::new(io::ErrorKind::InvalidData, format!("invalid Content-Length: {err}"))
                })?);
            }
        }
    }
    let len = content_length.ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "missing Content-Length header")
    })?;
    let mut buf = vec![0; len];
    reader.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf)
        .map(Some)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

fn handle_command_invoke(id: Value, params: &Value) -> io::Result<Value> {
    let command = params.get("command").and_then(Value::as_str).unwrap_or("");
    if command.is_empty() {
        return Ok(error(id, -32602, "command.invoke requires `command`"));
    }
    let request_id = params
        .get("request_id")
        .cloned()
        .unwrap_or_else(|| id.clone());
    let args: Vec<String> = params
        .get("args")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let mut sink = StdoutSink;
    let outcome = commands::handle_command_invoke(&mut sink, command, &args, &request_id)?;
    Ok(response(id, outcome.result))
}

pub async fn run() -> io::Result<()> {
    let mut reader = BufReader::new(tokio::io::stdin());
    while let Some(request) = read_frame(&mut reader).await? {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        match method {
            "initialize" => frame(&response(id, initialize_result()))?,
            "info.get" => frame(&response(id, info_result()))?,
            "command.invoke" => {
                let reply = handle_command_invoke(id, &params)?;
                frame(&reply)?;
            }
            "shutdown" => {
                frame(&response(id, Value::Null))?;
                break;
            }
            other => frame(&error(id, -32601, format!("method not found: {other}")))?,
        }
    }
    Ok(())
}
