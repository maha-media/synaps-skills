#!/usr/bin/env python3
"""Content-Length framed JSON-RPC runtime for pria-workflow-tools."""
import json
import sys
from notion_tools import TOOL_SPECS, TOOL_SUBJECTS, ToolError, configured_client, validate

def read_message():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line: return None
        if line in (b"\r\n", b"\n"): break
        key, sep, value = line.partition(b":")
        if not sep: raise ValueError("malformed header")
        headers[key.strip().lower()] = value.strip()
    length = int(headers[b"content-length"])
    if length < 0 or length > 200000: raise ValueError("invalid content length")
    payload = sys.stdin.buffer.read(length)
    return json.loads(payload.decode("utf-8")) if len(payload) == length else None

def send(message):
    raw = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: " + str(len(raw)).encode() + b"\r\n\r\n" + raw)
    sys.stdout.buffer.flush()

def error(msg_id, code, message): send({"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}})
def main():
    config = {}
    while True:
        try: request = read_message()
        except Exception: error(None, -32700, "parse error"); continue
        if request is None: return
        msg_id, method, params = request.get("id"), request.get("method"), request.get("params") or {}
        if method == "initialize":
            config = params.get("config") if isinstance(params.get("config"), dict) else {}
            send({"jsonrpc":"2.0", "id":msg_id, "result":{"protocol_version":1, "capabilities":{"tools":TOOL_SPECS}}})
        elif method == "tool.call":
            name, inp = params.get("name"), params.get("input", params.get("arguments", {})) or {}
            try:
                validate(name, inp)
                result = configured_client(config).call(TOOL_SUBJECTS[name], inp)
                send({"jsonrpc":"2.0", "id":msg_id, "result":{"content":json.dumps(result, ensure_ascii=False)}})
            except ToolError as exc: error(msg_id, -32000, str(exc))
        elif method == "shutdown": send({"jsonrpc":"2.0", "id":msg_id, "result":{}}); return
        else: error(msg_id, -32601, "method not found")
if __name__ == "__main__": main()
