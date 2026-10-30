"""Allow once: the hand-off between the access rule (owner rules 27a/27b)
and Pria Desktop's "Permission change" item.

Every access block writes a request record; the owner answers it with a native
click in the app (Allow once / Deny), which writes an answer record; the
same session's exact retry of that call then passes the access rule ONCE.
The record format is shared with Pria Desktop, which reads requests and writes answers:

    ~/.synaps-cli/memory/jev/access/            0700, this user's, no symlink
        requests/<id>.json   the guard (0600, temp + rename, O_NOFOLLOW)
        answers/<id>.json    ONLY the app's native click (O_EXCL, 0600, <= 4 KiB)
        used/<id>.json       a consumed answer (an atomic rename from answers/)

A request (v 1): id (128-bit hex), kind block|auto, ts, expires_at (block:
ts + 24 h), session, subagent_id (a builder's call only: the worker's
"sa_N" from the hook event, under its lead's session; absent for the
session's own call; "unrecognized" when the event's value isn't a plain
short word, and such a call is Deny only), tool, cwd, fingerprint, hits,
reason (block), and
either command (+ truncated, + shell_session for shell_send) or files
[{path, op}] (+ change: the call's input, for write/edit/multi_edit).
allow_once_possible is false when the text held a credential (it is then
withheld: the command, or the paths and the change), was cut at 4 KiB, or
the scan didn't reach the end: the owner must see the whole call they allow, so
those get Deny only. shell_send is always Deny only: it runs in a live
shell whose cwd and state the fingerprint can't bind. No record is
written with a credential anywhere in it (_withhold).

An answer: exactly {v: 1, id, fingerprint, decision: allow_once|deny,
answered_at (ISO 8601 with a zone), by: "owner_ui"}. Consuming checks: a
regular file of this user, <= 4 KiB, valid; id and fingerprint equal the
request's; the request is a block, still answerable (24 h) and allowable;
answered_at lies between the request's ts and now, and now is within 30
minutes of it; the retried call's hits equal the recorded ones. Then the
rename answers/ -> used/; a failed rename means still blocked.

Fingerprint: sha256 of canonical JSON {v: 1, session, tool, cwd,
tool_input}, plus subagent_id for a builder's call (sort_keys, separators
"," ":", UTF-8). It binds the exact call: another command, cwd, session,
caller (lead or builder) or file content is another request. A session's
own call has no subagent_id key, so its fingerprint is byte-equal to the
format before the field and records waiting across an install still match.

Nothing here ever unblocks on an error: a store that can't be written or
read leaves the call blocked. Known limit (README): a script run from a
file is not read by the guard, so a determined agent running as this user
could forge an answer; the sandbox rule 27c(3) is the second layer.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import stat
import time
from datetime import datetime, timezone

from .secret_patterns import scan_secrets

V = 1
ANSWERABLE_S = 24 * 3600     # a block request can be answered for 24 h
RETRY_S = 30 * 60            # the retry must come within 30 min of the answer
PRUNE_S = 7 * 24 * 3600      # records older than 7 days are pruned
PRUNE_EVERY_S = 3600
TEXT_MAX = 4096              # command / change text kept in a request
RECORD_MAX = 16 * 1024
ANSWER_MAX = 4096
HITS_MAX = 64
SCAN_MAX = 512               # request files read when looking for a waiting one
DIRS = ("requests", "answers", "used")
_ID = re.compile(r"\A[0-9a-f]{32}\Z")
_NAME = re.compile(r"\A([0-9a-f]{32})\.json\Z")
_ANSWER_KEYS = frozenset({"v", "id", "fingerprint", "decision", "answered_at", "by"})
_last_prune = 0.0


class StoreError(Exception):
    """The store can't be used (its message is a fixed text)."""


def root(home: str) -> str:
    return os.path.join(home, ".synaps-cli", "memory", "jev", "access")


_SUBAGENT = re.compile(r"\A[A-Za-z0-9_-]{1,64}\Z")
UNRECOGNIZED = "unrecognized"


def subagent_ok(value) -> bool:
    """A session's own call (None), or a builder's id that is a plain short
    word (the host sends "sa_N")."""
    return value is None or (isinstance(value, str) and bool(_SUBAGENT.match(value)))


def subagent_field(value) -> str | None:
    """What a record shows for the caller: None (no key) for the session's
    own call, the id, or UNRECOGNIZED (never the raw value)."""
    if value is None:
        return None
    return value if subagent_ok(value) else UNRECOGNIZED


def fingerprint(session, tool, cwd, tool_input, subagent_id=None) -> str:
    fields = {"v": V, "session": session, "tool": tool, "cwd": cwd, "tool_input": tool_input}
    if subagent_id is not None:
        fields["subagent_id"] = subagent_id
    blob = json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8", "surrogatepass")).hexdigest()


def hit_rows(hits) -> list[dict]:
    """(where, AccessHit) pairs as recorded and compared."""
    return [{"where": w, "kind": h.kind, "token": h.token, "why": h.why, "line": h.line,
             "descent": bool(h.descent)} for w, h in hits]


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value) -> float | None:
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        t = datetime.fromisoformat(value)
    except ValueError:
        return None
    return t.timestamp() if t.tzinfo is not None else None


def _private_dir(path: str) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISDIR(st.st_mode) and st.st_uid == os.geteuid() and not st.st_mode & 0o077


def open_store(home: str | None, *, create: bool) -> str:
    """The store root with its three dirs, each a private (0700) directory of
    this user and no symlink. Created (0700) when missing and create is set;
    an existing one that isn't private is refused, never chmod-ed."""
    if not home or not os.path.isabs(home):
        raise StoreError("no home directory")
    r = root(home)
    for d in (r, *(os.path.join(r, n) for n in DIRS)):
        if create:
            try:
                os.mkdir(d, 0o700)
            except FileExistsError:
                pass
            except OSError:
                raise StoreError("the request store could not be created") from None
        if not _private_dir(d):
            raise StoreError("the request store is not a private directory")
    return r


def _read(path: str, limit: int) -> dict | None:
    """A JSON object from a regular file of this user, at most limit bytes;
    None for anything else (a symlink, a FIFO, too big, not JSON)."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_size > limit:
            return None
        data = os.read(fd, limit + 1)
    except OSError:
        return None
    finally:
        os.close(fd)
    if len(data) > limit:
        return None
    try:
        obj = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return obj if isinstance(obj, dict) else None


def _write(dirpath: str, name: str, obj: dict) -> None:
    data = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(data) > RECORD_MAX:
        raise StoreError("the request record is too large")
    tmp = os.path.join(dirpath, f".{name}.{secrets.token_hex(4)}.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    except OSError:
        raise StoreError("the request record could not be written") from None
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp, os.path.join(dirpath, name))
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise StoreError("the request record could not be written") from None


def _names(dirpath: str) -> list[str]:
    try:
        return [m.group(1) for n in os.listdir(dirpath) if (m := _NAME.match(n))]
    except OSError:
        return []


def call_text(tool: str, tool_input) -> tuple[dict, bool]:
    """What the owner sees of the call, and whether it can be allowed once."""
    if not isinstance(tool_input, dict):
        return {}, False
    if tool in ("bash", "shell_start", "shell_send"):
        text = tool_input.get("input" if tool == "shell_send" else "command")
        text = text if isinstance(text, str) else ""
        out: dict = {}
        if tool == "shell_send":
            sid = tool_input.get("session_id")
            out["shell_session"] = sid if isinstance(sid, str) else None
            out["cwd_note"] = "the agent session's cwd; the shell's own cwd may differ"
        if tool == "shell_start" and isinstance(tool_input.get("working_directory"), str):
            out["working_directory"] = tool_input["working_directory"]
    else:
        files = []
        edits = tool_input.get("edits") if tool == "multi_edit" else [tool_input]
        for e in edits if isinstance(edits, list) else []:
            if isinstance(e, dict) and isinstance(e.get("path"), str):
                op = "create" if tool == "write" or e.get("create") is True else "change"
                if {"path": e["path"], "op": op} not in files:
                    files.append({"path": e["path"], "op": op})
        text = json.dumps(tool_input, ensure_ascii=False, sort_keys=True)
        out = {"files": files}
    kinds = scan_secrets(text)
    if kinds:
        if "files" in out:
            out["files"], out["change"] = [], None   # the paths too: they are part of the call's text
        else:
            out["command"] = None
        out["withheld"] = f"holds a credential ({', '.join(kinds)})"
        return out, False
    data = text.encode("utf-8", "surrogatepass")
    truncated = len(data) > TEXT_MAX
    kept = data[:TEXT_MAX].decode("utf-8", "ignore") if truncated else text
    out["command" if "files" not in out else "change"] = kept
    out["truncated"] = truncated
    return out, not truncated


_PREVIEW = ("command", "change", "shell_session", "working_directory")


def _withhold(rec: dict) -> dict:
    """The last check before a record is written: no credential anywhere in
    it. A hit drops every caller-made preview field (Deny only); if one is
    still found (in cwd, the hits or the reason) the record isn't written."""
    kinds = scan_secrets(json.dumps(rec, ensure_ascii=False, sort_keys=True))
    if not kinds:
        return rec
    for k in _PREVIEW:
        if k in rec:
            rec[k] = None
    if "files" in rec:
        rec["files"] = []
    rec.pop("truncated", None)
    rec["withheld"] = f"holds a credential ({', '.join(kinds)})"
    if rec.get("kind") == "block":
        rec["allow_once_possible"] = False
    if scan_secrets(json.dumps(rec, ensure_ascii=False, sort_keys=True)):
        raise StoreError("the request would hold a credential")
    return rec


def _prune(r: str, now: float) -> None:
    global _last_prune
    if now - _last_prune < PRUNE_EVERY_S:
        return
    _last_prune = now
    for n in DIRS:
        d = os.path.join(r, n)
        try:
            entries = os.listdir(d)
        except OSError:
            continue
        for e in entries:
            p = os.path.join(d, e)
            try:
                st = os.lstat(p)
                if stat.S_ISREG(st.st_mode) and now - st.st_mtime > PRUNE_S:
                    os.unlink(p)
            except OSError:
                pass


def new_id() -> str:
    return secrets.token_hex(16)


def record_block(home, rid: str, *, session, tool, cwd, tool_input, fp, hits, reason, possible, now,
                 subagent_id=None) -> None:
    """Write requests/<rid>.json for a block; StoreError when it can't.
    subagent_id: the builder's id from the hook event (None: the session's
    own call; the record then has no such key)."""
    r = open_store(home, create=True)
    _prune(r, now)
    shown, allowable = call_text(tool, tool_input)
    rows = hit_rows(hits)
    rec = {"v": V, "id": rid, "kind": "block", "ts": iso(now), "expires_at": iso(now + ANSWERABLE_S),
           "session": session, "tool": tool, "cwd": cwd, "fingerprint": fp, "hits": rows[:HITS_MAX],
           "hits_total": len(rows), "reason": reason,
           "allow_once_possible": bool(possible and allowable and len(rows) <= HITS_MAX
                                       and tool != "shell_send" and subagent_ok(subagent_id)), **shown}
    if subagent_id is not None:
        rec["subagent_id"] = subagent_field(subagent_id)
    _write(os.path.join(r, "requests"), f"{rid}.json", _withhold(rec))


def record_auto(home, *, session, tool, cwd, files, hits, now, subagent_id=None) -> str:
    """Write requests/<id>.json for a 27b auto pass (an FYI: no command text)."""
    r = open_store(home, create=True)
    _prune(r, now)
    rid = new_id()
    rows = hit_rows(hits)
    rec = {"v": V, "id": rid, "kind": "auto", "ts": iso(now), "session": session, "tool": tool, "cwd": cwd,
           "files": files, "hits": rows[:HITS_MAX], "hits_total": len(rows)}
    if subagent_id is not None:
        rec["subagent_id"] = subagent_field(subagent_id)
    _write(os.path.join(r, "requests"), f"{rid}.json", _withhold(rec))
    return rid


def _request(r: str, rid: str) -> dict | None:
    rec = _read(os.path.join(r, "requests", f"{rid}.json"), RECORD_MAX)
    if rec is None or rec.get("v") != V or rec.get("id") != rid or rec.get("kind") != "block":
        return None
    return rec


def _answer(r: str, rid: str) -> dict | None:
    a = _read(os.path.join(r, "answers", f"{rid}.json"), ANSWER_MAX)
    if a is None or set(a) != _ANSWER_KEYS or a.get("v") != V or a.get("id") != rid or a.get("by") != "owner_ui":
        return None
    if a.get("decision") not in ("allow_once", "deny") or not isinstance(a.get("fingerprint"), str):
        return None
    return a


_SHOWN = ("command", "change", "files", "shell_session", "working_directory", "cwd_note", "truncated",
          "withheld")


def _shows_this_call(rec: dict, call, reason) -> bool:
    """Whether the record the owner answered shows exactly the retried call: the
    same session, caller (subagent_id: the same builder, or none for the
    session's own call), tool and cwd, the same preview fields record_block
    derives from its input, and the same refusal text. The fingerprint alone
    doesn't prove that: a same-user rewrite of requests/<id>.json can keep it
    and show the owner a harmless preview, or another caller's name."""
    session, tool, cwd, tool_input, *rest = call
    subagent = rest[0] if rest else None
    shown, allowable = call_text(tool, tool_input)
    if not allowable or not subagent_ok(subagent) or (rec.get("session"), rec.get("tool"), rec.get("cwd")) != (
            session, tool, cwd):
        return False
    if ({k: rec[k] for k in ("subagent_id",) if k in rec}
            != ({} if subagent is None else {"subagent_id": subagent})):
        return False
    if any(rec.get(k) != shown.get(k) for k in _SHOWN):
        return False
    return reason is None or rec.get("reason") == reason(rec.get("id"))


def lookup(home, fp: str, hits, now: float, call=None, reason=None) -> tuple[str, str] | None:
    """The owner's answer for this exact call, consumed if it allows it:
    ('allow', id) after the rename to used/; ('deny', id); ('waiting', id)
    for a request still answerable with no answer yet; None otherwise.
    `call` = (session, tool, cwd, tool_input[, subagent_id]) of the retried
    call and `reason(id)` = the refusal text its record must hold: an Allow
    once is consumed only if the record shows exactly that call
    (_shows_this_call)."""
    try:
        r = open_store(home, create=False)
    except StoreError:
        return None
    rows = hit_rows(hits)
    denied = None
    for rid in sorted(_names(os.path.join(r, "answers"))):
        a = _answer(r, rid)
        if a is None or a["fingerprint"] != fp:
            continue
        rec = _request(r, rid)
        if rec is None or rec.get("fingerprint") != fp:
            continue
        ts, answered = parse_time(rec.get("ts")), parse_time(a.get("answered_at"))
        if (ts is None or answered is None or not ts <= answered <= now + 60 or answered - ts > ANSWERABLE_S
                or now - ts > ANSWERABLE_S + RETRY_S):
            continue
        if a["decision"] == "deny":
            denied = rid
            continue
        if (rec.get("allow_once_possible") is not True or rec.get("tool") == "shell_send" or now - answered > RETRY_S
                or rec.get("hits") != rows or rec.get("hits_total") != len(rows)
                or call is None or not _shows_this_call(rec, call, reason)):
            continue
        try:
            os.rename(os.path.join(r, "answers", f"{rid}.json"), os.path.join(r, "used", f"{rid}.json"))
        except OSError:
            continue
        return "allow", rid
    if denied is not None:
        return "deny", denied
    answered_ids = set(_names(os.path.join(r, "answers"))) | set(_names(os.path.join(r, "used")))
    waiting = []
    for rid in _names(os.path.join(r, "requests")):
        if rid in answered_ids:
            continue
        try:
            mtime = os.lstat(os.path.join(r, "requests", f"{rid}.json")).st_mtime
        except OSError:
            continue
        if now - mtime <= ANSWERABLE_S:
            waiting.append((mtime, rid))
    for _, rid in sorted(waiting, reverse=True)[:SCAN_MAX]:
        rec = _request(r, rid)
        ts = parse_time(rec.get("ts")) if rec else None
        if (rec is not None and rec.get("fingerprint") == fp and ts is not None and now - ts <= ANSWERABLE_S
                and rec.get("hits") == rows):
            return "waiting", rid
    return None
