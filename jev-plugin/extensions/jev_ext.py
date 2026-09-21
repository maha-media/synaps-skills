#!/usr/bin/env python3
"""
jev — Synaps CLI extension entry point.

A calibrated decision layer for the agent harness, backed by TypeSafe Jev
(System One). Everything lives in this plugin; the runtime is untouched.

Hooks (all subscribed in .synaps-plugin/plugin.json):
  before_tool_call  bash/write/edit/read → guard   (continue|confirm|block, fail-closed)
                    subagent_start/subagent → router (modify: role/write_policy/model, fail-open)
  after_tool_call   bash → advisory triage, otherwise compress (opt-in, fail-open)
                    subagent_collect → worker-report annotation (opt-in, advisory only; no host authority)
  before_message    remember the latest user message as the compression "goal"
  on_session_start  inject a one-paragraph note so the model knows the guard exists

Tools:   jev_evidence (descriptor relevance), jev_verify (verification priority), jev_select (candidate IDs), jev_decide (typed questions), jev_status (accounting) — always
         advertised; without a key they explain how to set one.
Command: /jev key|status|test|guard|router|compress|triage|discovery|verification|evidence|reports|on|off — set a key or flip a
         feature without restarting (session-only unless --save).

Key setup: the runtime resolves `api_key` once at initialize. If none is
present the extension loads INERT and re-checks the key sources every few
seconds, so `/jev key …`, `scripts/setup.sh --key …`, or an edit to the config
file all take effect in the running session.

Protocol: JSON-RPC 2.0 over stdio, Content-Length framing (docs/extensions/protocol.md).
"""

from __future__ import annotations

import itertools
import json
import os
import sys
import time
import traceback
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from jev import audit as audit_mod  # noqa: E402
from jev import commands, compress, discovery, evidence, guard, keys, reports, router, tools, triage, verify  # noqa: E402
from jev.client import DecisionClient, JevError  # noqa: E402

PLUGIN_ID = "jev"
INERT_RECHECK_S = 5.0


# ── framing ──────────────────────────────────────────────────────────────────

def send(obj: dict[str, Any]) -> None:
    body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n")
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def read_frame() -> dict[str, Any] | None:
    content_length: int | None = None
    while True:
        line = sys.stdin.buffer.readline()
        if line == b"":
            return None
        if line in (b"\r\n", b"\n"):
            break
        name, _, value = line.decode("ascii", "replace").partition(":")
        if name.lower() == "content-length":
            content_length = int(value.strip())
    if content_length is None:
        raise RuntimeError("missing Content-Length header")
    return json.loads(sys.stdin.buffer.read(content_length).decode("utf-8"))


def reply(req_id: Any, result: Any) -> None:
    send({"jsonrpc": "2.0", "id": req_id, "result": result})


def reply_error(req_id: Any, code: int, message: str) -> None:
    send({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def log(msg: str) -> None:
    sys.stderr.write(f"[{PLUGIN_ID}] {msg}\n")
    sys.stderr.flush()


def _bool(v, default: bool) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


# ── extension state ──────────────────────────────────────────────────────────

class Extension:
    def __init__(self) -> None:
        self.client: DecisionClient | None = None
        self.cfg: dict = {}
        self.key_source = "none"
        self.features = {"guard": False, "router": False, "compress": False, "triage": False, "discovery": False, "verification": False, "evidence": False, "reports": False, "tools": True}
        # Session-only feature overrides from `/jev guard off` etc. Applied on
        # top of config every time features are (re)computed, so a later
        # `/jev key …` re-activation cannot silently re-arm a disabled guard.
        self.session_overrides: dict[str, bool] = {}
        self.guard_cfg = guard.GuardConfig({})
        self.router_cfg = router.RouterConfig({})
        self.compress_cfg = compress.CompressConfig({})
        self.audit = audit_mod.Audit(None)
        self.goal = ""
        self.router = router.Router()
        self.triage = triage.Triage()
        self.reports = reports.Reports()
        self.discovery = discovery.Discovery()
        self._next_recheck = 0.0

    # ── config / activation ─────────────────────────────────────────────

    def model_name(self) -> str:
        return str(self.cfg.get("model") or "jev-latest")

    def timeout_s(self) -> float:
        return max(0.5, min(float(self.cfg.get("timeout_ms", 3000)) / 1000.0, 4.0))

    def activate(self, api_key: str, *, source: str) -> None:
        """Bring the decision layer up with this key (idempotent, no restart)."""
        self.reports.cache.clear()
        self.client = DecisionClient(api_key, model=self.model_name(), timeout_s=self.timeout_s())
        self.key_source = source
        self.recompute_features()
        log("active (" + ", ".join(k for k, v in self.features.items() if v) + f") key from {source}")

    FEATURE_DEFAULTS = {"guard": True, "router": True, "compress": False, "triage": True, "discovery": False, "verification": False, "evidence": False, "reports": False}

    def configured_feature(self, name: str) -> bool:
        """The persisted (config) value of a feature, ignoring session overrides."""
        return _bool(self.cfg.get(name), self.FEATURE_DEFAULTS[name])

    def recompute_features(self) -> None:
        """features = config defaults, then session overrides. Only meaningful
        while a client exists; an inert extension has everything but tools off."""
        if self.client is None:
            for k in self.FEATURE_DEFAULTS:
                self.features[k] = False
            self.features["tools"] = True
            return
        for k in self.FEATURE_DEFAULTS:
            self.features[k] = self.session_overrides.get(k, self.configured_feature(k))
        self.features["tools"] = True

    def set_feature(self, name: str, enabled: bool, *, persist: bool) -> None:
        """Flip a feature now. `persist=False` records a session override;
        `persist=True` updates the in-memory config (the caller has already
        written it through the host) and clears any session override so the
        saved value is what shows."""
        if name not in self.FEATURE_DEFAULTS:
            raise ValueError(f"unknown feature {name!r}")
        if persist:
            self.cfg[name] = enabled
            self.session_overrides.pop(name, None)
        else:
            self.session_overrides[name] = enabled
        self.recompute_features()

    def deactivate(self) -> None:
        self.reports.cache.clear()
        self.client = None
        self.key_source = "none"
        self.recompute_features()

    def maybe_pick_up_key(self) -> None:
        """Inert extensions re-check key sources at most every INERT_RECHECK_S."""
        if self.client is not None:
            return
        now = time.monotonic()
        if now < self._next_recheck:
            return
        self._next_recheck = now + INERT_RECHECK_S
        key, source = keys.discover()
        if key:
            try:
                self.activate(key, source=source)
            except JevError as e:
                log(f"key found at {source} but unusable: {e}")

    def initialize(self, params: dict) -> dict:
        self.cfg = dict(params.get("config") or {})
        self.audit = audit_mod.Audit(str(self.cfg.get("audit_file") or "") or None)
        self.guard_cfg = guard.GuardConfig(self.cfg)
        self.router_cfg = router.RouterConfig(self.cfg)
        self.compress_cfg = compress.CompressConfig(self.cfg)

        api_key = str(self.cfg.get("api_key") or "").strip()
        source = "host config"
        if not api_key:
            api_key, source = keys.discover()
        if api_key:
            try:
                self.activate(api_key, source=source)
            except JevError as e:
                log(f"key unusable: {e}")
        else:
            log(f"inert: no API key. Run `/jev key <apikey_…>` in synaps, or `scripts/setup.sh --key …` "
                f"(stores in {keys.plugin_config_path()}). Re-checking every {INERT_RECHECK_S:.0f}s.")

        # Tools are always advertised so the model can discover the plugin and
        # be told how to configure it.
        return {"protocol_version": 1, "capabilities": {"tools": [tools.DECIDE_SPEC, tools.STATUS_SPEC, tools.SELECT_SPEC, verify.SPEC, evidence.SPEC]}}

    # ── hooks ───────────────────────────────────────────────────────────

    def hook(self, params: dict) -> dict:
        self.maybe_pick_up_key()
        kind = params.get("kind", "")
        tool = params.get("tool_runtime_name") or params.get("tool_name") or ""

        if kind == "before_tool_call":
            if tool in router.SUBAGENT_TOOLS:
                return self.router.handle(params, self.client, self.router_cfg, self.audit, log,
                                          enabled=self.features["router"])
            if self.features["guard"]:
                return guard.handle(params, self.client, self.guard_cfg, self.audit, log)
            if self.client is None and tool in self.guard_cfg.tools:
                if not self.audit.counters.get("guard.inert"):
                    log("guard inert: no API key")
                self.audit.bump("guard.inert")
            return {"action": "continue"}

        if kind == "after_tool_call":
            if reports.collect_candidate(params):
                return self.reports.handle(params, self.client, self.features["reports"], self.audit)
            if discovery.recognized(params):
                return self.discovery.handle(params, self.client, self.features["discovery"], self.audit)
            if triage.recognized(params):
                return self.triage.handle(params, self.client, self.features["triage"], self.audit)
            if self.features["compress"]:
                return compress.handle(params, self.goal, self.client, self.compress_cfg, self.audit, log)
            return {"action": "continue"}

        if kind == "before_message":
            msg = params.get("message")
            if isinstance(msg, str) and msg.strip():
                self.goal = msg.strip()
            return {"action": "continue"}

        if kind == "on_session_start":
            return {"action": "inject", "content": (
                "Jev offers jev_select for batched candidate-ID choices and jev_decide for typed questions. "
                "jev_verify prioritizes optional checks only; honor all project/user/CI mandatory checks. "
                "jev_evidence offers descriptor relevance only, never trust or fetch permission; /jev evidence on. "
                "Opt-in /jev reports on adds unverified worker-claim advice, never lifecycle or merge authority. "
                "Enable with /jev verification on; configure the shared key with /jev key. "
                "Batch uncertain choices; skip obvious deterministic ones. Choice criteria are ID-to-description "
                "objects; score criteria are ordered lists. Bash failure triage is advisory, never authority "
                "to execute, retry, or certify success. Optional discovery recommendations are advisory, "
                "not activation/permission or authority. Check jev_status for active features and estimated Jev cost."
            )}

        return {"action": "continue"}

    # ── tools ───────────────────────────────────────────────────────────

    def tool_call(self, params: dict) -> dict:
        name = params.get("name")
        if name == "jev_evidence":
            return evidence.call_evidence(params.get("input"), self.client, self.audit,
                                          enabled=self.features["evidence"])
        if name == "jev_verify":
            return verify.call_verify(params.get("input"), self.client, self.audit,
                                      enabled=self.features["verification"])
        self.maybe_pick_up_key()
        tool_input = params.get("input") or {}
        if name == "jev_status":
            return tools.call_status(self.client, self.audit, self.features, self.key_source)
        if self.client is None:
            raise tools.ToolError(
                "jev: no API key configured. Ask the user to run `/jev key <apikey_…>` in synaps "
                f"(or `scripts/setup.sh --key …`); keys come from {keys.GET_KEY_URL}."
            )
        if name == "jev_select":
            return tools.call_select(tool_input, self.client, self.audit)
        if name == "jev_decide":
            return tools.call_decide(tool_input, self.client, self.audit)
        raise tools.ToolError(f"unknown tool: {name}")


# ── outbound RPC (extension → host) ──────────────────────────────────────────

_ids = itertools.count(1)
_pending_inbound: list[dict] = []


def host_call(method: str, params: dict, timeout_s: float = 10.0) -> Any:
    """Send a request to the host and wait for its response. Inbound
    requests that arrive meanwhile are queued for the main loop."""
    rid = f"ext-{next(_ids)}"
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        frame = read_frame()
        if frame is None:
            raise RuntimeError("host closed stdin")
        if frame.get("id") == rid and "method" not in frame:
            if "error" in frame:
                err = frame["error"] or {}
                raise RuntimeError(f"{method}: {err.get('message', err)}")
            return frame.get("result")
        _pending_inbound.append(frame)
    raise TimeoutError(f"{method}: no response within {timeout_s:.0f}s")


# ── main loop ────────────────────────────────────────────────────────────────

def dispatch(ext: Extension, req: dict) -> bool:
    """Handle one inbound frame. Returns False when the loop should stop."""
    method = req.get("method")
    req_id = req.get("id")
    try:
        if method == "initialize":
            reply(req_id, ext.initialize(req.get("params") or {}))
        elif method == "hook.handle":
            reply(req_id, ext.hook(req.get("params") or {}))
        elif method == "tool.call":
            try:
                reply(req_id, ext.tool_call(req.get("params") or {}))
            except tools.ToolError as e:
                reply_error(req_id, -32000, str(e))
        elif method == "command.invoke":
            reply(req_id, commands.handle(req.get("params") or {}, ext, send, host_call))
        elif method == "shutdown":
            reply(req_id, None)
            return False
        elif req_id is None:
            pass  # notification we don't handle
        else:
            reply_error(req_id, -32601, f"unknown method: {method}")
    except Exception as e:  # noqa: BLE001 — never let one bad frame kill the guard
        log(f"handler crashed on {method}: {e}\n{traceback.format_exc()}")
        if req_id is not None:
            if method == "hook.handle" and (req.get("params") or {}).get("kind") == "before_tool_call":
                # A crashed guard must not fail open.
                reply(req_id, {"action": "confirm", "message": f"jev: internal error ({e}); approve manually?"})
            else:
                reply_error(req_id, -32603, f"internal error: {e}")
    return True


def main() -> None:
    ext = Extension()
    log("started")
    running = True
    while running:
        if _pending_inbound:
            req = _pending_inbound.pop(0)
        else:
            try:
                req = read_frame()
            except Exception as e:  # noqa: BLE001
                log(f"framing error: {e}")
                break
            if req is None:
                break
        if "method" not in req:
            continue  # stray response (e.g. late host reply) — nothing to do
        running = dispatch(ext, req)
    log("stopped")


if __name__ == "__main__":
    main()
