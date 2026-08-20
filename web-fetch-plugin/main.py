#!/usr/bin/env python3
"""Content-Length-framed JSON-RPC process runtime for Synaps."""
import json
import sys
from web_fetch import FetchError, fetch_web_page

TOOL = {
    "name": "fetch_web_page",
    "description": "Fetch bounded static HTTPS HTML and same-origin CSS source evidence. Does not render, execute JavaScript, or interpret content.",
    "input_schema": {"type": "object", "properties": {
        "url": {"type": "string", "description": "HTTPS page URL"}
    }, "required": ["url"], "additionalProperties": False},
}


def read_message():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        key, separator, value = line.partition(b":")
        if not separator:
            raise ValueError("malformed JSON-RPC header")
        headers[key.strip().lower()] = value.strip()
    try:
        length = int(headers[b"content-length"])
    except (KeyError, ValueError) as exc:
        raise ValueError("missing or invalid Content-Length") from exc
    if length < 0 or length > 2_000_000:
        raise ValueError("invalid Content-Length")
    body = sys.stdin.buffer.read(length)
    if len(body) != length:
        return None
    return json.loads(body.decode("utf-8"))


def send(message):
    encoded = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: " + str(len(encoded)).encode("ascii") + b"\r\n\r\n" + encoded)
    sys.stdout.buffer.flush()


def error(message_id, code, message):
    send({"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": message}})


def main():
    while True:
        try:
            request = read_message()
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            error(None, -32700, "parse error: " + str(exc))
            continue
        if request is None:
            return
        if not isinstance(request, dict):
            error(None, -32600, "invalid request")
            continue
        message_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": message_id, "result": {
                "protocol_version": 1, "capabilities": {"tools": [TOOL]}
            }})
        elif method == "tool.call":
            if not isinstance(params, dict):
                error(message_id, -32602, "invalid tool parameters")
                continue
            input_data = params.get("input", params.get("arguments", {})) or {}
            if params.get("name") != "fetch_web_page" or not isinstance(input_data, dict) or not isinstance(input_data.get("url"), str):
                error(message_id, -32602, "fetch_web_page requires a string url")
                continue
            try:
                result = fetch_web_page(input_data["url"])
            except FetchError as exc:
                error(message_id, -32000, str(exc))
            except Exception:
                # Do not expose implementation/network details through the agent API.
                error(message_id, -32000, "fetch failed")
            else:
                send({"jsonrpc": "2.0", "id": message_id, "result": {"content": json.dumps(result, ensure_ascii=False)}})
        elif method == "shutdown":
            send({"jsonrpc": "2.0", "id": message_id, "result": {}})
            return
        else:
            error(message_id, -32601, "method not found")


if __name__ == "__main__":
    main()
