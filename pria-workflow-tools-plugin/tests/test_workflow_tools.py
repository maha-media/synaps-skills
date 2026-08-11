"""Schema + validation tests for pria-workflow-tools.

These pin the CLIENT-side gate. It is not the security boundary — the gateway
owns tenancy and re-validates everything — but it must never be laxer than the
server, or the model learns to send things that 400.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from workflow_tools import TOOL_SPECS, TOOL_SUBJECTS, ToolError, GatewayClient, validate


class SchemaShape(unittest.TestCase):
    def test_every_spec_has_a_subject_and_vice_versa(self):
        self.assertEqual({s["name"] for s in TOOL_SPECS}, set(TOOL_SUBJECTS))

    def test_no_schema_accepts_a_tenancy_field(self):
        # The caller never chooses whose workflows it touches.
        banned = {"institution", "createdBy", "user", "account", "_id", "subjectUserId"}
        for spec in TOOL_SPECS:
            props = set(spec["input_schema"].get("properties", {}))
            self.assertEqual(props & banned, set(), spec["name"])

    def test_every_schema_is_closed(self):
        for spec in TOOL_SPECS:
            self.assertFalse(spec["input_schema"]["additionalProperties"], spec["name"])

    def test_destructive_tool_advertises_its_gate(self):
        spec = next(s for s in TOOL_SPECS if s["name"] == "delete_workflow")
        self.assertIn("confirm", spec["input_schema"]["required"])
        self.assertIn("reason", spec["input_schema"]["required"])
        self.assertIn("cannot be undone", spec["description"])

    def test_run_tool_warns_it_spends_credits(self):
        spec = next(s for s in TOOL_SPECS if s["name"] == "run_workflow")
        self.assertIn("credits", spec["description"])


class Validation(unittest.TestCase):
    def test_rejects_unknown_tool_and_non_dict(self):
        with self.assertRaises(ToolError): validate("nope", {})
        with self.assertRaises(ToolError): validate("list_workflows", "x")

    def test_rejects_unexpected_field(self):
        with self.assertRaises(ToolError):
            validate("get_workflow", {"workflowId": "a", "institution": "b"})

    def test_requires_text_fields(self):
        with self.assertRaises(ToolError): validate("get_workflow", {})
        with self.assertRaises(ToolError): validate("get_workflow", {"workflowId": "   "})
        with self.assertRaises(ToolError): validate("create_workflow", {"presetKey": "vault-curator"})

    def test_enforces_length_caps(self):
        with self.assertRaises(ToolError):
            validate("create_workflow", {"name": "x" * 121, "presetKey": "k"})
        with self.assertRaises(ToolError):
            validate("create_workflow", {"name": "n", "presetKey": "k", "instruction": "i" * 4001})

    def test_enabled_must_be_boolean(self):
        with self.assertRaises(ToolError):
            validate("create_workflow", {"name": "n", "presetKey": "k", "enabled": "yes"})

    def test_update_is_partial(self):
        # only the id is required; omitted fields keep stored values server-side
        validate("update_workflow", {"workflowId": "a", "instruction": "new"})

    def test_delete_requires_explicit_confirmation(self):
        with self.assertRaises(ToolError):
            validate("delete_workflow", {"workflowId": "a", "confirm": False, "reason": "tidy"})
        with self.assertRaises(ToolError):
            validate("delete_workflow", {"workflowId": "a", "confirm": True, "reason": "  "})
        validate("delete_workflow", {"workflowId": "a", "confirm": True, "reason": "superseded"})

    def test_limit_bounds(self):
        with self.assertRaises(ToolError):
            validate("list_workflow_runs", {"workflowId": "a", "limit": 0})
        with self.assertRaises(ToolError):
            validate("list_workflow_runs", {"workflowId": "a", "limit": 101})
        with self.assertRaises(ToolError):
            validate("list_workflow_runs", {"workflowId": "a", "limit": True})
        validate("list_workflow_runs", {"workflowId": "a", "limit": 20})


class Client(unittest.TestCase):
    def test_refuses_to_construct_without_a_token(self):
        with self.assertRaises(ToolError):
            GatewayClient("", "https://x")

    def test_sends_subject_and_bearer_to_the_gateway(self):
        seen = {}

        class Resp:
            def read(self): return b'{"success":true,"result":{"count":0}}'
            def close(self): pass

        def opener(req, timeout=None):
            seen["url"] = req.full_url
            seen["auth"] = req.get_header("Authorization")
            seen["body"] = req.data.decode()
            return Resp()

        out = GatewayClient("tok", "https://pria.example", opener).call("WORKFLOW_LIST", {})
        self.assertTrue(seen["url"].endswith("/internal/agent-tool-call"))
        self.assertEqual(seen["auth"], "Bearer tok")
        self.assertIn("WORKFLOW_LIST", seen["body"])
        self.assertEqual(out, {"count": 0})

    def test_denied_call_raises_rather_than_returning_empty(self):
        class Resp:
            def read(self): return b'{"success":false}'
            def close(self): pass
        with self.assertRaises(ToolError):
            GatewayClient("tok", "https://x", lambda r, timeout=None: Resp()).call("WORKFLOW_RUN", {})


if __name__ == "__main__":
    unittest.main()
