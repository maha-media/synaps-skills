"""App — the extension's method handlers (initialize / hook.handle / tool.call).

B1 establishes the handshake and a hook dispatcher returning `continue`.
Later slices wire in: session-context loading (B2), audit tagging (B2/B4),
tool-policy gating (B3), and the credential tool (B5).
"""


class App:
    def __init__(self, plugin_id: str):
        self.plugin_id = plugin_id
        self.config = {}

    # ── initialize ──────────────────────────────────────────────────────────
    def initialize(self, params: dict) -> dict:
        incoming = params.get("config") or {}
        if isinstance(incoming, dict):
            self.config = {**self.config, **incoming}
        return {
            "protocol_version": 1,
            "capabilities": {
                "tools": self._tool_specs(),
            },
        }

    def _tool_specs(self) -> list:
        # B5 registers the request_credential tool here.
        return []

    # ── hooks ───────────────────────────────────────────────────────────────
    def handle_hook(self, event: dict) -> dict:
        kind = event.get("kind")
        handler = {
            "on_session_start": self._on_session_start,
            "on_session_end": self._on_session_end,
            "before_tool_call": self._before_tool_call,
            "after_tool_call": self._after_tool_call,
            "before_message": self._before_message,
        }.get(kind)
        if handler is None:
            return {"action": "continue"}
        return handler(event)

    def _on_session_start(self, event: dict) -> dict:
        return {"action": "continue"}

    def _on_session_end(self, event: dict) -> dict:
        return {"action": "continue"}

    def _before_tool_call(self, event: dict) -> dict:
        return {"action": "continue"}

    def _after_tool_call(self, event: dict) -> dict:
        return {"action": "continue"}

    def _before_message(self, event: dict) -> dict:
        return {"action": "continue"}

    # ── tools ───────────────────────────────────────────────────────────────
    def handle_tool_call(self, params: dict) -> dict:
        name = params.get("name")
        raise ValueError(f"unknown tool: {name}")

    # ── lifecycle ───────────────────────────────────────────────────────────
    def shutdown(self) -> None:
        return None
