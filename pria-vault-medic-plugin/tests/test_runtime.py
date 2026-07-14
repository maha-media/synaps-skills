"""Unit tests for JSON-RPC framing and App handshake."""
import json
import sys
import unittest
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.runtime import read_frame, write_frame  # noqa: E402
from pria.app import App  # noqa: E402


def _framed(method, params=None, req_id=1):
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

    def test_read_frame_eof_returns_none(self):
        self.assertIsNone(read_frame(BytesIO(b"")))

    def test_read_frame_missing_content_length_raises(self):
        with self.assertRaises(RuntimeError):
            read_frame(BytesIO(b"\r\n"))

    def test_write_frame_result(self):
        out = BytesIO()
        write_frame(out, 7, result={"ok": True})
        out.seek(0)
        echoed = read_frame(out)
        self.assertEqual(echoed["id"], 7)
        self.assertEqual(echoed["result"], {"ok": True})

    def test_write_frame_error(self):
        out = BytesIO()
        write_frame(out, 3, error={"code": -32601, "message": "unknown method"})
        out.seek(0)
        echoed = read_frame(out)
        self.assertIn("error", echoed)
        self.assertEqual(echoed["error"]["code"], -32601)


class HandshakeTest(unittest.TestCase):
    def test_initialize_returns_protocol_2_with_tools(self):
        app = App("pria-vault-medic")
        result = app.initialize({"config": {"pria_api_base": "https://x"}})
        self.assertEqual(result["protocol_version"], 2)
        tools = result["capabilities"]["tools"]
        names = [t["name"] for t in tools]
        self.assertIn("vault_health", names)
        self.assertIn("vault_diagnose", names)
        self.assertIn("vault_repair", names)
        self.assertIn("vault_regrade", names)
        self.assertEqual(len(names), 4)

    def test_initialize_merges_config(self):
        app = App("pria-vault-medic")
        app.initialize({"config": {"pria_api_base": "https://y", "extra": "val"}})
        self.assertEqual(app.config["extra"], "val")

    def test_any_hook_returns_continue(self):
        app = App("pria-vault-medic")
        app.initialize({"config": {}})
        for kind in ("on_session_start", "before_tool_call", "after_tool_call", "on_compaction"):
            result = app.handle_hook({"kind": kind})
            self.assertEqual(result["action"], "continue", f"kind={kind}")

    def test_unknown_tool_raises(self):
        app = App("pria-vault-medic")
        app.initialize({"config": {}})
        with self.assertRaises(ValueError):
            app.handle_tool_call({"name": "nonexistent_tool", "input": {}})

    def test_tool_schema_has_required_fields(self):
        """Each tool spec must have name, description, input_schema."""
        app = App("pria-vault-medic")
        result = app.initialize({"config": {}})
        for tool in result["capabilities"]["tools"]:
            self.assertIn("name", tool, f"missing name in {tool}")
            self.assertIn("description", tool, f"missing description in {tool}")
            self.assertIn("input_schema", tool, f"missing input_schema in {tool}")

    def test_vault_repair_schema_marks_write(self):
        """vault_repair description must contain 'WRITE' to signal mutation risk."""
        app = App("pria-vault-medic")
        result = app.initialize({"config": {}})
        repair = next(t for t in result["capabilities"]["tools"] if t["name"] == "vault_repair")
        self.assertIn("WRITE", repair["description"])


if __name__ == "__main__":
    unittest.main()
