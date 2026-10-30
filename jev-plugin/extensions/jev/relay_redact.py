"""relay_redact — what Jev is sent, redacted the way the Pria relay checks it.

THE outbound redactor of every op, on both transports (relay and direct):
the guard's state (`redact_state`) and every other op's request
(`redact_request`). Nothing else redacts what Jev is sent.

The app (pria-apps crates/fleet-api/src/jev.rs `check`) never redacts: it
refuses the whole call (`secret_in_state`) when `pria_redact::find_secrets`
finds anything in the raw request body, in the compact re-serialized JSON, or
in any decoded string or key of `state` and `questions`. A value that is
exactly `<redacted>` is no finding there. So `redact_state` replaces each
matched VALUE with exactly `<redacted>` and checks every one of those views
with the mirrored rules before anything is sent.

Source of truth: pria-apps crates/pria-redact/src/lib.rs — `rules()`,
`is_placeholder`, `open_rules`/`open_quoted_secret` and
`redact_secrets_finished`. LIB_RS_RULES and LIB_RS_OPEN_RULES below are its
patterns, copied verbatim and in its order; keep them in step with that file.
The additions (no app finding, redacted all the same): the plugin's own
TypeSafe API key (TYPESAFE_KEY), which lib.rs has no rule for, and
PLUGIN_RULES (hyphenated key names, a value on the next line).
"""

from __future__ import annotations

import bisect
import json
import re

REDACTED = "<redacted>"
REDACTED_PRIVATE_KEY = "<redacted private key>"
MAX_STRING_CHARS = 4096  # longer strings (only an absurd path can be) are cut first

# Rust regex `\s` is Unicode White_Space; Python's `\s` also takes \x1c-\x1f.
_WS = "\t\n\x0b\x0c\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000"
WHITESPACE = frozenset("\t\n\x0b\x0c\r \x85\xa0\u1680\u2028\u2029\u202f\u205f\u3000"
                       + "".join(chr(c) for c in range(0x2000, 0x200B)))
_WS_CHARS = "".join(sorted(WHITESPACE))

# lib.rs rules(), verbatim and in order (the PEM rule's replacement is REDACTED_PRIVATE_KEY)
LIB_RS_RULES = (
    r"-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(?s:.*?)(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)",
    r"(?:sk-ant-|sk_live_|rk_live_|gh[pousr]_|github_pat_|glpat-|glrt-|gldt-|glptt-|glft-|glsoat-|xox[abprs]-|\b(?:sk-|pria_|AIza|hf_|npm_))[A-Za-z0-9_\-]{12,}",
    r"(?:AKIA|ASIA)[0-9A-Z]{16}\b",
    r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
    r"""(?i)\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Z0-9_]*(?:\\?["'])?[ \t]*(?::=|[:=])[ \t]*)(?P<v>(?:(?:bearer|basic|token)[ \t]+)?(?:\\"(?:[^\\"]|\\[^"])*\\"|'[^']*'|"[^"]*"|=*(?:[^\s'";&|=\\]|\\[^\s'";&|])(?:[^\s'";&|\\]|\\[^\s'";&|])*))""",
    r"""(?i)((?:^|\s)--?(?:token|password|passwd|pass|secret|api-?key|access-?key|auth|private-token|client-secret)(?:=|\s+))(?P<v>\\"(?:[^\\"]|\\[^"])*\\"|'[^']*'|"[^"]*"|(?:[^\s'";&|\\]|\\[^\s'";&|])+)""",
    r"""(?i)\b((?:authorization|proxy-authorization|private-token|x-api-key|x-auth-token|cookie)\s*:\s*)(?P<v>(?:(?:bearer|basic|token)\s+)?[^\s'"]+)""",
    r"(?i)\b(bearer\s+)(?P<v>[A-Za-z0-9._~+/=\-]{8,})",
    r"([a-z][a-z0-9+.\-]*://[^/\s:@]+:)(?P<v>[^/\s@]+)@",
    r"""(?i)([?&](?:access_token|token|api_key|apikey|key|secret|password|sig|signature|auth)=)(?P<v>[^&\s'"]+)""",
)
# lib.rs open_rules(), verbatim: the two quoted NamedSecret lead-ins, up to the opening quote
LIB_RS_OPEN_RULES = (
    r"""(?i)\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Z0-9_]*(?:\\?["'])?[ \t]*(?::=|[:=])[ \t]*(?P<v>(?:(?:bearer|basic|token)[ \t]+)?(?P<q>\\?["']))""",
    r"""(?i)(?:^|\s)--?(?:token|password|passwd|pass|secret|api-?key|access-?key|auth|private-token|client-secret)(?:=|\s+)(?P<v>(?P<q>\\?["']))""",
)
PEM, NAME, URL = 0, 4, 8

# Rust's regex is linear; Python's backtracking is quadratic on three of the
# patterns above (a long word run before `=`; a long letter run before
# `://`; a long `eyJ-eyJ-…` run with no dots). Same matches, linear here
# (the suite checks them against the verbatim patterns): the NAME is the
# whole word run, read once (a lookahead and a backreference, as in
# secret_patterns), so it is checked for a keyword once; the scheme starts
# at its run's first letter only; a JWT is tried from the first `\beyJ` of
# its run only (every later one in the run fails where the first fails), and
# its value is group v, so its span still starts at `eyJ`.
_NAME_FAST = (r"(?=[A-Z0-9_]*?(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?))"
              r"(?=(?P<run>[A-Z0-9_]*))(?P=run)")
_NAME_SLOW = r"[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Z0-9_]*"
_URL_SLOW = r"([a-z][a-z0-9+.\-]*://"
_URL_FAST = r"(?<![a-z0-9+.\-])[0-9+.\-]*([a-z][a-z0-9+.\-]*://"
_JWT_SLOW = r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"
_JWT_FAST = (r"(?<![A-Za-z0-9_\-])(?>[A-Za-z0-9_\-]*?(?=\beyJ))"
             r"(?P<v>eyJ[A-Za-z0-9_\-]{8,}+\.[A-Za-z0-9_\-]{8,}+\.[A-Za-z0-9_\-]{8,})")


def _rx(pattern: str) -> re.Pattern:
    """A lib.rs pattern as Python: `\\s` → Unicode White_Space, and `$`
    (Rust, no m flag: the end of the text) → `\\Z`."""
    out, i, in_class = [], 0, False
    while i < len(pattern):
        c = pattern[i]
        if c == "\\":
            pair = pattern[i:i + 2]
            out.append((_WS if in_class else f"[{_WS}]") if pair == "\\s" else pair)
            i += 2
            continue
        if c == "[" and not in_class:
            in_class = True
        elif c == "]" and in_class:
            in_class = False
        elif c == "$" and not in_class:
            c = "\\Z"
        out.append(c)
        i += 1
    return re.compile("".join(out))


def _fast(pattern: str) -> str:
    if pattern == _JWT_SLOW:
        return _JWT_FAST
    return pattern.replace(_NAME_SLOW, _NAME_FAST, 1).replace(_URL_SLOW, _URL_FAST, 1)


RULES = [_rx(_fast(p)) for p in LIB_RS_RULES]
OPEN_RULES = [_rx(_fast(p)) for p in LIB_RS_OPEN_RULES]
# A rule that cannot match without this literal is skipped.
_NEEDS = {PEM: "-----BEGIN ", URL: "://"}

# Plugin-only rules (no app finding, so never in find(); the old
# triage.redact caught them): a NAME rule value after a hyphenated name
# (`api-key: v`, Azure style; `access-key`, `private-key`), and a value on
# the next line (`token:`, a line break, then the value, as YAML writes it;
# code-shaped lines excepted, see below). Redacting more than the app is
# safe. Applied with the lib.rs mirror's decoded findings (_redacted); each
# value becomes exactly `<redacted>`. Linear: a name run is read once, from
# its first character only (the lookbehind), and taken whole (it holds no
# `:` or `=`); the lines after it are read once (possessive), at most three
# comment lines of them.
_NAME_VALUE = LIB_RS_RULES[NAME][LIB_RS_RULES[NAME].index("(?P<v>"):]
_NAME_RUN = r"(?<![A-Z0-9_\-])(?=[A-Z0-9_\-]*?(?:{}))(?>[A-Z0-9_\-]*)"
_NAME_LEAD = r"""(?:\\?["'])?[ \t]*(?::=|[:=])[ \t]*"""
# The next line is often code (`if token:` then a call; `TOKEN=` then a
# command; a YAML key under `secretKeyRef:`), and as often a value: its
# first value is redacted unless the line is code-shaped (_code_shaped). A
# credential leaving the plugin costs more than a line of code hidden from
# the guard model (the deterministic rules read the raw input either way).
# The value: a quoted one to its closing quote (or the line's end); an
# unquoted one to the next whitespace (`;`, `&`, `|`, `(` do not end it).
# Before it, skipped: blank lines, up to three comment lines (`#`), a YAML
# list item's `- `; on the key line a block scalar indicator (`|`, `>-`), a
# comment or a line continuation (`\`). A line break is \n, \r\n, \r, VT,
# FF, NEL, U+2028 or U+2029; an indent any other Unicode White_Space.
_BREAKS = "\n\r\x0b\x0c\x85\u2028\u2029"
_BREAK = rf"(?:\r\n|[{_BREAKS}])"
_INDENT = r"[\t \xa0\u1680\u2000-\u200a\u202f\u205f\u3000]*+"
_LINE_REST = rf"[^{_BREAKS}]*+"
_NEXT_LINE_LEAD = (rf"(?:[|>][-+1-9]{{0,2}}+[ \t]*+)?+(?:#{_LINE_REST}|\\)?+(?:{_BREAK}{_INDENT})++"
                   rf"(?:#{_LINE_REST}(?:{_BREAK}{_INDENT})++){{0,3}}+(?:-[ \t]++)?+")
_NEXT_LINE_VALUE = rf"""(?P<v>"[^"{_BREAKS}]*+"?+|'[^'{_BREAKS}]*+'?+|[^\s]++)"""
PLUGIN_RULES = [_rx("(?i)" + p) for p in (
    _NAME_RUN.format("API-KEY|ACCESS-KEY|PRIVATE-KEY") + _NAME_LEAD + _NAME_VALUE,
    _NAME_RUN.format("TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?")
    + _NAME_LEAD + _NEXT_LINE_LEAD + _NEXT_LINE_VALUE,
)]
NEXT_LINE = 1
# Code-shaped next-line values, kept: a YAML key (`name:`, `"name":`); a
# call, an identifier (dotted, `::`, `->`; at most two digit runs) or `$`
# directly followed by `(`, with no `)` then a word character after it
# (`Pa55(w0rd)Xyz12` is no call); one of these words, alone or before `;`.
_YAML_KEY = re.compile(r"[A-Za-z_][\w.\-]*:\Z")
_CALL = re.compile(r"(?:\$|(?P<f>[A-Za-z_]\w*+(?:(?:\.|::|->)[A-Za-z_]\w*+)*+))\(")
_CLOSE_WORD = re.compile(r"\)\w")
KEYWORDS = frozenset((
    "if elif else fi then case esac for while do done def return raise pass assert yield async await "
    "print echo rm cd sudo export local unset exit import from class try with "
    "let const var fn function pub use impl match "
    "curl wget git ssh cat scp rsync nc").split())


def _code_shaped(text: str, v: str, end: int) -> bool:
    """A next-line value (`v`, ending at `end` in `text`) that is code."""
    if v[:1] in "\"'":
        return text.startswith(":", end)
    if _YAML_KEY.match(v) or v.rstrip(";") in KEYWORDS and v.count(";") <= 1:
        return True
    call = _CALL.match(v)
    return (call is not None and len(re.findall(r"\d+", call.group("f") or "")) <= 2
            and not _CLOSE_WORD.search(v, call.end()))


def _plugin_findings(text: str) -> list[tuple[int, int, int]]:
    """PLUGIN_RULES' values in text, as NAME findings (the plain placeholder)."""
    out = []
    for i, rx in enumerate(PLUGIN_RULES):
        for m in rx.finditer(text):
            v = m.group("v")
            if v and not is_placeholder(v) and not (i == NEXT_LINE and _code_shaped(text, v, m.end("v"))):
                out.append((*m.span("v"), NAME))
    return out


def is_placeholder(value: str) -> bool:
    """lib.rs is_placeholder: exactly a placeholder, maybe quoted or after an
    auth scheme (`Bearer <redacted>`)."""
    v = value
    for q in ('\\"', "'", '"'):
        if len(v) >= 2 * len(q) and v.startswith(q) and v.endswith(q):
            v = v[len(q):-len(q)]
    cut = next((i for i, c in enumerate(v) if c in WHITESPACE), None)
    if cut is not None and v[:cut].isascii() and v[:cut].lower() in ("bearer", "basic", "token"):
        v = v[cut + 1:].lstrip(_WS_CHARS)
    return v in (REDACTED, REDACTED_PRIVATE_KEY)


def find(text: str, rules=None) -> list[tuple[int, int, int]]:
    """lib.rs find_secrets: (start, end, rule) per credential, merged."""
    found = []
    for i, rx in enumerate(RULES if rules is None else rules):
        if i in _NEEDS and _NEEDS[i] not in text:
            continue
        group = "v" if "v" in rx.groupindex else 0
        for m in rx.finditer(text):
            value = m.group(group)
            if value and not is_placeholder(value):
                found.append((*m.span(group), i))
    found.sort(key=lambda f: (f[0], -f[1], f[2]))
    merged: list[tuple[int, int, int]] = []
    for start, end, i in found:
        if merged and start < merged[-1][1]:
            a, b, j = merged[-1]
            merged[-1] = (a, max(b, end), min(i, j))
        else:
            merged.append((start, end, i))
    return merged


def open_quoted_secret(head: str, rules=None) -> int | None:
    """lib.rs open_quoted_secret: where a quoted credential still open at the
    end of `head` starts, or None."""
    leads = sorted((m.start(), m.start("v"), m.end("q"), m.group("q"))
                   for rx in (OPEN_RULES if rules is None else rules) for m in rx.finditer(head))
    closed_until = 0
    for start, value, quote_end, quote in leads:
        if start < closed_until:
            continue
        at = head.find(quote, quote_end)
        if at < 0:
            return value
        closed_until = at + len(quote)
    return None


def _escaped_len(c: str, ascii_only: bool) -> int:
    """len(json.dumps(c, ensure_ascii=ascii_only)) - 2, without the call."""
    o = ord(c)
    if c in '"\\\b\f\n\r\t':
        return 2
    if o < 0x20:
        return 6
    if ascii_only and o > 0x7F:
        return 12 if o > 0xFFFF else 6
    return 1


def _view_findings(s: str, ascii_only: bool, budget: ReadBudget | None = None) -> list[tuple[int, int, int]]:
    """Findings in `s` as a JSON string followed by more JSON (`"s","`), the
    way the raw (ensure_ascii) and the compact (non-ASCII kept) bodies hold
    it, mapped back to [start, end) in `s` (start == len(s): a lead-in left
    open at the end). The view's length is taken from `budget` (if any)
    before it is scanned."""
    view = json.dumps(s, ensure_ascii=ascii_only) + ',"'
    _charge(budget, len(view))
    hits = find(view)
    if not hits:
        return []
    starts = [1]
    for c in s:
        starts.append(starts[-1] + _escaped_len(c, ascii_only))
    n, out = len(s), []
    for a, b, rule in hits:
        i = n if a >= starts[n] else max(0, bisect.bisect_right(starts, a) - 1)
        j = n if i == n else max(i + 1, min(n, bisect.bisect_left(starts, b)))
        out.append((i, j, rule))
    return out


def _needs_escape(c: str) -> bool:
    return c in '"\\' or ord(c) < 0x20 or ord(c) > 0x7F


def _edit(s: str, a: int, b: int, rule: int) -> str:
    """Replace the value s[a:b] with the placeholder, followed by a space
    where the next character would otherwise extend the value in an escaped
    view (`\\n`, `\\"`, `;` …)."""
    if a >= len(s):
        return s + REDACTED
    for p in (REDACTED, REDACTED_PRIVATE_KEY):
        if s.startswith(p, a) and all(_needs_escape(c) for c in s[a + len(p):b]):
            return s[:a + len(p)] + " " + s[a + len(p):]  # `<redacted>\n` escaped: split it off
    if s[a] in WHITESPACE:
        return s[:a] + REDACTED + " " + s[a:]  # `name:\n` escaped: the value starts at `\n`
    pad = " " if b < len(s) and s[b] not in " '@" else ""
    return s[:a] + (REDACTED_PRIVATE_KEY if rule == PEM else REDACTED) + pad + s[b:]


def _apply(s: str, hits) -> str:
    merged: list[list[int]] = []
    for a, b, rule in sorted(hits):
        if merged and a < merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
            merged[-1][2] = min(merged[-1][2], rule)
        else:
            merged.append([a, b, rule])
    for a, b, rule in reversed(merged):
        s = _edit(s, a, b, rule)
    return s


PASSES = 8
# The plugin's own TypeSafe API key (keys.KEY_RE), with the lib.rs prefix
# rules' minimum: lib.rs has no rule for it, so it is no app finding.
TYPESAFE_KEY = re.compile(r"\bapikey_[A-Za-z0-9_\-]{12,}")
# Read past a cut: a credential that reaches the kept part has at least
# this many characters in what is redacted, above every rule's minimum.
CLIP_MARGIN = 4096
# How far past that a run at the read window's end is read on to its end
# (_read_window): an ordinary whitespace-free blob keeps its preview, and
# the read stays bounded.
READ_WIDEN = 4 * CLIP_MARGIN


def _cut(s: str, n: int) -> str:
    """s[:n], ending before a placeholder that n falls inside (never cut
    inside one)."""
    for p in (REDACTED, REDACTED_PRIVATE_KEY):
        at = s.find(p, max(0, n - len(p) + 1), n + len(p) - 1)
        if 0 <= at < n:
            n = at
    return s[:n]


def _read_window(s: str, n: int) -> str | None:
    """s[:n], the part redact_string reads. Where s runs on past n inside a
    run (s[n] is no space), the run left at the window's end may be a
    credential cut below its rule's minimum (a URL password with no `@`, a
    JWT with a short signature, a key prefix and a few characters): the
    window is read on to the run's end (the next space, or the text's end)
    when that is at most READ_WIDEN characters on, else the run is dropped,
    back to the window's last space. Only U+0020 ends a run: every other
    whitespace is escaped in a JSON view, where it continues one. No rule's
    value holds a space but a quoted one (an open quote is redacted to the
    end) and a PEM block (redacted to the end). None: the window is all one
    run that goes on past the widening (the caller sends the placeholder)."""
    if len(s) <= n or s[n] == " ":
        return s[:n]
    end = s.find(" ", n, n + READ_WIDEN + 1)
    if end >= 0:
        return s[:end]
    if len(s) <= n + READ_WIDEN:
        return s
    at = s.rfind(" ", 0, n)
    return None if at < 0 else s[:at + 1]


class ReadBudget:
    """A read budget, in characters scanned. Each guard call has one
    (guard.GUARD_READ_CHARS) for its previews and its redact_state; its
    previews read from a share of it (`within`: what is taken here is taken
    there too, and fits only where both have room). Every redaction pass
    takes what it scans before it scans: the decoded text, and each escaped
    view it goes on to (an emoji is 12 characters in the ASCII view, a CJK
    or control character 6); redact_state also takes each body it checks.
    A string whose next scan does not fit what is left is the placeholder,
    read no further (a later, shorter one may still fit). `read`: what was
    taken. The worst case of a call is so bounded by the budget, not by the
    number of strings times the read window times the passes."""

    def __init__(self, chars: int, within: ReadBudget | None = None):
        self.left = chars
        self.read = 0
        self.within = within

    def room(self) -> int:
        return self.left if self.within is None else min(self.left, self.within.room())

    def take(self, n: int) -> None:
        if n > self.room():
            raise _Spent
        b = self
        while b is not None:
            b.left -= n
            b.read += n
            b = b.within


class _Spent(Exception):
    """A ReadBudget has no room for the next scan."""


def _charge(budget: ReadBudget | None, n: int) -> None:
    if budget is not None:
        budget.take(n)


def _read(s: str, budget: ReadBudget | None) -> str:
    """_redacted(s), each of its scans taken from the budget first (if
    any); not begun where the budget has no room for its first."""
    if budget is not None and len(s) > budget.room():
        raise _Spent
    return _redacted(s, budget)


def redact_string(s: str, limit: int | None = MAX_STRING_CHARS, *, budget: ReadBudget | None = None) -> str:
    """One string, clean in its decoded and both escaped views (findings in
    the decoded text first); a string that is not clean after PASSES is the
    placeholder alone. With a `limit` (None: no cut; the ops that bound
    their own text pass None) at most `limit` characters: redacted first,
    then cut never inside a placeholder, then redacted again (a cut can
    leave an open lead-in, `api_key=`, that gets a placeholder), cut
    shorter while that runs past the limit. Only limit + CLIP_MARGIN
    characters are read; where the text runs on past them inside a run, the
    read part goes on to the run's end within READ_WIDEN, else ends at its
    last space (_read_window), so no credential is cut down to a fragment
    below its rule's minimum. With a `budget`, every read is taken from it
    first; where it has no room, the string is the placeholder ("" where
    the limit has no room for that)."""
    none = REDACTED if limit is None or len(REDACTED) <= limit else ""
    try:
        if limit is None:
            return _read(s, budget)
        window = _read_window(s, limit + CLIP_MARGIN)
        if window is None:
            return none
        out = _read(window, budget)
        if len(out) <= limit:
            return out
        n = limit
        for _ in range(PASSES):
            kept = _read(_cut(out, n), budget)
            if len(kept) <= limit:
                return kept
            n = max(0, n - (len(kept) - limit))
    except _Spent:
        pass
    return none


_LAST_WORD = re.compile(r"\S*\s*\Z")


def clip(s: str, limit: int, tail: str = "", *, budget: ReadBudget | None = None) -> str:
    """A preview: s redacted, then cut to `limit` (see redact_string; a
    `budget` is shared by every read here). With a `tail` (a notice the
    caller appends after the cut), cut back a word at a time while clip +
    tail is not clean in the decoded text and both escaped views (the tail
    the value of an open lead-in the cut left at the end, `--password`,
    `Authorization:`; or, escaped, of a lead-in's placeholder, `token:
    <redacted>` then the notice's newline): clip + tail is clean too (the
    tail itself must be). Where PASSES words are not enough (a run of
    lead-ins), the last lead-in gets the placeholder as its value and a
    space, so the tail is no value in any view: checked, and only if that
    fails (or the limit has no room for it) is nothing kept. With a
    `budget`, the checks of clip + tail are taken from it too; where it has
    no room for one, nothing is kept."""
    kept = redact_string(s, limit, budget=budget)
    try:
        for _ in range(PASSES):
            if not tail or _clean(kept + tail, budget):
                return kept
            kept = redact_string(kept, _LAST_WORD.search(kept).start(), budget=budget)
        kept = redact_string(kept, max(0, limit - len(REDACTED) - 2), budget=budget)
        if not kept or len(REDACTED) + 2 > limit:
            return ""
        kept += ("" if kept[-1] in WHITESPACE else " ") + REDACTED + " "
        return kept if _clean(kept + tail, budget) else ""
    except _Spent:
        return ""


def _clean(text: str, budget: ReadBudget | None = None) -> bool:
    """No finding in text, decoded or in either escaped view (each scan
    taken from `budget` first, if any)."""
    _charge(budget, len(text))
    return not (find(text) or _view_findings(text, True, budget)
                or (not text.isascii() and _view_findings(text, False, budget)))


def _redacted(s: str, budget: ReadBudget | None = None) -> str:
    """Up to PASSES passes; each takes what it scans from `budget` (if any)
    before it scans: the decoded text (the open lead-ins, the rules, the
    plugin rules; the first pass the key rule too), then, where that finds
    nothing, the ASCII view and (non-ASCII text) the compact view."""
    _charge(budget, len(s))
    s = TYPESAFE_KEY.sub(REDACTED, s)
    for i in range(PASSES):
        if i:
            _charge(budget, len(s))
        at = open_quoted_secret(s)
        if at is not None:  # lib.rs redact_secrets_finished: open to the end
            s = s[:at] + REDACTED
            continue
        hits = ((find(s) + _plugin_findings(s)) or _view_findings(s, True, budget)
                or (not s.isascii() and _view_findings(s, False, budget)))
        if not hits:
            return s
        s = _apply(s, hits)
    return REDACTED


class Unclean(Exception):
    """A finding no state string can remove (a key or a question)."""


def _dump(obj, ascii_only: bool, sort_keys: bool):
    """json.dumps(obj, separators=(",", ":"), ensure_ascii=ascii_only,
    sort_keys=sort_keys) and the [start, end) span and path of every string
    value in it."""
    parts, spans, pos = [], [], 0

    def emit(text):
        nonlocal pos
        parts.append(text)
        pos += len(text)

    def walk(v, path):
        if isinstance(v, dict):
            emit("{")
            for k, (key, x) in enumerate(sorted(v.items()) if sort_keys else v.items()):
                emit(("," if k else "") + json.dumps(key, ensure_ascii=ascii_only) + ":")
                walk(x, path + (key,))
            emit("}")
        elif isinstance(v, list):
            emit("[")
            for k, x in enumerate(v):
                emit("," if k else "")
                walk(x, path + (k,))
            emit("]")
        elif isinstance(v, str):
            start = pos
            emit(json.dumps(v, ensure_ascii=ascii_only))
            spans.append((start, pos, path))
        else:
            emit(json.dumps(v, allow_nan=False))

    walk(obj, ())
    return "".join(parts), spans


# The bodies the app scans: the raw one as the relay line carries it, and
# the compact one (keys sorted; in order with serde_json preserve_order).
BODIES = ((True, False), (False, True), (False, False))


def decoded(obj) -> list[str]:
    """Every string and key in obj, as the app decodes them."""
    out = []

    def walk(v):
        if isinstance(v, dict):
            for k, x in v.items():
                out.append(k)
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, str):
            out.append(v)

    walk(obj)
    return out


def views(state, questions) -> list[str]:
    """Everything the app's SecretScan reads for this state and questions."""
    body = {"state": state, "questions": questions}
    return [_dump(body, a, s)[0] for a, s in BODIES] + decoded(body)


def _map(v, fn):
    if isinstance(v, dict):
        return {k: _map(x, fn) for k, x in v.items()}
    if isinstance(v, list):
        return [_map(x, fn) for x in v]
    return fn(v) if isinstance(v, str) else v


def _wipe(v, paths, path=()):
    if path in paths:
        return REDACTED
    if isinstance(v, dict):
        return {k: _wipe(x, paths, path + (k,)) for k, x in v.items()}
    if isinstance(v, list):
        return [_wipe(x, paths, path + (k,)) for k, x in enumerate(v)]
    return v


def redact_state(state, questions: dict, *, budget: ReadBudget | None = None):
    """THE guard-relay redactor: a copy of `state` with every credential
    value the app's SecretScan would find replaced by exactly `<redacted>`
    (rules: pria-apps crates/pria-redact/src/lib.rs). A finding that spans
    strings in a body wipes those strings; one that no state string can
    remove (a question or a key) raises Unclean. `questions` are only checked.
    With a `budget` (the guard call's), every string's redaction and every
    body check takes what it scans from it first: a string with no room is
    the placeholder, and where the body checks have no room every string
    of the state is (that skeleton is checked uncharged: it holds no text,
    only the state's keys and one placeholder per string, which the guard
    bounds; see `wiped`)."""
    out = _map(state, lambda s: redact_string(s, budget=budget))
    try:
        return _settled(out, questions, budget)
    except _Spent:
        return _settled(_map(state, lambda s: REDACTED), questions, None)


def wiped(state) -> bool:
    """True when a redacted state holds no text: it has strings and every
    one is exactly `<redacted>` (the skeleton past a call's read budget, or
    a state that was all secret). Keys, numbers and booleans do not count;
    a `<redacted private key>` does (it tells a private key was there). The
    guard does not send such a state: the model would see nothing."""
    strings = []
    _map(state, strings.append)
    return bool(strings) and all(s == REDACTED for s in strings)


def _settled(out, questions: dict, budget: ReadBudget | None):
    for _ in range(PASSES):
        body = {"state": out, "questions": questions}
        paths = set()
        for ascii_only, sort_keys in BODIES:
            text, spans = _dump(body, ascii_only, sort_keys)
            _charge(budget, len(text))
            for a, b, _rule in find(text):
                hit = {p for start, end, p in spans if start < b and a < end}
                if not hit or any(p[0] != "state" for p in hit):
                    raise Unclean("a finding outside the state's strings")
                paths |= {p[1:] for p in hit}
        if not paths:
            strings = decoded(body)
            _charge(budget, sum(map(len, strings)))
            if any(find(v) for v in strings):
                raise Unclean("a key or question holds a finding")
            return out
        out = _wipe(out, paths)
    raise Unclean("the state stays unclean")


# ── every other op: redact_request ───────────────────────────────────────


def _layout(obj, ascii_only: bool, sort_keys: bool):
    """_dump's text, with the [start, end) span, path and leafness of every
    value (containers too), sorted by start, and the span of every key."""
    parts, values, keys, pos = [], [], [], 0

    def emit(text):
        nonlocal pos
        parts.append(text)
        pos += len(text)

    def walk(v, path):
        start = pos
        if isinstance(v, dict):
            emit("{")
            for k, (key, x) in enumerate(sorted(v.items()) if sort_keys else v.items()):
                emit("," if k else "")
                at = pos
                emit(json.dumps(key, ensure_ascii=ascii_only))
                keys.append((at, pos))
                emit(":")
                walk(x, path + (key,))
            emit("}")
        elif isinstance(v, list):
            emit("[")
            for k, x in enumerate(v):
                emit("," if k else "")
                walk(x, path + (k,))
            emit("]")
        elif isinstance(v, str):
            emit(json.dumps(v, ensure_ascii=ascii_only))
        else:
            emit(json.dumps(v, allow_nan=False))
        values.append((start, pos, path, not isinstance(v, (dict, list))))

    walk(obj, ())
    values.sort(key=lambda v: v[0])  # no two values start at one place
    return "".join(parts), values, keys


def _map_keys(v, fn):
    """_map, keys too; two keys that are one once redacted raise Unclean."""
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            key = fn(k)
            if key in out:
                raise Unclean("two keys are one once redacted")
            out[key] = _map_keys(x, fn)
        return out
    if isinstance(v, list):
        return [_map_keys(x, fn) for x in v]
    return fn(v) if isinstance(v, str) else v


def _clean_key(k: str) -> bool:
    """A question key with nothing to redact, alone and as `"k":{` in a body."""
    if redact_string(k, None) != k:
        return False
    probe = {k: {"type": "noul"}}
    return not any(find(json.dumps(probe, ensure_ascii=a, separators=(",", ":"))) for a in (True, False))


def _wipeable(path: tuple, caller: bool) -> bool:
    """Any value below the state (the state itself only when it is the
    caller's: an op's state stays an object); in caller questions any value
    below a question but its `type` and its criteria object (the schema the
    answer keys on)."""
    if path[:1] == ("state",):
        return len(path) > 1 or caller
    if not caller or path[:1] != ("questions",) or len(path) < 3:
        return False
    return len(path) > 3 or path[2] not in ("type", "criteria")


def redact_request(state, questions: dict, *, caller: bool = False):
    """THE outbound redactor of every op but the guard, on both transports:
    (state, questions, names), with every credential the app's SecretScan
    would find replaced by exactly `<redacted>`. State strings and keys are
    redacted (redact_string, no cut: the ops bound their own text); a
    finding left in a body wipes the value it starts in (any type, so
    `"max_tokens":4096` sends `"max_tokens":"<redacted>"`) and every value
    it overlaps. `questions` are the op's fixed templates, only checked,
    unless `caller` (jev_decide, jev_select): then their strings are
    redacted and wiped the same way (never a `type`, a question or its
    criteria object), and a question key with a finding is sent as `q<n>`;
    names maps such a wire key back to the caller's. A finding anywhere else
    (a key, a fixed template) raises Unclean: the op skips, nothing is sent."""
    names: dict[str, str] = {}
    if caller:
        sent = {}
        for k, q in questions.items():
            wire, n = k, 0
            if not _clean_key(k):
                while f"q{n}" in questions or f"q{n}" in sent:
                    n += 1
                wire = f"q{n}"
                names[wire] = k
            sent[wire] = ({f: x if f == "type" else _map(x, lambda s: redact_string(s, None))
                           for f, x in q.items()} if isinstance(q, dict) else q)
        questions = sent
    body = {"state": _map_keys(state, lambda s: redact_string(s, None)), "questions": questions}
    for _ in range(PASSES):
        paths = set()
        for ascii_only, sort_keys in BODIES:
            text, values, keys = _layout(body, ascii_only, sort_keys)
            found = find(text)
            if not found:
                continue
            starts = [v[0] for v in values]
            leaves = [v for v in values if v[3]]
            leaf_ends = [v[1] for v in leaves]
            key_starts = [k[0] for k in keys]
            for a, b, _rule in found:
                j = bisect.bisect_right(key_starts, a) - 1
                if j >= 0 and a < keys[j][1]:
                    raise Unclean("a key holds a finding")
                i = bisect.bisect_right(starts, a) - 1
                while values[i][1] <= a:  # the innermost value the finding starts in
                    i -= 1
                hit = {values[i][2]}
                k = bisect.bisect_right(leaf_ends, a)
                while k < len(leaves) and leaves[k][0] < b:  # every value it overlaps
                    hit.add(leaves[k][2])
                    k += 1
                if not all(_wipeable(p, caller) for p in hit):
                    raise Unclean("a finding outside the redactable text")
                paths |= hit
        if not paths:
            if any(find(v) for v in decoded(body)):
                raise Unclean("a key or question holds a finding")
            return body["state"], body["questions"], names
        body = _wipe(body, paths)
    raise Unclean("the request stays unclean")
