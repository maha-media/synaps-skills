import io, json, os, sys, unittest
from unittest.mock import patch
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "extensions"))
from vault_curator.client import PriaGatewayClient
from vault_curator.tools import TOOL_ROUTES, TOOL_SCHEMAS, TOOL_SPECS

class Response:
    def __init__(self, value): self.value = value
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self): return json.dumps(self.value).encode()

class ClientTests(unittest.TestCase):
    @patch.dict(os.environ, {"PRIA_AGENT_TOOL_TOKEN": "agent-token", "PRIA_API_KEY": "must-ignore"}, clear=True)
    def test_posts_json_with_only_agent_token_auth(self):
        seen = {}
        def opener(req, timeout):
            seen.update(url=req.full_url, headers=dict(req.header_items()), body=req.data, timeout=timeout)
            return Response({"ok": True})
        result = PriaGatewayClient("https://pria.test/", opener=opener).call("/route", {"x": 1})
        self.assertEqual(result, {"ok": True})
        self.assertEqual(seen["url"], "https://pria.test/route")
        self.assertEqual(seen["headers"]["Authorization"], "Bearer agent-token")
        self.assertNotIn("must-ignore", json.dumps(seen, default=str))

    @patch.dict(os.environ, {"PRIA_API_KEY": "raw-key"}, clear=True)
    def test_no_raw_key_fallback(self):
        with self.assertRaisesRegex(ValueError, "PRIA_AGENT_TOOL_TOKEN"):
            PriaGatewayClient("https://pria.test")

    def test_tool_contract_is_complete_and_closed(self):
        expected = {"audit_vault", "inspect_vault_gap", "propose_vault_patch",
                    "request_vault_patch_publish", "get_vault_patch_status", "verify_vault_patch"}
        self.assertEqual(set(TOOL_ROUTES), expected)
        self.assertEqual(set(TOOL_SCHEMAS), expected)
        self.assertEqual({x["name"] for x in TOOL_SPECS}, expected)
        self.assertTrue(all(s["additionalProperties"] is False for s in TOOL_SCHEMAS.values()))

if __name__ == "__main__": unittest.main()
