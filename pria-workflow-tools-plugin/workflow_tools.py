"""Strict gateway client and tool schemas for Pria workflow control.

The Workflows page is the human render of the Twin's tool surface: every button
a person can press there is a subject here. These tools control SAVED JOBS only
— they cannot read knowledge, touch a vault, or reconfigure a Twin. Those belong
to the specialist agents a workflow spawns, not to the thing that starts them.

Every call is tenant-scoped SERVER-side from the machine principal. Nothing in
these schemas carries an institution or user id, because the caller does not get
to choose whose workflows it operates on.
"""
import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE = "https://pria.praxislxp.com"
NAME_MAX = 120
KEY_MAX = 100
INSTRUCTION_MAX = 4000
RUNS_MAX_LIMIT = 100

TOOL_SUBJECTS = {
    "list_workflows": "WORKFLOW_LIST",
    "get_workflow": "WORKFLOW_GET",
    "list_workflow_runs": "WORKFLOW_LIST_RUNS",
    "create_workflow": "WORKFLOW_CREATE",
    "update_workflow": "WORKFLOW_UPDATE",
    "delete_workflow": "WORKFLOW_DELETE",
    "run_workflow": "WORKFLOW_RUN",
}

_ID = {"type": "string", "maxLength": 128}

TOOL_SPECS = [
    {"name": "list_workflows",
     "description": "List the caller's saved workflows with availability annotations. A workflow whose agent is unavailable is still listed and marked broken, never hidden.",
     "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "get_workflow",
     "description": "Read one saved workflow by id.",
     "input_schema": {"type": "object", "properties": {"workflowId": _ID}, "required": ["workflowId"], "additionalProperties": False}},
    {"name": "list_workflow_runs",
     "description": "Read run receipts for one workflow: outcome, whether the saved instruction was delivered, and any recorded failure reason. terminalState may be empty, which means 'not yet observed' — it does not mean the run is still going.",
     "input_schema": {"type": "object", "properties": {"workflowId": _ID, "limit": {"type": "integer", "minimum": 1, "maximum": RUNS_MAX_LIMIT}}, "required": ["workflowId"], "additionalProperties": False}},
    {"name": "create_workflow",
     "description": "Save a new workflow: an agent plus the instruction to send it when the workflow runs.",
     "input_schema": {"type": "object", "properties": {
         "name": {"type": "string", "maxLength": NAME_MAX},
         "presetKey": {"type": "string", "maxLength": KEY_MAX},
         "instruction": {"type": "string", "maxLength": INSTRUCTION_MAX},
         "enabled": {"type": "boolean"}},
      "required": ["name", "presetKey"], "additionalProperties": False}},
    {"name": "update_workflow",
     "description": "Update a saved workflow. Omitted fields keep their stored values.",
     "input_schema": {"type": "object", "properties": {
         "workflowId": _ID,
         "name": {"type": "string", "maxLength": NAME_MAX},
         "presetKey": {"type": "string", "maxLength": KEY_MAX},
         "instruction": {"type": "string", "maxLength": INSTRUCTION_MAX},
         "enabled": {"type": "boolean"}},
      "required": ["workflowId"], "additionalProperties": False}},
    {"name": "delete_workflow",
     "description": "PERMANENTLY delete a saved workflow. This cannot be undone. Requires confirm=true and a reason stating why it is being removed; do not call it speculatively or to 'clean up' without being asked. Past run receipts survive independently.",
     "input_schema": {"type": "object", "properties": {
         "workflowId": _ID,
         "confirm": {"type": "boolean"},
         "reason": {"type": "string", "maxLength": 500}},
      "required": ["workflowId", "confirm", "reason"], "additionalProperties": False}},
    {"name": "run_workflow",
     "description": "Start this workflow's agent now and deliver its saved instruction. This spawns a real session and consumes credits. If the agent is already running, the run is reported as 'reused' and the instruction is NOT sent — that is deliberate, it avoids interrupting work in progress.",
     "input_schema": {"type": "object", "properties": {"workflowId": _ID}, "required": ["workflowId"], "additionalProperties": False}},
]


class ToolError(Exception):
    pass


_ALLOWED = {
    "list_workflows": set(),
    "get_workflow": {"workflowId"},
    "list_workflow_runs": {"workflowId", "limit"},
    "create_workflow": {"name", "presetKey", "instruction", "enabled"},
    "update_workflow": {"workflowId", "name", "presetKey", "instruction", "enabled"},
    "delete_workflow": {"workflowId", "confirm", "reason"},
    "run_workflow": {"workflowId"},
}
_REQUIRED_TEXT = {
    "list_workflows": [],
    "get_workflow": ["workflowId"],
    "list_workflow_runs": ["workflowId"],
    "create_workflow": ["name", "presetKey"],
    "update_workflow": ["workflowId"],
    "delete_workflow": ["workflowId", "reason"],
    "run_workflow": ["workflowId"],
}
_LIMITS = {"name": NAME_MAX, "presetKey": KEY_MAX, "instruction": INSTRUCTION_MAX, "reason": 500, "workflowId": 128}


def validate(name, value):
    """Reject client-side what the gateway would reject server-side.

    This is a convenience gate, NOT the security boundary — the gateway
    re-validates everything and owns tenancy. Failing here just saves a
    round-trip and gives the model a clearer error than a 400.
    """
    if name not in TOOL_SUBJECTS or not isinstance(value, dict):
        raise ToolError("invalid tool call")
    if set(value) - _ALLOWED[name]:
        raise ToolError("unexpected input field")

    for key in _REQUIRED_TEXT[name]:
        if not isinstance(value.get(key), str) or not value[key].strip():
            raise ToolError(f"'{key}' is required")

    for key, cap in _LIMITS.items():
        if key in value:
            if not isinstance(value[key], str):
                raise ToolError(f"'{key}' must be text")
            if len(value[key]) > cap:
                raise ToolError(f"'{key}' exceeds {cap} characters")

    if "enabled" in value and not isinstance(value["enabled"], bool):
        raise ToolError("'enabled' must be true or false")

    if name == "list_workflow_runs" and "limit" in value:
        limit = value["limit"]
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= RUNS_MAX_LIMIT:
            raise ToolError(f"'limit' must be an integer between 1 and {RUNS_MAX_LIMIT}")

    if name == "delete_workflow" and value.get("confirm") is not True:
        # The agent-native equivalent of a confirm modal: deletion must be an
        # explicit act, not a plausible next token.
        raise ToolError("deletion requires confirm=true and a stated reason")

    if name == "create_workflow" and not value.get("name", "").strip():
        raise ToolError("'name' is required")

    return value


class GatewayClient:
    def __init__(self, token, base_url=DEFAULT_BASE, opener=None):
        if not token:
            raise ToolError("pria_agent_tool_token not configured")
        self.token, self.base_url, self.opener = token, base_url.rstrip("/"), opener or urllib.request.urlopen

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
    token = (os.environ.get("PRIA_AGENT_TOOL_TOKEN") or config.get("pria_agent_tool_token") or "").strip()
    base = (config.get("pria_api_base") or DEFAULT_BASE).strip()
    return GatewayClient(token, base)
