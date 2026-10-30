#!/usr/bin/env python3
"""
jev — Synaps CLI extension entry point.

A calibrated decision layer for the agent harness, backed by TypeSafe Jev
(System One). Everything lives in this plugin; the runtime is untouched.

Hooks (all subscribed in .synaps-plugin/plugin.json):
  before_tool_call  bash/write/edit/read → guard   (continue|confirm|block, fail-closed)
                    multi_edit → guard per target file; send_events → body secrets check
                    bash/write/edit/multi_edit shell text → the deterministic shell-safety rule,
                    no model call; it also runs with no key or the guard switched off
                    bash/shell_start command, shell_send input → the rule-1 guard (heredocs,
                    here-strings, in-place edits, stdin and long inline scripts; fleet sessions
                    by default), first, no model call, also with no key or the guard off
                    subagent_start/subagent → router (modify: role/write_policy/model, fail-open)
  after_tool_call   bash → advisory triage, otherwise compress (opt-in, fail-open)
                    subagent_collect → worker-report annotation (opt-in, advisory only; no host authority)
  before_message    remember the latest user message as the compression "goal"
  on_session_start  inject a one-paragraph note so the model knows the guard exists
  on_message_complete  under host context pressure at turn end → advisory context_phase report (fail-open)

Tools:   jev_diagnose (supplied hypotheses/checks), jev_evidence (descriptor relevance), jev_verify (verification priority), jev_select (candidate IDs), jev_decide (typed questions), jev_status (accounting) — always
         advertised; without a key they explain how to set one.
Command: /jev economy|key|status|test|guard|router|compress|triage|discovery|verification|evidence|diagnosis|reports|context|on|off — set a key or flip a
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
from jev import commands, compress, context, discovery, diagnose, evidence, guard, keys, logs, relay, reports, router, tools, triage, verify  # noqa: E402
from jev import host_profile  # noqa: E402
from jev.policy import BudgetPolicy
from jev.client import DecisionClient, JevError, Stats  # noqa: E402

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


# ── logs: best-effort, never delay a reply ───────────────────────────────────
# stderr reaches synaps.log only up to the host's 128 KiB per process, so it
# carries notices; routine lines go to jev.log (jev/logs.py, README "Logs").

LOG_LINE_MAX = logs.LINE_MAX  # bytes per line, under PIPE_BUF: a pipe write is whole or EAGAIN
LOG_HOLD_MAX = logs.HOLD_MAX  # lines one frame may hold until its reply is out


class StderrLog:
    """The extension's log. One write per line, at most LOG_LINE_MAX bytes.
    `make_nonblocking()` sets O_NONBLOCK on a pipe or socket, so a host that
    stops reading stderr cannot stall us: on EAGAIN, or any other failure,
    the line is dropped and counted (`dropped`, plus `on_drop`). While a
    frame is being handled its lines are held (at most LOG_HOLD_MAX, the
    rest dropped) and written only after its reply. `lines` counts the
    lines written."""

    def __init__(self, fd: int = 2, *, write=None, on_drop=None) -> None:
        self.fd = fd
        self._write = write if write is not None else (lambda data: os.write(self.fd, data))
        self.on_drop = on_drop
        self.dropped = 0
        self.lines = 0
        self._held: list[bytes] | None = None

    def make_nonblocking(self) -> None:
        import fcntl
        import stat
        try:
            if stat.S_ISFIFO(mode := os.fstat(self.fd).st_mode) or stat.S_ISSOCK(mode):
                fcntl.fcntl(self.fd, fcntl.F_SETFL, fcntl.fcntl(self.fd, fcntl.F_GETFL) | os.O_NONBLOCK)
        except OSError:
            pass

    def __call__(self, msg: str) -> None:
        line = f"[{PLUGIN_ID}] {msg}".encode("utf-8", "replace")[:LOG_LINE_MAX - 1]
        line = line.decode("utf-8", "ignore").encode("utf-8") + b"\n"
        if self._held is None:
            self._emit(line)
        elif len(self._held) < LOG_HOLD_MAX:
            self._held.append(line)
        else:
            self._drop()

    def hold(self) -> None:
        self._held = []

    def release(self) -> None:
        held, self._held = self._held or [], None
        for line in held:
            self._emit(line)

    def _emit(self, line: bytes) -> None:
        try:
            ok = self._write(line) == len(line)
        except Exception:  # noqa: BLE001 — EAGAIN, EPIPE, EBADF, anything: drop it
            ok = False
        if ok:
            self.lines += 1
        else:
            self._drop()

    def _drop(self) -> None:
        self.dropped += 1
        if self.on_drop is not None:
            try:
                self.on_drop()
            except Exception:  # noqa: BLE001 — a counter must not break logging
                pass


STDERR = StderrLog()
FILELOG = logs.FileLog()  # main() sets its path: logs.default_path()


def log(msg: str) -> None:
    """A notice: stderr (forwarded to synaps.log) and jev.log."""
    STDERR(msg)
    FILELOG(msg)


def route(msg: str, routine: str = "file", limiter: logs.Limiter | None = None) -> None:
    """A notice (logs.Notice) goes to stderr and jev.log. A routine line
    goes by config `log_routine`: file (jev.log only, the default), stderr
    (stderr and jev.log, the routing before jev.log) or off (nowhere).
    With the extension's `limiter`, a notice repeated within its window goes
    to jev.log only (its `repeat` text), and the lines the limiter owes
    (summaries, recoveries) go to both, first."""
    shown, owed = True, ()
    if limiter is not None:
        try:
            shown = limiter(msg)
            owed = limiter.take()
        except Exception:  # noqa: BLE001 — a broken limiter limits nothing
            shown, owed = True, ()
    for line in owed:
        log(line)
    if isinstance(msg, logs.Notice):
        if shown:
            log(msg)
        else:
            FILELOG(msg.repeat or msg)
    elif routine == "stderr":
        log(msg)
    elif routine != "off":
        FILELOG(msg)


def flush_limiter(ext, *, close: bool = False) -> None:
    """The lines `ext`'s limiter owes: summaries of the windows that have
    ended (all open ones when `close`, at exit), to stderr and jev.log."""
    limiter = getattr(ext, "limiter", None)
    if not isinstance(limiter, logs.Limiter):
        return
    try:
        limiter.close() if close else limiter.tick()
        owed = limiter.take()
    except Exception:  # noqa: BLE001 — logging must not raise
        return
    for line in owed:
        log(line)


CRASH_FAMILY = "handler crashes"  # the limiter family of crash signatures: one summary a window


def _crash_text(method: str, e: BaseException, tb) -> str:
    if method == "hook.handle":
        return f"handler crashed on {method}: {type(e).__name__}\n" + "".join(traceback.format_list(tb))
    return (f"handler crashed on {method}: {e}\n"
            + "".join(traceback.format_exception(type(e), e, e.__traceback__)))


def log_crash(ext, method: str, e: BaseException) -> None:
    """A handler crash. The first of each signature (method, exception type,
    last frame) is logged in full; a repeat within the limiter's window is one
    jev.log line (its frames not even formatted), counted and summed up on
    stderr when the window ends, every signature in one line (CRASH_FAMILY).
    Hook params carry tool input and output, so exception text may quote
    them: for a hook, the type and the frames, never the message."""
    tb = traceback.extract_tb(e.__traceback__)
    limiter = getattr(ext, "limiter", None)
    try:
        where = f" at {os.path.basename(tb[-1].filename)}:{tb[-1].lineno} in {tb[-1].name}" if tb else ""
        kind = f"{method}: {type(e).__name__}{where}"
        sig = "handler crashed on " + kind
        key, again = "crash:" + sig, sig + " (again; the first in full)"
        repeat = isinstance(limiter, logs.Limiter) and limiter.holds(key)
    except Exception:  # noqa: BLE001
        log(_crash_text(method, e, tb))
        return
    text = again if repeat else _crash_text(method, e, tb)
    route(logs.notice(text, key=key, label=kind, family=CRASH_FAMILY, repeat=again), limiter=limiter)


LOG_ROUTINE_UNRECOGNISED = "config log_routine: unrecognised value; using file (file | stderr | off)"


def select_log_routine(value) -> str:
    """Config `log_routine`: file (default) | stderr | off. An unrecognised
    non-empty value means file and logs one fixed line (never the value)."""
    choice = value.strip().lower() if isinstance(value, str) else ("" if value is None else None)
    if choice in logs.LOG_ROUTINES:
        return choice
    if choice != "":
        log(LOG_ROUTINE_UNRECOGNISED)
    return "file"


def _bool(v, default: bool) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


TRANSPORT_UNRECOGNISED = "config transport: unrecognised value; using auto (relay | direct | auto)"


def select_transport(value) -> str:
    """Config `transport`: relay | direct | auto (default). An unrecognised
    non-empty value means auto and logs one fixed line (never the value).
    auto is relay whenever the Pria desktop state dir exists (a Pria host),
    even if a key also exists; otherwise the key path. A host with no state
    dir (no host profile on macOS) is direct."""
    choice = value.strip().lower() if isinstance(value, str) else ("" if value is None else None)
    if choice in ("relay", "direct"):
        return choice
    if choice not in ("", "auto"):
        log(TRANSPORT_UNRECOGNISED)
    directory = relay.state_dir()
    return "relay" if directory is not None and directory.is_dir() else "direct"


# ── extension state ──────────────────────────────────────────────────────────

class Extension:
    def __init__(self) -> None:
        self.stats = Stats()
        self.client: DecisionClient | None = None
        self.cfg: dict = {}
        self.policy = BudgetPolicy()
        self.key_source = "none"
        self.transport = "direct"  # "relay": jev.decide through the Pria desktop app, keys never consulted
        self.log_routine = "file"  # where routine log lines go: file | stderr | off
        self.features = {"guard": False, "router": False, "compress": False, "triage": False, "discovery": False, "verification": False, "evidence": False, "diagnosis": False, "reports": False, "context": False, "tools": True}
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
        self.context = context.ContextBoundary()
        self._next_recheck = 0.0
        self.limiter = logs.Limiter()  # notices repeated per call: the first to stderr, the rest counted

    # ── config / activation ─────────────────────────────────────────────

    def op_log(self, msg: str) -> None:
        """The log the ops get: a notice to stderr and jev.log (a repeat
        within its window to jev.log only), a routine line by `log_routine`."""
        route(msg, self.log_routine, self.limiter)

    def log_status(self) -> dict:
        """jev_status: where jev.log is and the log counts (this process)."""
        return {"log_file": str(FILELOG.path) if FILELOG.path is not None else None,
                "log_routine": self.log_routine,
                "counters": {"log.file_lines": FILELOG.lines, "log.file_dropped": FILELOG.dropped,
                             "log.stderr_lines": STDERR.lines,
                             "log.notices_limited": self.limiter.limited,
                             "log.notice_summaries": self.limiter.summaries}}

    def clear_caches(self) -> None:
        """Invalidate all exact-session advice on key/model activation changes."""
        for component in (self.router, self.triage, self.reports, self.discovery):
            component.cache.clear()

    def set_compress_mode(self, mode: str, *, persist: bool) -> None:
        """Set presentation mode immediately; caller persists before calling."""
        if mode not in ("jev", "deterministic"):
            raise ValueError("compress_mode must be jev or deterministic")
        if persist:
            self.cfg["compress_mode"] = mode
        self.compress_cfg.mode = mode
        self.recompute_features()

    def info(self) -> dict:
        """Optional `info.get` metadata ({build, capabilities, models}); no secrets.

        Hosts that expose tools probe this once at boot; answering keeps the
        boot path free of the unknown-method error (which older hosts treat as
        a transport failure and answer with a process restart).
        """
        caps = [{"kind": "decision", "name": k, "modes": ["on" if v else "off"]}
                for k, v in self.features.items()]
        if self.transport == "relay":  # the last relay code only; never the token or socket data
            caps.append({"kind": "decision", "name": "transport",
                         "modes": ["relay", str(getattr(self.client, "relay_code", None) or "unknown")]})
        return {"capabilities": caps,
                "models": [{"id": self.model_name(), "display_name": "TypeSafe Jev", "installed": False}]}

    def model_name(self) -> str:
        return str(self.cfg.get("model") or "jev-latest")

    def timeout_s(self) -> float:
        return max(0.5, min(float(self.cfg.get("timeout_ms", 3000)) / 1000.0, 4.0))

    def activate(self, api_key: str, *, source: str) -> None:
        """Bring the decision layer up with this key (idempotent, no restart)."""
        self.clear_caches()
        self.client = DecisionClient(
            api_key, model=self.model_name(), timeout_s=self.timeout_s(), policy=self.policy,
            diagnostic=lambda op, reason: self.audit.explain(op, reason) if op != "guard" else None)
        self.client.stats = self.stats
        self.key_source = source
        self.recompute_features()
        log("active (" + ", ".join(k for k, v in self.features.items() if v) + f") key from {source}")

    def activate_relay(self) -> None:
        """Relay mode: decisions go through the Pria desktop app's fleet.sock.
        No key is read, held or validated; each call that gets no answer is
        Jev-off for that call (RelayOff)."""
        self.clear_caches()
        self.client = relay.RelayClient(
            model=self.model_name(), timeout_s=self.timeout_s(), policy=self.policy,
            diagnostic=lambda op, reason: self.audit.explain(op, reason) if op != "guard" else None,
            log=self.op_log, bump=lambda name: self.audit.bump(name))
        self.client.stats = self.stats
        self.key_source = "relay"
        self.recompute_features()
        log("active (" + ", ".join(k for k, v in self.features.items() if v) + ") through the Pria desktop relay")

    FEATURE_DEFAULTS = {"guard": True, "router": True, "compress": False, "triage": True, "discovery": False, "verification": False, "evidence": False, "diagnosis": False, "reports": False, "context": True}

    def configured_feature(self, name: str) -> bool:
        """The persisted (config) value of a feature, ignoring session overrides."""
        return _bool(self.cfg.get(name), self.FEATURE_DEFAULTS[name])

    def recompute_features(self) -> None:
        """features = config defaults, then session overrides. Only meaningful
        while a client exists; explicit deterministic compression can run locally."""
        if self.client is None:
            for k in self.FEATURE_DEFAULTS:
                self.features[k] = False
            self.features["compress"] = (
                self.compress_cfg.mode == "deterministic"
                and self.session_overrides.get("compress", self.configured_feature("compress")))
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
        self.clear_caches()
        self.client = None
        self.key_source = "none"
        self.recompute_features()

    def maybe_pick_up_key(self) -> None:
        """Inert extensions re-check key sources at most every INERT_RECHECK_S.
        Never in relay mode: keys are not consulted there."""
        if self.client is not None or self.transport == "relay":
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
                # rechecked every INERT_RECHECK_S while inert: limited, as it repeats
                self.op_log(logs.notice(f"key found at {source} but unusable: {e}"))

    def _initialize_key(self) -> None:
        """The direct (key) path, unchanged: config key, else keys.discover()."""
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

    def initialize(self, params: dict) -> dict:
        self.cfg = dict(params.get("config") or {})
        # First, so a later config error cannot leave relay-intended mode on the key path.
        self.transport = select_transport(self.cfg.get("transport"))
        self.log_routine = select_log_routine(self.cfg.get("log_routine"))
        self.policy.configure(self.cfg)
        self.audit = audit_mod.Audit(str(self.cfg.get("audit_file") or "") or None)
        self.guard_cfg = guard.GuardConfig(self.cfg)
        self.router_cfg = router.RouterConfig(self.cfg)
        self.compress_cfg = compress.CompressConfig(self.cfg)

        if self.transport == "relay":
            self.activate_relay()  # the config key and keys.discover() are never consulted
        else:
            if isinstance(self.client, relay.RelayClient):  # a re-initialize that left relay mode
                self.deactivate()
            self._initialize_key()

        self.recompute_features()

        # Tools are always advertised so the model can discover the plugin and
        # be told how to configure it.
        return {"protocol_version": 1, "capabilities": {"tools": [tools.DECIDE_SPEC, tools.STATUS_SPEC, tools.SELECT_SPEC, verify.SPEC, evidence.SPEC, diagnose.SPEC]}}

    # ── hooks ───────────────────────────────────────────────────────────

    def hook(self, params: dict, received: float | None = None) -> dict:
        """`received`: time.monotonic() when the frame arrived; the guard's
        budget runs from there (None: from now)."""
        self.maybe_pick_up_key()
        try:  # before any guard alarm; a cheap stat unless host.toml changed or 60 s passed
            host_profile.HostProfile.current().refresh()
        except Exception:  # noqa: BLE001 — the profile keeps its last values
            pass
        with self.policy.scoped(params.get("session_id")), relay.session(params.get("session_id")):
            return self._hook(params, received)

    def _hook(self, params: dict, received: float | None = None) -> dict:
        kind = params.get("kind", "")
        tool = params.get("tool_runtime_name") or params.get("tool_name") or ""

        if kind == context.KIND:
            # Advisory only; inert on hosts without context_management.
            return self.context.handle(params, self.client, self.features["context"], self.audit, goal=self.goal)

        if kind == "before_tool_call":
            if tool in router.SUBAGENT_TOOLS:
                return self.router.handle(params, self.client, self.router_cfg, self.audit, self.op_log,
                                          enabled=self.features["router"])
            # The rule-1 guard: deterministic, no model, first and alone when
            # it refuses (R-GATE: whatever the key, budget, circuit or guard
            # switch; only guard_rule1 = off stops it). Its scan is timed by
            # the same frame-receipt budget and done before the guard's.
            # The access rule (and its sandbox switch): deterministic, no model,
            # first and alone when it refuses (R-GATE, like rule 1; only
            # guard_access = off stops it).
            decided = guard.access_check(params, self.guard_cfg, self.audit, self.op_log, started=received)
            if decided is not None:
                return decided
            decided = guard.rule1_check(params, self.guard_cfg, self.audit, self.op_log, started=received)
            if decided is not None:
                return decided
            if tool in guard.RULE1_ONLY_TOOLS:  # hooked for rule 1 only: the guard does not see them
                return {"action": "continue"}
            if self.features["guard"]:
                return guard.handle(params, self.client, self.guard_cfg, self.audit, self.op_log, started=received)
            # R-GATE: the deterministic shell-safety rule needs no model, so
            # it runs with no key and with the model guard switched off too
            # (only guard_shell_rule = off stops it)
            decided = guard.shell_rule_only(params, self.guard_cfg, self.audit, self.op_log, started=received)
            if decided is not None:
                return decided
            if self.client is None and tool in self.guard_cfg.tools:
                if not self.audit.counters.get("guard.inert"):
                    log("guard inert: no API key")
                self.audit.bump("guard.inert")
            self.audit.explain("guard", "continue")
            return {"action": "continue"}

        if kind == "after_tool_call":
            if reports.collect_candidate(params):
                return self.reports.handle(params, self.client, self.features["reports"], self.audit)
            if discovery.recognized(params):
                return self.discovery.handle(params, self.client, self.features["discovery"], self.audit)
            if triage.recognized(params):
                return self.triage.handle(params, self.client, self.features["triage"], self.audit)
            if self.features["compress"]:
                return compress.handle(params, self.goal, self.client, self.compress_cfg, self.audit, self.op_log)
            self.audit.explain("compress", "disabled")
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
                "jev_diagnose prioritizes supplied hypotheses/checks only; /jev diagnosis on. "
                "jev_evidence offers descriptor relevance only, never trust or fetch permission; /jev evidence on. "
                "Opt-in /jev reports on adds unverified worker-claim advice, never lifecycle or merge authority. "
                "Enable with /jev verification on; configure the shared key with /jev key. "
                "Batch uncertain choices; skip obvious deterministic ones. Choice criteria are ID-to-description "
                "objects; score criteria are ordered lists. Bash failure triage is advisory, never authority "
                "to execute, retry, or certify success. Optional discovery recommendations are advisory, "
                "not activation/permission or authority. Under context pressure, Jev may report task boundaries "
                "to the host; this is advisory and replaces no context_checkpoint discipline. "
                "Check jev_status for active features and estimated Jev cost."
            )}

        return {"action": "continue"}

    # ── tools ───────────────────────────────────────────────────────────

    def tool_call(self, params: dict) -> dict:
        with self.policy.scoped(), relay.session(params.get("session_id")):
            return self._tool_call(params)

    def _tool_call(self, params: dict) -> dict:
        name = params.get("name")
        if name == "jev_diagnose":
            return diagnose.call_diagnose(params.get("input"), self.client, self.audit,
                                          enabled=self.features["diagnosis"])
        if name == "jev_evidence":
            return evidence.call_evidence(params.get("input"), self.client, self.audit,
                                          enabled=self.features["evidence"])
        if name == "jev_verify":
            return verify.call_verify(params.get("input"), self.client, self.audit,
                                      enabled=self.features["verification"])
        self.maybe_pick_up_key()
        tool_input = params.get("input") or {}
        if name == "jev_status":
            return tools.call_status(self.client, self.audit, self.features, self.key_source, policy=self.policy, stats=self.stats, compress_mode=self.compress_cfg.mode, log=self.log_status())
        if self.client is None:
            if name in ("jev_select", "jev_decide"):
                self.audit.explain(name[4:], "nokey")
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
_pending_inbound: list[tuple[dict, float]] = []  # (frame, time.monotonic() at receipt)


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
        _pending_inbound.append((frame, time.monotonic()))
    raise TimeoutError(f"{method}: no response within {timeout_s:.0f}s")


# ── main loop ────────────────────────────────────────────────────────────────

def dispatch(ext: Extension, req: dict, received: float | None = None) -> bool:
    """Handle one inbound frame. Returns False when the loop should stop.
    `received` is when the frame arrived (time.monotonic()). The frame's log
    lines (stderr and jev.log) are held until its reply is written and flushed."""
    STDERR.hold()
    FILELOG.hold()
    try:
        return _dispatch(ext, req, received)
    finally:
        STDERR.release()
        FILELOG.release()
        flush_limiter(ext)  # summaries of the windows that ended, after the reply


def _dispatch(ext: Extension, req: dict, received: float | None) -> bool:
    method = req.get("method")
    req_id = req.get("id")
    try:
        if method == "initialize":
            reply(req_id, ext.initialize(req.get("params") or {}))
        elif method == "hook.handle":
            reply(req_id, ext.hook(req.get("params") or {}, received))
        elif method == "tool.call":
            try:
                reply(req_id, ext.tool_call(req.get("params") or {}))
            except tools.ToolError as e:
                reply_error(req_id, -32000, str(e))
        elif method == "command.invoke":
            reply(req_id, commands.handle(req.get("params") or {}, ext, send, host_call))
        elif method == "info.get":
            reply(req_id, ext.info())
        elif method == "shutdown":
            reply(req_id, None)
            return False
        elif req_id is None:
            pass  # notification we don't handle
        else:
            reply_error(req_id, -32601, f"unknown method: {method}")
    except Exception as e:  # noqa: BLE001 — never let one bad frame kill the guard
        # Reply first, then log.
        if req_id is not None:
            if method == "hook.handle" and (req.get("params") or {}).get("kind") == "before_tool_call":
                # A crashed guard must not fail open, nor prompt under guard_confirm = auto.
                reply(req_id, guard.crash_result(getattr(ext, "guard_cfg", None)))
            elif method == "hook.handle":
                reply_error(req_id, -32603, f"internal error: {type(e).__name__}")
            else:
                reply_error(req_id, -32603, f"internal error: {e}")
        log_crash(ext, method, e)
    return True


def main() -> None:
    ext = Extension()
    STDERR.on_drop = lambda: ext.audit.bump("log.dropped")
    STDERR.make_nonblocking()
    if FILELOG.path is None:
        FILELOG.path = logs.default_path()
    host_profile.HostProfile.log = log  # one line per host profile error state
    log("started")
    running = True
    while running:
        if _pending_inbound:
            req, received = _pending_inbound.pop(0)
        else:
            try:
                req = read_frame()
            except Exception as e:  # noqa: BLE001
                log(f"framing error: {e}")
                break
            if req is None:
                break
            received = time.monotonic()
        if "method" not in req:
            continue  # stray response (e.g. late host reply) — nothing to do
        running = dispatch(ext, req, received)
    flush_limiter(ext, close=True)  # every open window's summary
    log("stopped")


if __name__ == "__main__":
    main()
