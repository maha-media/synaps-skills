"""A copy of the host's Confirm-prompt key=value scrub, for tests only.

Synaps runs every extension confirm message through
`trace::export::redact_command_text` (the AGGRESSIVE scrub) before it shows
the prompt. These are its key=value, compound-name, UPPER_SNAKE `_KEY=` and
`--flag` rules, copied from SynapsCLI crates/agent-engine/src/runtime/trace/export.rs
(dd637355). A key that matches them reaches the user and the app as
`[REDACTED]`, so the guard's numeric verdict keys must never match.
"""
from __future__ import annotations

import re

KW = r"(?:api[_-]?key|access[_-]?key|token|secret|passw(?:or)?d|credential)"
VAL = r"""("[^"]*"|'[^']*'|[^\s&'"]+)"""
RULES = [
    re.compile(rf"(?i)(\b[a-z0-9_-]*{KW}[a-z0-9_-]*\s*[=:]\s*){VAL}"),
    re.compile(rf"(?i)(\b[a-z0-9]*[_-][a-z0-9_-]*{KW}[a-z0-9_-]*\s+|\b[a-z0-9_-]*{KW}[a-z0-9_-]*[_-][a-z0-9_-]*\s+){VAL}"),
    re.compile(rf"(\b[A-Z][A-Z0-9_]*_KEY\s*=\s*){VAL}"),
    re.compile(rf"(?i)(--[a-z0-9-]*(?:api-?key|access-?key|token|secret|passw(?:or)?d|credential)[a-z0-9-]*(?:=|\s+)){VAL}"),
]


def scrub(text: str) -> str:
    """Apply the copied rules the way the host does (each rule, in order)."""
    for rule in RULES:
        text = rule.sub(lambda m: m.group(1) + "[REDACTED]", text)
    return text
