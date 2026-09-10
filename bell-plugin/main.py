#!/usr/bin/env python3
"""
bell — ring the terminal bell when the assistant's turn completes.

Wire protocol: JSON-RPC 2.0 over stdio with Content-Length framing (see
SynapsCLI docs/extensions/protocol.md). The runtime calls us; we only respond.

Signal derivation (README.md):
  * `on_message_complete` with `data.has_tool_use == false` is a candidate
    turn end; it arms a short settle timer.
  * `before_message` arriving before the timer fires means the turn is
    continuing (steering, autonomous driver): the candidate is cancelled.
  * Otherwise one BEL byte (0x07) is written to the controlling terminal.

Privacy: both hooks carry assistant/user text because they require the
`privacy.llm_content` permission. This plugin reads only `kind` and
`data.has_tool_use`; message bodies are never inspected, stored, or logged.
"""

import json
import os
import stat
import sys
import threading
import time

BEL = b"\x07"
DEFAULTS = {"enabled": True, "settle_ms": 400, "min_interval_ms": 1000, "tty": ""}
SETTLE_BOUNDS = (0, 10_000)
INTERVAL_BOUNDS = (0, 60_000)


# ── Framing ───────────────────────────────────────────────────────────

def read_message(stream=None):
    """Read one Content-Length-framed JSON-RPC message, or None on EOF."""
    stream = stream or sys.stdin.buffer
    content_length = None
    while True:
        line = stream.readline()
        if line == b"":
            return None
        if line in (b"\r\n", b"\n"):
            break
        name, _, value = line.decode("ascii", "replace").partition(":")
        if name.strip().lower() == "content-length":
            try:
                content_length = int(value.strip())
            except ValueError:
                return None
    if content_length is None or content_length < 0:
        return None
    body = stream.read(content_length)
    if len(body) != content_length:
        return None
    try:
        return json.loads(body)
    except ValueError:
        return None


def write_message(request, result=None, error=None, stream=None):
    stream = stream or sys.stdout.buffer
    payload = {"jsonrpc": "2.0", "id": request.get("id")}
    if error is None:
        payload["result"] = result
    else:
        payload["error"] = error
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    stream.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body)
    stream.flush()


# ── Configuration ─────────────────────────────────────────────────────

def _coerce_bool(value, default):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "1", "yes", "on"):
            return True
        if lowered in ("false", "0", "no", "off"):
            return False
    return default


def _coerce_ms(value, default, bounds):
    if isinstance(value, bool):
        return default
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return default
    low, high = bounds
    if number < low or number > high:
        return default
    return number


def resolve_config(raw):
    """Coerce the resolved `initialize` config; invalid values fall back."""
    raw = raw if isinstance(raw, dict) else {}
    return {
        "enabled": _coerce_bool(raw.get("enabled"), DEFAULTS["enabled"]),
        "settle_ms": _coerce_ms(raw.get("settle_ms"), DEFAULTS["settle_ms"], SETTLE_BOUNDS),
        "min_interval_ms": _coerce_ms(
            raw.get("min_interval_ms"), DEFAULTS["min_interval_ms"], INTERVAL_BOUNDS
        ),
        "tty": raw.get("tty").strip() if isinstance(raw.get("tty"), str) else "",
    }


# ── Terminal output ───────────────────────────────────────────────────

def ring_terminal(path=None):
    """Write one BEL to the controlling terminal. Silent no-op on failure.

    The `tty` config entry (or `path`) redirects the target; a regular file
    is accepted only through that override so tests can capture the byte.
    The host clears the child environment, so `SYNAPS_BELL_TTY` only applies
    when the plugin is driven directly (its own test harness).
    """
    override = path if path is not None else os.environ.get("SYNAPS_BELL_TTY")
    override = override or None
    target = override or "/dev/tty"
    flags = os.O_WRONLY | getattr(os, "O_NOCTTY", 0) | getattr(os, "O_CLOEXEC", 0)
    if override:
        flags |= os.O_APPEND
    try:
        fd = os.open(target, flags)
    except OSError:
        return False
    try:
        mode = os.fstat(fd).st_mode
        if not (stat.S_ISCHR(mode) or (override and stat.S_ISREG(mode))):
            return False
        os.write(fd, BEL)
        return True
    except OSError:
        return False
    finally:
        os.close(fd)


# ── Turn-boundary detector ────────────────────────────────────────────

class Bell:
    """Owns the settle timer and rate limit. Thread-safe."""

    def __init__(self, config, ring=ring_terminal, clock=time.monotonic, timer_factory=threading.Timer):
        self.config = config
        self._ring = ring
        self._clock = clock
        self._timer_factory = timer_factory
        self._lock = threading.Lock()
        self._timer = None
        self._last_ring = None
        self.rings = 0

    def handle_hook(self, params):
        kind = params.get("kind") if isinstance(params, dict) else None
        if kind == "before_message":
            self._cancel()
        elif kind == "on_message_complete":
            data = params.get("data")
            has_tool_use = data.get("has_tool_use") if isinstance(data, dict) else None
            if has_tool_use is False:
                self._arm()
        return {"action": "continue"}

    def _arm(self):
        if not self.config["enabled"]:
            return
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
            delay = self.config["settle_ms"] / 1000.0
            timer = self._timer_factory(delay, self._fire)
            timer.daemon = True
            self._timer = timer
            timer.start()

    def _cancel(self):
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None

    def _fire(self):
        with self._lock:
            self._timer = None
            now = self._clock()
            interval = self.config["min_interval_ms"] / 1000.0
            if self._last_ring is not None and now - self._last_ring < interval:
                return
            self._last_ring = now
            self.rings += 1
        self._ring(self.config["tty"] or None)

    def shutdown(self):
        self._cancel()


# ── Dispatch loop ─────────────────────────────────────────────────────

def serve(stdin=None, stdout=None, ring=ring_terminal):
    """Dispatch loop. `ring(path_or_none)` receives the configured override."""
    bell = Bell(resolve_config({}), ring=ring)
    while True:
        request = read_message(stdin)
        if request is None:
            break
        if not isinstance(request, dict):
            continue
        method = request.get("method")
        if method == "initialize":
            params = request.get("params") or {}
            bell.config = resolve_config(params.get("config"))
            write_message(request, {"protocol_version": 1, "capabilities": {}}, stream=stdout)
        elif method == "hook.handle":
            write_message(request, bell.handle_hook(request.get("params") or {}), stream=stdout)
        elif method == "shutdown":
            bell.shutdown()
            write_message(request, None, stream=stdout)
            break
        elif "id" in request:
            write_message(
                request,
                error={"code": -32601, "message": f"unknown method: {method}"},
                stream=stdout,
            )
    bell.shutdown()


if __name__ == "__main__":
    serve()
