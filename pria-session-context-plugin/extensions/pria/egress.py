"""Egress correlation (B6 — PARTIAL; HARD STOP HS-4).

Goal (spec §9.5): generate a `tool_call_id` and propagate it to network tools so
the egress proxy can join outbound requests to agent actions.

HARD STOP HS-4 (CONFIRMED): a plugin can `Modify` a tool's *input* via
before_tool_call, but it CANNOT rewrite the *outbound HTTP headers* emitted by
SynapsCLI's native network tools / model-provider calls (those live in
crates/agent-engine/src/tools/* and the provider runtimes, which the extension
ABI does not expose). Therefore native-tool header injection is OUT of plugin
reach.

Plugin-only mitigation (this module):
  - For tools this plugin owns or that *cooperate* (honour a `tool_call_id` /
    correlation field in their input), inject a correlation id via
    before_tool_call -> Modify{input}. The egress proxy can then read the id
    from a per-session side channel or from cooperating tools.
  - Always record the generated tool_call_id in the audit stream so the proxy
    can correlate at the control-plane side using per-session proxy credentials
    (Track A, §6.5) even when header injection is impossible.

Whether a tool cooperates is declared in policy:
  policy.egress_correlation = {
    "header_field": "x_tool_call_id",        # input field cooperating tools read
    "tools": ["web_fetch", "http_request"],  # plugin-owned/cooperating tools
  }
Native tools (not listed) are correlated proxy-side only (HS-4).
"""
import uuid

# Conservative default: only tools this plugin can vouch for cooperate.
DEFAULT_HEADER_FIELD = "x_tool_call_id"


def new_tool_call_id() -> str:
    return "tool_" + uuid.uuid4().hex[:16]


class EgressCorrelator:
    def __init__(self, ctx):
        self.ctx = ctx

    def _settings(self):
        pol = self.ctx.get("policy") or {}
        ec = pol.get("egress_correlation") if isinstance(pol, dict) else None
        if not isinstance(ec, dict):
            return {"header_field": DEFAULT_HEADER_FIELD, "tools": []}
        return {
            "header_field": ec.get("header_field") or DEFAULT_HEADER_FIELD,
            "tools": ec.get("tools") or [],
        }

    def cooperating(self, tool_name: str) -> bool:
        return tool_name in self._settings()["tools"]

    def correlate(self, tool_name: str, tool_input):
        """Return (tool_call_id, modify_input_or_None).

        modify_input is non-None only for cooperating, plugin-owned tools whose
        input is a JSON object — those get the correlation field injected so the
        proxy can join request↔tool_call. For native tools, modify_input is None
        (HS-4: cannot rewrite their outbound headers) and correlation must happen
        proxy-side via per-session credentials.
        """
        tool_call_id = new_tool_call_id()
        if self.cooperating(tool_name) and isinstance(tool_input, dict):
            field = self._settings()["header_field"]
            modified = dict(tool_input)
            modified[field] = tool_call_id
            return tool_call_id, modified
        return tool_call_id, None
