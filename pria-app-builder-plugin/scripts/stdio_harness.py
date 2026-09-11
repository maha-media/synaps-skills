#!/usr/bin/env python3
"""Stdio smoke harness: drive main.py over its JSON-RPC framing as a subprocess.

Exactly how SynapsCLI launches the extension. No network: the tool.call below
is rejected by client-side validation before any gateway request is attempted,
and the second one fails on the missing token, so the harness proves the
handshake, tool registration and error framing without ever opening a socket.
"""
import json
import os
import subprocess
import sys
from io import BytesIO
from pathlib import Path

EXT = Path(__file__).resolve().parents[1] / "main.py"

EXPECTED_TOOLS = [
    "app_dev_start", "app_dev_stop", "app_service_status", "app_service_logs",
    "app_build_seal", "app_release_start", "app_release_publish",
    "app_release_rollback", "app_release_stop",
]


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
    if content_length is None:
        return None
    return json.loads(stream.read(content_length).decode("utf-8"))


def run(requests):
    env = {k: v for k, v in os.environ.items() if k != "PRIA_AGENT_TOOL_TOKEN"}
    proc = subprocess.Popen([sys.executable, str(EXT)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env)
    payload = b"".join(frame(m, p, req_id=i + 1) for i, (m, p) in enumerate(requests))
    out, err = proc.communicate(payload, timeout=20)
    buf, responses = BytesIO(out), []
    while True:
        r = read_frame(buf)
        if r is None:
            break
        responses.append(r)
    return responses, err.decode("utf-8", "replace")


def main():
    responses, err = run([
        ("initialize", {"synaps_version": "test", "extension_protocol_version": 1,
                        "plugin_id": "pria-app-builder", "config": {"pria_api_base": "http://127.0.0.1:9"}}),
        ("tool.call", {"name": "app_dev_start", "input": {"workdir": "app", "command": ["sh", "-c", "npm run dev"]}}),
        ("tool.call", {"name": "app_service_status", "input": {"serviceId": "64b0c0ffee00000000000001"}}),
        ("shutdown", None),
    ])
    assert len(responses) == 4, f"expected 4 responses, got {len(responses)} — stderr={err}"

    init = responses[0]
    assert "error" not in init, f"initialize error: {init}"
    assert init["result"]["protocol_version"] == 1, init
    names = [t["name"] for t in init["result"]["capabilities"]["tools"]]
    assert names == EXPECTED_TOOLS, f"tool list drift: {names}"
    print(f"✓ initialize: protocol_version=1, {len(names)} tools registered")

    shell = responses[1]
    assert shell.get("error", {}).get("code") == -32000, f"shell argv must be refused client-side: {shell}"
    assert "no shell" in shell["error"]["message"], shell
    print("✓ tool.call with a shell argv → refused before any gateway request")

    no_token = responses[2]
    assert no_token.get("error", {}).get("code") == -32000, f"expected token error: {no_token}"
    assert "not configured" in no_token["error"]["message"], no_token
    print("✓ tool.call without a token → 'pria_agent_tool_token not configured' (no socket opened)")

    assert responses[3].get("result") == {}, responses[3]
    print("✓ shutdown acknowledged; stdio handshake complete")


if __name__ == "__main__":
    main()
