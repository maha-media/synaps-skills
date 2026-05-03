#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export SYNAPS_BASE_DIR="$TMP/base"

python3 - <<'PY' "$ROOT/extensions/showcase.py" "$SYNAPS_BASE_DIR"
import json
import os
import subprocess
import sys

script, base = sys.argv[1], sys.argv[2]
proc = subprocess.Popen(["python3", script], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

def send(method, params=None, id=1):
    body = json.dumps({"jsonrpc":"2.0","id":id,"method":method,"params":params or {}}).encode()
    proc.stdin.write(b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
    proc.stdin.flush()
    length = None
    while True:
        line = proc.stdout.readline()
        if line in (b"\r\n", b"\n"):
            break
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":", 1)[1].strip())
    return json.loads(proc.stdout.read(length))

init = send("initialize", {"config": {"response_prefix": "test", "notes_file": "memory/showcase-test.jsonl"}}, 1)
assert init["result"]["capabilities"]["tools"][0]["name"] == "showcase_note"
assert init["result"]["capabilities"]["providers"][0]["id"] == "showcase"

tool = send("tool.call", {"name": "showcase_note", "input": {"note": "hello", "tag": "smoke"}}, 2)
assert tool["result"]["ok"] is True

hook = send("hook.handle", {"kind": "before_tool_call", "tool_name": "bash", "tool_input": {"command": "rm -rf /"}}, 3)
assert hook["result"]["action"] == "block"

provider = send("provider.complete", {"provider_id": "showcase", "model_id": "demo-small", "messages": [{"role": "user", "content": "hello provider"}]}, 4)
assert provider["result"]["content"][0]["text"].startswith("test: I am the extension-showcase provider model")

send("shutdown", {}, 5)
proc.wait(timeout=5)
notes = os.path.join(base, "memory", "showcase-test.jsonl")
assert os.path.exists(notes), notes
print("extension-showcase smoke ok")
PY
