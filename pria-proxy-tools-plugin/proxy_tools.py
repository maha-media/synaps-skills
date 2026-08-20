"""pria-notion-tools — read-only Notion workspace access through the Capability Gateway.

The agent never holds a Notion credential. Each tool maps to a NOTION_* subject;
Pria resolves the institution's integration token server-side, calls Notion, and
returns the shaped result. Egress from an agent VM is unenforced, so a credential
in here would be exfiltratable with no log — keeping it out makes that impossible
rather than merely discouraged.

Tenancy is derived SERVER-side from the machine principal. Nothing in these
schemas carries an institution or user id, because the caller does not get to
choose whose workspace it reads.
"""

import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE = "https://pria.praxislxp.com"
MAX_PAYLOAD_BYTES = 200_000

TOOL_SUBJECTS = {
    "proxy_call": "PROXY_CALL",
}

ARG_REMAP = {}

TOOL_SPECS = [
    {
        "name": "proxy_call",
        "description": ("Make an HTTP call to a connected third-party service through Pria's HOST-PINNED "
                        "proxy. YOU supply the connector, HTTP method, relative path and (for writes) a JSON "
                        "body; Pria attaches the service credential SERVER-SIDE and forwards the call to that "
                        "connector's pinned host. You never see the key. Use the service's API docs to choose "
                        "the exact path and body. Available connector: 'pria-api' (the Pria platform API on "
                        "this server). The path is RELATIVE and must start with '/', e.g. "
                        "'/api/user/agents/catalogue' \u2014 the host is pinned, you supply only the path. "
                        "Returns {status, ok, body}."),
        "input_schema": {
            "type": "object",
            "properties": {
                "connector": {"type": "string", "description": "Which connected service to call. Currently: 'pria-api'."},
                "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"], "description": "HTTP method (default GET)."},
                "path": {"type": "string", "description": "Relative request path starting with '/'. The host is pinned server-side; supply only the path."},
                "body": {"type": "object", "description": "JSON request body for POST/PUT/PATCH (omit for GET/DELETE)."},
            },
            "required": ["connector", "path"],
        },
    },
]


class ToolError(RuntimeError):
    """An actionable failure to surface to the model."""


def validate(name, payload):
    """Convenience gate, NOT the security boundary — the gateway re-validates.

    Also normalises public input keys to the gateway's expected arg keys
    (page_id/block_id -> id) IN PLACE, so main.py can forward the object verbatim.
    """
    if name not in TOOL_SUBJECTS:
        raise ToolError(f"unknown tool '{name}'")
    if not isinstance(payload, dict):
        raise ToolError("input must be an object")
    spec = next(t for t in TOOL_SPECS if t["name"] == name)
    for req in spec["input_schema"].get("required", []):
        if not payload.get(req):
            raise ToolError(f"'{req}' is required")
    for public_key, gateway_key in ARG_REMAP.get(name, {}).items():
        if public_key in payload:
            payload[gateway_key] = payload.pop(public_key)
    if len(json.dumps(payload)) > MAX_PAYLOAD_BYTES:
        raise ToolError("input too large")
    return payload


class GatewayClient:
    def __init__(self, token, base_url=DEFAULT_BASE, opener=None):
        if not token:
            raise ToolError("pria_agent_tool_token not configured")
        self.token, self.base_url = token, base_url.rstrip("/")
        self.opener = opener or urllib.request.urlopen

    def call(self, subject, args):
        req = urllib.request.Request(
            f"{self.base_url}/internal/agent-tool-call",
            data=json.dumps({"subject": subject, "args": args}).encode("utf-8"),
            method="POST",
        )
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Content-Type", "application/json")
        try:
            response = self.opener(req, timeout=30)
            payload = json.loads(response.read().decode("utf-8"))
            response.close()
        except urllib.error.HTTPError as exc:
            raise ToolError(f"gateway request failed ({exc.code})") from exc
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise ToolError("gateway request failed") from exc
        if not payload.get("success"):
            raise ToolError("gateway request denied")
        return payload.get("result") or {}


def configured_client(config):
    token = (os.environ.get("PRIA_AGENT_TOOL_TOKEN")
             or config.get("pria_agent_tool_token") or "").strip()
    base = (config.get("pria_api_base") or DEFAULT_BASE).strip()
    return GatewayClient(token, base)


def dispatch(name, tool_input, config):
    args = validate(name, tool_input or {})
    return configured_client(config).call(TOOL_SUBJECTS[name], args)
