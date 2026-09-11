#!/usr/bin/env python3
"""Content-Length framed JSON-RPC runtime for pria-app-builder.

Same wire contract as pria-proxy-tools / pria-twin-tools (byte-compatible with
SynapsCLI process.rs): `initialize` -> tool specs, `tool.call` -> {content},
`shutdown`. The only side effect of any tool is one HTTPS POST to the Pria
Capability Gateway (`{subject: AGENTSPACE_APP_*, args}`); this process never
spawns anything.
"""
import json
import sys

from app_builder_tools import TOOL_SPECS, ToolError, configured_client, dispatch

MAX_FRAME_BYTES = 200_000
PROTOCOL_VERSION = 1


def read_message(stream=None):
    stream = stream or sys.stdin.buffer
    headers = {}
    while True:
        line = stream.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        key, sep, value = line.partition(b":")
        if not sep:
            raise ValueError("malformed header")
        headers[key.strip().lower()] = value.strip()
    length = int(headers[b"content-length"])
    if length < 0 or length > MAX_FRAME_BYTES:
        raise ValueError("invalid content length")
    payload = stream.read(length)
    return json.loads(payload.decode("utf-8")) if len(payload) == length else None


def send(message, stream=None):
    stream = stream or sys.stdout.buffer
    raw = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    stream.write(b"Content-Length: " + str(len(raw)).encode() + b"\r\n\r\n" + raw)
    stream.flush()


def _ok(msg_id, result):
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _err(msg_id, code, message):
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def handle_request(request, state, client_factory=configured_client):
    """Pure request -> (response, should_exit). `state` holds the initialize config."""
    if not isinstance(request, dict):
        return _err(None, -32600, "invalid request"), False
    msg_id, method = request.get("id"), request.get("method")
    params = request.get("params") if isinstance(request.get("params"), dict) else {}
    if method == "initialize":
        config = params.get("config")
        state["config"] = config if isinstance(config, dict) else {}
        return _ok(msg_id, {"protocol_version": PROTOCOL_VERSION,
                            "capabilities": {"tools": TOOL_SPECS}}), False
    if method == "tool.call":
        name = params.get("name")
        tool_input = params.get("input", params.get("arguments", {}))
        try:
            content = dispatch(name, tool_input or {}, state.get("config") or {},
                               client_factory=client_factory)
            return _ok(msg_id, {"content": content}), False
        except ToolError as exc:
            return _err(msg_id, -32000, str(exc)), False
    if method == "shutdown":
        return _ok(msg_id, {}), True
    return _err(msg_id, -32601, "method not found"), False


def main():
    state = {"config": {}}
    while True:
        try:
            request = read_message()
        except Exception:
            send(_err(None, -32700, "parse error"))
            continue
        if request is None:
            return
        response, done = handle_request(request, state)
        send(response)
        if done:
            return


if __name__ == "__main__":
    main()
