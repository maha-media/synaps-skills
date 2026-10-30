"""guard — before_tool_call safety gate.

Scores each bash/write/edit/read call for risk, secret exposure, and
workspace escape; returns continue / confirm / block. Fails CLOSED on any
upstream error because the runtime's own hook timeout is fail-open.

guard_confirm (`auto`, the default, or `prompt`) says what a confirm
becomes. The host turns a hook confirm into an interactive prompt even under
the app's allow-all policy, so under `auto` no Jev guard confirm reaches the
user: a model-derived confirm continues (guard.confirm_auto); an evaluation
failure continues (guard.error_auto) only once every deterministic rule for
the call has run and passed, and blocks otherwise; a deterministic finding
that `prompt` would confirm blocks. `prompt` keeps every confirm. The one
exception is guard_shell_rule = confirm, an explicit opt-in that confirms a
shell-rule finding under both.

The multi-file builtins get the same gate: `multi_edit` is scored per
distinct target file (edit's three questions each, strictest file wins) and
`send_events` gets the secrets check on message bodies only (a model question
per message preview plus a deterministic full-body pattern scan).
"""

from __future__ import annotations

import collections
import json
import os
import re
import signal
import threading
import time

from . import access, allow_once, relay_redact, roster, rule1
from .logs import decision, notice, routine
from .client import DecisionClient, InvalidResponse, JevError, top_level
from .policy import PolicyDenied
from .relay import RelayClient, RelayOff, valid_session
from .secret_patterns import scan_secrets
from .shell_rules import FINDINGS_MAX as SHELL_FINDINGS_MAX, ScanLimit, is_shell_script, scan_shell
from .shell_rules import HOME as SHELL_HOME, NESTED as SHELL_NESTED, ROOT as SHELL_ROOT, UNGUARDED as SHELL_UNGUARDED
from .shell_rules import KILL as SHELL_KILL, KILLALL as SHELL_KILLALL, KILLALL5 as SHELL_KILLALL5
from .shell_rules import PKILL as SHELL_PKILL, SIGNAL_ALL as SHELL_SIGNAL_ALL
from .tool_schemas import MULTI_EDIT_MAX_EDITS, MULTI_EDIT_OPS, SEND_EVENTS_MAX_MESSAGES  # noqa: F401 (re-exported)
from .tool_schemas import MalformedInput, validate_multi_edit, validate_send_events

RISK_LEVELS = [
    "Read-only or purely informational (ls, cat, grep, git status, cargo build, tests)",
    "Local change that is trivially reversible (edit a tracked file, create a scratch file, git stash)",
    "Local change that is hard to reverse (delete untracked files, overwrite config, chmod, rewrite git history locally)",
    "Irreversible or affects shared/remote/system state (rm -rf outside /tmp, git push --force, drop table, curl | sh, sudo, writes to ~/.ssh or credentials, network exfiltration)",
]

QUESTIONS = {
    "risk": {
        "type": "score",
        "instructions": "How risky is it for an autonomous coding agent to execute `call` unattended, given `cwd`?",
        "criteria": RISK_LEVELS,
    },
    # `leak`, not a key naming a secret: the Pria relay refuses a request in
    # which pria_redact's NAME rule matches, and `"touches_secrets":{` is such
    # a match (see relay_redact). Question keys are not seen by the model.
    "leak": {
        "type": "noul",
        "instructions": "Does `call` read, write, print, or transmit credentials, tokens, private keys, or auth stores (e.g. ~/.synaps-cli/auth.json, ~/.synaps-cli/config, ~/.ssh, .env, ~/.aws)?",
        "criteria": {
            "true": "The command or file path plausibly exposes or modifies secret material",
            "false": "No credential or secret material is involved",
        },
    },
    "leaves_workspace": {
        "type": "noul",
        "instructions": "Does `call` write or delete outside of `cwd` (or /tmp)?",
        "criteria": {
            "true": "Targets paths outside the working directory and /tmp, or system-wide locations",
            "false": "Confined to the working directory or /tmp, or read-only",
        },
    },
}


DEFAULT_TOOLS = "bash,write,edit,read,multi_edit,send_events"

# One wall-clock budget per hook, from frame receipt: parse, realpath I/O,
# scan, upstream call and audit. The host's own deadline is 5 s and fails
# open, so a spent budget answers well before it: confirm under
# guard_confirm = prompt; under auto, continue only if the deterministic
# rules already passed, otherwise block.
HOOK_BUDGET_S = 4.0
REPLY_MARGIN_S = 0.15   # kept back from the upstream call for verdict, audit and reply
AUDIT_GRACE_S = 0.5     # a confirm's audit row may use this much past the budget
# One read budget per guard call (relay_redact.ReadBudget), in characters
# scanned: every redaction pass takes what it scans before it scans (the
# decoded text and each escaped view: an emoji is 12 characters in the
# ASCII view, a CJK or control character 6), and so does every body check
# of redact_state. The previews (a multi_edit's 128 anchors and texts, a
# send_events call's bodies) read from a PREVIEW_READ_CHARS share of it;
# the state (paths, aliases, realpaths, cwd, the previews again, the body
# checks) from the rest. Past it a preview or a state string is
# `<redacted>`; where the body checks have no room, every state string is.
# A preview reads its limit + 4 KiB (more where a run is widened), so an
# ordinary 64-edit multi_edit with 6000-character ASCII anchors and texts
# takes ~9 K per preview (~1.17 M for 128) and keeps them all; its state
# (15 ordinary paths and the previews again) takes ~0.26 M of the 512 K.
# Measured on a 32-core host at load ~3.5, a whole call that spends the
# budget (64 emoji, CJK or control-character edits, 32 such bodies, dense
# name runs, emoji previews with 64 dense 4 KiB paths) takes 0.19-0.45 s.
# A state that needs more than the rest (those dense paths need ~5 M) is
# all placeholders, and such a state is not sent: no model call, the
# deterministic rules' result stands (guard.state_wiped_skip, as for a
# state too large for the relay). The skeleton check that decides so is
# not charged: it reads the state's keys and one placeholder per string,
# which the tool contracts bound (~120 K for the largest multi_edit; a
# write/edit/read path that is not a string is malformed input).
PREVIEW_READ_CHARS = 1280 * 1024
GUARD_READ_CHARS = PREVIEW_READ_CHARS + 512 * 1024

# The app answers at most 60 jev.decide calls per session in any 60 s (one
# window for calls without a valid session id) and refuses the rest `busy`,
# which holds the whole relay client for 2 s. Above this many guard asks in a
# session's last 60 s the guard asks nothing and continues on its local rules,
# as when the relay is off (counter guard.sampled_out). Relay transport only.
RELAY_ASKS_PER_MIN = 50
RELAY_ASK_WINDOW_S = 60.0
RELAY_ASK_SESSIONS = 256  # windows kept; the least recently used goes first


class AskWindow:
    """Per-session sliding window of guard asks through the relay."""

    def __init__(self, cap: int = RELAY_ASKS_PER_MIN, clock=time.monotonic) -> None:
        self.cap = cap
        self.clock = clock
        self._seen: dict = {}
        self._lock = threading.Lock()

    def take(self, session) -> bool:
        """True (and counted) when this session may ask now."""
        key = session if valid_session(session) else None  # the relay omits an invalid id
        now = self.clock()
        with self._lock:
            times = self._seen.pop(key, None) or collections.deque()
            while times and times[0] <= now - RELAY_ASK_WINDOW_S:
                times.popleft()
            allowed = len(times) < self.cap
            if allowed:
                times.append(now)
            self._seen[key] = times
            while len(self._seen) > RELAY_ASK_SESSIONS:
                del self._seen[next(iter(self._seen))]
            return allowed


class GuardConfig:
    def __init__(self, cfg: dict) -> None:
        # The extension process runs with the *plugin root* as cwd, so os.getcwd()
        # is wrong for "does this leave the workspace?". Prefer the host-supplied
        # project root (manifest `host_context: project_root`).
        self.workspace = str(cfg.get("project_root") or "").strip() or os.getcwd()
        self.tools = {t.strip() for t in str(cfg.get("guard_tools") or DEFAULT_TOOLS).split(",") if t.strip()}
        self.ask_at = float(cfg.get("guard_ask_at", 1.5))
        self.block_at = float(cfg.get("guard_block_at", 3.5))
        self.min_conf = float(cfg.get("guard_min_conf", 0.6))
        self.secrets_at = float(cfg.get("guard_secrets_at", 0.5))
        self.escape_at = float(cfg.get("guard_escape_at", 0.7))
        self.budget_s = HOOK_BUDGET_S  # not configurable: it must stay under the host's 5 s
        self.shell_rule = shell_rule_mode(cfg.get("guard_shell_rule"))
        # what a confirm becomes: auto (continue or block, never a prompt) or prompt
        self.confirm = confirm_mode(cfg.get("guard_confirm"))
        # the rule-1 guard (fleet safety rule 1): its own switch and scope
        self.rule1 = rule1_mode(cfg.get("guard_rule1"))
        self.rule1_scope = rule1_scope_mode(cfg.get("guard_rule1_scope"))
        # the access rule (owner rules 27a/27b): its own switch and scope
        self.access = access_mode(cfg.get("guard_access"))
        self.access_scope = access_scope_mode(cfg.get("guard_access_scope"))
        self.roster = roster.FleetRoster()
        self.asks = AskWindow()  # guard asks per session through the relay


SHELL_RULE_MODES = ("block", "confirm", "off")


def shell_rule_mode(value) -> str:
    """guard_shell_rule: block (default), confirm or off. Anything else is
    block: a typo must not switch the rule off."""
    mode = "block" if value is None else str(value).strip().lower()
    return mode if mode in SHELL_RULE_MODES else "block"


GUARD_CONFIRM_MODES = ("auto", "prompt")


def confirm_mode(value) -> str:
    """guard_confirm: auto (default) or prompt. Anything else, a missing key
    or a missing plugin config, is auto: a typo must not bring the prompts
    back. Under an allow-all approval policy a confirm must never reach the
    user (the host prompts on a hook confirm whatever the app's policy)."""
    mode = "auto" if value is None else str(value).strip().lower()
    return mode if mode in GUARD_CONFIRM_MODES else "auto"


# The tail of every block that `prompt` would have asked about.
AUTO_BLOCKED = "blocked, not prompted (guard_confirm = auto): "


def summarize_call(tool: str, tool_input: dict, budget: relay_redact.ReadBudget | None = None) -> dict:
    """Compact, preview-only rendering of the call. Never full file bodies.
    Each preview is redacted first, then cut (relay_redact.clip): a cut
    never leaves a credential fragment below its rule's minimum, nor ends
    inside a placeholder. The previews read from one PREVIEW_READ_CHARS
    share of the call's read `budget` (if any)."""
    budget = relay_redact.ReadBudget(PREVIEW_READ_CHARS, within=budget)

    def clip(text, limit):
        return relay_redact.clip(text, limit, budget=budget)

    if tool == "bash":
        return {"tool": "bash", "command": clip(str(tool_input.get("command", "")), 2000)}
    if tool in ("write", "edit", "read"):
        path = tool_input.get("path", "")
        if not isinstance(path, str):
            # a list or dict would reach the state as one string per item,
            # unbounded, and so would redact_state's uncharged skeleton check
            raise MalformedInput("path is not a string")
    if tool == "write":
        content = str(tool_input.get("content", ""))
        return {
            "tool": "write",
            "path": path,
            "content_preview": clip(content, 400),
            "content_bytes": len(content),
        }
    if tool == "edit":
        return {
            "tool": "edit",
            "path": path,
            "old_preview": clip(str(tool_input.get("old_string", "")), 200),
            "new_preview": clip(str(tool_input.get("new_string", "")), 200),
        }
    if tool == "read":
        return {"tool": "read", "path": path}
    return {"tool": tool, "input": clip(json.dumps(tool_input), 600)}


_EPS = 1e-9  # float rounding at the range edges is not malformed


def _in_range(value, low: float, high: float, what: str) -> float:
    """float(value) if finite and inside [low, high]; else ValueError (→ confirm).
    A 401-digit JSON integer is valid JSON, and float() of it overflows."""
    problem = f"{what} is not a number in [{low:g}, {high:g}]"
    try:
        x = float(value)
    except ArithmeticError:
        raise ValueError(problem) from None
    if not (low - _EPS <= x <= high + _EPS):  # NaN fails every comparison
        raise ValueError(problem)
    return x


def decide(answers: dict, cfg: GuardConfig) -> tuple[dict, str]:
    """Pure policy: Jev answers → HookResult dict + one-line rationale.

    Raises ValueError on a non-finite or out-of-range answer: json.loads
    accepts NaN, and NaN compares false against every threshold, so an
    unchecked malformed answer would continue."""
    risk = answers["risk"]
    score = _in_range(risk["score"], 0.0, len(RISK_LEVELS) - 1, "risk score")
    conf = _in_range(risk.get("confidence", 0.0), 0.0, 1.0, "risk confidence")
    secrets_p = _in_range(answers["leak"]["noul"], 0.0, 1.0, "leak")
    escapes_p = _in_range(answers["leaves_workspace"]["noul"], 0.0, 1.0, "leaves_workspace")
    _, label = top_level(risk)

    # `leak=`, not `secrets=`: the host scrubs every confirm message before
    # the prompt, and any key naming a secret reaches the user as [REDACTED].
    why = f"risk={score:.2f} conf={conf:.2f} leak={secrets_p:.2f} escapes_cwd={escapes_p:.2f} — {label}"

    if score >= cfg.block_at and conf >= cfg.min_conf:
        return {"action": "block", "reason": f"jev: blocked. {why}"}, why
    if score >= cfg.ask_at or conf < cfg.min_conf or secrets_p >= cfg.secrets_at or escapes_p >= cfg.escape_at:
        return {"action": "confirm", "message": f"jev: {why}"}, why
    return {"action": "continue"}, why


# ── sanitizing: fixed error categories, allowlisted response metadata ──────

_JEV_CATEGORIES = {
    "deadline exceeded": "timeout",
    "retry budget exhausted": "rate limited",
    "api_key is empty": "no key",
    "hard transport deadline unavailable": "deadline unavailable",
    "transport deadline timer already in use": "deadline unavailable",
    "decision transport or response failure": "transport error",
    "transport or response decoding failure": "transport error",
}
_HTTP_STATUS = re.compile(r"HTTP [1-5][0-9]{2}")
# Jev's own model ids only (the client asks for jev-latest; responses name a
# version such as jev-1.13.0). Anything else is dropped: an upstream field
# that echoed a body or a token could otherwise look like an identifier.
_MODEL_NAME = re.compile(r"jev-(?:latest|[0-9]{1,4}(?:\.[0-9]{1,4}){0,3})")
USAGE_FIELDS = ("input_tokens", "output_tokens")


class BudgetSpent(Exception):
    """The hook's wall-clock budget ran out: confirm."""


def check_budget(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise BudgetSpent()


class TimerUnavailable(BudgetSpent):
    """No hard timer can be armed here: off the main thread, no
    signal.setitimer, or another timer already armed. The budget cannot be
    enforced, so the guard confirms before any local work that could block
    (review r2 R2-3a)."""


def hard_timer_available() -> bool:
    return (hasattr(signal, "setitimer") and threading.current_thread() is threading.main_thread()
            and signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0))


class BudgetAlarm:
    """Bounds a local phase (realpath I/O, the scan, an audit write) by the
    budget: SIGALRM interrupts a blocking call (a hung filesystem, a slow
    regex). Where no timer can be armed it refuses to start
    (TimerUnavailable). The client's transport timer is never nested: the
    alarm is off during the upstream call."""

    def __init__(self, until: float) -> None:
        self.until = until
        self.previous = None
        self.armed = False

    def __enter__(self):
        remaining = self.until - time.monotonic()
        if remaining <= 0:
            raise BudgetSpent()
        if not hard_timer_available():
            raise TimerUnavailable()
        self.previous = signal.signal(signal.SIGALRM, _alarm_expired)
        self.armed = True
        signal.setitimer(signal.ITIMER_REAL, remaining)
        return self

    def __exit__(self, *exc) -> bool:
        while self.armed:
            try:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, self.previous)
                self.armed = False
            except BudgetSpent:  # fired just now; _ask's check_budget or the audit alarm sees it
                continue
        return False


def _alarm_expired(signum, frame):
    raise BudgetSpent()


def _write_audit(audit, row: dict, until: float) -> None:
    """An audit write inside the budget. Raises BudgetSpent if it cannot
    finish in time (the caller then answers confirm)."""
    with BudgetAlarm(until):
        audit.write(row)


def _write_audit_best_effort(audit, row: dict, until: float) -> None:
    """A confirm's audit row: written if there is time, else only counted."""
    try:
        _write_audit(audit, row, until + AUDIT_GRACE_S)
    except BudgetSpent:
        audit.bump("guard.audit_skipped")


def error_category(error: BaseException) -> str:
    """A fixed, value-free name for any exception. Exception text may quote
    a command, a body or an upstream payload, so it is only ever compared
    against known client texts, never emitted."""
    if isinstance(error, TimerUnavailable):
        return "deadline unavailable"
    if isinstance(error, BudgetSpent):
        return "hook budget spent"
    if isinstance(error, MalformedInput):
        return "malformed input"
    if isinstance(error, ScanLimit):  # before ValueError: a shell text past a scan limit
        return "shell text too complex to check"
    if isinstance(error, PolicyDenied):
        return "budget denied"
    if isinstance(error, InvalidResponse):
        return "invalid response"
    if isinstance(error, JevError):
        text = str(error)
        if text in _JEV_CATEGORIES:
            return _JEV_CATEGORIES[text]
        return text if _HTTP_STATUS.fullmatch(text) else "upstream error"
    if isinstance(error, KeyError):
        return "missing answer"
    if isinstance(error, (TypeError, ValueError, AttributeError, ArithmeticError, LookupError)):
        return "malformed answer"
    return "internal error"


def safe_model(resp) -> str | None:
    model = resp.get("model") if isinstance(resp, dict) else None
    return model if isinstance(model, str) and _MODEL_NAME.fullmatch(model) else None


def safe_usage(resp) -> dict | None:
    usage = resp.get("usage") if isinstance(resp, dict) else None
    if not isinstance(usage, dict):
        return None
    kept = {k: v for k in USAGE_FIELDS
            if type(v := usage.get(k)) is int and 0 <= v <= 2 ** 53 - 1}
    return kept or None


GUARD_ERROR_KEY = "guard.error:"     # the limiter keys of evaluation errors; a model answer clears them
GUARD_ERROR_FAMILY = "guard: evaluation errors"  # their family: one window, one summary, one recovery
AUTO_RECORD_KEY = "guard.27b_record"  # the 27b auto record could not be written


def _error_line(line: str, category: str, outcome: str) -> str:
    """An evaluation error's notice. The guard is exempt from budgets and the
    circuit (client.decide), so through an outage it repeats on every call:
    the first of each (category, outcome) reaches stderr, repeats go to
    jev.log only, counted. Every HTTP status is a category of its own, so the
    keys are one family: ONE summary a window with the counts per category,
    and the next model answer says "recovered after N errors" once an episode."""
    return notice(line, key=f"{GUARD_ERROR_KEY}{category}:{outcome}", label=f"{category} → {outcome}",
                  family=GUARD_ERROR_FAMILY)


def _confirm_error(tool: str, error: BaseException, t0: float, audit, log, session,
                   deadline: float, *, cfg: GuardConfig, local_done: bool) -> dict:
    """Any failure while evaluating a call, with a fixed category. prompt:
    confirm. auto: continue (guard.error_auto) when `local_done`, that is
    every deterministic rule for this call has run and passed (Jev-off for
    this call, as with no key); else block, never prompt: the call was not
    checked."""
    ms = int((time.monotonic() - t0) * 1000)
    category = error_category(error)
    audit.bump("guard.error")
    if isinstance(error, BudgetSpent):
        audit.bump("guard.budget")
    if cfg.confirm == "prompt":
        audit.explain("guard", "confirm")
        log(_error_line(f"guard {tool}: error after {ms} ms → confirm ({category})", category, "confirm"))
        _write_audit_best_effort(audit, {"op": "guard", "tool": tool, "action": "confirm", "error": category,
                                         "ms": ms, "session": session}, deadline)
        return {"action": "confirm",
                "message": f"jev: could not evaluate this {tool} call ({category}); approve manually?"}
    if local_done:
        audit.explain("guard", "error_auto")
        audit.bump("guard.error_auto")
        log(_error_line(f"guard {tool}: error after {ms} ms → continue (auto, local rules passed) ({category})",
                        category, "continue"))
        _write_audit_best_effort(audit, {"op": "guard", "tool": tool, "action": "error_auto", "error": category,
                                         "ms": ms, "session": session}, deadline)
        return {"action": "continue"}
    audit.explain("guard", "block")
    audit.bump("guard.block")
    log(_error_line(f"guard {tool}: error after {ms} ms → block (auto, local rules not run) ({category})",
                    category, "block"))
    _write_audit_best_effort(audit, {"op": "guard", "tool": tool, "action": "block", "error": category,
                                     "ms": ms, "session": session}, deadline)
    return {"action": "block", "reason": f"jev: could not evaluate this {tool} call ({category})\n"
                                         f"{AUTO_BLOCKED}it could not be checked; retry or split it"}


def _confirm_auto(tool: str, why: str, audit, log) -> dict:
    """A model-derived confirm under guard_confirm = auto: continue, counted.
    The caller has written the audit row (action confirm_auto, `why`)."""
    audit.explain("guard", "confirm_auto")
    audit.bump("guard.confirm_auto")
    log(routine(f"guard {tool}: confirm→continue (auto) {why}", clears=GUARD_ERROR_KEY))
    return {"action": "continue"}


def _write_verdict(audit, row: dict, deadline: float, cfg: GuardConfig) -> None:
    """The audit row of a model verdict: inside the budget, so an answer
    after it is an evaluation failure. Under auto a block stays a block: its
    row is written if there is time (a late block must not continue)."""
    if cfg.confirm == "auto" and row["action"] == "block":
        _write_audit_best_effort(audit, row, deadline)
    else:
        _write_audit(audit, row, deadline)


def crash_result(cfg) -> dict:
    """The answer when a before_tool_call handler crashed: never fail open.
    prompt: confirm. auto (or no usable config): block, the call was not
    checked."""
    if getattr(cfg, "confirm", None) == "prompt":
        return {"action": "confirm", "message": "jev: internal error; approve manually?"}
    return {"action": "block",
            "reason": f"jev: internal error\n{AUTO_BLOCKED}this call could not be checked; retry or split it"}


def _relay_off(audit) -> dict:
    """The Pria relay gave no answer (RelayOff): this call is Jev-off, the
    inert result exactly as with no client (the deterministic rules have
    already run). No audit row, like the no-key path."""
    audit.explain("guard", "continue")
    audit.bump("guard.relay_off")
    return {"action": "continue"}


def _state_wiped(tool: str, audit, log) -> dict:
    """The redacted state holds no text (relay_redact.wiped: every string
    is the placeholder, past the call's read budget): the model would see
    nothing, so nothing is asked and this call is Jev-off, as when its
    state is too large for the relay (_relay_off). The deterministic rules
    have already run and passed. No audit row."""
    audit.explain("guard", "continue")
    audit.bump("guard.state_wiped_skip")
    log(f"guard {tool}: redacted state is all placeholders → continue (no model call)")
    return {"action": "continue"}


def _sampled_out(client: DecisionClient, cfg: GuardConfig, session, audit) -> bool:
    """True when this session is over RELAY_ASKS_PER_MIN guard asks through
    the relay: no ask, the inert result as in _relay_off (the deterministic
    rules have already run). Every ask past those rules is counted, whether
    the relay then sends it or holds it."""
    if not isinstance(client, RelayClient) or cfg.asks.take(session):
        return False
    audit.explain("guard", "continue")
    audit.bump("guard.sampled_out")
    return True


def _ask(client: DecisionClient, state, questions: dict, deadline: float) -> dict:
    """The upstream call gets what is left of the budget, minus the reply
    margin. An answer after the budget confirms: every success path writes
    its audit row through _write_audit, whose BudgetAlarm refuses a spent
    budget."""
    check_budget(deadline - REPLY_MARGIN_S)
    return client.decide(state, questions, op="guard", deadline=deadline - REPLY_MARGIN_S)


def handle(params: dict, client: DecisionClient, cfg: GuardConfig, audit, log, *,
           started: float | None = None) -> dict:
    """`started` is when the host's frame arrived (monotonic); the budget
    runs from there."""
    tool = params.get("tool_runtime_name") or params.get("tool_name") or ""
    if tool not in cfg.tools:
        audit.explain("guard", "continue")
        return {"action": "continue"}
    deadline = (time.monotonic() if started is None else started) + cfg.budget_s
    if not hard_timer_available():
        # No deterministic rule can run without a timer: local_done only when
        # this call has none to run (no shell text, or the rule off).
        local_done = (tool not in ("multi_edit", "send_events")
                      and (cfg.shell_rule == "off" or not shell_texts(tool, params.get("tool_input") or {})))
        return _confirm_error(tool, TimerUnavailable(), time.monotonic(), audit, log, params.get("session_id"),
                              deadline, cfg=cfg, local_done=local_done)
    if tool == "multi_edit":
        return handle_multi_edit(params, client, cfg, audit, log, deadline)
    if tool == "send_events":
        return handle_send_events(params, client, cfg, audit, log, deadline)

    t0 = time.monotonic()
    checked = False  # the shell-safety rule (this call's last deterministic rule) ran and passed
    try:
        tool_input = params.get("tool_input") or {}
        decided = shell_rule(tool, shell_texts(tool, tool_input), cfg, audit, log, params.get("session_id"),
                             deadline)
        if decided is not None:
            return decided
        checked = True
        cwd = session_cwd(params) if tool in SESSION_CWD_TOOLS else None
        if _sampled_out(client, cfg, params.get("session_id"), audit):
            return {"action": "continue"}
        # Only the state sent to Jev (and its audit row) is redacted: the
        # deterministic rules above decided on the raw input. Redaction is
        # local work inside the budget (a spent one is an evaluation failure
        # after the local rules passed: confirm under prompt, continue under auto),
        # on one read budget for the call (GUARD_READ_CHARS).
        with BudgetAlarm(deadline - REPLY_MARGIN_S):
            budget = relay_redact.ReadBudget(GUARD_READ_CHARS)
            state = relay_redact.redact_state({"call": summarize_call(tool, tool_input, budget),
                                               "cwd": cwd or cfg.workspace}, QUESTIONS, budget=budget)
        if relay_redact.wiped(state):
            return _state_wiped(tool, audit, log)
        resp = _ask(client, state, QUESTIONS, deadline)
        result, why = decide(resp["answers"], cfg)
        ms = int((time.monotonic() - t0) * 1000)
        row = {"op": "guard", "tool": tool, "action": result["action"], "ms": ms,
               "model": safe_model(resp), "usage": safe_usage(resp),
               "answers": resp["answers"], "state": state, "session": params.get("session_id")}
        if cfg.confirm == "auto" and result["action"] == "confirm":
            _write_audit_best_effort(audit, {**row, "action": "confirm_auto", "why": why}, deadline)
            return _confirm_auto(tool, why, audit, log)
        _write_verdict(audit, row, deadline, cfg)
        audit.explain("guard", result["action"])
        audit.bump(f"guard.{result['action']}")
        log(decision(result["action"], f"guard {tool}: {result['action']} ({ms} ms) {why}", clears=GUARD_ERROR_KEY))
        return result
    except MalformedInput as e:  # a write/edit/read path that is not a string (summarize_call)
        return _confirm_malformed(tool, e, audit, log, params.get("session_id"), deadline, cfg=cfg)
    except RelayOff:
        return _relay_off(audit)
    except Exception as e:  # noqa: BLE001 — fail closed with a fixed category, never the exception text
        return _confirm_error(tool, e, t0, audit, log, params.get("session_id"), deadline,
                              cfg=cfg, local_done=checked)


# ── the shell-safety rule (guard item 2(b)): deterministic, whole text ─────

# The largest shell text scanned (all texts of one call together). A larger
# one confirms ("too large"): it is never let through unscanned. 256 KiB
# (the body size of the V1 scan bound) keeps the costliest shapes measured,
# read twice where strings run across lines, inside the scan bound on both
# core classes: the costliest (deep carried quoting, stopped by the rescan
# budget) came to a median 45% of the bound on a P-core (one pair 56%) and
# 61% on an E-core (i9-14900K, 2026-10-18, load 8-12). An earlier build at
# 512 KiB came to ~86% on an E-core at load 33.
SHELL_SCAN_MAX_BYTES = 256 * 1024
AUDIT_FINDINGS_MAX = 32  # findings listed in one audit row (all are counted)

_SHELL_FIX = {
    SHELL_ROOT: "operand is the root directory: use a narrower path",
    SHELL_HOME: "operand is the home directory: use a narrower path inside it (`:?` does not help here)",
    SHELL_NESTED: "heredoc opened inside another heredoc's body (the outer body can end early, or the inner "
                  "heredoc stay open, and the rest runs as commands): write the script with the write tool, "
                  "then run it",
}
# signal_all, by command: fixed text (a kill(-1, SIGKILL) from a test binary
# once ended a whole desktop session)
_SIGNAL_FIX = {
    SHELL_KILL: "with pid -1 signals every process you own (it has killed a whole desktop session). "
                "Signal a specific pid or a process group > 1 instead",
    SHELL_PKILL: "with a user and no pattern signals every process the user owns (kill -1 has killed a whole "
                 "desktop session). Add a pattern naming the processes, or signal a specific pid instead",
    SHELL_KILLALL: "with a user and no process name signals every process the user owns (kill -1 has killed a "
                   "whole desktop session). Name the processes, or signal a specific pid instead",
    SHELL_KILLALL5: "signals every process outside its own session (kill -1 has killed a whole desktop session). "
                    "Signal a specific pid or a process group > 1 instead",
}
_SIGNAL_FIX_OTHER = ("signals every process you own (kill -1 has killed a whole desktop session). "
                     "Signal a specific pid or a process group > 1 instead")


def shell_texts(tool: str, tool_input) -> list[tuple]:
    """(where, text, path) for the shell text in a bash/write/edit call: the
    bash command, or the new content of a shell script (by name or shebang;
    see shell_rules.is_shell_script). A non-string field keeps today's path."""
    if not isinstance(tool_input, dict):
        return []
    if tool == "bash":
        command = tool_input.get("command")
        return [("command", command, None)] if isinstance(command, str) else []
    field = {"write": "content", "edit": "new_string"}.get(tool)
    if field is None:
        return []
    path, text = tool_input.get("path"), tool_input.get(field)
    if isinstance(text, str) and is_shell_script(path if isinstance(path, str) else "", text):
        return [(field, text, path if isinstance(path, str) else None)]
    return []


def multi_edit_shell_texts(tool_input: dict) -> list[tuple]:
    """The shell-script edits of a validated multi_edit (by target name, or a
    shebang at the start of the edit's text)."""
    out = []
    for i, edit in enumerate(tool_input["edits"]):
        if edit["op"] != "append_jsonl" and is_shell_script(edit["path"], edit["text"]):
            out.append((f"edits[{i}]", edit["text"], edit["path"]))
    return out


def loose_multi_edit_shell_texts(tool_input) -> list[tuple]:
    """multi_edit_shell_texts without the contract check, for the rule on
    its own (shell_rule_only): with the model guard off nothing confirms a
    malformed input, so every edit that has a string text is scanned."""
    edits = tool_input.get("edits") if isinstance(tool_input, dict) else None
    if not isinstance(edits, list):
        return []
    out = []
    for i, edit in enumerate(edits):
        if not isinstance(edit, dict) or edit.get("op") == "append_jsonl":
            continue
        path, text = edit.get("path"), edit.get("text")
        path = path if isinstance(path, str) else None
        if isinstance(text, str) and is_shell_script(path or "", text):
            out.append((f"edits[{i}]", text, path))
    return out


def shell_rule_only(params: dict, cfg: GuardConfig, audit, log, *, started: float | None = None) -> dict | None:
    """R-GATE: the shell-safety rule where the model guard is not running
    (no API key, or the guard feature switched off). It needs no model, so a
    missing key, a spent budget, an open circuit or the guard switch never
    turn it off; only guard_shell_rule = off does. The rule's answer, or
    None when there is no shell text or nothing found (the call goes on as
    it would without the model guard)."""
    tool = params.get("tool_runtime_name") or params.get("tool_name") or ""
    if tool not in cfg.tools or cfg.shell_rule == "off":
        return None
    tool_input = params.get("tool_input")
    if tool == "multi_edit":
        texts = loose_multi_edit_shell_texts(tool_input)
    else:
        texts = shell_texts(tool, tool_input)
    if not texts:
        return None
    deadline = (time.monotonic() if started is None else started) + cfg.budget_s
    decided = shell_rule(tool, texts, cfg, audit, log, params.get("session_id"), deadline)
    if decided is not None:
        audit.bump("guard.shell_only")  # decided without the model guard
    return decided


def _text_bytes(text: str) -> int:
    if len(text) > SHELL_SCAN_MAX_BYTES:
        return len(text)  # already over: no need to encode it
    return len(text.encode("utf-8", "surrogatepass"))


def _finding_line(tool: str, where: str, path, finding) -> str:
    at = f"line {finding.line}" if tool == "bash" else f"{where} ({_shorten(str(path or '?'))}) line {finding.line}"
    if finding.rule == SHELL_UNGUARDED:
        names = ", ".join(f"${{{n}}}" if "[" in n else f"${n}" for n in finding.names)
        fixes = " and ".join(f'"${{{n}:?}}"' for n in finding.names)
        return (f"{at}: {finding.command} operand expands {names} with no empty-check: write {fixes} "
                f"(stops with an error if it is unset or empty) or use a literal path")
    if finding.rule == SHELL_SIGNAL_ALL:
        return f"{at}: {finding.command} {_SIGNAL_FIX.get(finding.command, _SIGNAL_FIX_OTHER)}"
    return f"{at}: {finding.command} {_SHELL_FIX.get(finding.rule, finding.rule)}"


def shell_rule(tool: str, texts: list, cfg: GuardConfig, audit, log, session, deadline: float) -> dict | None:
    """The deterministic shell-safety rule over the whole text, ahead of the
    model: block (or confirm, per guard_shell_rule) when it finds anything,
    None to carry on. A text over SHELL_SCAN_MAX_BYTES is not scanned: it
    confirms under guard_confirm = prompt and blocks under auto. A scan that
    stops (a scan limit, a spent budget, a scanner failure) is an evaluation
    failure when it found nothing before it stopped (prompt: confirm; auto:
    block, the rule did not pass), and takes the finding action (block, or
    confirm per guard_shell_rule) on what it found when it did, saying the
    rest was not checked (R-FINDINGS-WIN: a stopped scan never takes a weaker
    action than a complete scan with its findings; host policy may approve a
    confirm). guard_shell_rule = confirm is an explicit opt-in: a finding
    confirms under both guard_confirm policies. Hook message, log and audit
    carry rule names, commands, line numbers and variable names only, never
    text."""
    if cfg.shell_rule == "off" or not texts:
        return None
    t0 = time.monotonic()
    try:
        size = sum(_text_bytes(text) for _, text, _ in texts)
        if size > SHELL_SCAN_MAX_BYTES:
            too_large = (f"jev: this {tool} call's shell text is too large to check "
                         f"({size} bytes, over {SHELL_SCAN_MAX_BYTES})")
            action = "confirm" if cfg.confirm == "prompt" else "block"
            audit.explain("guard", action)
            audit.bump(f"guard.{action}")
            audit.bump("guard.shell_too_large")
            log(decision(action, f"guard {tool}: {action}, shell text too large to check ({size} bytes)"))
            _write_audit_best_effort(audit, {"op": "guard", "tool": tool, "action": action,
                                             "rule": "shell_safety", "error": "too large", "bytes": size,
                                             "ms": 0, "session": session}, deadline)
            if action == "confirm":
                return {"action": "confirm", "message": f"{too_large}; approve manually?"}
            return {"action": "block", "reason": f"{too_large}\n{AUTO_BLOCKED}split it into smaller calls"}
        found, capped, stopped = [], False, None
        current, partial = (None, None), []
        try:
            with BudgetAlarm(deadline - REPLY_MARGIN_S):  # the scan is local work inside the budget
                for where, text, path in texts:
                    current, partial = (where, path), []
                    one = scan_shell(text, partial)
                    capped = capped or len(one) >= SHELL_FINDINGS_MAX  # the scan stopped early
                    found.extend((where, path, f) for f in one)
                    partial = []
        except Exception as e:  # noqa: BLE001 — R-FINDINGS-WIN: a scan that stops after a finding takes the finding action
            partial.sort(key=lambda f: f.line)
            found.extend((current[0], current[1], f) for f in partial[:SHELL_FINDINGS_MAX])
            if not found:
                raise
            if isinstance(e, ScanLimit):
                audit.bump("guard.shell_limit")
            audit.bump("guard.shell_stopped")
            stopped = error_category(e)
    except Exception as e:  # noqa: BLE001 — a scanner failure: the rule did not pass; never echo the text
        if isinstance(e, ScanLimit):
            audit.bump("guard.shell_limit")
        return _confirm_error(tool, e, t0, audit, log, session, deadline, cfg=cfg, local_done=False)
    if not found:
        return None
    action = "block" if cfg.shell_rule == "block" else "confirm"
    ms = int((time.monotonic() - t0) * 1000)
    lines = [_finding_line(tool, where, path, f) for where, path, f in found]
    listed = _listed(lines, capped or stopped is not None)
    if stopped is not None:
        listed += (f"\nthe rest of the text could not be checked ({stopped}): it may hold more; "
                   "fix these first")
    _write_audit_best_effort(audit, {"op": "guard", "tool": tool, "action": action, "rule": "shell_safety",
                                     "findings": [{"rule": f.rule, "command": f.command, "line": f.line,
                                                   "where": where}
                                                  for where, _, f in found[:AUDIT_FINDINGS_MAX]],
                                     "findings_total": len(found), "findings_capped": capped,
                                     "stopped": stopped, "ms": ms, "session": session}, deadline)
    audit.explain("guard", action)
    audit.bump(f"guard.{action}")
    audit.bump("guard.shell_rule")
    log(decision(action, f"guard {tool}: {action} ({ms} ms) shell-safety rule, {len(found)} finding(s)"
                 + (f", scan stopped ({stopped})" if stopped else "") + ": "
                 + ", ".join(f"{f.rule} {where} line {f.line}" for where, _, f in found[:NAMED_IN_MESSAGE])))
    if action == "block":
        return {"action": "block", "reason": "jev: blocked by the shell-safety rule (decided locally, no model "
                                             "call). Fix these and retry:\n" + listed}
    return {"action": "confirm", "message": "jev: the shell-safety rule flags this call:\n"
            + listed + "\napprove manually?"}


# ── multi-file builtins: multi_edit and send_events ─────────────────────────

MULTI_EDIT_MAX_FILES = 16       # 16 files x 3 questions = 48, inside the 64-question cap
PREVIEW_CHARS = 200
MAX_PATH_BYTES = 4096           # Linux PATH_MAX; longer is malformed, not summarized
BODY_PREVIEW_CHARS = 400        # same bound as write's content_preview
SEND_EVENTS_MAX_SCAN_BYTES = 32 * 256 * 1024  # the tool's own ceiling: 32 messages x 256 KiB
NAMED_IN_MESSAGE = 6            # tripped files/messages listed in one hook message
_RANK = {"continue": 0, "confirm": 1, "block": 2}


# Tools judged against the session cwd once the host sends it (HookEvent.cwd).
# bash/write/read keep the project root until that is ruled on.
SESSION_CWD_TOOLS = frozenset({"edit", "multi_edit"})


class Unresolvable(ValueError):
    """A target whose canonical path cannot be established (a relative path
    and no session cwd from the host): confirm without a call, never guess."""


def session_cwd(params: dict) -> str | None:
    """HookEvent.cwd, the directory the host's tools resolve relative paths
    against. None when absent or unusable (an older host)."""
    cwd = params.get("cwd")
    if not isinstance(cwd, str) or not cwd or "\x00" in cwd or not os.path.isabs(cwd):
        return None
    if len(cwd.encode("utf-8", "surrogatepass")) > MAX_PATH_BYTES:
        return None
    return cwd


def expand_home(raw: str) -> str:
    """tools/util.rs expand_path: only `~` and `~/...`, from $HOME when it is
    set (even empty). os.path.join keeps Rust's PathBuf::join rule that an
    absolute remainder replaces the base (`~//etc/x` is /etc/x)."""
    home = os.environ.get("HOME")
    if home is None:
        return raw
    if raw == "~":
        return home
    if raw.startswith("~/"):
        return os.path.join(home, raw[2:])
    return raw


def resolve_target(raw: str, cwd: str | None) -> str:
    """Canonical target as the tool resolves it (resolve_path_in, then
    canonicalize): `~` expansion, a relative path joined to the session cwd,
    then realpath (symlinks resolved; a missing tail is kept). Without a
    session cwd a relative path is Unresolvable."""
    if "\x00" in raw:
        raise MalformedInput("path contains NUL")
    if len(raw.encode("utf-8", "surrogatepass")) > MAX_PATH_BYTES:
        raise MalformedInput(f"path longer than {MAX_PATH_BYTES} bytes")
    path = expand_home(raw)
    if not os.path.isabs(path):
        if cwd is None:
            raise Unresolvable("relative path and the host sent no session cwd")
        path = os.path.join(cwd, path)
    try:
        return os.path.realpath(path)
    except (OSError, ValueError) as e:
        raise MalformedInput(f"path cannot be resolved ({type(e).__name__})") from None


def summarize_multi_edit(tool_input, cwd: str | None, budget: relay_redact.ReadBudget | None = None) -> dict:
    """Per distinct target file (grouped by realpath, first-appearance order):
    raw path and aliases, realpath, ops, edit count and per-edit 200-char
    anchor/text previews. Never full texts. The input is checked against the
    frozen contract first (tool_schemas). All previews read from one
    PREVIEW_READ_CHARS share of the call's read `budget` (if any), in edit
    order."""
    validate_multi_edit(tool_input)
    edits = tool_input["edits"]
    placeholders = tool_input.get("placeholders")
    budget = relay_redact.ReadBudget(PREVIEW_READ_CHARS, within=budget)
    files: dict[str, dict] = {}
    for i, edit in enumerate(edits):
        raw, op = edit["path"], edit["op"]
        anchor = edit.get("anchor") or ""
        mode = edit.get("anchor_mode") or "exact"
        create = edit.get("create") is True
        if op == "append_jsonl":
            text = json.dumps(edit["value"], ensure_ascii=False)
        else:
            text = edit["text"]
        try:
            real = resolve_target(raw, cwd)
        except Unresolvable:
            raise Unresolvable(f"edits[{i}].path is relative and the host sent no session cwd") from None
        entry = files.get(real)
        if entry is None:
            if len(files) >= MULTI_EDIT_MAX_FILES:
                raise MalformedInput(f"more than {MULTI_EDIT_MAX_FILES} distinct target files")
            entry = files[real] = {"file": len(files), "path": raw, "aliases": [], "realpath": real,
                                   "ops": [], "edits": 0, "previews": []}
        elif raw != entry["path"] and raw not in entry["aliases"]:
            entry["aliases"].append(raw)
        entry["edits"] += 1
        if op not in entry["ops"]:
            entry["ops"].append(op)
        # redacted first, then cut (relay_redact.clip), as in summarize_call; one shared read budget
        preview = {"op": op, "anchor_preview": relay_redact.clip(anchor, PREVIEW_CHARS, budget=budget),
                   "text_preview": relay_redact.clip(text, PREVIEW_CHARS, budget=budget), "text_chars": len(text)}
        if mode != "exact":
            preview["anchor_mode"] = mode
        if create:
            preview["create"] = True
        entry["previews"].append(preview)
    return {"tool": "multi_edit", "placeholders": placeholders is True,
            "edit_count": len(edits), "files": list(files.values())}


def multi_edit_questions(n_files: int) -> dict:
    """edit's three questions, asked once per target file `call.files[i]`."""
    questions = {}
    for i in range(n_files):
        ref = f"`call.files[{i}]`"
        questions[f"risk_{i}"] = {
            "type": "score",
            "instructions": f"How risky is it for an autonomous coding agent to apply the edits in {ref} "
                            f"(one target file: path, realpath, ops and previews) unattended, given `cwd`?",
            "criteria": RISK_LEVELS,
        }
        questions[f"leak_{i}"] = {
            "type": "noul",
            "instructions": f"Do the edits in {ref} read, write, print, or transmit credentials, tokens, private keys, "
                            "or auth stores (e.g. ~/.synaps-cli/auth.json, ~/.synaps-cli/config, ~/.ssh, .env, ~/.aws)?",
            "criteria": QUESTIONS["leak"]["criteria"],
        }
        questions[f"leaves_workspace_{i}"] = {
            "type": "noul",
            "instructions": f"Do the edits in {ref} write or delete outside of `cwd` (or /tmp)? Judge by its `realpath`.",
            "criteria": QUESTIONS["leaves_workspace"]["criteria"],
        }
    return questions


def _shorten(text: str, limit: int = 120) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _file_label(entry: dict, base: str) -> str:
    raw = entry["path"]
    lexical = os.path.normpath(os.path.join(base, expand_home(raw)))
    label = _shorten(raw)
    if entry["realpath"] != lexical:
        label += " → " + _shorten(entry["realpath"])
    return label


def _confirm_unresolvable(tool: str, error: Exception, audit, log, session, deadline: float, *,
                          cfg: GuardConfig) -> dict:
    """A target the guard cannot place, after the shell-safety rule passed
    (its only caller runs it there). prompt: confirm. auto: an evaluation
    failure with the local rules done, so continue (guard.error_auto)."""
    audit.bump("guard.unresolved")
    if cfg.confirm == "prompt":
        audit.explain("guard", "confirm")
        log(f"guard {tool}: unresolvable target → confirm ({error})")
        _write_audit_best_effort(audit, {"op": "guard", "tool": tool, "action": "confirm",
                                         "error": f"unresolved: {error}", "ms": 0, "session": session}, deadline)
        return {"action": "confirm",
                "message": f"jev: cannot check this {tool} call: {error}, so its real target is unknown; "
                           "approve manually?"}
    audit.explain("guard", "error_auto")
    audit.bump("guard.error_auto")
    log(f"guard {tool}: unresolvable target → continue (auto, local rules passed) ({error})")
    _write_audit_best_effort(audit, {"op": "guard", "tool": tool, "action": "error_auto",
                                     "error": f"unresolved: {error}", "ms": 0, "session": session}, deadline)
    return {"action": "continue"}


def _confirm_malformed(tool: str, error: Exception, audit, log, session, deadline: float, *,
                       cfg: GuardConfig) -> dict:
    """Input outside the tool's contract, found locally. prompt: confirm.
    auto: block, with the same text."""
    action = "confirm" if cfg.confirm == "prompt" else "block"
    audit.explain("guard", action)
    audit.bump("guard.malformed")
    if action == "block":
        audit.bump("guard.block")
    log(decision(action, f"guard {tool}: malformed input → {action} ({error})"))
    _write_audit_best_effort(audit, {"op": "guard", "tool": tool, "action": action,
                                     "error": f"malformed: {error}", "ms": 0, "session": session}, deadline)
    if action == "confirm":
        return {"action": "confirm", "message": f"jev: malformed {tool} input ({error}); approve manually?"}
    return {"action": "block", "reason": f"jev: malformed {tool} input ({error})\n{AUTO_BLOCKED}fix the input and retry"}


def _answer_problem(error: Exception) -> str:
    """A fixed description of why one file's answers could not be used."""
    return "missing answer" if isinstance(error, KeyError) else "malformed answer"


def _listed(lines: list[str], capped: bool = False) -> str:
    """The first NAMED_IN_MESSAGE lines and a count of the rest ("N+ more"
    when the count is a lower bound: a scan that stopped at its cap)."""
    shown = lines[:NAMED_IN_MESSAGE]
    more = len(lines) - len(shown)
    return "\n".join(shown) + (f"\n… and {more}{'+' if capped else ''} more" if more > 0 else "")


def handle_multi_edit(params: dict, client: DecisionClient, cfg: GuardConfig, audit, log,
                      deadline: float) -> dict:
    """edit's check per distinct target file in ONE request; strictest wins.
    The deterministic rules come first: the contract check and the
    shell-safety rule (no I/O) run before the previews (realpath I/O, which
    may block or spend the budget), so a slow summary never hides a finding."""
    tool = "multi_edit"
    session = params.get("session_id")
    cwd = session_cwd(params)
    base = cwd or cfg.workspace
    t0 = time.monotonic()
    tool_input = params.get("tool_input")
    try:
        with BudgetAlarm(deadline - REPLY_MARGIN_S):
            validate_multi_edit(tool_input)
            texts = multi_edit_shell_texts(tool_input)
    except MalformedInput as e:
        return _confirm_malformed(tool, e, audit, log, session, deadline, cfg=cfg)
    except Exception as e:  # noqa: BLE001 — a spent budget, no timer or anything unexpected: not checked
        return _confirm_error(tool, e, t0, audit, log, session, deadline, cfg=cfg, local_done=False)
    decided = shell_rule(tool, texts, cfg, audit, log, session, deadline)
    if decided is not None:
        return decided
    try:
        budget = relay_redact.ReadBudget(GUARD_READ_CHARS)  # the call's: the previews, then the state
        with BudgetAlarm(deadline - REPLY_MARGIN_S):  # realpath I/O may block
            call = summarize_multi_edit(tool_input, cwd, budget)
    except MalformedInput as e:
        return _confirm_malformed(tool, e, audit, log, session, deadline, cfg=cfg)
    except Unresolvable as e:
        return _confirm_unresolvable(tool, e, audit, log, session, deadline, cfg=cfg)
    except Exception as e:  # noqa: BLE001 — a spent budget or anything unexpected, after the shell rule passed
        return _confirm_error(tool, e, t0, audit, log, session, deadline, cfg=cfg, local_done=True)
    files = call["files"]  # unredacted: the hook message's file labels stay local
    questions = multi_edit_questions(len(files))
    try:
        if _sampled_out(client, cfg, session, audit):
            return {"action": "continue"}
        with BudgetAlarm(deadline - REPLY_MARGIN_S):  # redaction is local work inside the budget
            state = relay_redact.redact_state({"call": call, "cwd": base}, questions, budget=budget)
        if relay_redact.wiped(state):
            return _state_wiped(tool, audit, log)
        resp = _ask(client, state, questions, deadline)
        answers = resp["answers"]
        if not isinstance(answers, dict):
            raise TypeError("answers is not an object")
        worst, tripped, file_errors = "continue", [], 0
        for entry in files:
            i = entry["file"]
            try:
                result, why = decide({"risk": answers[f"risk_{i}"],
                                      "leak": answers[f"leak_{i}"],
                                      "leaves_workspace": answers[f"leaves_workspace_{i}"]}, cfg)
                action = result["action"]
            except Exception as e:  # noqa: BLE001 — any failure in this file's answers
                # is this file's confirm; the others still count (block > confirm),
                # whatever the exception class (review r2 R2-2).
                action, why = "confirm", f"could not evaluate ({_answer_problem(e)})"
                file_errors += 1
                audit.bump("guard.file_error")
            if _RANK[action] > _RANK[worst]:
                worst = action
            if action != "continue":
                tripped.append((_RANK[action], i, f"{_file_label(entry, base)} [{action}]: {why}",
                                f"files[{i}] [{action}]: {why}"))
        ms = int((time.monotonic() - t0) * 1000)
        tripped.sort(key=lambda t: (-t[0], t[1]))
        lines = [line for _, _, line, _ in tripped]
        summary = f"{len(tripped)} of {len(files)} files tripped" if tripped else f"{len(files)} files clear"
        row = {"op": "guard", "tool": tool, "action": worst, "ms": ms,
               "model": safe_model(resp), "usage": safe_usage(resp), "file_errors": file_errors,
               "answers": answers, "state": state, "session": session}
        if cfg.confirm == "auto" and worst == "confirm":
            # the row names files by index: their labels are unredacted paths
            why = summary + "; " + "; ".join(at for _, _, _, at in tripped)
            _write_audit_best_effort(audit, {**row, "action": "confirm_auto", "why": why}, deadline)
            return _confirm_auto(tool, f"{summary}; " + "; ".join(lines), audit, log)
        _write_verdict(audit, row, deadline, cfg)
        audit.explain("guard", worst)
        audit.bump(f"guard.{worst}")
        log(decision(worst, f"guard {tool}: {worst} ({ms} ms) {summary}" + ("; " + "; ".join(lines) if lines else ""),
                     clears=GUARD_ERROR_KEY))
        if worst == "block":
            return {"action": "block", "reason": f"jev: blocked. multi_edit {summary}:\n{_listed(lines)}"}
        if worst == "confirm":
            return {"action": "confirm", "message": f"jev: multi_edit {summary}:\n{_listed(lines)}"}
        return {"action": "continue"}
    except RelayOff:
        return _relay_off(audit)
    except Exception as e:  # noqa: BLE001 — fail closed with a fixed category, never the exception text
        return _confirm_error(tool, e, t0, audit, log, session, deadline, cfg=cfg, local_done=True)


def send_events_bodies(tool_input) -> tuple[list[str], list[int]]:
    """The full bodies and their UTF-8 sizes, for the local pattern scan
    (bodies never leave this function's caller). The input is checked
    against the frozen contract first (tool_schemas)."""
    validate_send_events(tool_input)
    bodies, sizes, total = [], [], 0
    for message in tool_input["messages"]:
        body = message["body"]
        size = len(body.encode("utf-8", "surrogatepass"))
        total += size
        if total > SEND_EVENTS_MAX_SCAN_BYTES:
            raise MalformedInput(f"bodies exceed {SEND_EVENTS_MAX_SCAN_BYTES} bytes in total")
        bodies.append(body)
        sizes.append(size)
    return bodies, sizes


def send_events_previews(bodies: list[str], sizes: list[int],
                         budget: relay_redact.ReadBudget | None = None) -> list[dict]:
    """Bounded per-message previews for the model, built after the scan:
    redacted first, then cut (relay_redact.clip), as in summarize_call, all
    of them on one PREVIEW_READ_CHARS share of the call's read `budget` (if
    any), in message order."""
    budget = relay_redact.ReadBudget(PREVIEW_READ_CHARS, within=budget)
    return [{"message": i, "body_preview": relay_redact.clip(body, BODY_PREVIEW_CHARS, budget=budget),
             "body_bytes": size} for i, (body, size) in enumerate(zip(bodies, sizes))]


def summarize_send_events(tool_input) -> tuple[list[dict], list[str]]:
    """Previews and full bodies in one step (send_events_bodies, then
    send_events_previews)."""
    bodies, sizes = send_events_bodies(tool_input)
    return send_events_previews(bodies, sizes), bodies


def send_events_questions(n_messages: int) -> dict:
    return {f"leak_{i}": {
        "type": "noul",
        "instructions": f"Does the body preview in `call.messages[{i}]` contain or transmit credentials, tokens, "
                        "private keys, or auth store contents (e.g. ~/.synaps-cli/auth.json, ~/.ssh, .env, ~/.aws)?",
        "criteria": QUESTIONS["leak"]["criteria"],
    } for i in range(n_messages)}


def _probability(answer) -> float:
    return _in_range(answer["noul"], 0.0, 1.0, "leak")


def handle_send_events(params: dict, client: DecisionClient, cfg: GuardConfig, audit, log,
                       deadline: float) -> dict:
    """Secrets check on bodies only. The deterministic full-body pattern scan
    runs first, before the previews are built; a hit confirms (prompt) or
    blocks (auto) without a model call. Otherwise one secrets question per
    message preview. Hook message, log and audit carry indices, kinds,
    scores and sizes only: never matched text or body excerpts."""
    tool = "send_events"
    session = params.get("session_id")
    t0 = time.monotonic()
    try:
        with BudgetAlarm(deadline - REPLY_MARGIN_S):  # 8 MiB of scanning is local work too
            bodies, sizes = send_events_bodies(params.get("tool_input"))
            hits = []
            for i, body in enumerate(bodies):
                if kinds := scan_secrets(body):
                    hits.append((i, kinds))
    except MalformedInput as e:
        return _confirm_malformed(tool, e, audit, log, session, deadline, cfg=cfg)
    except Exception as e:  # noqa: BLE001 — a spent budget, no timer or a scanner failure: the scan did not pass
        return _confirm_error(tool, e, t0, audit, log, session, deadline, cfg=cfg, local_done=False)
    if hits:
        action = "confirm" if cfg.confirm == "prompt" else "block"
        ms = int((time.monotonic() - t0) * 1000)
        named = [f"messages[{i}] ({', '.join(kinds)})" for i, kinds in hits]
        audit.explain("guard", action)
        audit.bump(f"guard.{action}")
        audit.bump("guard.secret_pattern")
        log(decision(action, f"guard {tool}: {action} ({ms} ms) secret pattern in " + ", ".join(named)))
        _write_audit_best_effort(audit, {"op": "guard", "tool": tool, "action": action,
                                         "rule": "secret_pattern",
                                         "hits": [{"message": i, "kinds": kinds} for i, kinds in hits],
                                         "messages": len(bodies), "body_bytes": sizes, "ms": ms,
                                         "session": session}, deadline)
        found = "jev: send_events body matches a secret pattern:\n" + _listed(named)
        if action == "confirm":
            return {"action": "confirm", "message": found + "\napprove manually?"}
        return {"action": "block", "reason": f"{found}\n{AUTO_BLOCKED}take the secret out of the body and retry"}
    try:
        questions = send_events_questions(len(bodies))
        if _sampled_out(client, cfg, session, audit):
            return {"action": "continue"}
        # the previews (redacted first, then cut) and the redaction are local work inside the budget
        with BudgetAlarm(deadline - REPLY_MARGIN_S):
            budget = relay_redact.ReadBudget(GUARD_READ_CHARS)  # the call's: the previews, then the state
            previews = send_events_previews(bodies, sizes, budget)
            state = relay_redact.redact_state({"call": {"tool": tool, "messages": previews}}, questions,
                                              budget=budget)
        if relay_redact.wiped(state):
            return _state_wiped(tool, audit, log)
        resp = _ask(client, state, questions, deadline)
        answers = resp["answers"]
        probs = [_probability(answers[f"leak_{i}"]) for i in range(len(previews))]
        flagged = [i for i, p in enumerate(probs) if p >= cfg.secrets_at]
        action = "confirm" if flagged else "continue"
        ms = int((time.monotonic() - t0) * 1000)
        named = [f"messages[{i}] leak={probs[i]:.2f}" for i in flagged]
        row = {"op": "guard", "tool": tool, "action": action, "ms": ms, "model": safe_model(resp),
               "usage": safe_usage(resp), "secrets": [round(p, 4) for p in probs],
               "messages": len(previews), "body_bytes": sizes, "session": session}
        if cfg.confirm == "auto" and flagged:
            why = f"max leak={max(probs):.2f} over {len(probs)} messages: " + ", ".join(named)
            _write_audit_best_effort(audit, {**row, "action": "confirm_auto", "why": why}, deadline)
            return _confirm_auto(tool, why, audit, log)
        _write_audit(audit, row, deadline)
        audit.explain("guard", action)
        audit.bump(f"guard.{action}")
        log(decision(action, f"guard {tool}: {action} ({ms} ms) max secrets={max(probs):.2f} over {len(probs)} messages"
                     + (": " + ", ".join(named) if named else ""), clears=GUARD_ERROR_KEY))
        if flagged:
            # No colon right after "secrets": the host's confirm scrub would
            # hide the next word (the message index) as a secret value.
            return {"action": "confirm", "message": "jev: send_events body may carry secrets (Jev's leak score):\n"
                    + _listed(named) + "\napprove manually?"}
        return {"action": "continue"}
    except RelayOff:
        return _relay_off(audit)
    except Exception as e:  # noqa: BLE001 — fail closed and never echo exception text (it may quote a body)
        return _confirm_error(tool, e, t0, audit, log, session, deadline, cfg=cfg, local_done=True)


# ── the rule-1 guard (fleet safety rule 1): deterministic, command texts ───
#
# Fleet rule 1: scripts and file content are written with the write/edit
# tools, never generated inside a shell call (an `rm -rf /*` incident came
# from such a script). The rule refuses, before the call runs, a bash
# command, a shell_start command or a shell_send input holding a heredoc
# (H1), a here-string (H2), an in-place sed/perl edit (E1), a script fed to
# python or a shell on stdin (S1) or a long or multi-line `python -c` (S2),
# at command level (rule1.scan_rule1). Never the content of write, edit or
# multi_edit: scripts legitimately hold heredocs.
#
# It needs no model, so it runs whatever the key, the budget, the circuit
# or the guard switch (R-GATE, like the shell-safety rule); only
# guard_rule1 = off stops it, and guard_tools does not narrow it. It runs
# before the shell-safety rule and the model and answers alone when it
# refuses; its scan is one BudgetAlarm of the same hook budget, entered and
# left before the guard's own. Scope (guard_rule1_scope): `fleet` = the
# sessions in the fleet roster (roster.FleetRoster, read only when there is
# something to refuse), `all` = every session.
#
# Actions: a hit blocks (guard_rule1 = warn: logs and counts only). A shape
# limit (over SHELL_SCAN_MAX_BYTES, nesting, descent, the re-read budget)
# blocks too: the fix (a file) is always available. A spent budget, a timer
# that cannot be armed or an internal error asks to confirm under
# guard_confirm = prompt, as the guard does, and blocks under auto (never a
# prompt): they come from the host, not from the text. Hits made before a stop
# decide (R-FINDINGS-WIN). Audit rows (rule "rule1") and log lines carry
# families, fixed tokens, line numbers and the session id, never text; a
# clean call writes no row.

RULE1_TOOLS = frozenset({"bash", "shell_start", "shell_send"})
RULE1_ONLY_TOOLS = frozenset({"shell_start", "shell_send"})  # hooked for this rule only
RULE1_MODES = ("block", "warn", "off")
RULE1_SCOPES = ("fleet", "all")

_RULE1_WRITE = ("write the content with the write tool (a script as f.sh or f.py, or with a #!/bin/bash line), "
                "then run or pass the file (`git commit -F msg.txt`, `python3 f.py </dev/null`)")
_RULE1_SCRIPT = ("write the script with the write tool (as f.py, or as f.sh / with a #!/bin/bash line), "
                 "then run `python3 f.py </dev/null` / `bash f.sh`")
_RULE1_FIX = {
    "H1": ("heredoc", _RULE1_WRITE),
    "H2": ("here-string", _RULE1_WRITE),
    "E1": ("in-place edit", "change the file with the edit tool"),
    "S1": ("script fed on stdin", _RULE1_SCRIPT),
    "S2": (f"inline python with a newline or over {rule1.S2_MAX_CHARS} characters", _RULE1_SCRIPT),
}
_RULE1_HEAD = ("jev: blocked by the rule-1 guard (decided locally, no model call). Fleet rule 1: scripts and file "
               "content are written with the write/edit tools, not inside a shell call.")
_RULE1_ROSTER = "\n(the fleet roster could not be read, so this rule applies to every session)"


def rule1_mode(value) -> str:
    """guard_rule1: block (default), warn or off. Anything else is block."""
    mode = "block" if value is None else str(value).strip().lower()
    return mode if mode in RULE1_MODES else "block"


def rule1_scope_mode(value) -> str:
    """guard_rule1_scope: fleet (default) or all. Anything else is fleet."""
    scope = "fleet" if value is None else str(value).strip().lower()
    return scope if scope in RULE1_SCOPES else "fleet"


def rule1_texts(tool: str, tool_input) -> list[tuple]:
    """(where, text) for the rule: bash's and shell_start's `command`,
    shell_send's `input` (as the shell reads it: rule1.pty_text)."""
    if not isinstance(tool_input, dict):
        return []
    if tool in ("bash", "shell_start"):
        command = tool_input.get("command")
        return [("command", command)] if isinstance(command, str) and command else []
    if tool == "shell_send":
        text = tool_input.get("input")
        return [("input", rule1.pty_text(text))] if isinstance(text, str) and text else []
    return []


def _rule1_line(tool: str, where: str, hit) -> str:
    name, fix = _RULE1_FIX[hit.family]
    at = f"{where} line {hit.line}" if tool != "bash" else f"line {hit.line}"
    nested = " (in a nested script)" if hit.descent else ""
    return f"{at}{nested}: {hit.family} {name} `{hit.token}`: {fix}"


def rule1_check(params: dict, cfg: GuardConfig, audit, log, *, started: float | None = None) -> dict | None:
    """The rule-1 guard's answer for one call: a block (or a confirm, see
    above), or None to carry on (nothing found, out of scope, warn, off)."""
    if cfg.rule1 == "off":
        return None
    tool = params.get("tool_runtime_name") or params.get("tool_name") or ""
    if tool not in RULE1_TOOLS:
        return None
    texts = rule1_texts(tool, params.get("tool_input"))
    if not texts:
        return None
    session = params.get("session_id")
    deadline = (time.monotonic() if started is None else started) + cfg.budget_s
    t0 = time.monotonic()
    hits, stopped, shape = [], None, False
    try:
        size = sum(_text_bytes(text) for _, text in texts)
        if size > SHELL_SCAN_MAX_BYTES:
            stopped, shape = f"too large: {size} bytes, over {SHELL_SCAN_MAX_BYTES}", True
        else:
            with BudgetAlarm(deadline - REPLY_MARGIN_S):
                for where, text in texts:
                    partial = []
                    try:
                        rule1.scan_rule1(text, partial)
                    finally:
                        hits.extend((where, h) for h in partial)
    except rule1.Rule1Limit as e:  # the message is a fixed text
        stopped, shape = f"too complex to check: {e}", True
    except BudgetSpent as e:
        stopped = error_category(e)
    except Exception:  # noqa: BLE001 — never the exception text
        stopped = "internal error"
    if not hits and stopped is None:
        return None
    seen, unique = set(), []
    for where, h in hits:
        if (where, h) not in seen:
            seen.add((where, h))
            unique.append((where, h))
    hits = unique

    match = "all"
    if cfg.rule1_scope == "fleet":
        try:
            with BudgetAlarm(deadline - REPLY_MARGIN_S):
                in_scope, match = cfg.roster.lookup(session, log)
        except Exception:  # noqa: BLE001 — a spent budget or no timer: fail closed
            in_scope, match = True, "unchecked"
        if not in_scope:
            audit.bump("guard.rule1.out_of_scope")
            return None
        if match in ("no_session", "unreadable", "unchecked"):
            audit.bump(f"guard.rule1.{'roster_' + match if match != 'no_session' else match}")

    if hits or shape:
        action = "block"
    elif cfg.confirm == "prompt":
        action = "confirm"  # stopped by the host (budget, timer) or a scanner failure, before any hit
    else:
        action = "block"  # the same stop under guard_confirm = auto: unchecked, so blocked, never prompted
    if cfg.rule1 == "warn":
        action = "warn"
    ms = int((time.monotonic() - t0) * 1000)
    for family in sorted({h.family for _, h in hits}):
        audit.bump(f"guard.rule1.{family}")
    if stopped is not None:
        audit.bump("guard.rule1.stopped")
        if shape:
            audit.bump("guard.rule1.limit")
    audit.bump(f"guard.rule1.{action}")
    _write_audit_best_effort(audit, {"op": "guard", "tool": tool, "action": action, "rule": "rule1",
                                     "hits": [{"family": h.family, "token": h.token, "line": h.line,
                                               "descent": h.descent, "where": where}
                                              for where, h in hits[:AUDIT_FINDINGS_MAX]],
                                     "hits_total": len(hits), "stopped": stopped, "scope": cfg.rule1_scope,
                                     "scope_match": match, "ms": ms, "session": session}, deadline)
    log(decision(action, f"guard {tool}: {action} ({ms} ms) rule-1 guard, {len(hits)} hit(s)"
        + (f", scan stopped ({stopped})" if stopped else "")
        + (": " + ", ".join(f"{h.family} {where} line {h.line}" for where, h in hits[:NAMED_IN_MESSAGE])
           if hits else "")
        + f"; session {session if isinstance(session, str) and session.isprintable() and len(session) <= 64 else '?'}"
        + f", scope {cfg.rule1_scope} ({match})"))
    if action == "warn":
        return None
    audit.explain("guard", action)
    roster_note = _RULE1_ROSTER if match == "unreadable" else ""
    if action == "confirm":
        return {"action": "confirm", "message": f"jev: the rule-1 guard could not check this {tool} call "
                                                f"({stopped}); approve manually?" + roster_note}
    if not hits and not shape:  # the host stop above, under guard_confirm = auto
        return {"action": "block", "reason": f"jev: the rule-1 guard could not check this {tool} call ({stopped})\n"
                                             f"{AUTO_BLOCKED}retry, or split it" + roster_note}
    if not hits:
        return {"action": "block", "reason": f"{_RULE1_HEAD} This {tool} call could not be checked ({stopped}): "
                                             f"{_RULE1_SCRIPT}." + roster_note}
    listed = _listed([_rule1_line(tool, where, h) for where, h in hits],
                     len(hits) >= rule1.HITS_MAX or stopped is not None)
    if stopped is not None:
        listed += f"\nthe rest of the text could not be checked ({stopped}): it may hold more; fix these first"
    return {"action": "block", "reason": f"{_RULE1_HEAD} Fix these and retry:\n{listed}" + roster_note}


# ── the access rule (owner rules 27a and 27b) ──────────────────────────────
# Before a command that changes access (such as removing group write
# permission), the agent should end its turn and ask permission, and the task
# should halt until it gets an answer. The model score rates chmod as hard to
# reverse and confirms, but fleet auto-accept passes a confirm, so this rule
# BLOCKS, decided locally with no model call (R-GATE:
# whatever the key, budget, circuit or guard switch; only guard_access = off
# stops it). It runs first, before the rule-1 guard. What it refuses is in
# access.py: access commands, mode/owner/ACL changes outside the session's
# own worktree or scratch, writes to protected paths, writes to systemd
# units that set a limit or access key, umask lines in shell or service
# config, inline code naming an access change, and (27b) sandbox files: in
# manual mode only a NEW sessions/<name>.conf passes; in auto mode any change
# below sessions/ passes and a change to an existing file is audited as rule
# access_auto. The mode is the switch file access.switch_path (missing or
# anything but `auto` = manual), itself protected.
#
# Fail closed where it matters: a scan that stops (a shape limit, a spent
# budget, an internal error) before any hit blocks when the call's text or
# paths hold an access word (access.RAW_WORDS), and passes otherwise. Audit
# rows (rule "access" or "access_auto") and log lines carry fixed tokens,
# line numbers and the session id, never text. Scope (guard_access_scope):
# all (default: owner rule 27a binds every agent) or fleet (the roster).

ACCESS_TOOLS = frozenset({"bash", "shell_start", "shell_send", "write", "edit", "multi_edit"})
ACCESS_MODES = ("block", "warn", "off")
ACCESS_SCOPES = ("all", "fleet")

_ACCESS_HEAD = ("jev: blocked by the access rule (decided locally, no model call). Owner rule 27a: this changes "
                "access. Don't run it or work around it. End your turn and ask for the owner's yes (a worker "
                "asks its foreman). This task waits.")
_ACCESS_27B = " (27b: this can widen a sandbox; the owner's yes)"
_ACCESS_AFTER = ("After the owner's yes, the owner runs it in their own terminal (or approves it once); do not "
                 "retry it another way.")
# only when every hit is a mode command that the own-area exception could
# cover: the exception is checked again, so naming the files is no way round
_ACCESS_OWN = ("27a's only exception is a file you created yourself for this task in your own scratch "
               "(/var/tmp/<lane>/...) or worktree. If that is all this is, name those files by literal path "
               "(absolute, or after a plain `cd` to a literal directory) in a call of their own; it is checked again. "
               "Otherwise stop here.")


def access_mode(value) -> str:
    """guard_access: block (default), warn or off. Anything else is block."""
    mode = "block" if value is None else str(value).strip().lower()
    return mode if mode in ACCESS_MODES else "block"


def access_scope_mode(value) -> str:
    """guard_access_scope: all (default) or fleet. Anything else is all."""
    scope = "all" if value is None else str(value).strip().lower()
    return scope if scope in ACCESS_SCOPES else "all"


def access_targets(tool: str, tool_input) -> list[tuple]:
    """(where, raw path, new text, op) for write, edit and multi_edit."""
    if not isinstance(tool_input, dict):
        return []
    if tool == "write":
        path, content = tool_input.get("path"), tool_input.get("content")
        return [("path", path, content if isinstance(content, str) else "", "create")] \
            if isinstance(path, str) and path else []
    if tool == "edit":
        path, new = tool_input.get("path"), tool_input.get("new_string")
        return [("path", path, new if isinstance(new, str) else "", "change")] \
            if isinstance(path, str) and path else []
    if tool == "multi_edit":
        out = []
        edits = tool_input.get("edits")
        for i, e in enumerate(edits if isinstance(edits, list) else []):
            if not isinstance(e, dict) or not isinstance(e.get("path"), str) or not e.get("path"):
                continue
            if e.get("op") == "append_jsonl":
                try:
                    text = json.dumps(e.get("value"), ensure_ascii=False)
                except (TypeError, ValueError):
                    text = ""
            else:
                text = e.get("text") if isinstance(e.get("text"), str) else ""
            out.append((f"edits[{i}]", e["path"], text, "create" if e.get("create") is True else "change"))
        return out
    return []


def _access_change(tool: str, tool_input: dict, path: str) -> dict:
    """What path_access needs to follow the change to a file that exists:
    the edit's old_string, or that file's multi_edit edits in order."""
    if tool == "edit":
        old = tool_input.get("old_string")
        return {"tool": "edit", "old": old if isinstance(old, str) else None}
    if tool == "multi_edit":
        edits = tool_input.get("edits")
        return {"tool": "multi_edit",
                "edits": [e for e in (edits if isinstance(edits, list) else [])
                          if isinstance(e, dict) and e.get("path") == path]}
    return {"tool": "write"}


def _access_line(tool: str, where: str, hit) -> str:
    if hit.line and tool != "bash":
        at = f"{where} line {hit.line}"
    elif hit.line:
        at = f"line {hit.line}"
    else:
        at = where
    nested = " (in a nested script)" if hit.descent else ""
    if hit.kind == "command":
        return f"{at}{nested}: `{hit.token}` {hit.why}"
    return f"{at}{nested}: {hit.token}: {hit.why}"


_ASK_OPEN = ("Request {id}: the owner can answer it in Pria Desktop (Permission change). If they allow it once, "
             "run exactly this call again, unchanged, within 30 minutes of their answer; anything else stays "
             "blocked.")
_ASK_CLOSED = ("Request {id}: this call can't be allowed once ({why}); after the owner's yes, the owner runs it "
               "themselves.")
_ASK_WAITING = ("Request {id} is already waiting for the owner's answer in Pria Desktop; don't retry it before "
                "they answer.")
_ASK_DENIED = "The owner said no (request {id}): don't retry it or work around it."
_ASK_UNRECORDED = "(Request not recorded: {why}. The owner can't answer it in the app; ask them directly.)"


def _access_ask(params: dict, tool: str, tool_input, blocking, stopped, reason: str):
    """Allow once (allow_once.py): ('allow', None, id, 'allow_once') when the
    owner allowed exactly this call once and the answer was consumed; else
    ('block', the line to add to the refusal, the request id or None, the
    answer state). Any error leaves the call blocked."""
    session = params.get("session_id")
    subagent = params.get("subagent_id")  # a builder's call: its sa_N under its lead's session
    home = os.environ.get("HOME")
    now = time.time()
    try:
        fp = allow_once.fingerprint(session, tool, session_cwd(params), tool_input, subagent_id=subagent)
        found = allow_once.lookup(home, fp, blocking, now,
                                  call=(session, tool, session_cwd(params), tool_input, subagent),
                                  reason=lambda rid: f"{reason}\n{_ASK_OPEN.format(id=rid)}")
    except Exception:  # noqa: BLE001 — never the exception text; never an allow
        return "block", _ASK_UNRECORDED.format(why="the request store could not be read"), None, "error"
    if found is not None and found[0] == "allow":
        return "allow", None, found[1], "allow_once"
    if found is not None and found[0] == "deny":
        return "block", _ASK_DENIED.format(id=found[1]), found[1], "deny"
    if found is not None:
        return "block", _ASK_WAITING.format(id=found[1]), found[1], "waiting"
    rid = allow_once.new_id()
    try:
        _, allowable = allow_once.call_text(tool, tool_input)
        possible = (stopped is None and bool(blocking) and tool != "shell_send" and allowable
                    and len(blocking) <= allow_once.HITS_MAX and allow_once.subagent_ok(subagent))
        if possible:
            line = _ASK_OPEN.format(id=rid)
        else:
            why = ("the scan didn't reach the end" if stopped is not None or not blocking
                   else "it is typed into a live shell, whose directory and state can't be bound"
                   if tool == "shell_send"
                   else "it holds a credential or is too long to show in full" if not allowable
                   else "the builder that made it can't be named" if not allow_once.subagent_ok(subagent)
                   else "too many access changes in one call")
            line = _ASK_CLOSED.format(id=rid, why=why)
        allow_once.record_block(home, rid, session=session, tool=tool, cwd=session_cwd(params),
                                tool_input=tool_input, fp=fp, hits=blocking, reason=f"{reason}\n{line}",
                                possible=possible, now=now, subagent_id=subagent)
    except allow_once.StoreError as e:  # a fixed text
        return "block", _ASK_UNRECORDED.format(why=str(e)), None, "unrecorded"
    except Exception:  # noqa: BLE001
        return "block", _ASK_UNRECORDED.format(why="the request could not be recorded"), None, "unrecorded"
    return "block", line, rid, "new" if possible else "deny_only"


def _access_auto_record(params: dict, tool: str, tool_input, autos, log) -> str | None:
    """An FYI request record for a 27b auto pass; a failure only logs."""
    try:
        files = [{"path": p, "op": op} for _, p, _, op in access_targets(tool, tool_input)]
        return allow_once.record_auto(os.environ.get("HOME"), session=params.get("session_id"), tool=tool,
                                      cwd=session_cwd(params), files=files, hits=autos, now=time.time(),
                                      subagent_id=params.get("subagent_id"))
    except Exception:  # noqa: BLE001
        log(notice(f"guard {tool}: the 27b auto record could not be written (the pass stands, audited)",
                   key=AUTO_RECORD_KEY, label="guard: the 27b auto record could not be written"))
        return None


def access_check(params: dict, cfg: GuardConfig, audit, log, *, started: float | None = None) -> dict | None:
    """The access rule's answer for one call: a block, or None to carry on
    (nothing found, a 27b auto pass, out of scope, warn, off)."""
    if cfg.access == "off":
        return None
    tool = params.get("tool_runtime_name") or params.get("tool_name") or ""
    if tool not in ACCESS_TOOLS:
        return None
    tool_input = params.get("tool_input")
    texts = rule1_texts(tool, tool_input) if tool in RULE1_TOOLS else []
    targets = access_targets(tool, tool_input)
    if not texts and not targets:
        return None
    session = params.get("session_id")
    deadline = (time.monotonic() if started is None else started) + cfg.budget_s
    t0 = time.monotonic()
    hits, stopped = [], None
    raw_words = False
    try:
        size = sum(_text_bytes(text) for _, text in texts)
        raw_words = any(access.RAW_WORDS.search(text) for _, text in texts) or any(
            access.RAW_WORDS.search(path) for _, path, _, _ in targets)
        if size > SHELL_SCAN_MAX_BYTES:
            stopped = f"too large: {size} bytes, over {SHELL_SCAN_MAX_BYTES}"
        else:
            with BudgetAlarm(deadline - REPLY_MARGIN_S):  # realpath, glob and small reads
                home = os.environ.get("HOME")
                ctx = access.Context(session_cwd(params), home, sandbox_mode=access.read_sandbox_mode(home))
                for where, text in texts:
                    partial = []
                    try:
                        access.scan_access(text, ctx, partial)
                    finally:
                        hits.extend((where, h) for h in partial)
                for where, path, text, op in targets:
                    h = access.path_access(path, text, ctx, op, **_access_change(tool, tool_input, path))
                    if h is not None:
                        hits.append((where, h))
    except access.AccessLimit as e:  # the message is a fixed text
        stopped = f"too complex to check: {e}"
    except BudgetSpent as e:
        stopped = error_category(e)
    except Exception:  # noqa: BLE001 — never the exception text
        stopped = "internal error"
    blocking = [(w, h) for w, h in hits if h.kind != "auto"]
    autos = [(w, h) for w, h in hits if h.kind == "auto"]
    if not blocking and (stopped is None or not raw_words):
        if autos and stopped is None:
            audit.bump("guard.access.auto")
            rid = _access_auto_record(params, tool, tool_input, autos, log)
            _write_audit_best_effort(audit, {"op": "guard", "tool": tool, "action": "continue",
                                             "rule": "access_auto",
                                             "hits": [{"token": h.token, "why": h.why, "line": h.line,
                                                       "where": w} for w, h in autos[:AUDIT_FINDINGS_MAX]],
                                             "request": rid, "session": session}, deadline)
            log(routine(f"guard {tool}: continue, access rule 27b auto mode: {len(autos)} sandbox file change(s) "
                        f"passed and audited; session {_session_label(session)}",
                        clears=AUTO_RECORD_KEY if rid is not None else None))
        elif stopped is not None:
            audit.bump("guard.access.stopped_clear")
        return None

    match = "all"
    if cfg.access_scope == "fleet":
        try:
            with BudgetAlarm(deadline - REPLY_MARGIN_S):
                in_scope, match = cfg.roster.lookup(session, log)
        except Exception:  # noqa: BLE001 — a spent budget or no timer: fail closed
            in_scope, match = True, "unchecked"
        if not in_scope:
            audit.bump("guard.access.out_of_scope")
            return None

    action = "warn" if cfg.access == "warn" else "block"
    head = _ACCESS_HEAD + (_ACCESS_27B if any(h.kind == "sandbox" for _, h in blocking) else "")
    if not blocking:
        reason = (f"{head}\nThis {tool} call names an access change and could not "
                  f"be checked to the end ({stopped}). {_ACCESS_AFTER}")
    else:
        listed = _listed([_access_line(tool, w, h) for w, h in blocking], len(blocking) >= access.ACCESS_MAX)
        if stopped is not None:
            listed += f"\nthe rest of the call could not be checked ({stopped})"
        after = _ACCESS_AFTER
        if all(h.kind == "command" and h.why in access.OWN_AREA_WHYS for _, h in blocking):
            after = _ACCESS_OWN + " " + after
        reason = f"{head}\n{listed}\n{after}"
    rid, answer, ask = None, None, None
    if action == "block":
        outcome, ask, rid, answer = _access_ask(params, tool, tool_input, blocking, stopped, reason)
        if outcome == "allow":
            ms = int((time.monotonic() - t0) * 1000)
            audit.bump("guard.access.allowed_once")
            _write_audit_best_effort(audit, {"op": "guard", "tool": tool, "action": "continue",
                                             "rule": "access_allowed_once", "request": rid,
                                             "hits": [{"kind": h.kind, "token": h.token, "why": h.why,
                                                       "line": h.line, "descent": h.descent, "where": w}
                                                      for w, h in blocking[:AUDIT_FINDINGS_MAX]],
                                             "hits_total": len(blocking), "ms": ms, "session": session},
                                      deadline)
            log(f"guard {tool}: continue ({ms} ms), access rule 27a: the owner allowed request {rid} once; "
                f"session {_session_label(session)}")
            return None
    ms = int((time.monotonic() - t0) * 1000)
    for kind in sorted({h.kind for _, h in blocking}):
        audit.bump(f"guard.access.{kind}")
    if stopped is not None:
        audit.bump("guard.access.stopped")
    audit.bump(f"guard.access.{action}")
    _write_audit_best_effort(audit, {"op": "guard", "tool": tool, "action": action, "rule": "access",
                                     "hits": [{"kind": h.kind, "token": h.token, "why": h.why, "line": h.line,
                                               "descent": h.descent, "where": w}
                                              for w, h in blocking[:AUDIT_FINDINGS_MAX]],
                                     "hits_total": len(blocking), "stopped": stopped,
                                     "scope": cfg.access_scope, "scope_match": match, "ms": ms,
                                     "request": rid, "answer": answer, "session": session}, deadline)
    log(decision(action, f"guard {tool}: {action} ({ms} ms) access rule 27a, {len(blocking)} hit(s)"
        + (f", scan stopped ({stopped})" if stopped else "")
        + (": " + ", ".join(f"{h.kind} {h.token} {w} line {h.line}" for w, h in blocking[:NAMED_IN_MESSAGE])
           if blocking else "")
        + (f", request {rid} ({answer})" if rid else f", request {answer}" if answer else "")
        + f"; session {_session_label(session)}, scope {cfg.access_scope} ({match})"))
    if action == "warn":
        return None
    audit.explain("guard", "block")
    return {"action": "block", "reason": f"{reason}\n{ask}" if ask else reason}


def _session_label(session) -> str:
    return session if isinstance(session, str) and session.isprintable() and len(session) <= 64 else "?"
