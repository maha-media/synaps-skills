"""commands — the `/jev` interactive slash command.

    /jev key <apikey_…>   validate the key live, persist it, activate now (no restart)
    /jev key              show where a key would be read from / how to get one
    /jev status           configured? source, model, features, session stats
    /jev test             one live decision: latency + cost
    /jev guard on|off [--save]     flip the tool-call safety gate (session-only unless --save)
    /jev router on|off [--save]    flip subagent routing
    /jev compress on|off [--save]  flip output compression
    /jev off|on [--save]           all features at once (all five tools stay advertised)

Output is streamed as `command.output` notifications (text/system/error/done)
matched by `request_id`; the RPC response body itself is ignored by the TUI.
"""

from __future__ import annotations

import json
import time

from . import keys
from .client import DecisionClient, JevError

USAGE = (
    "**/jev** — TypeSafe Jev decision layer\n\n"
    "| command | does |\n|---|---|\n"
    "| `/jev key <apikey_…>` | validate, save, and activate an API key (no restart) |\n"
    "| `/jev status` | configuration + session stats |\n"
    "| `/jev test` | one live decision: latency + cost |\n"
    "| `/jev guard off` | stop reviewing tool calls for this session (`--save` persists) |\n"
    "| `/jev guard on` | resume the safety gate |\n"
    "| `/jev router on\\|off`, `/jev compress on\\|off` | flip sparse session-cached routing or compression; `/jev triage on or off` controls advisory failure triage; `/jev discovery on or off [--save]` controls opt-in discovery advice |\n"
    "| `/jev evidence on\\|off [--save]` | opt-in descriptor relevance advice; no fetch or trust certification |\n"
    "| `/jev verification on\\|off [--save]` | opt-in explicit optional-check prioritization, independent of guard |\n"
    "| `/jev off` / `/jev on` | guard+router+compress+triage+discovery+verification+evidence together (including opt-in API calls); all five tools stay advertised |\n\n"
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
    """Entry point from the RPC loop. `ext` is the Extension; `host_call`
    performs an outbound JSON-RPC request to the host (or raises)."""
    out = Emitter(send, str(params.get("request_id") or ""))
    args = [str(a) for a in (params.get("args") or [])]
    sub = args[0].lower() if args else ""
    try:
        if sub == "key":
            _cmd_key(args[1:], ext, out, host_call)
        elif sub == "status":
            _cmd_status(ext, out)
        elif sub == "test":
            _cmd_test(ext, out)
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
        "The guard now reviews bash/write/edit/read calls; `jev_decide`, `jev_select` and `jev_status` are live; `jev_verify` is available (enable optional advice with `/jev verification on`); `jev_evidence` is available (enable descriptor relevance advice with `/jev evidence on`)."
    )


def _parse_on_off(word: str) -> bool | None:
    w = word.strip().lower()
    if w in ("on", "true", "1", "yes", "enable", "enabled"):
        return True
    if w in ("off", "false", "0", "no", "disable", "disabled"):
        return False
    return None


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
    if ext.client is None and enabled:
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
        ["audit", str(ext.audit.path) if ext.audit.path else "(off)"],
    ]
    if active:
        s = ext.client.stats.snapshot()
        rows += [
            ["calls / errors", f"{s['calls']} / {s['errors']}"],
            ["tokens / cost", f"{s['input_tokens']} / ${s['cost_usd']:.6f}"],
            ["mean latency", f"{s['mean_ms']} ms"],
            ["per-op (estimated Jev cost only)", str(s["op_stats"])],
            ["verdicts", ", ".join(f"{k}={v}" for k, v in sorted(ext.audit.counters.items())) or "—"],
        ]
    out.table(["jev", ""], rows)


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
    tokens = int((resp.get("usage") or {}).get("input_tokens") or 0)
    out.text(
        f"`git push --force origin main` → risk **{a['risk']['score']:.2f}**/3 "
        f"(conf {a['risk']['confidence']:.2f}), ask_user **{a['ask_user']['noul']:.2f}** — "
        f"{ms} ms, {tokens} tokens, ${tokens * 0.042 / 1e6:.6f}, model {resp.get('model')}"
    )
    out.system(json.dumps(a, separators=(",", ":"))[:600])
