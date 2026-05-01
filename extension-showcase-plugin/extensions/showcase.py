#!/usr/bin/env python3
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

CONFIG = {
    "response_prefix": "showcase",
    "notes_file": "memory/extension-showcase.jsonl",
}
PLUGIN_ID = "extension-showcase"


def read_frame():
    content_length = None
    while True:
        line = sys.stdin.buffer.readline()
        if line == b"":
            return None
        if line in (b"\r\n", b"\n"):
            break
        name, _, value = line.decode("ascii").partition(":")
        if name.lower() == "content-length":
            content_length = int(value.strip())
    if content_length is None:
        raise RuntimeError("missing Content-Length")
    return json.loads(sys.stdin.buffer.read(content_length).decode("utf-8"))


def write_frame(request, result=None, error=None):
    payload = {"jsonrpc": "2.0", "id": request.get("id")}
    if error is None:
        payload["result"] = result
    else:
        payload["error"] = error
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body)
    sys.stdout.buffer.flush()


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def synaps_base_dir():
    configured = os.environ.get("SYNAPS_BASE_DIR")
    if configured:
        return Path(configured)
    return Path.home() / ".synaps-cli"


def notes_path():
    configured = str(CONFIG.get("notes_file") or "memory/extension-showcase.jsonl")
    path = Path(configured)
    if path.is_absolute():
        return path
    return synaps_base_dir() / path


def append_record(kind, payload):
    path = notes_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "schema_version": 1,
        "timestamp": now(),
        "plugin": PLUGIN_ID,
        "kind": kind,
        **payload,
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    return record


def content_to_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts)
    return ""


def last_user_text(messages):
    for message in reversed(messages or []):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        text = content_to_text(message.get("content"))
        if text:
            return text
    return ""


def initialize(request):
    global CONFIG
    params = request.get("params") or {}
    incoming = params.get("config") or {}
    if isinstance(incoming, dict):
        CONFIG = {**CONFIG, **incoming}
    return {
        "protocol_version": 1,
        "capabilities": {
            "tools": [
                {
                    "name": "showcase_note",
                    "description": "Append a local JSONL note from the extension showcase plugin.",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "note": {
                                "type": "string",
                                "description": "Note text to record locally."
                            },
                            "tag": {
                                "type": "string",
                                "description": "Optional short tag for the note."
                            }
                        },
                        "required": ["note"]
                    }
                }
            ],
            "providers": [
                {
                    "id": "showcase",
                    "display_name": "Showcase Provider",
                    "description": "Local deterministic provider demonstrating extension model registration.",
                    "models": [
                        {
                            "id": "demo-small",
                            "display_name": "Demo Small",
                            "capabilities": {
                                "streaming": False,
                                "tool_use": False
                            },
                            "context_window": 4096
                        }
                    ],
                    "config_schema": {
                        "type": "object",
                        "properties": {
                            "response_prefix": {"type": "string"},
                            "notes_file": {"type": "string"}
                        }
                    }
                }
            ]
        }
    }


def handle_tool_call(params):
    name = params.get("name")
    tool_input = params.get("input") or {}
    if name != "showcase_note":
        raise ValueError(f"unknown showcase tool: {name}")
    note = str(tool_input.get("note") or "").strip()
    if not note:
        raise ValueError("note is required")
    tag = str(tool_input.get("tag") or "general").strip() or "general"
    record = append_record("tool_note", {"tag": tag, "note": note})
    return {
        "ok": True,
        "message": f"Recorded showcase note with tag '{tag}'.",
        "path": str(notes_path()),
        "record": record,
    }


def handle_hook(event):
    kind = event.get("kind")
    if kind == "before_tool_call":
        tool_input = event.get("tool_input") or {}
        command = str(tool_input.get("command") or "")
        if "rm -rf /" in command or "rm -rf ~" in command:
            append_record("blocked_tool", {"tool": event.get("tool_name"), "reason": "broad destructive rm -rf"})
            return {"action": "block", "reason": "extension-showcase blocked broad destructive rm -rf command"}
        if "rm -rf" in command:
            append_record("confirm_tool", {"tool": event.get("tool_name"), "reason": "rm -rf requires confirmation"})
            return {"action": "confirm", "message": f"extension-showcase asks you to confirm: {command}"}
    elif kind == "after_tool_call":
        output = event.get("tool_output") or ""
        append_record("tool_complete", {
            "tool": event.get("tool_runtime_name") or event.get("tool_name"),
            "output_chars": len(output),
        })
    elif kind == "on_message_complete":
        message = event.get("message") or ""
        append_record("message_complete", {"chars": len(message)})
    elif kind == "on_session_start":
        append_record("session_start", {"session_id": event.get("session_id")})
    elif kind == "on_session_end":
        append_record("session_end", {"session_id": event.get("session_id")})
    return {"action": "continue"}


def provider_complete(params):
    user_text = last_user_text(params.get("messages"))
    prefix = CONFIG.get("response_prefix") or "showcase"
    text = (
        f"{prefix}: I am the extension-showcase provider model. "
        f"I received {len(user_text)} characters from the latest user message. "
        f"Preview: {user_text[:180]}"
    )
    append_record("provider_complete", {
        "provider_id": params.get("provider_id"),
        "model_id": params.get("model_id"),
        "input_chars": len(user_text),
    })
    return {
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 0, "output_tokens": 0}
    }


def main():
    while True:
        request = read_frame()
        if request is None:
            break
        method = request.get("method")
        try:
            if method == "initialize":
                write_frame(request, initialize(request))
            elif method == "tool.call":
                write_frame(request, handle_tool_call(request.get("params") or {}))
            elif method == "hook.handle":
                write_frame(request, handle_hook(request.get("params") or {}))
            elif method == "provider.complete":
                write_frame(request, provider_complete(request.get("params") or {}))
            elif method == "provider.stream":
                write_frame(request, error={"code": -32000, "message": "provider.stream is reserved in this Synaps version"})
            elif method == "shutdown":
                write_frame(request, None)
                break
            else:
                write_frame(request, error={"code": -32601, "message": f"unknown method: {method}"})
        except Exception as exc:
            write_frame(request, error={"code": -32000, "message": str(exc)})


if __name__ == "__main__":
    main()
