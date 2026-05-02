//! Minimal JSON-RPC 2.0 extension runtime for Synaps CLI.
//!
//! The voice sidecar line-JSON protocol remains the runtime path for dictation.
//! This module exists so Synaps can load the plugin as a first-class extension
//! and query generic metadata through `info.get`.

use std::io::{self, Write};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

fn frame(payload: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(payload)?;
    let mut stdout = io::stdout().lock();
    write!(stdout, "Content-Length: {}\r\n\r\n", body.len())?;
    stdout.write_all(&body)?;
    stdout.flush()
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

pub async fn run() -> io::Result<()> {
    let mut reader = BufReader::new(tokio::io::stdin());
    while let Some(request) = read_frame(&mut reader).await? {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        match method {
            "initialize" => frame(&response(
                id,
                json!({"protocol_version": 1, "capabilities": {"tools": []}}),
            ))?,
            "info.get" => frame(&response(id, info_result()))?,
            "shutdown" => {
                frame(&response(id, Value::Null))?;
                break;
            }
            other => frame(&error(id, -32601, format!("method not found: {other}")))?,
        }
    }
    Ok(())
}
