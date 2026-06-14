"""Unit tests for the JSON-RPC framing helpers and App handshake (B1)."""
import sys
import unittest
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.runtime import read_frame, write_frame  # noqa: E402
from pria.app import App  # noqa: E402


def _framed(method, params=None, req_id=1):
    import json
    msg = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        msg["params"] = params
    body = json.dumps(msg).encode()
    return b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body


class FramingTest(unittest.TestCase):
    def test_read_frame_roundtrip(self):
        buf = BytesIO(_framed("initialize", {"config": {}}))
        msg = read_frame(buf)
        self.assertEqual(msg["method"], "initialize")
        self.assertEqual(msg["params"], {"config": {}})

    def test_read_frame_eof(self):
        self.assertIsNone(read_frame(BytesIO(b"")))

    def test_read_frame_missing_length(self):
        with self.assertRaises(RuntimeError):
            read_frame(BytesIO(b"\r\n"))

    def test_write_frame_result(self):
        out = BytesIO()
        write_frame(out, 7, result={"ok": True})
        out.seek(0)
        echoed = read_frame(out)
        self.assertEqual(echoed["id"], 7)
        self.assertEqual(echoed["result"], {"ok": True})


class HandshakeTest(unittest.TestCase):
    def test_initialize_returns_protocol_1(self):
        app = App("pria-session-context")
        result = app.initialize({"config": {"ingest_url": "https://x"}})
        self.assertEqual(result["protocol_version"], 1)
        self.assertIn("tools", result["capabilities"])
        self.assertEqual(app.config["ingest_url"], "https://x")

    def test_unknown_hook_continues(self):
        app = App("pria-session-context")
        self.assertEqual(app.handle_hook({"kind": "on_compaction"}), {"action": "continue"})

    def test_before_tool_call_fail_closed_without_context(self):
        # B3: high-risk tools (bash) fail closed when no session context is loaded.
        app = App("pria-session-context")
        out = app.handle_hook({"kind": "before_tool_call", "tool_name": "bash",
                               "tool_input": {"command": "ls"}})
        self.assertEqual(out["action"], "block")


if __name__ == "__main__":
    unittest.main()
