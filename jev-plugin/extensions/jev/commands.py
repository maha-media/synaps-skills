"""commands — the `/jev` interactive slash command.

    /jev key <apikey_…>   validate the key live, persist it, activate now (no restart)
    /jev key              show where a key would be read from / how to get one
    /jev status           configured? source, model, features, session stats
    /jev test             one live decision: latency + cost
    /jev guard on|off [--save]     flip the tool-call safety gate (session-only unless --save)
    /jev router on|off [--save]    flip subagent routing
    /jev compress on|off [--save]  flip output compression
    /jev context on|off [--save]   flip advisory context-boundary reports (pressure only)
    /jev off|on [--save]           all features at once (all six tools stay advertised)

Output is streamed as `command.output` notifications (text/system/error/done)
matched by `request_id`; the RPC response body itself is ignored by the TUI.
"""

from __future__ import annotations

import json
import time

from . import keys
from .client import DecisionClient, JevError, usage_tokens
from .policy import validate

USAGE = (
    "**/jev** — TypeSafe Jev decision layer\n\n"
    "| command | does |\n|---|---|\n"
    "| `/jev key <apikey_…>` | validate, save, and activate an API key (no restart) |\n"
    "| `/jev economy [--save]` | preset: guard unchanged; router+triage+context on, deterministic compression; optional advice off; no savings claim |\n"
    "| `/jev compress mode jev\\|deterministic [--save]` | choose compression mode without enabling it |\n"
    "| `/jev budget [on\\|off\\|reset]` | optional session API budgets; limits: calls, cost, latency, errors, cooldown; --save for settings |\n"
    "| `/jev explain [clear]` | bounded local diagnostics; clear only the ring, not accounting |\n"
    "| `/jev status` | configuration + session stats |\n"
    "| `/jev test` | one live decision: latency + cost |\n"
    "| `/jev guard off` | stop reviewing tool calls for this session (`--save` persists) |\n"
    "| `/jev guard on` | resume the safety gate |\n"
    "| `/jev router on\\|off`, `/jev compress on\\|off` | flip sparse session-cached routing or compression; `/jev triage on or off` controls advisory failure triage; `/jev discovery on or off [--save]` controls opt-in discovery advice |\n"
    "| `/jev evidence on\\|off [--save]` | opt-in descriptor relevance advice; no fetch or trust certification |\n"
    "| `/jev diagnosis on\\|off [--save]` | supplied hypotheses/checks only; advisory, no fixes or execution |\n"
    "| `/jev verification on\\|off [--save]` | opt-in explicit optional-check prioritization, independent of guard |\n"
    "| `/jev reports on\\|off [--save]` | opt-in worker-report claim triage, independent of guard; no lifecycle authority |\n"
    "| `/jev context on\\|off [--save]` | advisory task-boundary reports only under host context pressure at turn end; no rollover authority |\n"
    "| `/jev off` / `/jev on` | guard+router+compress+triage+discovery+verification+evidence+diagnosis+reports+context together (including opt-in API calls); mode unchanged; all six tools stay advertised |\n\n"
    "Tip: the Confirm dialog's **Allow all this session** button keeps the guard scoring+auditing "
    "but stops asking; `/jev guard off` skips the ~0.4 s review entirely.\n\n"
    f"Get a key at {keys.GET_KEY_URL}. Keys are stored in `{keys.plugin_config_path()}` (mode 600), "
    "or set `TYPESAFE_API_KEY` in the environment that launches synaps."
)


class Emitter:
    """Streams command.output frames for one request."""

    def __init__(self, send, request_id: str) -> None:
        self._send = send
        self._rid = request_id

    def _emit(self, kind: str, **fields) -> None:
        self._send({"jsonrpc": "2.0", "method": "command.output",
                    "params": {"request_id": self._rid, "event": {"kind": kind, **fields}}})

    def text(self, content: str) -> None:
        self._emit("text", content=content)

    def system(self, content: str) -> None:
        self._emit("system", content=content)

    def error(self, content: str) -> None:
        self._emit("error", content=content)

    def table(self, headers: list[str], rows: list[list[str]]) -> None:
        self._emit("table", headers=headers, rows=rows)

    def done(self) -> None:
        self._emit("done")


def probe(client: DecisionClient) -> tuple[int, dict]:
    """One tiny live decision; returns (ms, response). Raises JevError."""
    t0 = time.monotonic()
    resp = client.decide(
        {"note": "jev plugin key check"},
        {"ok": {"type": "noul", "instructions": "Is `note` a self-test?"}},
        op="probe",
    )
    return int((time.monotonic() - t0) * 1000), resp


def handle(params: dict, ext, send, host_call) -> dict:
    with ext.policy.scoped():
        return _handle(params, ext, send, host_call)


def _handle(params: dict, ext, send, host_call) -> dict:
    """Entry point from the RPC loop. `ext` is the Extension; `host_call`
    performs an outbound JSON-RPC request to the host (or raises)."""
    out = Emitter(send, str(params.get("request_id") or ""))
    args = [str(a) for a in (params.get("args") or [])]
    sub = args[0].lower() if args else ""
    try:
        if sub == "key":
            _cmd_key(args[1:], ext, out, host_call)
        elif sub == "explain":
            from .audit import GLOSS
            if args[1:] not in ([], ["clear"]):
                out.error("Usage: /jev explain [clear]")
            else:
                if args[1:]:
                    ext.audit.clear_explanations()
                out.text("Last 64 plugin-process explanations, shared across sessions; not source authority. Clear affects only this ring, not counters or budgets.")
                out.table(["sequence", "op", "reason", "meaning"],
                          [[str(r["sequence"]), r["op"], r["reason"], GLOSS[r["reason"]]]
                           for r in ext.audit.explanations()])
        elif sub == "status":
            _cmd_status(ext, out)
        elif sub == "test":
            _cmd_test(ext, out)
        elif sub == "budget":
            _cmd_budget(args[1:], ext, out, host_call)
        elif sub == "economy":
            _cmd_economy(args[1:], ext, out, host_call)
        elif sub == "compress" and len(args) > 1 and args[1] == "mode":
            _cmd_compress_mode(args[2:], ext, out, host_call)
        elif sub in ext.FEATURE_DEFAULTS:
            _cmd_feature([sub], args[1:], ext, out, host_call)
        elif sub in ("on", "off"):
            _cmd_feature(list(ext.FEATURE_DEFAULTS), [sub, *args[1:]], ext, out, host_call)
        else:
            out.text(USAGE)
    except Exception as e:  # noqa: BLE001
        out.error(f"/jev {sub}: {e}")
    out.done()
    return {"ok": True}


# ── subcommands ──────────────────────────────────────────────────────────────

def _cmd_key(rest: list[str], ext, out: Emitter, host_call) -> None:
    if not rest:
        key, source = keys.discover()
        out.text(
            f"Current key: `{keys.redact(key)}` (source: {source})\n\n"
            f"Set one with `/jev key <apikey_…>` — it is validated with a live call, saved to "
            f"`{keys.plugin_config_path()}` (mode 600), and activated immediately.\n\n"
            f"Get a key at {keys.GET_KEY_URL}."
        )
        return

    value = rest[0].strip().strip('"').strip("'")
    if not keys.looks_like_key(value):
        out.error("That doesn't look like a TypeSafe key (expected `apikey_…`). Nothing saved.")
        return

    # 1. Validate live before persisting anything.
    candidate = DecisionClient(value, model=ext.model_name(), timeout_s=6.0)
    try:
        ms, resp = probe(candidate)
    except JevError as e:
        out.error(f"Key rejected by api.typesafe.ai: {e}. Nothing saved.")
        return
    out.system(f"key accepted by {resp.get('model')} in {ms} ms")

    # 2. Persist via the host's config store (canonical), fall back to a direct write.
    where = str(keys.plugin_config_path())
    try:
        host_call("config.set", {"key": "api_key", "value": value})
        how = "saved via host config.set"
    except Exception as e:  # noqa: BLE001
        keys.write_plugin_config("api_key", value)
        how = f"saved directly (host config.set unavailable: {e})"
    out.system(f"{how} → `{where}` (mode 600)")

    # 3. Activate in this process — no restart.
    ext.activate(value, source=f"file:{where}")
    out.text(
        "✓ Jev is active: " + ", ".join(k for k, v in ext.features.items() if v) + ".\n\n"
        "The guard now reviews bash/write/edit/read calls; `jev_decide`, `jev_select` and `jev_status` are live; `jev_verify` is available (enable optional advice with `/jev verification on`); `jev_evidence` is available (enable descriptor relevance advice with `/jev evidence on`); `jev_diagnose` is available (enable supplied-hypothesis/check advice with `/jev diagnosis on`)."
    )


def _parse_on_off(word: str) -> bool | None:
    w = word.strip().lower()
    if w in ("on", "true", "1", "yes", "enable", "enabled"):
        return True
    if w in ("off", "false", "0", "no", "disable", "disabled"):
        return False
    return None


def _setting_args(rest: list[str], *, mode: bool = False) -> tuple[str | None, bool]:
    words = [a for a in rest if a != "--save"]
    if rest.count("--save") > 1 or (mode and (len(words) != 1 or words[0] not in ("jev", "deterministic"))) or (not mode and words):
        raise ValueError("expected jev|deterministic [--save]" if mode else "expected [--save]")
    return (words[0] if mode else None), "--save" in rest


def _save_setting(name: str, value: str, host_call) -> None:
    try:
        host_call("config.set", {"key": name, "value": value})
    except Exception:
        keys.write_plugin_config(name, value)


def _cmd_compress_mode(rest, ext, out, host_call) -> None:
    mode, persist = _setting_args(rest, mode=True)
    if persist:
        _save_setting("compress_mode", mode, host_call)
    ext.set_compress_mode(mode, persist=persist)
    out.system(f"compress mode: {mode} — " + ("saved" if persist else "session only; --save persists"))
    out.text("Mode does not enable compression; use `/jev compress on` or `/jev economy`.")


def _cmd_economy(rest, ext, out, host_call) -> None:
    _, persist = _setting_args(rest)
    settings = {name: name in ("router", "triage", "compress", "context")
                for name in ext.FEATURE_DEFAULTS if name != "guard"}
    if persist:
        _save_setting("compress_mode", "deterministic", host_call)
        for name, enabled in settings.items():
            _save_setting(name, "true" if enabled else "false", host_call)
    ext.set_compress_mode("deterministic", persist=persist)
    for name, enabled in settings.items():
        ext.set_feature(name, enabled, persist=persist)
    out.system("Economy preset applied; guard unchanged; compression deterministic — "
               + ("saved" if persist else "session only; --save persists"))
    out.text("Router, triage and context configured on; discovery, verification, evidence, diagnosis and reports off. "
             "Economy is a preset, not a savings estimate. /jev on enables all features including guard; "
             "it leaves the chosen compression mode alone.")
    if ext.client is None:
        out.text("No API key: only local compression is active. Remote features need `/jev key <apikey_…>`; "
                 "guard remains inert and tools remain available.")


def _cmd_feature(names: list[str], rest: list[str], ext, out: Emitter, host_call) -> None:
    """`/jev <feature> on|off [--save]` and `/jev on|off [--save]`."""
    flags = {a.lower() for a in rest if a.startswith("-")}
    words = [a for a in rest if not a.startswith("-")]
    persist = bool(flags & {"--save", "--persist", "-s"})
    if not words:
        rows = []
        for n in names:
            live = ext.features.get(n, False)
            src = "session override" if n in ext.session_overrides else "config"
            rows.append([n, "on" if live else "off", src, "on" if ext.configured_feature(n) else "off"])
        out.table(["feature", "now", "source", "saved"], rows)
        out.text(f"Flip with `/jev {names[0] if len(names) == 1 else 'off'} on|off` (session) — add `--save` to persist.")
        return
    enabled = _parse_on_off(words[0])
    if enabled is None:
        out.error(f"expected on|off, got {words[0]!r}")
        return
    if ext.client is None and enabled and not (names == ["compress"] and ext.compress_cfg.mode == "deterministic"):
        out.error("No API key — nothing to enable. Run `/jev key <apikey_…>` first.")
        return

    saved_to = None
    for n in names:
        if persist:
            try:
                host_call("config.set", {"key": n, "value": "true" if enabled else "false"})
                saved_to = f"host config.set → {keys.plugin_config_path()}"
            except Exception as e:  # noqa: BLE001
                keys.write_plugin_config(n, "true" if enabled else "false")
                saved_to = f"{keys.plugin_config_path()} (direct write; host config.set unavailable: {e})"
        ext.set_feature(n, enabled, persist=persist)

    state = "on" if enabled else "off"
    what = ", ".join(names)
    scope = f"saved ({saved_to})" if persist else "this session only — add `--save` to persist"
    out.system(f"jev {what}: {state} — {scope}")
    if "guard" in names:
        if enabled:
            out.text("✓ The safety gate is reviewing bash/write/edit/read calls again.")
        else:
            out.text(
                "⚠ Tool calls are no longer reviewed by Jev"
                + (" until you run `/jev guard on`." if not persist else "; `/jev guard on --save` re-enables.")
                + " `jev_decide` / `jev_select` / `jev_status` remain available."
            )
    ext.audit.bump(f"feature.{'+'.join(names)}.{state}")


def _cmd_status(ext, out: Emitter) -> None:
    key, source = keys.discover()
    active = ext.client is not None
    rows = [
        ["active", "yes" if active else "no — run `/jev key <apikey_…>`"],
        ["key", f"{keys.redact(key)}  ({source})" if key else f"(none)  → {keys.GET_KEY_URL}"],
        ["model", ext.model_name() + (f"  (answering as {ext.client.stats.last_model})" if active and ext.client.stats.last_model else "")],
        ["features", _features_line(ext)],
        ["compress mode", ext.compress_cfg.mode],
        ["local compression folds", str(ext.audit.counters.get("compress.local", 0))],
        ["audit", str(ext.audit.path) if ext.audit.path else "(off)"],
    ]
    stats = ext.client.stats if active else ext.stats
    if stats is not None:
        s = stats.snapshot()
        rows += [
            ["calls / errors", f"{s['calls']} / {s['errors']}"],
            ["tokens / cost", f"{s['input_tokens'] if s['input_tokens'] is not None else 'unknown'} / {_cost(s['cost_usd'])}"],
            ["mean latency", f"{s['mean_ms']} ms"],
            ["per-op (estimated Jev cost only)", str(s["op_stats"])],
            ["verdicts", ", ".join(f"{k}={v}" for k, v in sorted(ext.audit.counters.items())) or "—"],
        ]
    rows.append(["explanations", "Last 64 plugin-process rows: /jev explain [clear]; clear is not accounting reset"])
    rows.append(["budget", json.dumps(ext.policy.snapshot(), sort_keys=True)])
    out.table(["jev", ""], rows)
    out.text("/jev on [--save]: all features including guard, mode unchanged. "
             "/jev economy [--save]: guard unchanged, router/triage/context on, deterministic compression; "
             "other optional advice off. Remote features require a key; no savings estimate.")


def _features_line(ext) -> str:
    parts = []
    for k, v in ext.features.items():
        if k in ext.session_overrides:
            parts.append(f"{k}={'on' if v else 'off'} (session)")
        elif v:
            parts.append(k)
        else:
            parts.append(f"{k}=off")
    return ", ".join(parts)


def _cmd_test(ext, out: Emitter) -> None:
    if ext.client is None:
        out.error("No API key. Run `/jev key <apikey_…>` first.")
        return
    t0 = time.monotonic()
    resp = ext.client.decide(
        {"tool": "bash", "command": "git push --force origin main"},
        {
            "risk": {"type": "score", "instructions": "How risky is running `command` unattended?",
                     "criteria": ["read-only", "reversible", "hard to reverse", "irreversible / remote"]},
            "ask_user": {"type": "noul", "instructions": "Should an agent harness pause and ask a human before running `command`?"},
        },
        op="test",
    )
    ms = int((time.monotonic() - t0) * 1000)
    a = resp["answers"]
    tokens = usage_tokens(resp)
    out.text(
        f"`git push --force origin main` → risk **{a['risk']['score']:.2f}**/3 "
        f"(conf {a['risk']['confidence']:.2f}), ask_user **{a['ask_user']['noul']:.2f}** — "
        f"{ms} ms, {tokens} tokens, {_cost(None if tokens is None else tokens * 0.042 / 1e6)}, model {resp.get('model')}"
    )
    out.system(json.dumps(a, separators=(",", ":"))[:600])


def _cost(value):
    return "unknown" if value is None else f"${value:.6f}"


def _cmd_budget(rest, ext, out, host_call):
    if not rest:
        out.text(json.dumps(ext.policy.snapshot(), sort_keys=True))
        return
    if rest == ["reset"]:
        ext.policy.reset()
        out.system("Optional budget session state reset; guard and accounting unchanged.")
        return
    persist = rest[-1:] == ["--save"]
    words = rest[:-1] if persist else rest
    aliases = {"calls": "calls", "cost": "cost_usd", "latency": "latency_ms",
               "errors": "error_streak", "cooldown": "cooldown_s"}
    if len(words) == 1 and words[0] in ("on", "off"):
        name, value = "enabled", words[0] == "on"
    elif len(words) == 2 and words[0] in aliases:
        name = aliases[words[0]]
        value = validate(name, words[1])
    else:
        raise ValueError("expected budget on|off or calls N|cost USD|latency MS|errors N|cooldown SECONDS [--save], or reset")
    if persist:
        _save_setting("budget_" + name, str(value).lower(), host_call)
        ext.cfg["budget_" + name] = value
    ext.policy.settings[name] = value
    out.system("Optional budget setting updated; session state retained. Guard excluded; cost is input-only estimated.")
