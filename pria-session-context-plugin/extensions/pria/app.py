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
from pria.credential import CredentialBroker, TOOL_SPEC, TOOL_NAME
from pria.egress import EgressCorrelator
from pria.usage import UsageForwarder, usage_from_hook, build_usage_batch


class App:
    def __init__(self, plugin_id: str):
        self.plugin_id = plugin_id
        self.config = {}
        self.ctx = SessionContext()
        self.audit = AuditSink(self.ctx, self.config)
        self.policy = PolicyEngine(self.ctx)
        self.broker = CredentialBroker(self.ctx, self.config, audit=self.audit)
        self.egress = EgressCorrelator(self.ctx)
        # AC-B2.1: usage forwarder is constructed on initialize (needs config).
        # Live under protocol v2: the manifest declares the `on_usage` hook, so
        # SynapsCLI core (Track C) delivers raw LLM token usage here. We join it
        # with the file-delivered session context and forward via the guest-agent
        # signing proxy. Emits RAW usage only — no credits (spec §5.5).
        self.usage = None

    # ── initialize ──────────────────────────────────────────────────────────
    def initialize(self, params: dict) -> dict:
        incoming = params.get("config") or {}
        if isinstance(incoming, dict):
            self.config = {**self.config, **incoming}
        self.audit.config = self.config
        # B4: attach the Pria ingest sink (multi-sink: spool + ingest POST).
        ingest = IngestSink(self.ctx, self.config)
        self.audit.attach_ingest(ingest)
        self.broker.config = self.config
        # AC-B2.1: usage forwarder (raw-usage → guest-agent signing proxy →
        # Pria /internal/agentic-vm/usage). Live under protocol v2; the manifest
        # now declares the `on_usage` hook (see contract §6). Raw usage only.
        self.usage = UsageForwarder(self.ctx, self.config)
        return {
            "protocol_version": 2,
            "capabilities": {
                "tools": self._tool_specs(),
            },
        }

    def _tool_specs(self) -> list:
        # B5: register the request_credential tool (tools.register permission).
        return [TOOL_SPEC]

    # ── hooks ───────────────────────────────────────────────────────────────
    def handle_hook(self, event: dict) -> dict:
        kind = event.get("kind")
        handler = {
            "on_session_start": self._on_session_start,
            "on_session_end": self._on_session_end,
            "before_tool_call": self._before_tool_call,
            "after_tool_call": self._after_tool_call,
            "before_message": self._before_message,
            # AC-B2.1: `on_usage` is declared in the manifest (protocol v2), so
            # SynapsCLI core delivers raw LLM token usage here (contract §6).
            "on_usage": self._on_usage,
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

        # B6: egress correlation (partial; HS-4). Always generate a tool_call_id
        # for audit join; inject it into cooperating, plugin-owned tools' input.
        tool_call_id, modified_input = self.egress.correlate(tool_name, tool_input)
        correlated = False
        if result.get("action") == "continue" and modified_input is not None:
            result = {"action": "modify", "input": modified_input}
            correlated = True

        kind = self.policy.classify_kind(result.get("action"))
        # A pure egress modify is not a policy "modified" decision — record as started.
        if correlated and kind == "tool.call.modified":
            kind = "tool.call.started"
        fields = {
            "tool_name": tool_name,
            "tool_runtime_name": event.get("tool_runtime_name"),
            "decision": result.get("action"),
            "tool_call_id": tool_call_id,
            "egress_correlated": correlated,
            "egress_native_limited": (not correlated) and (modified_input is None),
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

    def _on_usage(self, event: dict) -> dict:
        """Raw-usage emission path (AC-B2.1; raw-only, no credits).

        SynapsCLI core (protocol v2) fires `on_usage` once per billable LLM turn
        (it reuses the `usage_emitted` latch so message_start + delta never
        double-emit). We join the raw token counts with the file-delivered
        session context (account/instance/user/vm/session), derive a stable
        idempotency key, build the §6.2 batch, and forward via the guest-agent
        signing proxy (which HMAC-signs + POSTs to /internal/agentic-vm/usage).

        Never raises and always returns `continue` — usage metering must never
        block or corrupt the agent loop. Forwarding is best-effort/spooled.
        """
        try:
            record = usage_from_hook(event)
            batch = build_usage_batch(self.ctx, [record])
            self.audit.emit("usage.observed", {
                "provider": record.get("provider"),
                "model": record.get("model"),
                "message_id": record.get("message_id"),
                "event_count": len(batch.get("events", [])),
            })
            if self.usage is not None:
                self.usage.forward(batch)
        except Exception:  # noqa: BLE001 — usage path must never break the loop
            pass
        return {"action": "continue"}

    # ── tools ───────────────────────────────────────────────────────────────
    def handle_tool_call(self, params: dict) -> dict:
        name = params.get("name")
        if name == TOOL_NAME:
            return self.broker.issue(params.get("input") or {})
        raise ValueError(f"unknown tool: {name}")

    # ── lifecycle ───────────────────────────────────────────────────────────
    def shutdown(self) -> None:
        self.audit.flush()
        return None
