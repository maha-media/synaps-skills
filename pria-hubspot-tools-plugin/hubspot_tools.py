"""pria-hubspot-tools — read-only HubSpot CRM access through the Capability Gateway.

The agent never holds a HubSpot credential. Each tool maps to a HUBSPOT_* subject;
Pria resolves the institution's service key server-side, calls HubSpot, and
returns the shaped result. Egress from an agent VM is unenforced, so a credential
in here would be exfiltratable with no log — keeping it out makes that impossible
rather than merely discouraged.

Tenancy is derived SERVER-side from the machine principal. Nothing in these
schemas carries an institution or user id, because the caller does not get to
choose whose CRM it reads.
"""

import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE = "https://pria.praxislxp.com"
MAX_PAYLOAD_BYTES = 200_000

TOOL_SUBJECTS = {
    "hubspot_whoami": "HUBSPOT_WHOAMI",
    "hubspot_search": "HUBSPOT_SEARCH",
    "hubspot_list": "HUBSPOT_LIST",
    "hubspot_get": "HUBSPOT_GET",
    "hubspot_pipelines": "HUBSPOT_PIPELINES",
    "hubspot_owners": "HUBSPOT_OWNERS",
}

OBJECT_TYPES = ["companies", "contacts", "deals"]
PIPELINE_TYPES = ["deals", "tickets"]
_PROPS = ("Optional list of HubSpot property names. Omit for a sensible default set.")

TOOL_SPECS = [
    {
        "name": "hubspot_whoami",
        "description": ("Verify HubSpot access and report which portal this institution is "
                        "connected to. Run FIRST when diagnosing any HubSpot problem — it "
                        "separates a bad token from a missing scope. Never raises."),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "hubspot_search",
        "description": ("Full-text search the CRM — 'find the company named X', 'which contacts "
                        "match Y'. Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {
                "object_type": {"type": "string", "enum": OBJECT_TYPES},
                "query": {"type": "string", "description": "Free-text search string."},
                "properties": {"type": "array", "items": {"type": "string"}, "description": _PROPS},
                "limit": {"type": "integer", "description": "Max records (1-100, default 10)."},
                "after": {"type": "string", "description": "Paging cursor from a previous call."},
            },
            "required": ["object_type"],
        },
    },
    {
        "name": "hubspot_list",
        "description": ("Page through CRM records of one type. Order is by record id and is NOT "
                        "chronological — never infer recency from position. Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {
                "object_type": {"type": "string", "enum": OBJECT_TYPES},
                "properties": {"type": "array", "items": {"type": "string"}, "description": _PROPS},
                "limit": {"type": "integer", "description": "Max records (1-100, default 10)."},
                "after": {"type": "string", "description": "Paging cursor from a previous call."},
            },
            "required": ["object_type"],
        },
    },
    {
        "name": "hubspot_get",
        "description": "Fetch ONE CRM record by its numeric id, with full properties. Read-only.",
        "input_schema": {
            "type": "object",
            "properties": {
                "object_type": {"type": "string", "enum": OBJECT_TYPES},
                "object_id": {"type": "string", "description": "Numeric HubSpot record id."},
                "properties": {"type": "array", "items": {"type": "string"}, "description": _PROPS},
            },
            "required": ["object_type", "object_id"],
        },
    },
    {
        "name": "hubspot_pipelines",
        "description": ("List pipelines and their stages (id, label, order, closed flag, probability). "
                        "REQUIRED to interpret a raw dealstage id — stage ids frequently do not match "
                        "their business meaning, so always resolve the label before describing a deal."),
        "input_schema": {
            "type": "object",
            "properties": {"pipeline_type": {"type": "string", "enum": PIPELINE_TYPES,
                                             "description": "Defaults to 'deals'."}},
        },
    },
    {
        "name": "hubspot_owners",
        "description": "List CRM owners (reps) so an ownerId on a record resolves to a person.",
        "input_schema": {
            "type": "object",
            "properties": {"limit": {"type": "integer", "description": "Max owners (1-100, default 50)."}},
        },
    },
]


class ToolError(RuntimeError):
    """An actionable failure to surface to the model."""


def validate(name, payload):
    """Convenience gate, NOT the security boundary — the gateway re-validates."""
    if name not in TOOL_SUBJECTS:
        raise ToolError(f"unknown tool '{name}'")
    if not isinstance(payload, dict):
        raise ToolError("input must be an object")
    spec = next(t for t in TOOL_SPECS if t["name"] == name)
    for req in spec["input_schema"].get("required", []):
        if not payload.get(req):
            raise ToolError(f"'{req}' is required")
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
