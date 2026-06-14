#!/usr/bin/env python3
"""Stdio smoke harness: drive context.py over its JSON-RPC framing.

Spawns the extension as a subprocess (exactly how SynapsCLI does), sends framed
requests, and asserts framed responses. Usable from scripts/test.sh.
"""
import json
import subprocess
import sys
from pathlib import Path

EXT = Path(__file__).resolve().parents[1] / "extensions" / "context.py"


def frame(method, params=None, req_id=1):
    msg = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        msg["params"] = params
    body = json.dumps(msg).encode("utf-8")
    return b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body


def read_frame(stream):
    content_length = None
    while True:
        line = stream.readline()
        if line == b"":
            return None
        if line in (b"\r\n", b"\n"):
            break
        name, _, value = line.decode("ascii").partition(":")
        if name.strip().lower() == "content-length":
            content_length = int(value.strip())
    body = stream.read(content_length)
    return json.loads(body.decode("utf-8"))


def run(requests, env=None):
    """Send a list of (method, params) and collect responses."""
    proc = subprocess.Popen(
        [sys.executable, str(EXT)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env,
    )
    payload = b""
    for method, params in requests:
        payload += frame(method, params, req_id=len(payload) + 1)
    out, err = proc.communicate(payload, timeout=20)
    responses = []
    from io import BytesIO
    buf = BytesIO(out)
    while True:
        r = read_frame(buf)
        if r is None:
            break
        responses.append(r)
    return responses, err.decode("utf-8", "replace")


def main():
    responses, err = run([
        ("initialize", {"synaps_version": "test", "extension_protocol_version": 1,
                        "plugin_id": "pria-session-context", "config": {}}),
        ("hook.handle", {"kind": "before_tool_call", "tool_name": "bash",
                         "tool_input": {"command": "ls"}}),
        ("shutdown", None),
    ])
    assert responses, f"no responses; stderr={err}"
    init = responses[0]
    assert init.get("result", {}).get("protocol_version") == 1, f"bad init: {init}"
    hook = responses[1]
    assert hook.get("result", {}).get("action") == "continue", f"bad hook: {hook}"
    print("B1 handshake OK:", json.dumps(init["result"]))
    print("B1 hook dispatch OK:", json.dumps(hook["result"]))


if __name__ == "__main__":
    main()
