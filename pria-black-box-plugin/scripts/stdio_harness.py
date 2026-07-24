#!/usr/bin/env python3
"""Stdio smoke harness: drive pria_black_box.py over its JSON-RPC framing.

Spawns the extension as a subprocess (exactly how SynapsCLI does), sends
framed requests, and asserts framed responses. Run by scripts/test.sh.
"""
import json
import subprocess
import sys
from pathlib import Path

EXT = Path(__file__).resolve().parents[1] / "extensions" / "pria_black_box.py"


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
    body = stream.read(content_length)
    return json.loads(body.decode("utf-8"))


def run(requests):
    proc = subprocess.Popen(
        [sys.executable, str(EXT)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    payload = b""
    for i, (method, params) in enumerate(requests):
        payload += frame(method, params, req_id=i + 1)
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
        ("initialize", {
            "synaps_version": "test",
            "extension_protocol_version": 2,
            "plugin_id": "pria-black-box",
            "config": {"pria_api_base": "https://pria.praxislxp.com"},
        }),
        ("hook.handle", {"kind": "on_session_start", "session_id": "sess_test"}),
        ("hook.handle", {"kind": "before_tool_call", "tool_name": "bash",
                         "tool_input": {"command": "ls"}}),
        ("shutdown", None),
    ])

    assert responses, f"no responses — stderr={err}"

    init = responses[0]
    assert "error" not in init, f"initialize error: {init}"
    result = init["result"]
    assert result["protocol_version"] == 2, f"bad protocol_version: {result}"
    tool_names = [t["name"] for t in result["capabilities"]["tools"]]
    assert "trace_answer" in tool_names, f"missing trace_answer: {tool_names}"
    assert "list_traceable_answers" in tool_names, f"missing list_traceable_answers: {tool_names}"
    assert "answer_confidence" in tool_names, f"missing answer_confidence: {tool_names}"
    print(f"✓ initialize: protocol_version=2, tools={tool_names}")

    hook_session = responses[1]
    assert hook_session.get("result", {}).get("action") == "continue", \
        f"bad on_session_start: {hook_session}"
    print("✓ on_session_start → continue")

    hook_tool = responses[2]
    assert hook_tool.get("result", {}).get("action") == "continue", \
        f"expected continue for before_tool_call: {hook_tool}"
    print("✓ before_tool_call → continue")

    print("✓ stdio handshake complete")


if __name__ == "__main__":
    main()
