"""JSON-RPC 2.0 / Content-Length stdio framing helpers.

Verified against crates/agent-engine/src/extensions/runtime/process.rs:
  - LSP-style `Content-Length: N\r\n\r\n<body>` framing.
  - Requests carry `method`, optional `id`, `params`.
  - Responses echo `id` with `result` or `error`.
"""
import json


def read_frame(stream):
    """Read one Content-Length framed JSON message. Returns dict or None on EOF."""
    content_length = None
    while True:
        line = stream.readline()
        if line == b"":
            return None
        if line in (b"\r\n", b"\n"):
            break
        name, _, value = line.decode("ascii", "replace").partition(":")
        if name.strip().lower() == "content-length":
            try:
                content_length = int(value.strip())
            except ValueError:
                raise RuntimeError(f"invalid Content-Length: {value!r}")
    if content_length is None:
        raise RuntimeError("missing Content-Length header")
    body = stream.read(content_length)
    return json.loads(body.decode("utf-8"))


def write_frame(stream, req_id, result=None, error=None):
    """Write one framed JSON-RPC response."""
    payload = {"jsonrpc": "2.0", "id": req_id}
    if error is None:
        payload["result"] = result
    else:
        payload["error"] = error
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    stream.write(b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body)
    stream.flush()
