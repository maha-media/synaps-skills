"""Strict gateway client and tool schemas for Pria Twin Improvement Loop."""
import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE = "https://pria.praxislxp.com"
MAX_QUESTIONS = 20
TOOL_SUBJECTS = {
    "read_twin_profile": "TWIN_PROFILE_READ",
    "create_twin_improvement_proposal": "TWIN_TRAINER_PROPOSAL_CREATE",
    "get_twin_improvement_run": "TWIN_IMPROVEMENT_RUN_STATUS",
    "create_twin_evaluation": "TWIN_EVALUATION_CREATE",
    "create_conversation_insights": "CONVERSATION_INSIGHTS_CREATE",
}
TOOL_SPECS = [
    {"name": "read_twin_profile", "description": "Read a safe, tenant-scoped Twin and vault readiness summary before advising.", "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "create_twin_improvement_proposal", "description": "Persist a read-only Twin improvement proposal. It never changes Twin configuration, vault content, guardrails, or public availability.", "input_schema": {"type": "object", "properties": {"goal": {"type": "string", "maxLength": 1000}, "audience": {"type": "string", "maxLength": 300}, "notes": {"type": "string", "maxLength": 2000}}, "required": ["goal", "audience"], "additionalProperties": False}},
    {"name": "get_twin_improvement_run", "description": "Read a persisted Twin improvement proposal, evaluation plan, or insight receipt by opaque run id.", "input_schema": {"type": "object", "properties": {"runId": {"type": "string", "maxLength": 128}}, "required": ["runId"], "additionalProperties": False}},
    {"name": "create_twin_evaluation", "description": "Persist a bounded manual Twin evaluation matrix. It does not execute prompts or claim unobserved answer quality.", "input_schema": {"type": "object", "properties": {"purpose": {"type": "string", "maxLength": 1000}, "audience": {"type": "string", "maxLength": 300}, "questions": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "string", "maxLength": 500}}}, "required": ["purpose", "audience", "questions"], "additionalProperties": False}},
    {"name": "create_conversation_insights", "description": "Create a privacy-bounded, aggregate-only conversation insight report for an authorized date range. No raw conversation text is returned.", "input_schema": {"type": "object", "properties": {"purpose": {"type": "string", "maxLength": 1000}, "after": {"type": "string"}, "before": {"type": "string"}}, "required": ["purpose", "after", "before"], "additionalProperties": False}},
]

class ToolError(Exception):
    pass

def validate(name, value):
    if name not in TOOL_SUBJECTS or not isinstance(value, dict):
        raise ToolError("invalid tool call")
    allowed = {
        "read_twin_profile": set(), "create_twin_improvement_proposal": {"goal", "audience", "notes"},
        "get_twin_improvement_run": {"runId"}, "create_twin_evaluation": {"purpose", "audience", "questions"},
        "create_conversation_insights": {"purpose", "after", "before"},
    }[name]
    if set(value) - allowed:
        raise ToolError("unexpected input field")
    required = {
        "read_twin_profile": [], "create_twin_improvement_proposal": ["goal", "audience"],
        "get_twin_improvement_run": ["runId"], "create_twin_evaluation": ["purpose", "audience", "questions"],
        "create_conversation_insights": ["purpose", "after", "before"],
    }[name]
    if any(not isinstance(value.get(key), str) or not value[key].strip() for key in required if key != "questions"):
        raise ToolError("required text input is missing")
    if name == "create_twin_evaluation":
        questions = value.get("questions")
        if not isinstance(questions, list) or not 1 <= len(questions) <= MAX_QUESTIONS or any(not isinstance(q, str) or not q.strip() or len(q) > 500 for q in questions):
            raise ToolError("questions must contain 1-20 non-empty items")
    return value

class GatewayClient:
    def __init__(self, token, base_url=DEFAULT_BASE, opener=None):
        if not token:
            raise ToolError("pria_agent_tool_token not configured")
        self.token, self.base_url, self.opener = token, base_url.rstrip("/"), opener or urllib.request.urlopen
    def call(self, subject, args):
        req = urllib.request.Request(f"{self.base_url}/internal/agent-tool-call", data=json.dumps({"subject": subject, "args": args}).encode("utf-8"), method="POST")
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Content-Type", "application/json")
        try:
            response = self.opener(req, timeout=10)
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
