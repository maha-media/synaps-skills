"""App — the extension's method handlers (initialize / hook.handle / tool.call).

Slice wiring:
  B1 handshake + hook dispatch
  B2 session-context loading + audit tagging
  B3 tool-policy gating (before_tool_call) + after_tool_call audit
  B4 multi-sink audit (ingest)
  B5 request_credential tool
  B6 egress correlation
"""
from pria.sessionctx import SessionContext
from pria.audit import AuditSink
from pria.policy import PolicyEngine
from pria.ingest import IngestSink


class App:
    def __init__(self, plugin_id: str):
        self.plugin_id = plugin_id
        self.config = {}
        self.ctx = SessionContext()
        self.audit = AuditSink(self.ctx, self.config)
        self.policy = PolicyEngine(self.ctx)

    # ── initialize ──────────────────────────────────────────────────────────
    def initialize(self, params: dict) -> dict:
        incoming = params.get("config") or {}
        if isinstance(incoming, dict):
            self.config = {**self.config, **incoming}
        self.audit.config = self.config
        # B4: attach the Pria ingest sink (multi-sink: spool + ingest POST).
        ingest = IngestSink(self.ctx, self.config)
        self.audit.attach_ingest(ingest)
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
        session_id = event.get("session_id") or ""
        self.ctx.load(session_id)
        self.audit.emit("session.started", {
            "context_path": self.ctx.path,
        })
        return {"action": "continue"}

    def _on_session_end(self, event: dict) -> dict:
        self.audit.emit("session.ended", {})
        self.audit.flush()
        self.ctx.clear()
        return {"action": "continue"}

    def _before_tool_call(self, event: dict) -> dict:
        tool_name = event.get("tool_name") or event.get("tool_runtime_name") or ""
        tool_input = event.get("tool_input")
        result = self.policy.decide(tool_name, tool_input)
        kind = self.policy.classify_kind(result.get("action"))
        fields = {
            "tool_name": tool_name,
            "tool_runtime_name": event.get("tool_runtime_name"),
            "decision": result.get("action"),
        }
        if "reason" in result:
            fields["reason"] = result["reason"]
        if "message" in result:
            fields["message"] = result["message"]
        self.audit.emit(kind, fields)
        return result

    def _after_tool_call(self, event: dict) -> dict:
        output = event.get("tool_output") or ""
        self.audit.emit("tool.call.completed", {
            "tool_name": event.get("tool_runtime_name") or event.get("tool_name"),
            "output_chars": len(output),
        })
        return {"action": "continue"}

    def _before_message(self, event: dict) -> dict:
        return {"action": "continue"}

    # ── tools ───────────────────────────────────────────────────────────────
    def handle_tool_call(self, params: dict) -> dict:
        name = params.get("name")
        raise ValueError(f"unknown tool: {name}")

    # ── lifecycle ───────────────────────────────────────────────────────────
    def shutdown(self) -> None:
        self.audit.flush()
        return None
