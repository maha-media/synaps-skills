#!/usr/bin/env python3
"""
plugin-maker — SynapsCLI extension.

Implements the v1 extension protocol over JSON-RPC 2.0 on stdio. Each frame is
a single JSON object on its own line. This extension is a thin RPC adapter
that shells out to the bash CLI at ../bin/plugin-maker.

Capabilities used:
    permissions: tools.intercept, session.lifecycle, config.subscribe, config.write
    hooks:       on_session_start, before_tool_call (bash), after_tool_call (bash)
    methods:     command.invoke, settings.editor.{open,render,key,commit}, help.lightbox.refresh

Showcase wiring:
    /help lightbox  ← help_entries in manifest are auto-indexed by Synaps.
    /settings menu  ← settings.categories in manifest + custom 'editor' field
                      backed by settings.editor.* RPC below.
    on_session_start → injects a one-line health summary if any installed
                       plugin fails validate.
    before/after bash → if cwd looks like a plugin and a plugin.json was
                       touched, suggests / runs `plugin-maker validate`.
"""

from __future__ import annotations
import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

EXT_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = EXT_DIR.parent
CLI = PLUGIN_ROOT / "bin" / "plugin-maker"

PROTOCOL_VERSION = 1
EXT_NAME = "plugin-maker"
EXT_VERSION = "0.1.0"

# ── stdio JSON-RPC plumbing (LSP-style Content-Length framing) ──────────────
_lock = threading.Lock()


def _send(obj: dict[str, Any]) -> None:
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    header = b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n"
    with _lock:
        sys.stdout.buffer.write(header + body)
        sys.stdout.buffer.flush()


def _read_frame() -> dict[str, Any] | None:
    """Read one Content-Length-framed JSON-RPC message from stdin. Returns None on EOF."""
    content_length: int | None = None
    while True:
        line = sys.stdin.buffer.readline()
        if line == b"":  # EOF
            return None
        if line in (b"\r\n", b"\n"):
            break
        name, _, value = line.decode("ascii", errors="replace").partition(":")
        if name.strip().lower() == "content-length":
            try:
                content_length = int(value.strip())
            except ValueError:
                content_length = None
    if content_length is None:
        # Malformed frame — skip and try again rather than crashing the loop.
        return {}
    body = sys.stdin.buffer.read(content_length)
    if len(body) < content_length:
        return None  # EOF mid-frame
    try:
        return json.loads(body.decode("utf-8"))
    except json.JSONDecodeError:
        return {}


def _ok(req_id: Any, result: Any) -> None:
    _send({"jsonrpc": "2.0", "id": req_id, "result": result})


def _err(req_id: Any, code: int, message: str, data: Any = None) -> None:
    body: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        body["data"] = data
    _send({"jsonrpc": "2.0", "id": req_id, "error": body})


def _log(msg: str) -> None:
    sys.stderr.write(f"[plugin-maker] {msg}\n")
    sys.stderr.flush()


# ── shell helper ────────────────────────────────────────────────────────────
def _run_cli(*args: str, cwd: str | None = None, timeout: int = 20) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            [str(CLI), *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "exit": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        }
    except subprocess.TimeoutExpired:
        return {"exit": 124, "stdout": "", "stderr": f"timeout after {timeout}s"}
    except FileNotFoundError:
        return {"exit": 127, "stdout": "", "stderr": f"plugin-maker CLI not found at {CLI}"}


def _looks_like_plugin_dir(path: str) -> bool:
    if not path:
        return False
    return (Path(path) / ".synaps-plugin" / "plugin.json").is_file()


def _enclosing_plugin(path: str | None) -> str | None:
    if not path:
        return None
    p = Path(path).resolve()
    for cand in [p, *p.parents]:
        if (cand / ".synaps-plugin" / "plugin.json").is_file():
            return str(cand)
    return None


# ── handlers ────────────────────────────────────────────────────────────────
def h_initialize(_params: dict) -> dict:
    return {
        "name": EXT_NAME,
        "version": EXT_VERSION,
        "protocol_version": PROTOCOL_VERSION,
        "capabilities": {
            "hooks": ["on_session_start", "before_tool_call", "after_tool_call"],
            "commands": ["plugin-maker"],
            "settings_editors": ["browse_plugins"],
        },
    }


def h_shutdown(_params: dict) -> dict:
    return {"ok": True}


# ── hooks ───────────────────────────────────────────────────────────────────
def h_on_session_start(_params: dict) -> dict:
    """Synaps' OnSessionStart hook only accepts `continue` — we cannot inject
    a message from here. We log the health summary to stderr (visible in the
    Synaps debug log) and stay out of the way."""
    repo = os.environ.get("SYNAPS_SKILLS_REPO") or str(Path.home() / "Projects/Maha-Media/synaps-skills")
    if Path(repo).is_dir():
        # Fire-and-forget: don't block the session boot on a full validate.
        try:
            res = _run_cli("validate", repo, timeout=5)
            if res["exit"] != 0:
                summary = ""
                for line in (res["stdout"] + "\n" + res["stderr"]).splitlines():
                    if "error(s)" in line:
                        summary = line.strip()
                        break
                _log(f"session-start health: {summary or 'plugin-maker found issues'}")
            else:
                _log("session-start health: all installed plugins clean")
        except Exception as e:  # noqa: BLE001
            _log(f"session-start health check failed: {e!r}")
    return {"action": "continue"}


def _bash_targets_plugin_json(params: dict) -> str | None:
    """If the bash command seems to touch a plugin.json, return the enclosing plugin dir."""
    inp = params.get("input") or {}
    cmd = inp.get("command") or inp.get("cmd") or ""
    if "plugin.json" not in cmd:
        return None
    # Heuristic: the agent's cwd, falling back to params.cwd
    cwd = params.get("cwd") or os.getcwd()
    return _enclosing_plugin(cwd)


def h_before_tool_call(params: dict) -> dict:
    # before_tool_call only accepts: continue, block, confirm, modify.
    # We just observe and continue — no `annotate` field exists.
    if (params.get("tool") or "") != "bash":
        return {"action": "continue"}
    plugin = _bash_targets_plugin_json(params)
    if plugin:
        _log(f"observe: bash about to touch {Path(plugin).name}/.synaps-plugin/plugin.json")
    return {"action": "continue"}


def h_after_tool_call(params: dict) -> dict:
    # after_tool_call only accepts: continue.
    if (params.get("tool") or "") != "bash":
        return {"action": "continue"}
    plugin = _bash_targets_plugin_json(params)
    if not plugin:
        return {"action": "continue"}
    try:
        res = _run_cli("validate", plugin, timeout=8)
        if res["exit"] == 0:
            _log(f"post-bash: {Path(plugin).name} still validates ✓")
        else:
            tail = (res["stdout"] + res["stderr"]).strip().splitlines()[-3:]
            _log(f"post-bash: {Path(plugin).name} validate ✗ — " + " | ".join(tail))
    except Exception as e:  # noqa: BLE001
        _log(f"post-bash validate failed: {e!r}")
    return {"action": "continue"}


# ── command.invoke (interactive /plugin-maker subcommands) ──────────────────
def h_command_invoke(params: dict) -> dict:
    sub = (params.get("subcommand") or params.get("name") or "").strip()
    args = params.get("args") or []
    if not isinstance(args, list):
        args = [str(args)]
    if not sub:
        return {"output": "usage: /plugin-maker <new|validate|lint|info|doctor|list|catalog> [...]"}
    res = _run_cli(sub, *map(str, args))
    return {
        "output": (res["stdout"] + res["stderr"]).rstrip() or f"(exit {res['exit']})",
        "exit": res["exit"],
    }


# ── settings.editor.* (custom Plugin Browser overlay) ───────────────────────
_browser_state: dict[str, Any] = {"plugins": [], "cursor": 0, "msg": ""}


def _scan_repo_plugins() -> list[dict[str, Any]]:
    repo = os.environ.get("SYNAPS_SKILLS_REPO") or str(Path.home() / "Projects/Maha-Media/synaps-skills")
    out: list[dict[str, Any]] = []
    if not Path(repo).is_dir():
        return out
    for entry in sorted(Path(repo).iterdir()):
        manifest = entry / ".synaps-plugin" / "plugin.json"
        if not manifest.is_file():
            continue
        try:
            mf = json.loads(manifest.read_text())
        except Exception:
            mf = {}
        v = _run_cli("validate", str(entry), timeout=8)
        out.append({
            "path": str(entry),
            "name": mf.get("name") or entry.name,
            "version": mf.get("version") or "?",
            "valid": v["exit"] == 0,
            "skills": len(list((entry / "skills").glob("*"))) if (entry / "skills").is_dir() else 0,
            "has_extension": bool(mf.get("extension")),
            "has_sidecar": bool(((mf.get("provides") or {}).get("sidecar"))),
        })
    return out


def h_settings_editor_open(params: dict) -> dict:
    if (params.get("field") or "") != "browse_plugins":
        return {"ok": False, "message": "unknown field"}
    _browser_state["plugins"] = _scan_repo_plugins()
    _browser_state["cursor"] = 0
    _browser_state["msg"] = ""
    return {"ok": True, "title": "Plugin Browser", "size": "80x24"}


def _render_browser() -> str:
    rows = _browser_state["plugins"]
    cur = _browser_state["cursor"]
    lines = [
        "Plugin Browser  —  ↑/↓ move · Enter info · v validate · l lint · r refresh · Esc close",
        "─" * 76,
    ]
    if not rows:
        lines.append("(no plugins found in synaps-skills repo)")
    for i, p in enumerate(rows):
        mark = "✓" if p["valid"] else "✗"
        sel = "▶" if i == cur else " "
        feats = []
        if p["has_extension"]:
            feats.append("ext")
        if p["has_sidecar"]:
            feats.append("sc")
        feats.append(f"{p['skills']}s")
        lines.append(f"{sel} [{mark}] {p['name']:<28} {p['version']:<8} {','.join(feats)}")
    if _browser_state["msg"]:
        lines.append("─" * 76)
        for line in _browser_state["msg"].splitlines()[-8:]:
            lines.append(line)
    return "\n".join(lines)


def h_settings_editor_render(_params: dict) -> dict:
    return {"text": _render_browser()}


def h_settings_editor_key(params: dict) -> dict:
    key = (params.get("key") or "").lower()
    rows = _browser_state["plugins"]
    cur = _browser_state["cursor"]
    if key in ("up", "k"):
        _browser_state["cursor"] = max(0, cur - 1)
    elif key in ("down", "j"):
        _browser_state["cursor"] = min(max(0, len(rows) - 1), cur + 1)
    elif key == "r":
        _browser_state["plugins"] = _scan_repo_plugins()
        _browser_state["msg"] = "(refreshed)"
    elif key == "v" and rows:
        res = _run_cli("validate", rows[cur]["path"])
        _browser_state["msg"] = (res["stdout"] + res["stderr"]).strip() or "(no output)"
    elif key == "l" and rows:
        res = _run_cli("lint", rows[cur]["path"])
        _browser_state["msg"] = (res["stdout"] + res["stderr"]).strip() or "(no output)"
    elif key == "enter" and rows:
        res = _run_cli("info", rows[cur]["path"])
        _browser_state["msg"] = (res["stdout"] + res["stderr"]).strip() or "(no output)"
    elif key in ("escape", "esc", "q"):
        return {"close": True}
    return {"text": _render_browser()}


def h_settings_editor_commit(_params: dict) -> dict:
    return {"ok": True}


# ── dispatch table ──────────────────────────────────────────────────────────
# Hook handlers are dispatched via the single `hook.handle` method using the
# `kind` field in params (per Synaps protocol). Top-level methods are the
# RPC verbs Synaps actually sends to the extension process.
_HOOK_HANDLERS: dict[str, Any] = {
    "on_session_start": h_on_session_start,
    "before_tool_call": h_before_tool_call,
    "after_tool_call": h_after_tool_call,
}


def h_hook_handle(params: dict) -> dict:
    kind = params.get("kind") or ""
    handler = _HOOK_HANDLERS.get(kind)
    if handler is None:
        # Unknown hook kind — return continue so we don't break the session.
        return {"action": "continue"}
    return handler(params)


HANDLERS: dict[str, Any] = {
    "initialize": h_initialize,
    "shutdown": h_shutdown,
    "hook.handle": h_hook_handle,
    "command.invoke": h_command_invoke,
    "settings.editor.open": h_settings_editor_open,
    "settings.editor.key": h_settings_editor_key,
    "settings.editor.commit": h_settings_editor_commit,
}


def main() -> int:
    _log(f"started v{EXT_VERSION} (cli={CLI})")
    if not CLI.is_file() or not os.access(CLI, os.X_OK):
        _log(f"warning: bash CLI not executable at {CLI}")
    # LSP-style Content-Length framing — Synaps does not use line-delimited JSON.
    while True:
        req = _read_frame()
        if req is None:  # EOF — parent closed stdin
            break
        if not req:  # malformed frame, skip
            continue
        method = req.get("method")
        params = req.get("params") or {}
        req_id = req.get("id")
        handler = HANDLERS.get(method)
        if handler is None:
            if req_id is not None:
                _err(req_id, -32601, f"method not found: {method}")
            continue
        try:
            result = handler(params)
        except Exception as e:  # noqa: BLE001
            _log(f"handler {method} raised: {e!r}")
            if req_id is not None:
                _err(req_id, -32000, f"handler error: {e}")
            continue
        if req_id is not None:
            _ok(req_id, result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
