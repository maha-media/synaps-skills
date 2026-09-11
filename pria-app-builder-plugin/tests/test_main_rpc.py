"""JSON-RPC surface tests for main.py (initialize / tool.call / shutdown / framing).

Drives `handle_request` directly with an injected gateway client factory and
round-trips the Content-Length framing through in-memory streams. No network,
no subprocess.
"""
import io
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main as ext  # noqa: E402
from app_builder_tools import TOOL_SPECS, ToolError  # noqa: E402

SID = "64b0c0ffee00000000000001"
REV = "0123456789abcdef0123456789abcdef"


class FakeClient:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result if result is not None else {}, error, []

    def call(self, subject, args):
        self.calls.append((subject, args))
        if self.error:
            raise self.error
        return self.result


def factory_for(client, seen_config):
    def factory(config):
        seen_config.append(config)
        return client
    return factory


class Rpc(unittest.TestCase):
    def test_initialize_registers_all_tools_and_keeps_config(self):
        state = {"config": {}}
        resp, done = ext.handle_request({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                         "params": {"config": {"pria_api_base": "http://gw"}}}, state)
        self.assertFalse(done)
        self.assertEqual(resp["result"]["protocol_version"], 1)
        self.assertEqual(resp["result"]["capabilities"]["tools"], TOOL_SPECS)
        self.assertEqual(state["config"], {"pria_api_base": "http://gw"})

    def test_initialize_with_bad_config_is_empty_dict(self):
        state = {"config": {"old": 1}}
        ext.handle_request({"id": 1, "method": "initialize", "params": {"config": "nope"}}, state)
        self.assertEqual(state["config"], {})

    def test_tool_call_validates_then_calls_gateway_with_subject(self):
        client, seen = FakeClient({"serviceId": "s1", "generation": 2, "previewUrl": "https://sites/p/d/c/"}), []
        state = {"config": {"pria_api_base": "http://gw", "pria_agent_tool_token": "t"}}
        resp, done = ext.handle_request(
            {"id": 7, "method": "tool.call",
             "params": {"name": "app_dev_start", "input": {"workdir": "app", "command": ["npm", "run", "dev"]}}},
            state, client_factory=factory_for(client, seen))
        self.assertFalse(done)
        self.assertEqual(seen, [state["config"]])
        self.assertEqual(client.calls, [("AGENTSPACE_APP_DEV_START", {"workdir": "app", "command": ["npm", "run", "dev"]})])
        self.assertEqual(json.loads(resp["result"]["content"])["previewUrl"], "https://sites/p/d/c/")

    def test_tool_call_accepts_arguments_alias(self):
        client, seen = FakeClient({"status": "ready"}), []
        resp, _ = ext.handle_request({"id": 1, "method": "tool.call",
                                      "params": {"name": "app_service_status", "arguments": {"serviceId": SID}}},
                                     {"config": {}}, client_factory=factory_for(client, seen))
        self.assertEqual(client.calls, [("AGENTSPACE_APP_SERVICE_STATUS", {"serviceId": SID})])
        self.assertEqual(json.loads(resp["result"]["content"]), {"status": "ready"})

    def test_invalid_input_is_a_tool_error_without_gateway_call(self):
        client, seen = FakeClient(), []
        resp, _ = ext.handle_request({"id": 2, "method": "tool.call",
                                      "params": {"name": "app_release_publish", "input": {"revisionId": REV, "expectedHead": REV}}},
                                     {"config": {}}, client_factory=factory_for(client, seen))
        self.assertEqual(resp["error"]["code"], -32000)
        self.assertIn("expectedHead", resp["error"]["message"])
        self.assertEqual(client.calls, [])
        # validation precedes client construction: no token is needed to refuse bad input
        self.assertEqual(seen, [])

    def test_unknown_tool_is_a_tool_error(self):
        resp, _ = ext.handle_request({"id": 3, "method": "tool.call", "params": {"name": "bash", "input": {}}},
                                     {"config": {}}, client_factory=lambda c: FakeClient())
        self.assertEqual(resp["error"]["code"], -32000)

    def test_gateway_error_is_surfaced_as_tool_error(self):
        client = FakeClient(error=ToolError("gateway request failed (403 denied_subject)"))
        resp, _ = ext.handle_request({"id": 4, "method": "tool.call",
                                      "params": {"name": "app_service_status", "input": {"serviceId": SID}}},
                                     {"config": {}}, client_factory=lambda c: client)
        self.assertEqual(resp["error"], {"code": -32000, "message": "gateway request failed (403 denied_subject)"})

    def test_missing_token_is_reported_not_crashed(self):
        resp, _ = ext.handle_request({"id": 5, "method": "tool.call",
                                      "params": {"name": "app_service_status", "input": {"serviceId": SID}}},
                                     {"config": {}}, client_factory=lambda c: (_ for _ in ()).throw(ToolError("pria_agent_tool_token not configured")))
        self.assertIn("not configured", resp["error"]["message"])

    def test_shutdown_and_unknown_method(self):
        resp, done = ext.handle_request({"id": 9, "method": "shutdown"}, {"config": {}})
        self.assertTrue(done)
        self.assertEqual(resp["result"], {})
        resp, done = ext.handle_request({"id": 10, "method": "hook.handle", "params": {}}, {"config": {}})
        self.assertFalse(done)
        self.assertEqual(resp["error"]["code"], -32601)
        resp, _ = ext.handle_request("garbage", {"config": {}})
        self.assertEqual(resp["error"]["code"], -32600)


class Framing(unittest.TestCase):
    def test_round_trip(self):
        out = io.BytesIO()
        ext.send({"jsonrpc": "2.0", "id": 1, "result": {"ok": True, "s": "\u2192"}}, out)
        raw = out.getvalue()
        self.assertTrue(raw.startswith(b"Content-Length: "))
        header, _, body = raw.partition(b"\r\n\r\n")
        self.assertEqual(int(header.split(b":")[1]), len(body))
        self.assertIn("\u2192".encode("utf-8"), body)
        self.assertEqual(ext.read_message(io.BytesIO(raw)), {"jsonrpc": "2.0", "id": 1, "result": {"ok": True, "s": "\u2192"}})

    def test_eof_and_oversize(self):
        self.assertIsNone(ext.read_message(io.BytesIO(b"")))
        with self.assertRaises(ValueError):
            ext.read_message(io.BytesIO(b"Content-Length: 999999999\r\n\r\n"))
        with self.assertRaises(ValueError):
            ext.read_message(io.BytesIO(b"garbage\r\n\r\n"))
        self.assertIsNone(ext.read_message(io.BytesIO(b"Content-Length: 10\r\n\r\n{}")))


if __name__ == "__main__":
    unittest.main()
