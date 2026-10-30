"""Relay transport: jev.decide through the Pria Desktop app (contract J1 r1.1).

On a Pria host the plugin holds no Jev key. Each decision opens ONE short
connection to the app's Fleet API socket (~/.local/state/pria-desktop/
fleet.sock), says hello with the app's per-start fleet.token (read fresh per
connection, never kept, never logged), sends one `jev.decide` line and reads
one reply line. Any refusal, malformed or missing answer, close or deadline is
a RelayOff: the call behaves exactly as if no client existed (Jev-off), with
no retry and no fallback to a local key or direct HTTP.

The request line is built only by json.dumps of the parsed {state, questions}
objects (never spliced caller text), and the reply is parsed and validated,
never compared as bytes.
"""

from __future__ import annotations

import contextlib
import contextvars
import json
import math
import os
import socket
import time
from pathlib import Path

from .client import DecisionClient, JevError, Stats
from .logs import notice

VERSION = "0.9.0"  # == .synaps-plugin/plugin.json "version"
CLIENT = f"jev-relay/{VERSION}"
STATE_DIR = None  # None: ~/.local/state/pria-desktop (tests point this at a temp dir)
SOCKET_NAME = "fleet.sock"
TOKEN_NAME = "fleet.token"
MAX_LINE = 65536  # whole request line, newline included
MAX_REPLY = 1 << 20  # bytes buffered for one welcome/reply line
MAX_SESSION_BYTES = 256

SERVER_CODES = frozenset({
    "not_signed_in", "needs_sign_in", "busy", "secret_in_state", "invalid_request", "unavailable",
    "unauthorized", "line_too_long", "bad_request", "unknown_verb", "not_available", "internal", "restarting"})
LOCAL_CODES = frozenset({"no_socket", "no_token", "no_relay", "too_large", "deadline", "malformed", "closed",
                         "unknown_code", "error"})
CODES = SERVER_CODES | LOCAL_CODES

# Negative cache (seconds without connecting after this code): protects the
# app's 16-connection Fleet API; it is not a retry. Codes absent here: 0.
HOLD_S = {"no_socket": 60, "no_relay": 60, "unknown_verb": 60, "not_available": 60,
          "unauthorized": 30, "not_signed_in": 30, "needs_sign_in": 30,
          "restarting": 10, "busy": 2,
          # the app or Pria down/stalling: without a hold every guarded tool call would wait ~3 s
          "deadline": 5, "unavailable": 5, "internal": 5, "closed": 5, "malformed": 5, "error": 5}
RELAY_FAMILY = "relay"  # the limiter family of the state notices (relay:<code>)

_clock = time.monotonic

SESSION: contextvars.ContextVar = contextvars.ContextVar("jev_relay_session", default=None)


def state_dir() -> Path:
    return Path(STATE_DIR) if STATE_DIR else Path.home() / ".local" / "state" / "pria-desktop"


def valid_session(value) -> bool:
    return (isinstance(value, str) and value.strip() != ""
            and len(value.encode("utf-8", "surrogatepass")) <= MAX_SESSION_BYTES
            and not any(ord(c) < 0x20 or 0x7F <= ord(c) < 0xA0 for c in value))


@contextlib.contextmanager
def session(value):
    """The hook/tool session id for requests encoded inside this block
    (omitted when absent or invalid)."""
    mark = SESSION.set(value if valid_session(value) else None)
    try:
        yield
    finally:
        SESSION.reset(mark)


class RelayOff(JevError):
    """This call is Jev-off. `code` is from the closed set CODES; the message
    is fixed text built from it alone (never upstream text, token or state)."""

    def __init__(self, code: str) -> None:
        self.code = code if code in CODES else "unknown_code"
        super().__init__(f"Jev is off for this call (Pria relay: {self.code})")


class _Lines:
    """Bounded newline-framed reads within one absolute deadline."""

    def __init__(self, sock: socket.socket, end: float) -> None:
        self.sock, self.end, self.buf = sock, end, bytearray()

    def line(self) -> bytes:
        while True:
            i = self.buf.find(b"\n")
            if i >= 0:
                out = bytes(self.buf[:i])
                del self.buf[:i + 1]
                return out
            if len(self.buf) > MAX_REPLY:
                raise RelayOff("unavailable")
            _arm(self.sock, self.end)
            chunk = self.sock.recv(min(65536, MAX_REPLY + 1 - len(self.buf)))
            if not chunk:
                raise RelayOff("closed")
            self.buf += chunk


def _arm(sock: socket.socket, end: float) -> None:
    remaining = end - time.monotonic()
    if remaining <= 0:
        raise RelayOff("deadline")
    sock.settimeout(remaining)


def _reject_constant(name):
    raise ValueError("non-standard JSON constant")


def _parse(line: bytes):
    try:
        return json.loads(line.decode("utf-8"), parse_constant=_reject_constant)
    except Exception:  # noqa: BLE001 — bad UTF-8/JSON, depth or size: never echo it
        raise RelayOff("malformed") from None


def _refusal(obj) -> RelayOff | None:
    error = obj.get("error") if isinstance(obj, dict) and obj.get("ok") is False else None
    if isinstance(error, dict) and isinstance(error.get("code"), str):
        return RelayOff(error["code"] if error["code"] in SERVER_CODES else "unknown_code")
    return None


def _hello_line(directory: Path) -> bytes:
    try:
        with open(directory / TOKEN_NAME, "rb") as f:
            raw = f.read(80)
    except OSError:
        raise RelayOff("no_token") from None
    text = raw[:-1] if raw.endswith(b"\n") else raw
    if len(text) != 64 or any(b not in b"0123456789abcdefABCDEF" for b in text):
        raise RelayOff("no_token")
    return json.dumps({"verb": "hello", "token": text.decode("ascii"), "api": 1, "client": CLIENT},
                      separators=(",", ":")).encode("ascii") + b"\n"


class RelayClient(DecisionClient):
    """DecisionClient whose wire is the Pria Desktop Fleet API socket."""

    def __init__(self, *, model: str = "jev-latest", timeout_s: float = 3.0, policy=None, diagnostic=None,
                 state_dir=None, log=None, bump=None) -> None:
        # No api_key: the app authenticates upstream; this object never holds a credential.
        self.model = model
        self.timeout_s = min(4.0, max(0.1, timeout_s)) if math.isfinite(timeout_s) else 3.0
        self.stats = Stats()
        self.policy = policy
        self.diagnostic = diagnostic
        self.state_dir = state_dir
        self.log = log or (lambda msg: None)
        self.bump = bump or (lambda name: None)
        self.relay_code = None  # None: no call yet; "ok" or the last Jev-off code
        self._held_code = None
        self._hold_until = 0.0
        self._seq = 0
        self._sent_id = None

    def relay_status(self) -> dict:
        return {"transport": "relay", "relay_code": self.relay_code}

    # ── decide: negative cache + every failure as RelayOff ─────────────────

    def decide(self, state, questions: dict, *, op: str = "decide", deadline: float | None = None) -> dict:
        from .policy import PolicyDenied
        if self._held_code and _clock() < self._hold_until:
            self.bump(f"relay.{self._held_code}")
            self.bump("relay.cached")
            off = RelayOff(self._held_code)
            if self.diagnostic:
                self.diagnostic(op, "relayoff")
            off.diagnosed = bool(self.diagnostic)
            raise off
        try:
            resp = super().decide(state, questions, op=op, deadline=deadline)
        except PolicyDenied:
            raise
        except RelayOff as e:
            self._note(e.code)
            raise
        except JevError as e:
            off = RelayOff("deadline" if str(e) == "deadline exceeded" else "error")
            off.diagnosed = getattr(e, "diagnosed", False)
            self._note(off.code)
            raise off from None
        self._note("ok")
        return resp

    def _note(self, code: str) -> None:
        self.bump(f"relay.{code}")
        hold = HOLD_S.get(code, 0)
        if code != self.relay_code:
            # once per change of state, so a notice (stderr too) either way; the states are
            # one limiter family: flapping over several codes is one summary a window
            if code == "ok":
                self.log(notice("relay: ok (jev.decide through the Pria desktop app)",
                                key="relay:ok", label="ok", family=RELAY_FAMILY))
            else:
                self.log(notice(f"relay: Jev is off ({code})" + (f"; not reconnecting for {hold} s" if hold else ""),
                                key=f"relay:{code}", label=f"off ({code})", family=RELAY_FAMILY))
        self.relay_code = code
        self._held_code = code if hold else None
        self._hold_until = _clock() + hold

    def _diagnosis(self, e: BaseException) -> str:
        return "relayoff"

    # ── wire ───────────────────────────────────────────────────────────────

    def _encode(self, state, questions) -> bytes:
        # Only json.dumps of the parsed objects: a string state stays a JSON
        # string value; caller text is never spliced into the line.
        self._seq += 1
        args = {"state": state, "questions": questions}
        sess = SESSION.get()
        if sess is not None:
            args["session"] = sess
        try:
            line = json.dumps({"id": self._seq, "verb": "jev.decide", "args": args},
                              separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
        except (TypeError, ValueError, RecursionError):
            raise RelayOff("error") from None
        if len(line) > MAX_LINE:
            raise RelayOff("too_large")
        self._sent_id = self._seq
        return line

    def _post(self, body: bytes, *, timeout_s: float) -> dict:
        end = time.monotonic() + timeout_s
        directory = Path(self.state_dir) if self.state_dir else state_dir()
        sock = None
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            _arm(sock, end)
            try:
                sock.connect(os.fspath(directory / SOCKET_NAME))
            except (FileNotFoundError, ConnectionRefusedError, NotADirectoryError):
                raise RelayOff("no_socket") from None
            hello = _hello_line(directory)
            try:
                _arm(sock, end)
                sock.sendall(hello)
            finally:
                hello = None
            lines = _Lines(sock, end)
            welcome = _parse(lines.line())
            refused = _refusal(welcome)
            if refused:
                raise refused
            result = welcome.get("result") if isinstance(welcome, dict) and welcome.get("ok") is True else None
            verbs = result.get("verbs") if isinstance(result, dict) else None
            if not isinstance(verbs, list) or type(result.get("api")) is not int or result["api"] != 1:
                raise RelayOff("malformed")
            if "jev.decide" not in verbs:
                raise RelayOff("no_relay")
            _arm(sock, end)
            sock.sendall(body)
            return self._answer(_parse(lines.line()))
        except RelayOff:
            raise
        except (socket.timeout, TimeoutError):
            raise RelayOff("deadline") from None
        except JevError as e:  # the hard SIGALRM deadline lands here mid-I/O
            raise RelayOff("deadline" if str(e) == "deadline exceeded" else "error") from None
        except Exception:  # noqa: BLE001 — never surface socket or payload text
            raise RelayOff("error") from None
        finally:
            if sock is not None:
                sock.close()

    def _answer(self, reply) -> dict:
        if not isinstance(reply, dict):
            raise RelayOff("malformed")
        rid = reply.get("id")
        ours = type(rid) is int and rid == self._sent_id
        if reply.get("ok") is True and ours:
            result = reply.get("result")
            if (isinstance(result, dict) and isinstance(result.get("answers"), dict)
                    and isinstance(result.get("model"), str)
                    and (result.get("usage") is None or isinstance(result["usage"], dict))):
                return result  # JSON-equal to the app's answer; usage absent/null stays unknown
            raise RelayOff("malformed")
        refused = _refusal(reply) if ours or rid is None else None
        raise refused or RelayOff("malformed")
