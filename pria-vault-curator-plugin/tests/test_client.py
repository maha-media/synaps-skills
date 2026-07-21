import json, os, sys, unittest
from urllib import error
from unittest.mock import patch
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "extensions"))
from vault_curator.client import (MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_SECONDS, GatewayError, PriaGatewayClient)
from vault_curator.tools import TOOL_ROUTES, TOOL_SCHEMAS, TOOL_SPECS, ValidationError, validate_input

class Response:
    def __init__(self, value, raw=False): self.value, self.raw = value, raw
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, limit):
        data = self.value if self.raw else json.dumps(self.value).encode()
        return data[:limit]

class ClientTests(unittest.TestCase):
    @patch.dict(os.environ, {"PRIA_AGENT_TOOL_TOKEN": "agent-token", "PRIA_API_KEY": "must-ignore"}, clear=True)
    def test_posts_to_configured_origin_with_only_agent_token(self):
        seen = {}
        def opener(req, timeout):
            seen.update(url=req.full_url, headers=dict(req.header_items()), body=req.data, timeout=timeout)
            return Response({"ok": True})
        result = PriaGatewayClient("https://pria.test/", opener=opener).call("/route", {"x": 1})
        self.assertEqual(result, {"ok": True})
        self.assertEqual(seen["url"], "https://pria.test/route")
        self.assertEqual(seen["timeout"], REQUEST_TIMEOUT_SECONDS)
        self.assertEqual(seen["headers"]["Authorization"], "Bearer agent-token")
        self.assertNotIn("must-ignore", json.dumps(seen, default=str))

    @patch.dict(os.environ, {"PRIA_AGENT_TOOL_TOKEN": "token"}, clear=True)
    def test_requires_strict_https_origin_and_relative_route(self):
        for value in ("http://pria.test", "https://user@pria.test", "https://pria.test/api", "https://pria.test?q=x"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "HTTPS origin|must be an origin"):
                PriaGatewayClient(value)
        client = PriaGatewayClient("https://pria.test")
        for route in ("https://evil.test/x", "//evil.test/x", "relative"):
            with self.subTest(route=route), self.assertRaisesRegex(ValueError, "gateway-relative"):
                client.call(route, {})

    @patch.dict(os.environ, {"PRIA_API_KEY": "raw-key"}, clear=True)
    def test_no_raw_key_fallback(self):
        with self.assertRaisesRegex(ValueError, "PRIA_AGENT_TOOL_TOKEN"):
            PriaGatewayClient("https://pria.test")

    @patch.dict(os.environ, {"PRIA_AGENT_TOOL_TOKEN": "token"}, clear=True)
    def test_structured_sanitized_gateway_errors_and_bounds(self):
        def denied(req, timeout): raise error.HTTPError(req.full_url, 403, "no", {}, None)
        with self.assertRaises(GatewayError) as caught:
            PriaGatewayClient("https://pria.test", opener=denied).call("/x", {})
        self.assertEqual(caught.exception.as_dict(), {"code": "upstream_http_error", "message": "Pria gateway rejected the request", "status": 403})
        client = PriaGatewayClient("https://pria.test", opener=lambda r, timeout: Response(b"x" * (MAX_RESPONSE_BYTES + 1), raw=True))
        with self.assertRaisesRegex(GatewayError, "size limit"):
            client.call("/x", {})

    def test_six_exact_closed_tool_contracts(self):
        expected = {"audit_vault", "inspect_vault_gap", "propose_vault_patch", "request_vault_patch_publish", "get_vault_patch_status", "verify_vault_patch"}
        self.assertEqual(set(TOOL_ROUTES), expected)
        self.assertEqual(set(TOOL_SCHEMAS), expected)
        self.assertEqual({x["name"] for x in TOOL_SPECS}, expected)
        self.assertTrue(all(s["additionalProperties"] is False for s in TOOL_SCHEMAS.values()))
        self.assertEqual(TOOL_SCHEMAS["propose_vault_patch"]["required"], ["vault_id", "gap_id", "patch", "rationale"])

    def test_argument_validation_rejects_missing_unknown_type_and_bounds(self):
        bad = ({}, {"vault_id": "v", "extra": 1}, {"vault_id": 7}, {"vault_id": " "}, {"vault_id": "x" * 257})
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ValidationError):
                validate_input("audit_vault", value)
        with self.assertRaises(ValidationError): validate_input("propose_vault_patch", {"vault_id":"v", "gap_id":"g", "patch":{}, "rationale":"why"})
        self.assertEqual(validate_input("audit_vault", {"vault_id":"v"}), {"vault_id":"v"})

if __name__ == "__main__": unittest.main()
