#!/usr/bin/env python3
"""pria-session-context — Synaps process extension entry point.

Implements the SynapsCLI extension JSON-RPC 2.0 / Content-Length stdio protocol
(modelled on extension-showcase-plugin/extensions/showcase.py and verified
against crates/agent-engine/src/extensions/runtime/process.rs).

Methods handled: initialize, hook.handle, tool.call, shutdown.

Slice map:
  B1  RPC loop + initialize handshake + hook dispatch (continue)
  B2  session-context loader + audit tagging (on_session_start/end)
  B3  tool-policy gating (before_tool_call) + after_tool_call audit
  B4  multi-sink audit (spool already; ingest in pria.audit)
  B5  request_credential tool (tool.call)
  B6  egress correlation (Modify input for plugin-owned/cooperating tools)
"""
import json
import os
import sys
from pathlib import Path

# Make the bundled `pria` package importable regardless of launch cwd.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from pria.runtime import (  # noqa: E402
    read_frame,
    write_frame,
)
from pria.app import App  # noqa: E402

PLUGIN_ID = "pria-session-context"


def main() -> None:
    app = App(plugin_id=PLUGIN_ID)
    while True:
        request = read_frame(sys.stdin.buffer)
        if request is None:
            break
        method = request.get("method")
        req_id = request.get("id")
        # Notifications (no id) get no response.
        is_notification = "id" not in request
        try:
            if method == "initialize":
                result = app.initialize(request.get("params") or {})
                if not is_notification:
                    write_frame(sys.stdout.buffer, req_id, result=result)
            elif method == "hook.handle":
                result = app.handle_hook(request.get("params") or {})
                if not is_notification:
                    write_frame(sys.stdout.buffer, req_id, result=result)
            elif method == "tool.call":
                result = app.handle_tool_call(request.get("params") or {})
                if not is_notification:
                    write_frame(sys.stdout.buffer, req_id, result=result)
            elif method == "shutdown":
                app.shutdown()
                if not is_notification:
                    write_frame(sys.stdout.buffer, req_id, result=None)
                break
            else:
                if not is_notification:
                    write_frame(
                        sys.stdout.buffer,
                        req_id,
                        error={"code": -32601, "message": f"unknown method: {method}"},
                    )
        except Exception as exc:  # noqa: BLE001 — never crash the pipe
            if not is_notification:
                write_frame(
                    sys.stdout.buffer,
                    req_id,
                    error={"code": -32000, "message": str(exc)},
                )


if __name__ == "__main__":
    main()
