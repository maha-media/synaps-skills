"""tool_schemas — the frozen input contracts of the multi-file builtins.

`multi_edit` is tools-design.md §A.1 (with the tool's own parse: unknown
fields are refused, an optional field may be absent or `null`, which both
mean "not given"); `send_events` is §B.4 and its "Validation first" rules.

The guard checks a call against its contract *before* summarizing it.
Anything outside the contract is MalformedInput: the guard confirms without
a model call instead of guessing what the tool will do with it. Error texts
name the index and field only, never a value (a value may be a secret).
"""

from __future__ import annotations

import json
import re


class MalformedInput(ValueError):
    """Tool input outside its contract: always confirm, never call Jev."""


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def utf8_len(text: str) -> int:
    return len(text.encode("utf-8", "surrogatepass"))


# ── multi_edit (§A.1) ───────────────────────────────────────────────────────

MULTI_EDIT_TOP = frozenset({"edits", "placeholders"})
MULTI_EDIT_FIELDS = frozenset({"path", "op", "anchor", "anchor_mode", "occurrence", "text", "value",
                               "timestamp_field", "unless_present", "create"})
MULTI_EDIT_OPS = ("replace", "insert_before", "insert_after", "append", "append_jsonl")
ANCHORED_OPS = frozenset({"replace", "insert_before", "insert_after"})
ANCHOR_MODES = ("exact", "line_prefix", "line_regex")
MULTI_EDIT_MAX_EDITS = 64
MAX_FIELD_BYTES = 1 << 20          # per anchor/text/unless_present/value (§A.4)
MAX_OCCURRENCE = 2 ** 64 - 1       # the tool reads a u64
_STRING_FIELDS = ("anchor", "text", "timestamp_field", "unless_present")


def _json_bytes(value) -> int:
    try:
        return utf8_len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    except (TypeError, ValueError, RecursionError):
        return MAX_FIELD_BYTES + 1


def validate_multi_edit(tool_input) -> None:
    if not isinstance(tool_input, dict):
        raise MalformedInput("input is not an object")
    if not set(tool_input) <= MULTI_EDIT_TOP:
        raise MalformedInput("input has an unknown field")
    placeholders = tool_input.get("placeholders")
    if placeholders is not None and not isinstance(placeholders, bool):
        raise MalformedInput("placeholders is not true or false")
    edits = tool_input.get("edits")
    if not isinstance(edits, list) or not edits:
        raise MalformedInput("edits must be a non-empty array")
    if len(edits) > MULTI_EDIT_MAX_EDITS:
        raise MalformedInput(f"{len(edits)} edits exceed {MULTI_EDIT_MAX_EDITS}")
    for i, edit in enumerate(edits):
        _check_edit(i, edit)


def _check_edit(i: int, edit) -> None:
    at = f"edits[{i}]"
    if not isinstance(edit, dict):
        raise MalformedInput(f"{at} is not an object")
    if not set(edit) <= MULTI_EDIT_FIELDS:
        raise MalformedInput(f"{at} has an unknown field")
    path = edit.get("path")
    if not isinstance(path, str) or not path.strip():
        raise MalformedInput(f"{at}.path must be a non-empty string")
    op = edit.get("op")
    if not isinstance(op, str) or op not in MULTI_EDIT_OPS:
        raise MalformedInput(f"{at}.op must be one of {', '.join(MULTI_EDIT_OPS)}")
    for key in _STRING_FIELDS:
        value = edit.get(key)
        if value is not None and not isinstance(value, str):
            raise MalformedInput(f"{at}.{key} must be a string")
    mode = edit.get("anchor_mode")
    if mode is not None and (not isinstance(mode, str) or mode not in ANCHOR_MODES):
        raise MalformedInput(f"{at}.anchor_mode must be one of {', '.join(ANCHOR_MODES)}")
    occurrence = edit.get("occurrence")
    if occurrence is not None and not (_is_int(occurrence) and 1 <= occurrence <= MAX_OCCURRENCE):
        raise MalformedInput(f"{at}.occurrence must be an integer of at least 1")
    value = edit.get("value")
    if value is not None and not isinstance(value, dict):
        raise MalformedInput(f"{at}.value must be an object")
    create = edit.get("create")
    if create is not None and not isinstance(create, bool):
        raise MalformedInput(f"{at}.create is not true or false")

    if op in ANCHORED_OPS:
        anchor = edit.get("anchor")
        if anchor is None:
            raise MalformedInput(f"{at}: {op} needs an anchor")
        if anchor == "":
            raise MalformedInput(f"{at}.anchor is empty")
        if create is True:
            raise MalformedInput(f"{at}: create is only for append/append_jsonl")
    else:
        for key in ("anchor", "anchor_mode", "occurrence"):
            if edit.get(key) is not None:
                raise MalformedInput(f"{at}: {op} takes no {key}")
    if op == "append_jsonl":
        if edit.get("text") is not None:
            raise MalformedInput(f"{at}: append_jsonl takes value, not text")
        if value is None:
            raise MalformedInput(f"{at}: append_jsonl needs value (an object)")
        stamp = edit.get("timestamp_field")
        if stamp == "":
            raise MalformedInput(f"{at}.timestamp_field is empty")
        if stamp is not None and stamp in value:  # §A.1: "Error if already present."
            raise MalformedInput(f"{at}.timestamp_field is already in value")
    else:
        for key in ("value", "timestamp_field"):
            if edit.get(key) is not None:
                raise MalformedInput(f"{at}: {op} takes no {key}")
        text = edit.get("text")
        if text is None:
            raise MalformedInput(f"{at}: {op} needs text")
        if text == "" and op != "replace":
            raise MalformedInput(f"{at}: {op} with empty text changes nothing")
    if edit.get("unless_present") == "":
        raise MalformedInput(f"{at}.unless_present is empty")
    for key in ("anchor", "text", "unless_present"):
        field = edit.get(key)
        if isinstance(field, str) and utf8_len(field) > MAX_FIELD_BYTES:
            raise MalformedInput(f"{at}.{key} exceeds {MAX_FIELD_BYTES} bytes")
    if value is not None and _json_bytes(value) > MAX_FIELD_BYTES:
        raise MalformedInput(f"{at}.value exceeds {MAX_FIELD_BYTES} bytes")


# ── send_events (§B.4) ──────────────────────────────────────────────────────

SEND_EVENTS_TOP = frozenset({"source", "record_dir", "on_error", "messages"})
SEND_EVENTS_FIELDS = frozenset({"session", "body", "severity", "source", "record_name"})
SEVERITIES = ("low", "medium", "high", "critical")
ON_ERROR = ("continue", "stop")
SOURCE_RE = re.compile(r"[A-Za-z0-9._:@-]{1,64}")   # the CLI's source format (§B.1)
SEND_EVENTS_MAX_MESSAGES = 32
MAX_BODY_BYTES = 256 * 1024        # a larger body can never fit the 256 KiB event (§B.3)
MAX_RECORD_NAME_BYTES = 128


def _valid_source(source) -> bool:
    return isinstance(source, str) and SOURCE_RE.fullmatch(source) is not None


def _plain_name(name) -> bool:
    return (isinstance(name, str) and name != "" and utf8_len(name) <= MAX_RECORD_NAME_BYTES
            and "/" not in name and "\\" not in name and ".." not in name
            and not any(ord(c) < 0x20 or 0x7F <= ord(c) < 0xA0 for c in name))


def validate_send_events(tool_input) -> None:
    if not isinstance(tool_input, dict):
        raise MalformedInput("input is not an object")
    if not set(tool_input) <= SEND_EVENTS_TOP:
        raise MalformedInput("input has an unknown field")
    call_source = tool_input.get("source")
    if call_source is not None and not _valid_source(call_source):
        raise MalformedInput("source is not 1-64 characters of [A-Za-z0-9._:@-]")
    record_dir = tool_input.get("record_dir")
    if record_dir is not None and (not isinstance(record_dir, str) or not record_dir.strip()
                                   or "\x00" in record_dir):
        raise MalformedInput("record_dir must be a non-empty path")
    on_error = tool_input.get("on_error")
    if on_error is not None and (not isinstance(on_error, str) or on_error not in ON_ERROR):
        raise MalformedInput(f"on_error must be one of {', '.join(ON_ERROR)}")
    messages = tool_input.get("messages")
    if not isinstance(messages, list) or not messages:
        raise MalformedInput("messages must be a non-empty array")
    if len(messages) > SEND_EVENTS_MAX_MESSAGES:
        raise MalformedInput(f"{len(messages)} messages exceed {SEND_EVENTS_MAX_MESSAGES}")
    seen = set()
    for i, message in enumerate(messages):
        at = f"messages[{i}]"
        if not isinstance(message, dict):
            raise MalformedInput(f"{at} is not an object")
        if not set(message) <= SEND_EVENTS_FIELDS:
            raise MalformedInput(f"{at} has an unknown field")
        session = message.get("session")
        if not isinstance(session, str) or not session.strip():
            raise MalformedInput(f"{at}.session must be a non-empty string")
        body = message.get("body")
        if not isinstance(body, str) or not body.strip():
            raise MalformedInput(f"{at}.body must be a non-empty, non-whitespace string")
        if utf8_len(body) > MAX_BODY_BYTES:
            raise MalformedInput(f"{at}.body exceeds {MAX_BODY_BYTES} bytes")
        severity = message.get("severity")
        if severity is not None and (not isinstance(severity, str) or severity not in SEVERITIES):
            raise MalformedInput(f"{at}.severity must be one of {', '.join(SEVERITIES)}")
        source = message.get("source")
        if source is not None and not _valid_source(source):
            raise MalformedInput(f"{at}.source is not 1-64 characters of [A-Za-z0-9._:@-]")
        if source is None and call_source is None:
            raise MalformedInput(f"{at} has no source (its own or the call's)")
        record_name = message.get("record_name")
        if record_name is not None and not _plain_name(record_name):
            raise MalformedInput(f"{at}.record_name must be a plain file name of at most "
                                 f"{MAX_RECORD_NAME_BYTES} bytes")
        if (session, body) in seen:
            raise MalformedInput(f"{at} repeats an earlier (session, body) pair")
        seen.add((session, body))
