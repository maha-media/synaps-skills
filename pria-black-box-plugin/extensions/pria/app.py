"""App — initialize / hook.handle / tool.call method handlers for pria-black-box-plugin."""
from pria.tools import TOOL_SPECS, ToolHandler, TOOL_TRACE_ANSWER, TOOL_LIST_TRACEABLE, TOOL_ANSWER_CONFIDENCE

_KNOWN_TOOLS = {TOOL_TRACE_ANSWER, TOOL_LIST_TRACEABLE, TOOL_ANSWER_CONFIDENCE}


class App:
    def __init__(self, plugin_id: str):
        self.plugin_id = plugin_id
        self.config: dict = {}
        self._handler: ToolHandler | None = None

    # ── initialize ────────────────────────────────────────────────────────────

    def initialize(self, params: dict) -> dict:
        incoming = params.get("config") or {}
        if isinstance(incoming, dict):
            self.config = {**self.config, **incoming}
        self._handler = ToolHandler(self.config)
        return {
            "protocol_version": 2,
            "capabilities": {
                "tools": TOOL_SPECS,
            },
        }

    # ── hooks — this plugin registers no hooks; always continue ───────────────

    def handle_hook(self, event: dict) -> dict:  # noqa: ARG002
        return {"action": "continue"}

    # ── tools ─────────────────────────────────────────────────────────────────

    def handle_tool_call(self, params: dict) -> dict:
        name = params.get("name") or ""
        if name not in _KNOWN_TOOLS:
            raise ValueError(f"unknown tool: {name}")
        handler = self._handler
        if handler is None:
            return {"error": "plugin not initialized"}
        return handler.call(name, params.get("input") or {})

    # ── lifecycle ─────────────────────────────────────────────────────────────

    def shutdown(self) -> None:
        return None
