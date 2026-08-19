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
    "notion_search": "NOTION_SEARCH",
    "notion_get_page": "NOTION_GET_PAGE",
    "notion_get_blocks": "NOTION_GET_BLOCKS",
}

# Public input key -> gateway arg key. The Pria handler validates a Notion UUID
# in an `id` field, so page_id/block_id are renamed to `id` before egress. The
# transform is applied IN PLACE inside validate(), because main.py forwards the
# input object verbatim to the gateway.
ARG_REMAP = {
    "notion_get_page": {"page_id": "id"},
    "notion_get_blocks": {"block_id": "id"},
}

TOOL_SPECS = [
    {
        "name": "notion_search",
        "description": ("Search the Notion workspace by keyword and return matching pages and "
                        "databases (title, id, url, last-edited). START HERE when you know a "
                        "page by name but not its id — the id you get back is what "
                        "notion_get_page and notion_get_blocks require. An empty `query` "
                        "returns the most recently edited objects. Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Free-text search string. Omit or empty to list recently edited objects."},
                "page_size": {"type": "integer", "description": "Max results (1-100, default 10)."},
            },
        },
    },
    {
        "name": "notion_get_page",
        "description": ("Fetch ONE page's METADATA by id — its properties, title, parent, "
                        "icon, cover and timestamps. This does NOT return the page body; for "
                        "the actual content (paragraphs, headings, lists, etc.) call "
                        "notion_get_blocks with the same id. Get the id from notion_search. "
                        "Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {
                "page_id": {"type": "string", "description": "Notion page id (UUID, dashed or bare)."},
            },
            "required": ["page_id"],
        },
    },
    {
        "name": "notion_get_blocks",
        "description": ("Fetch the CHILD BLOCKS of a page or block — i.e. its actual content: "
                        "paragraphs, headings, lists, to-dos, toggles, tables and so on. Pass "
                        "a page id to read that page's body, or a block id to read the "
                        "children nested under that block. Pair with notion_get_page, which "
                        "returns metadata but no content. Get the id from notion_search. "
                        "Read-only."),
        "input_schema": {
            "type": "object",
            "properties": {
                "block_id": {"type": "string", "description": "Notion page or block id (UUID, dashed or bare)."},
                "page_size": {"type": "integer", "description": "Max child blocks (1-100, default 100)."},
            },
            "required": ["block_id"],
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
