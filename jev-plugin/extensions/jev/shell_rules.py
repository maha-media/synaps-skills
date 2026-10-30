"""shell_rules — the guard's deterministic shell-safety rule (guard item 2(b)).

After an incident (a generated script nested one heredoc inside
another, the outer one closed early, and `rm -rf "$FS"/*` ran with FS
empty), the guard blocks these shapes in shell text, decided locally with
no model call (signal_all since a test binary called kill(-1, SIGKILL)
and ended a whole desktop session):

- unguarded_variable: an operand of `rm -r`, `find ... -delete` (or
  `-exec rm`) or `mv` that expands a variable without the `:?` check
  (`$X`, `${X}`, `${X:-}`, `$1`, `$@`, ...). `"${X:?}"` stops the command
  when X is unset or empty, so an empty variable can't turn a path into `/`.
- root_operand / home_operand: a recursive-rm or find-delete operand that is
  the root (`/`, `/*`, `//`, `/.`) or the home directory (`~`, `~/*`,
  `$HOME`, `${HOME:?}/*`). `:?` does not help there, so it is never
  reported as unguarded.
- nested_heredoc: a heredoc opened inside another heredoc's body: `<<` or
  `<<-` there, then a word starting with a letter, an underscore or a
  quote, whether or not the inner terminator follows (not `<<<`, not a
  shift such as `1 << 3`).
- signal_all: a signal to every process the user may signal, in literal
  shapes only: `kill` with a pid operand of `-1` (`kill -9 -1`,
  `kill -- -1`, `kill -s KILL -1`; options read as bash's builtin and
  util-linux read them, so `kill -1 123` is SIGHUP to pid 123), `killall5`
  with any arguments, and `pkill` / `killall` selecting by user alone
  (`pkill -u user`, `killall -u user`: no pattern, no process name). A
  variable is not reported (`kill $p`, `kill -TERM -- -$G`): unset, it
  gives a usage error, not -1. A program that calls kill(-1) itself, as
  that test binary did, is no shell text and is not seen here. pkill and
  killall are read as procps/psmisc read them; on macOS and other non-Linux
  hosts (host_profile.Platform.kill_readings) also as BSD pkill/killall read
  them (`killall -m REGEX`, `pkill -v`, BSD option letters), a finding
  under either reading counting. Linux keeps the procps reading alone.

The scan covers the WHOLE text (not a preview) and is conservative: any
word `rm`, `find`, `mv`, `kill`, `pkill`, `killall` or `killall5` (also
`/bin/rm`, `\\rm`, `sudo rm`, `git rm`, and the word spelled with quotes or
backslashes: `'rm'`, `"rm"`, `r""m`) starts a command, its arguments run to the next `; & | )`, a comment or the
end of the enclosing quoted string, and code inside quoted strings, command
substitutions and heredoc bodies is scanned too. Every logical line is
scanned with a fresh quote state, so a mis-tracked quote or heredoc can add
a finding but never hide a line; a line that starts inside a string or
backticks left open by an earlier line (bash reads them across newlines) is
scanned a second time with that quoting reopened, as bash reads it. Limits
(documented in the README): no variable values or control flow are
evaluated, the value of a command substitution used as an operand is
opaque (the commands inside it are scanned), and other deleting tools
(rsync --delete, git clean, shutil.rmtree in a heredoc) are not covered.
"""

from __future__ import annotations

import re
import warnings
from collections import Counter
from typing import NamedTuple

from . import host_profile

UNGUARDED = "unguarded_variable"
ROOT = "root_operand"
HOME = "home_operand"
NESTED = "nested_heredoc"
SIGNAL_ALL = "signal_all"
RM, FIND, MV, HEREDOC = "rm -r", "find -delete", "mv", "heredoc"
KILL, PKILL, KILLALL, KILLALL5 = "kill", "pkill -u", "killall -u", "killall5"

MAX_DEPTH = 64  # quoted code inside quoted code; deeper input stops the scan (ScanLimit)
FINDINGS_MAX = 256  # one is enough to decide; a dense input stops here


class Finding(NamedTuple):
    rule: str
    command: str
    line: int
    names: tuple
    detail: str


class ScanLimit(ValueError):
    """A text past one of the scan's limits: quoted code nested deeper than
    MAX_DEPTH (or than the interpreter's recursion limit), quoted code read
    again past the rescan budget, or more carried-quoting text than
    REOPEN_MAX. Not scanned to the end, so not cleared: the guard confirms,
    or takes the finding action (block, or confirm per guard_shell_rule) on
    the findings made before it (R-FINDINGS-WIN; scan_shell).
    The message is one of the fixed texts above, never input text."""


# ── words ───────────────────────────────────────────────────────────────────

_WS = " \t\r\n\f\v"
_STOP = frozenset(_WS + ";&|()<>")
_PLAIN = re.compile(r"[^\s;&|()<>'\"`\\$]+")
_DQ_PLAIN = re.compile(r'[^\\"$`]+')
_DQ_SPECIAL = re.compile(r'[\\"$`]')
_ANSI_SPECIAL = re.compile(r"[\\']")
_BQ_SPECIAL = re.compile(r"[\\`]")
_PAREN_SPECIAL = re.compile(r"[()\\'\"`]")
_BRACE_SPECIAL = re.compile(r"[{}\\'\"`$]")
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_BRACE_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-]")
_DQ_ESCAPE = re.compile(r'\\([\\"$`\n])')
_IGNORED = frozenset("#?$!-")  # $# $? $$ $! $-: never a path
OPAQUE = "\x03"                 # a command substitution or another value we don't model


def _marker(name: str) -> str:
    return "\x01" + name + "\x02"


def _sq_end(s: str, i: int) -> int:
    """Index after the `'` closing a single-quoted string whose content starts at i."""
    j = s.find("'", i)
    return len(s) if j < 0 else j + 1


def _ansi_end(s: str, i: int) -> int:
    n = len(s)
    while True:
        m = _ANSI_SPECIAL.search(s, i)
        if not m:
            return n
        if m.group() == "\\":
            i = m.start() + 2
            continue
        return m.start() + 1


def _bq_end(s: str, i: int) -> int:
    n = len(s)
    while True:
        m = _BQ_SPECIAL.search(s, i)
        if not m:
            return n
        if m.group() == "\\":
            i = m.start() + 2
            continue
        return m.start() + 1


def _dq_end(s: str, i: int, memo: dict | None = None) -> int:
    """Index after the `"` closing a double-quoted string whose content
    starts at i (a `$(...)` inside it may hold quotes of its own)."""
    n = len(s)
    while True:
        m = _DQ_SPECIAL.search(s, i)
        if not m:
            return n
        j, c = m.start(), m.group()
        if c == "\\":
            i = j + 2
        elif c == '"':
            return j + 1
        elif c == "`":
            i = _bq_end(s, j + 1)
        elif s.startswith("$(", j):
            i = _paren_end(s, j + 2, memo)
        else:
            i = j + 1


def _paren_end(s: str, i: int, memo: dict | None = None) -> int:
    """Index after the `)` matching an opening paren just before i.

    With a memo (one dict per string), the end of every paren passed on the
    way is kept, keyed by the index after it: a chain like `rm $(rm $(rm
    ...` is then read once, not once per level. `$'...'` inside is an
    ANSI-C string (its \\' does not end it)."""
    if memo is not None:
        known = memo.get(i)
        if known is not None:
            return known
    n = len(s)
    opened = [i]  # content starts of the parens still open, innermost last
    k, esc = i, -1  # esc: the last character escaped by a backslash
    while True:
        m = _PAREN_SPECIAL.search(s, k)
        if not m:
            break
        j, c = m.start(), m.group()
        if c == "(":
            known = memo.get(j + 1) if memo is not None else None
            if known is not None:
                k = known
            else:
                opened.append(j + 1)
                k = j + 1
        elif c == ")":
            start = opened.pop()
            if memo is not None:
                memo[start] = j + 1
            if not opened:
                return j + 1
            k = j + 1
        elif c == "\\":
            esc, k = j + 1, j + 2
        elif c == "'":
            ansi = j > 0 and s[j - 1] == "$" and esc != j - 1
            k = _ansi_end(s, j + 1) if ansi else _sq_end(s, j + 1)
        elif c == '"':
            k = _dq_end(s, j + 1, memo)
        else:
            k = _bq_end(s, j + 1)
    if memo is not None:
        for start in opened:
            memo[start] = n
    return n


def _brace_end(s: str, i: int, memo: dict | None = None) -> int:
    """Index after the `}` matching a `${` just before i (memo as for
    _paren_end; the two share one dict, keyed by different positions)."""
    if memo is not None:
        known = memo.get(i)
        if known is not None:
            return known
    n = len(s)
    opened = [i]
    k = i
    while True:
        m = _BRACE_SPECIAL.search(s, k)
        if not m:
            break
        j, c = m.start(), m.group()
        if c == "{":
            known = memo.get(j + 1) if memo is not None else None
            if known is not None:
                k = known
            else:
                opened.append(j + 1)
                k = j + 1
        elif c == "}":
            start = opened.pop()
            if memo is not None:
                memo[start] = j + 1
            if not opened:
                return j + 1
            k = j + 1
        elif c == "\\":
            k = j + 2
        elif c == "'":
            k = _sq_end(s, j + 1)
        elif c == '"':
            k = _dq_end(s, j + 1, memo)
        elif c == "`":
            k = _bq_end(s, j + 1)
        else:  # `$`: `$(...)` and `$'...'` hold braces of their own
            nxt = s[j + 1:j + 2]
            if nxt == "(":
                k = _paren_end(s, j + 2, memo)
            elif nxt == "'":
                k = _ansi_end(s, j + 2)
            else:
                k = j + 1
    if memo is not None:
        for start in opened:
            memo[start] = n
    return n


# A subscript shown as written in a reason (`${a[@]:?}`, `${a[$i]:?}`);
# any other is shown as `…`: a reason carries variable names, never text.
_SHOWN_SUB = re.compile(r"[@*]|-?[0-9]+|\$?[A-Za-z_][A-Za-z0-9_]*")
_BRACKETS = re.compile(r"[\[\]]")


def _subscript_end(inner: str, i: int) -> int:
    """The index of the `]` closing the `[` at inner[i] (len(inner) if
    none); brackets inside it nest."""
    depth = 0
    for m in _BRACKETS.finditer(inner, i):
        if m.group() == "[":
            depth += 1
        else:
            depth -= 1
            if depth == 0:
                return m.start()
    return len(inner)


def _dollar(s: str, i: int, parts: list, exps: list, in_dq: bool, memo: dict | None = None) -> int:
    """One `$` form at s[i]; returns the index after it."""
    n = len(s)
    nxt = s[i + 1] if i + 1 < n else ""
    if nxt == "{":
        end = _brace_end(s, i + 2, memo)
        inner = s[i + 2:end - 1] if s[end - 1:end] == "}" else s[i + 2:end]
        k = 0
        if inner.startswith("#") and len(inner) > 1:  # ${#X}: a length
            parts.append(OPAQUE)
            return end
        if inner.startswith("!"):  # ${!X}: indirect
            k = 1
        m = _BRACE_NAME.match(inner, k)
        if not m or m.group() in _IGNORED:
            parts.append(OPAQUE)
            return end
        name = base = m.group()
        after = m.end()
        if inner.startswith("[", after) and _NAME.fullmatch(name):
            # an array element or all of them: `:?` comes after the
            # subscript (${a[@]:?}), and the fix keeps the subscript
            close = _subscript_end(inner, after)
            sub = inner[after + 1:close]
            name = f"{name}[{sub if close < len(inner) and _SHOWN_SUB.fullmatch(sub) else '…'}]"
            after = close + 1
        exps.append((name, inner.startswith(":?", after)))
        parts.append(_marker(base))
        return end
    if nxt == "(":
        parts.append(OPAQUE)
        return _paren_end(s, i + 2, memo)
    if nxt == "'" and not in_dq:
        end = _ansi_end(s, i + 2)
        parts.append(s[i + 2:end - 1])
        return end
    if nxt == '"' and not in_dq:
        return _dq_part(s, i + 2, parts, exps, memo)
    m = _NAME.match(s, i + 1)
    if m:
        exps.append((m.group(), False))
        parts.append(_marker(m.group()))
        return m.end()
    if nxt and nxt in "0123456789@*":
        exps.append((nxt, False))
        parts.append(_marker(nxt))
        return i + 2
    if nxt and nxt in _IGNORED:
        parts.append(OPAQUE)
        return i + 2
    parts.append("$")
    return i + 1


def _dq_part(s: str, i: int, parts: list, exps: list, memo: dict | None = None) -> int:
    """The content of a double-quoted string starting at i; returns the
    index after its closing quote."""
    n = len(s)
    while i < n:
        m = _DQ_PLAIN.match(s, i)
        if m:
            parts.append(m.group())
            i = m.end()
            if i >= n:
                break
        c = s[i]
        if c == '"':
            return i + 1
        if c == "\\":
            nxt = s[i + 1:i + 2]
            if nxt == "\n":
                pass
            elif nxt in ('"', "\\", "$", "`"):
                parts.append(nxt)
            else:
                parts.append("\\" + nxt)
            i += 2
        elif c == "$":
            i = _dollar(s, i, parts, exps, True, memo)
        else:  # a backtick
            parts.append(OPAQUE)
            i = _bq_end(s, i + 1)
    return n


def _read_word(s: str, i: int, bq: bool, memo: dict | None = None):
    """One shell word from s[i]: (value, expansions, index after it). The
    value is dequoted, with each expansion as a marker; the expansions are
    (name, guarded) pairs from outside single quotes."""
    n = len(s)
    parts: list = []
    exps: list = []
    while i < n:
        c = s[i]
        if c in _STOP:
            break
        if c == "`":
            if bq:
                break
            parts.append(OPAQUE)
            i = _bq_end(s, i + 1)
        elif c == "\\":
            if s[i + 1:i + 2] != "\n":
                parts.append(s[i + 1:i + 2])
            i += 2
        elif c == "'":
            end = _sq_end(s, i + 1)
            parts.append(s[i + 1:end - 1] if s[end - 1:end] == "'" else s[i + 1:end])
            i = end
        elif c == '"':
            i = _dq_part(s, i + 1, parts, exps, memo)
        elif c == "$":
            i = _dollar(s, i, parts, exps, False, memo)
        else:
            m = _PLAIN.match(s, i)
            parts.append(m.group())
            i = m.end()
    return "".join(parts), exps, i


class _Word(NamedTuple):
    value: str
    exps: list


def _words(s: str, i: int, bq: bool, memo: dict | None = None):
    """The arguments from s[i] up to a command terminator: `; & | ( )`, a
    comment, the end, or (inside backticks) a backtick. Redirections and
    their targets are dropped. Returns (words, stop index)."""
    n = len(s)
    words: list[_Word] = []
    while i < n:
        c = s[i]
        if c in _WS:
            i += 1
            continue
        if c in ";&|()" or c == "#" or (c == "`" and bq):
            break
        if c in "<>":
            j = i
            while j < n and s[j] in "<>":
                j += 1
            if j < n and s[j] == "(":  # process substitution: an opaque operand
                words.append(_Word(OPAQUE, []))
                i = _paren_end(s, j + 1, memo)
                continue
            if j < n and s[j] in "&|":
                j += 1
            while j < n and s[j] in " \t":
                j += 1
            _, _, i = _read_word(s, j, bq, memo)  # the target is not an operand
            continue
        value, exps, j = _read_word(s, i, bq, memo)
        if j < n and s[j] in "<>" and value.isdigit() and not exps:
            i = j  # a file descriptor number: `2>/dev/null`
            continue
        words.append(_Word(value, exps))
        i = j
    return words, i


# ── operands ────────────────────────────────────────────────────────────────

_HOME_PREFIX = re.compile("~[A-Za-z0-9_.-]*|" + _marker("HOME"))


def _is_home(value: str) -> bool:
    m = _HOME_PREFIX.match(value)
    if not m:
        return False
    rest = value[m.end():]
    return all(seg in ("", ".", "..", "*") for seg in rest.split("/"))


def _is_root(value: str) -> bool:
    return value.startswith("/") and all(seg in ("", ".", "..", "*") for seg in value.split("/"))


def _unguarded(word: _Word) -> tuple:
    return tuple(dict.fromkeys(name for name, guarded in word.exps if not guarded))


def _operand(word: _Word, command: str, deleting: bool, line: int, out: list) -> None:
    if deleting:
        if _is_home(word.value):
            out.append(Finding(HOME, command, line, (), "the home directory"))
            return
        if _is_root(word.value):
            out.append(Finding(ROOT, command, line, (), "the root directory"))
            return
    names = _unguarded(word)
    if names:
        out.append(Finding(UNGUARDED, command, line, names, "unguarded expansion"))


def _basename(value: str) -> str:
    return value.rsplit("/", 1)[-1]


_DQ_ESCAPED = frozenset('\\"$`\n')


def _literal_word(t: str, k: int):
    """The value of t[:k], a word of literal characters, quotes and
    backslashes (a _CMD match), or None if a quote opened in it, or a
    backslash at its end, reaches past it. An expansion (`$m`) or an ANSI-C
    escape other than \\\\ and \\' (`$'\\x72m'`) gives a value that is no
    command."""
    out, i = [], 0
    while i < k:
        c = t[i]
        if c == "\\":
            if i + 1 >= k:
                return None
            out.append(t[i + 1])
            i += 2
            continue
        if c == "$":
            i += 1
            c = t[i:i + 1] if i < k else ""
            if c != "'" and c != '"':
                out.append(OPAQUE)
                continue
            ansi = c == "'"
        elif c == "'" or c == '"':
            ansi = False
        else:
            out.append(c)
            i += 1
            continue
        j = i + 1
        while j < k and t[j] != c:
            if t[j] == "\\" and (c == '"' or ansi):
                if j + 1 >= k:
                    return None
                nxt = t[j + 1]
                if ansi and nxt not in ("\\", "'"):
                    out.append(OPAQUE)
                elif not ansi and nxt not in _DQ_ESCAPED:
                    out.append("\\")
                out.append(nxt)
                j += 2
                continue
            out.append(t[j])
            j += 1
        if j >= k:
            return None
        i = j + 1
    return "".join(out)


def _rm(words: list, line: int, out: list) -> None:
    recursive, ended, operands = False, False, []
    for w in words:
        v = w.value
        if not ended and v == "--":
            ended = True
        elif not ended and v.startswith("--"):
            recursive = recursive or v.startswith("--r")
        elif not ended and len(v) > 1 and v.startswith("-"):
            recursive = recursive or "r" in v or "R" in v
        else:
            operands.append(w)
    if recursive:
        for w in operands:
            _operand(w, RM, True, line, out)


_FIND_OPTIONS = re.compile(r"-[HLP]+|-O[0-9]*")
_FIND_EXEC = frozenset({"-exec", "-execdir", "-ok", "-okdir"})


def _find(words: list, line: int, out: list) -> None:
    i, n = 0, len(words)
    while i < n:
        v = words[i].value
        if _FIND_OPTIONS.fullmatch(v):
            i += 1
        elif v == "-D":
            i += 2
        else:
            break
    paths = []
    while i < n and not (words[i].value.startswith("-") or words[i].value in ("(", "!", ")")):
        paths.append(words[i])
        i += 1
    deleting = False
    for k in range(i, n):
        v = words[k].value
        if v == "-delete" or (v in _FIND_EXEC and k + 1 < n and _basename(words[k + 1].value) == "rm"):
            deleting = True
            break
    if deleting:
        for w in paths:
            _operand(w, FIND, True, line, out)


def _mv(words: list, line: int, out: list) -> None:
    ended, skip_next, operand_next = False, False, False
    for w in words:
        v = w.value
        if skip_next:
            skip_next = False
        elif operand_next:
            operand_next = False
            _operand(w, MV, False, line, out)
        elif not ended and v == "--":
            ended = True
        elif not ended and v.startswith("--"):
            if v.startswith("--target-directory="):
                _operand(w, MV, False, line, out)
            elif v == "--target-directory":
                operand_next = True
            elif v == "--suffix":
                skip_next = True
        elif not ended and len(v) > 1 and v.startswith("-"):
            letters = v[1:]
            for k, ch in enumerate(letters):
                if ch == "t":
                    if letters[k + 1:]:
                        _operand(w, MV, False, line, out)
                    else:
                        operand_next = True
                    break
                if ch == "S":
                    skip_next = not letters[k + 1:]
                    break
        else:
            _operand(w, MV, False, line, out)


# ── signals to every process ──────────────────────────────────────────────
# kill(-1, sig) signals every process the caller may signal: a test binary
# once did that and ended the owner's desktop session. Only literal shapes
# count; nothing here runs or signals anything.

# a pid operand read as -1 (strtol: blanks around it, leading zeros)
_PID_ALL = re.compile(r"[ \t\n\r\f\v]*-0*1[ \t\n\r\f\v]*")
_KILL_LIST = frozenset({"-l", "-L", "--list", "--table"})
_KILL_VALUE = frozenset({"-s", "-n", "--signal"})


def _kill(words: list, line: int, out: list) -> None:
    """kill (bash's builtin or util-linux's): a pid operand of -1. Options
    as both read them: `-s SIG`, `-n NUM` and `--signal SIG` take a value,
    one leading `-SIG` names the signal (`-9`, `-KILL`, and `-1` = SIGHUP
    when it comes first), `--` ends the options, `-l`/`-L`/`--list` only
    list signals. One finding per command."""
    i, n, named = 0, len(words), False  # named: the signal is given
    while i < n:
        v = words[i].value
        if v in _KILL_LIST or v.startswith("--list="):
            return
        if v == "--":
            i += 1
            break
        if v in _KILL_VALUE:
            named, i = True, i + 2
        elif len(v) > 1 and v.startswith("-") and not named:
            named, i = True, i + 1
        else:
            break
    for w in words[i:]:
        if _PID_ALL.fullmatch(w.value):
            out.append(Finding(SIGNAL_ALL, KILL, line, (), "pid -1"))
            return


# A leading -SIG of pkill (procps: any case, a digit starts a number) and of
# killall (psmisc: upper case or a number), read before the option letters
# (`-HUP` is no -U).
_SIG_NAMES = (r"(?:SIG)?(?:ABRT|ALRM|BUS|CHLD|CLD|CONT|EXIT|FPE|HUP|ILL|INT|IOT?|KILL|NULL|PIPE|POLL|"
              r"PROF|PWR|QUIT|SEGV|STKFLT|STOP|SYS|TERM|TRAP|TSTP|TTIN|TTOU|URG|USR[12]|VTALRM|WINCH|"
              r"XCPU|XFSZ|RTMIN(?:\+[0-9]+)?|RTMAX(?:-[0-9]+)?)")
_PKILL_SIG = re.compile(r"[0-9].*|" + _SIG_NAMES, re.I | re.S)
_KILLALL_SIG = re.compile(r"[0-9]+|" + _SIG_NAMES)
# the option letters and long options that take a value
_PKILL_VALUES = "qFPOgsuUGtr"
_PKILL_LONG_VALUES = frozenset({"signal", "queue", "pidfile", "parent", "older", "pgroup", "session", "euid",
                                "uid", "group", "terminal", "runstates", "ns", "nslist", "cgroup", "env"})
_KILLALL_VALUES = "yosuZn"
_KILLALL_LONG_VALUES = frozenset({"signal", "user", "younger-than", "older-than", "context", "ns"})
_USER_LETTERS = "uU"
_USER_LONG = frozenset({"uid", "euid", "user"})


def _user_only(words: list, values: str, long_values: frozenset, sig_word: re.Pattern) -> bool:
    """True if the words select processes by user (-u/-U, --uid, --euid,
    --user) and hold no operand (a pattern or a process name), read as
    getopt reads them: options anywhere until `--`, a value glued to its
    letter or in the next word, the -SIG word skipped."""
    user, skip, n = False, False, len(words)
    for k, w in enumerate(words):
        v = w.value
        if skip:
            skip = False
        elif v == "--":
            return user and k + 1 == n
        elif v.startswith("--"):
            name, eq, _ = v[2:].partition("=")
            user = user or name in _USER_LONG
            skip = not eq and name in long_values
        elif len(v) > 1 and v.startswith("-"):
            if sig_word.fullmatch(v, 1):
                continue
            for at, letter in enumerate(v[1:], 2):
                if letter in values:
                    user = user or letter in _USER_LETTERS
                    skip = at == len(v)
                    break
        else:
            return False
    return user


# BSD pkill and killall (macOS). host_profile.Platform.kill_readings() says
# which readings apply: Linux procps/psmisc only (unchanged); macOS (and any
# other OS) the BSD reading too, a finding when either reading finds one.
# BSD pkill: one leading -SIG (a strtol number or a signal name, any case,
# SIG optional) only as the first word; then getopt WITHOUT permutation
# (options end at the first operand or `--`); value letters below; -u/-U
# select by user. BSD killall: each `-word` is dispatched on its first
# letter only (-u/-t/-c/-j take the rest of the word or the next one, any
# other letter is a flag or a signal name), options end at the first word
# without a dash; -c NAME names the process. On macOS a pattern that matches
# every process name (pkill's pattern, killall -m's regex; one that cannot
# be compiled counts) or pkill -v (all but the named ones) selects by user
# as well, and so it does with no -u at all (BSD killall then takes the
# caller's processes; pkill all it may signal) unless another selector
# (pkill -F/-G/-P/-c/-g/-j/-s/-t, killall -t/-j) narrows it. A dry run
# (killall -s) is still reported.
_BSD_SIGNALS = frozenset({"HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "IOT", "EMT", "FPE", "KILL", "BUS",
                          "SEGV", "SYS", "PIPE", "ALRM", "TERM", "URG", "STOP", "TSTP", "CONT", "CHLD",
                          "TTIN", "TTOU", "IO", "XCPU", "XFSZ", "VTALRM", "PROF", "WINCH", "INFO", "USR1",
                          "USR2"})
_BSD_PKILL_VALUES = "FGMNPUcdgjstu"
_BSD_KILLALL_VALUES = "utcj"
_BSD_PKILL_NARROW = "FGPcgjst"  # selectors other than the user (-d/-M/-N are not)
_STRTOL = re.compile(r"[ \t\n\v\f\r]*[-+]?[0-9]+")
# process names a match-all pattern matches (search; -x: whole name)
_PROBE_NAMES = ("a", "Z", "0", "_", "-", ".", "/", "x y", "zsh", "Finder", "launchd", "WindowServer")
_PATTERN_MAX = 256


def _bsd_signal(v: str) -> bool:
    """A word after its dash that BSD pkill reads as the signal."""
    if v == "" or _STRTOL.fullmatch(v):
        return True
    name = v[3:] if v[:3].upper() == "SIG" else v
    return name.upper() in _BSD_SIGNALS


def _matches_all(pattern: str, exact: bool = False, icase: bool = False) -> bool:
    if OPAQUE in pattern:
        return False  # literal shapes only, as everywhere in this rule
    if pattern == "" or len(pattern) > _PATTERN_MAX:
        return True
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            rx = re.compile(pattern, re.I if icase else 0)
        match = rx.fullmatch if exact else rx.search
        return all(match(name) for name in _PROBE_NAMES)
    except (re.error, RecursionError, OverflowError, ValueError):
        return True


def _bsd_pkill_user_only(words: list) -> bool:
    vals = [w.value for w in words]
    i, n = 0, len(vals)
    if n and vals[0].startswith("-") and _bsd_signal(vals[0][1:]):
        i = 1
    user = invert = exact = icase = narrowed = False
    while i < n:
        v = vals[i]
        if v == "--":
            i += 1
            break
        if not v.startswith("-") or v == "-":
            break
        step = 1
        for at, letter in enumerate(v[1:], 2):
            if letter in _BSD_PKILL_VALUES:
                user = user or letter in _USER_LETTERS
                narrowed = narrowed or letter in _BSD_PKILL_NARROW
                step = 2 if at == len(v) else 1
                break
            invert = invert or letter == "v"
            exact = exact or letter == "x"
            icase = icase or letter == "i"
        i += step
    ops = vals[i:]
    if not ops:
        return user
    if not user and narrowed:
        return False
    return invert or any(_matches_all(o, exact, icase) for o in ops)


def _bsd_killall_user_only(words: list) -> bool:
    vals = [w.value for w in words]
    i, n = 0, len(vals)
    user = named = regex = narrowed = False
    while i < n and vals[i].startswith("-"):
        v = vals[i][1:]
        if v in ("l", "help"):
            return False  # lists the signals / prints the usage, kills nothing
        letter = v[:1]
        if letter in _BSD_KILLALL_VALUES:
            if len(v) == 1:
                i += 1
            user = user or letter == "u"
            named = named or letter == "c"
            narrowed = narrowed or letter in "tj"
        regex = regex or letter == "m"
        i += 1
    ops = vals[i:]
    if named:
        return False
    if regex and (user or not narrowed) and any(_matches_all(o) for o in ops):
        return True
    return user and not ops


def _readings() -> tuple:
    return host_profile.HostProfile.current().platform.kill_readings()


def _pkill(words: list, line: int, out: list) -> None:
    if _user_only(words, _PKILL_VALUES, _PKILL_LONG_VALUES, _PKILL_SIG) or (
            "bsd" in _readings() and _bsd_pkill_user_only(words)):
        out.append(Finding(SIGNAL_ALL, PKILL, line, (), "selects by user alone"))


def _killall(words: list, line: int, out: list) -> None:
    if _user_only(words, _KILLALL_VALUES, _KILLALL_LONG_VALUES, _KILLALL_SIG) or (
            "bsd" in _readings() and _bsd_killall_user_only(words)):
        out.append(Finding(SIGNAL_ALL, KILLALL, line, (), "selects by user alone"))


def _killall5(words: list, line: int, out: list) -> None:
    out.append(Finding(SIGNAL_ALL, KILLALL5, line, (), "every process"))


_COMMANDS = {"rm": _rm, "find": _find, "mv": _mv,
             "kill": _kill, "pkill": _pkill, "killall": _killall, "killall5": _killall5}

# A command word: rm, find, mv, kill, pkill, killall or killall5, alone or
# as the last part of a path, maybe backslash-escaped, at a word start
# (after whitespace, an operator, a paren, a brace or a quote): group 1,
# the pattern before r1, tried first.
# The candidates also take the same word spelled with quotes and
# backslashes (r1 finding 5): 'rm', "rm", r""m, r\m, $'rm', '/bin/rm', up
# to 8 of $ ' " \ before, between and after its letters (_NOISE, bounded
# so a run of quotes costs a few steps per character); group 2 is what
# follows its last letter. A spelled candidate counts only if it dequotes
# to the command (_literal_word): $RM, ${R}m and $'\x72m' are misses. A
# word that only starts like one, its first quote still open where the
# word ends (`"rm x"`, `'rm -r`: a string), is not a spelled candidate;
# the plain word inside it is (the string is scanned as code).
_NOISE = r"[$'\"\\]{0,8}"
_CMD_END = r"(?=[\s;&|()<>'\"`]|$)"
# kill and killall are prefixes of killall and killall5: glued to a quote
# they are left to the spelled pattern, as the quote may spell the longer
# name (kill'all'5 is killall5)
_CMD = re.compile(
    r"(?<![^\s;&|(){}'\"`])(?:"
    r"\\?(?:[^\s;&|(){}<>'\"`$\\]*/)?(rm|find|mv|pkill|killall5|kill(?:all)?(?!['\"]))" + _CMD_END + r"|"
    # a spelled word starts with one of $ ' " \, a first letter, or a path
    r"(?=[$'\"\\rfmkp]|[^\s;&|(){}<>'\"`$\\]*/)"
    r"(?!\$?['\"][^'\"\s;&|()<>`]*(?:[\s;&|()<>`]|$)|\$(?!['\"]))"
    # a spelled word holds one of $ ' " \ (else the plain pattern matched):
    # most words fail here after one pass over them
    r"(?=[^\s;&|()<>`$'\"\\]*[$'\"\\])" + _NOISE
    + r"(?:[^\s;&|(){}<>'\"`$\\]*/" + _NOISE + r")?"
    + r"(?:r" + _NOISE + r"m|f" + _NOISE + r"i" + _NOISE + r"n" + _NOISE + r"d|m" + _NOISE + r"v"
    + r"|p?" + _NOISE + r"k" + _NOISE + r"i" + _NOISE + r"l" + _NOISE + r"l"
    + r"(?:" + _NOISE + r"a" + _NOISE + r"l" + _NOISE + r"l(?:" + _NOISE + r"5)?)?)"
    + r"(" + _NOISE + r")" + _CMD_END + r")")


# ── one logical line ─────────────────────────────────────────────────────────

CODE, SQ, DQ, BQ, SUB, ANSI = range(6)
_CODE_SPECIAL = re.compile(r"[\\'\"`$()#]")
_COMMENT_AFTER = frozenset(" \t\r\f\v;&|(")
# where a command substitution opens: $( ` <( >(
_SUB_OPEN = re.compile(r"\$\(|`|[<>]\(")
# Quoted code is scanned again as a script of its own. All such rescans of
# one text together may cover RESCAN_FACTOR x its length (+ RESCAN_SLACK);
# beyond that the scan stops with ScanLimit (see ScanLimit). Quoted
# code nested n deep holds the same bytes n times, so this bounds the cost
# of deep nesting where MAX_DEPTH alone would allow 64 passes. 1.5 (was 2,
# BLOCK r2 fix 9): the costliest unit at 256 KiB, a deep stack of quoting
# carried over many short lines, which this budget stops, took 0.49-0.55 s
# on an E-core at 2 (load 14-16) and 0.38-0.41 s at 1.5 (load 21-37; CPU
# 20, i9-14900K, 2026-10-18). The trade-off: a text that needs more
# rescanning confirms sooner (more friction on very long rescanned text,
# never a let-through); 1.5 and 2 gave the same findings on both
# false-positive corpora.
RESCAN_FACTOR = 1.5
RESCAN_SLACK = 64 * 1024
# Lines read a second time with quoting carried from an earlier line
# reopened (see scan_shell) may hold REOPEN_MAX bytes in all; beyond that the
# scan stops with ScanLimit (see ScanLimit). A text up to this size is
# never stopped by it; it keeps the second reading of a large text to a
# quarter of the guard's largest scanned text (at this cap a text carried
# to it came to 29% of the scan bound on a P-core and 48% on an E-core,
# i9-14900K, 2026-10-18, load 8-12).
REOPEN_MAX = 64 * 1024


def _innermost_sub(stack: list) -> int:
    """The open index of the innermost command substitution on the walk
    stack ($( <( >( or a backtick), -1 if none. Quotes cannot hold quotes
    without one between them, so this looks at no more than 3 entries."""
    for entry in reversed(stack):
        if entry[0] == SUB or entry[0] == BQ:
            return entry[1]
    return -1


def _bq_close(s: str, j: int, outer: int) -> int:
    """The index of the backtick closing the one at j (len(s) if none), at
    most `outer`, the closing backtick of an enclosing one."""
    end = _bq_end(s, j + 1)
    at = end - 1 if end - 1 > j and s[end - 1] == "`" else len(s)
    return at if at < outer else outer


def _scan_line(s: str, line: int, out: list, depth: int, budget: list) -> None:
    """Command findings in one logical line (or in quoted code from one).

    An rm/mv command's words (its region) are not commands themselves, so
    the candidate search jumps past them, except inside a command
    substitution opened in the region (`rm "$(rm -rf $X)"`), which runs as
    a command of its own. A find region only hides later find words (its
    -exec may run rm or mv). budget[0]: the bytes rescans may still cover."""
    if depth > MAX_DEPTH:
        raise ScanLimit("quoted code nested too deeply")
    memo: dict = {}  # paren/brace ends in s (see _paren_end)
    stack: list = []  # [kind, open index, paren depth]; empty = top-level code
    n = len(s)
    closes: list = []  # the closing backtick of each open backtick substitution, innermost last
    close = n          # closes[-1], or n outside backticks
    i = 0
    esc = -1        # the last character the walk saw escaped by a backslash
    regions: list = []  # (start, end, substitutions run) of rm/mv words and rescanned strings
    finds: list = []    # (start, end) of find words
    pos = 0         # where the next candidate search starts
    opener = False  # in a region, after a plain word: jump to its next substitution
    while True:
        while regions and pos >= regions[-1][1]:
            regions.pop()
            opener = False
        if regions:
            # A candidate inside a region is a command only inside a
            # substitution opened there; the search skips the rest in C, so
            # `rm rm rm ...` or quoted code nested deep costs no Python
            # step per word. The walk below still covers every character.
            _, end, runs = regions[-1]
            if not runs:
                pos = end
                continue
            if opener:
                o = _SUB_OPEN.search(s, pos, end)
                if o is None:
                    pos = end
                    continue
                pos = o.start()
                opener = False
            m = _CMD.search(s, pos, end)
            if m is None:
                pos = end
                continue
        else:
            m = _CMD.search(s, pos)
            if m is None:
                return
        p = m.start()
        cmd = m.group(1)  # a plain word (as before r1); None for a spelled one
        pos = m.end() if cmd else p + 1
        # walk the quote context up to p
        while i < p:
            if i >= close:
                # The first unescaped backtick ends a backtick substitution,
                # whatever quotes or parens are open inside it: bash finds
                # it before parsing the inside (_bq_end).
                while stack.pop()[0] != BQ:
                    pass
                closes.pop()
                i = max(i, close + 1)
                close = closes[-1] if closes else n
                continue
            lim = p if p < close else close
            kind = stack[-1][0] if stack else CODE
            if kind == SQ:
                j = s.find("'", i, lim)
                if j < 0:
                    i = lim
                else:
                    stack.pop()
                    i = j + 1
            elif kind == ANSI:
                mm = _ANSI_SPECIAL.search(s, i, lim)
                if not mm:
                    i = lim
                elif mm.group() == "\\":
                    i = mm.start() + 2
                else:
                    stack.pop()
                    i = mm.start() + 1
            elif kind == DQ:
                mm = _DQ_SPECIAL.search(s, i, lim)
                if not mm:
                    i = lim
                    continue
                j, c = mm.start(), mm.group()
                if c == "\\":
                    esc, i = j + 1, j + 2
                elif c == '"':
                    stack.pop()
                    i = j + 1
                elif c == "`":
                    close = _bq_close(s, j, close)
                    closes.append(close)
                    stack.append([BQ, j, 0])
                    i = j + 1
                elif s.startswith("$(", j):
                    stack.append([SUB, j + 1, 0])
                    i = j + 2
                else:
                    i = j + 1
            else:
                mm = _CODE_SPECIAL.search(s, i, lim)
                if not mm:
                    i = lim
                    continue
                j, c = mm.start(), mm.group()
                i = j + 1
                if c == "\\":
                    esc, i = j + 1, j + 2
                elif c == "'":
                    stack.append([SQ, j, 0])
                elif c == '"':
                    stack.append([DQ, j, 0])
                elif c == "`":  # an opening one: the closing one is `close`
                    close = _bq_close(s, j, close)
                    closes.append(close)
                    stack.append([BQ, j, 0])
                elif c == "$":
                    nxt = s[j + 1:j + 2]
                    if nxt == "(":
                        stack.append([SUB, j + 1, 0])
                        i = j + 2
                    elif nxt == "'":
                        stack.append([ANSI, j + 1, 0])
                        i = j + 2
                    elif nxt == '"':
                        stack.append([DQ, j + 1, 0])
                        i = j + 2
                elif c == "(":
                    if j > 0 and s[j - 1] in "<>" and esc != j - 1:  # <( >(: process substitution
                        stack.append([SUB, j, 0])
                    elif kind == SUB:
                        stack[-1][2] += 1
                elif c == ")":
                    if kind == SUB:
                        if stack[-1][2]:
                            stack[-1][2] -= 1
                        else:
                            stack.pop()
                elif j == 0 or s[j - 1] in _COMMENT_AFTER:  # `#` at a word start
                    if not closes:
                        return  # the rest of the line is a comment
                    i = close  # a comment inside backticks ends at the closing one
        if i > p:
            continue  # inside an escape
        if regions and _innermost_sub(stack) < regions[-1][0]:
            opener = True  # a plain word of the region
            continue
        if len(out) >= FINDINGS_MAX:
            return
        kind = stack[-1][0] if stack else CODE
        if kind in (SQ, DQ, ANSI):
            # code quoted as a string (trap '...', bash -c "..."): scan the
            # whole string as a script of its own, once (inside backticks,
            # up to the closing backtick at most)
            start = stack[-1][1] + 1
            end = (_sq_end if kind == SQ else _ansi_end if kind == ANSI else _dq_end)(s, start)
            if end > close:
                end = close
                content = s[start:close]
            else:
                quote = "'" if kind != DQ else '"'
                content = s[start:end - 1] if end > start and s[end - 1] == quote else s[start:end]
            if kind == DQ:
                content = _DQ_ESCAPE.sub(lambda e: "" if e.group(1) == "\n" else e.group(1), content)
            budget[0] -= len(content)
            if budget[0] < 0:
                raise ScanLimit("quoted code rescanned too often")
            _scan_line(content, line, out, depth + 1, budget)
            regions.append((end, end, False))
            continue
        if not cmd:
            # a spelled word (r1 finding 5): the command if the matched
            # text, its quotes closed within it, dequotes to rm/find/mv (or
            # a path ending in one). As for a plain word, whatever is glued
            # after it at a quote starts the arguments (`'rm'"$X"` reads
            # like `rm"$X"`); never at a backslash or a $ (`rm\ x` is no rm).
            t = m.group()
            core = m.start(2) - p  # up to the command's last letter
            for k in range(len(t), core - 1, -1):  # what follows the letters: longest first
                if k < len(t) and t[k] not in "'\"":
                    continue
                value = _literal_word(t, k)
                if value is not None:
                    if _basename(value) in _COMMANDS:
                        cmd, pos = _basename(value), p + k
                    break
            if not cmd:
                continue
        if cmd == "find":
            while finds and p >= finds[-1][1]:
                finds.pop()
            if finds and _innermost_sub(stack) < finds[-1][0]:
                continue  # a word of an earlier find
        words, stop = _words(s, pos, kind == BQ, memo)
        if stop > close:
            stop = close  # a command inside backticks ends at the closing one
        _COMMANDS[cmd](words, line, out)
        if cmd == "find":
            finds.append((pos, stop))
        else:
            regions.append((pos, stop, True))


def _logical_lines(lines: list[str]):
    """(first line number, text) with backslash-newline continuations joined."""
    i, n = 0, len(lines)
    while i < n:
        start = i
        text = lines[i]
        if text.endswith("\\") and (len(text) - len(text.rstrip("\\"))) % 2 == 1:
            parts = [text[:-1]]
            while i + 1 < n:
                i += 1
                nxt = lines[i]
                if nxt.endswith("\\") and (len(nxt) - len(nxt.rstrip("\\"))) % 2 == 1:
                    parts.append(nxt[:-1])
                    continue
                parts.append(nxt)
                break
            text = "".join(parts)
        yield start + 1, text
        i += 1


# ── heredocs ────────────────────────────────────────────────────────────────

ARITH = 6
_HD_SPECIAL = re.compile(r"[\\'\"`$()#<]")
_PARENS = re.compile(r"[()]")
_OPENER_START = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_'\"\\")


def _openers(s: str) -> list:
    """(delimiter, strips tabs, opener shape) for each heredoc operator in
    one line, outside quotes, comments and arithmetic; `<<<` is a
    here-string. The shape (as ruled for nested_heredoc): the word after
    << or <<- starts with a letter, an underscore or a quote (here also a
    backslash, which quotes too), so `1 << 3` and `x<<2` are not openers."""
    found = []
    n, i = len(s), 0
    stack: list = []
    while i < n:
        kind = stack[-1][0] if stack else CODE
        if kind == SQ:
            j = s.find("'", i)
            if j < 0:
                break
            stack.pop()
            i = j + 1
            continue
        if kind == ANSI:
            i = _ansi_end(s, i)
            stack.pop()
            continue
        if kind == DQ:
            m = _DQ_SPECIAL.search(s, i)
            if not m:
                break
            j, c = m.start(), m.group()
            if c == "\\":
                i = j + 2
            elif c == '"':
                stack.pop()
                i = j + 1
            elif c == "`":
                stack.append([BQ, j, 0])
                i = j + 1
            elif s.startswith("$((", j):
                stack.append([ARITH, j, 2])
                i = j + 3
            elif s.startswith("$(", j):
                stack.append([SUB, j, 0])
                i = j + 2
            else:
                i = j + 1
            continue
        if kind == ARITH:
            m = _PARENS.search(s, i)
            if not m:
                break
            stack[-1][2] += 1 if m.group() == "(" else -1
            if stack[-1][2] <= 0:
                stack.pop()
            i = m.end()
            continue
        m = _HD_SPECIAL.search(s, i)
        if not m:
            break
        j, c = m.start(), m.group()
        i = j + 1
        if c == "<":
            if s.startswith("<<<", j):
                i = j + 3
            elif s.startswith("<<", j):
                k = j + 2
                dash = s.startswith("-", k)
                if dash:
                    k += 1
                while k < n and s[k] in " \t":
                    k += 1
                delimiter, _, i = _read_word(s, k, False)
                if delimiter:
                    found.append((delimiter, dash, s[k] in _OPENER_START))
        elif c == "\\":
            i = j + 2
        elif c == "'":
            stack.append([SQ, j, 0])
        elif c == '"':
            stack.append([DQ, j, 0])
        elif c == "`":
            if kind == BQ:
                stack.pop()
            else:
                stack.append([BQ, j, 0])
        elif c == "$":
            if s.startswith("$((", j):
                stack.append([ARITH, j, 2])
                i = j + 3
            elif s.startswith("$(", j):
                stack.append([SUB, j, 0])
                i = j + 2
            elif s.startswith("$'", j):
                stack.append([ANSI, j, 0])
                i = j + 2
            elif s.startswith('$"', j):
                stack.append([DQ, j, 0])
                i = j + 2
        elif c == "(":
            if s.startswith("((", j):
                stack.append([ARITH, j, 2])
                i = j + 2
            elif kind == SUB:
                stack[-1][2] += 1
        elif c == ")":
            if kind == SUB:
                if stack[-1][2]:
                    stack[-1][2] -= 1
                else:
                    stack.pop()
        elif j == 0 or s[j - 1] in _COMMENT_AFTER:  # `#` at a word start
            break
    return found


def _heredocs(lines: list[str], out: list) -> None:
    """Nested heredocs: an opener (see _openers) on a line of another
    heredoc's body, whether or not its terminator follows in that body. The
    body is text bash writes out; a script holding a heredoc inside a
    heredoc is the incident's shape, and an inner opener left unterminated (or
    reusing the outer delimiter, which ends the outer body early) leaves the
    rest to run as commands."""
    n, i = len(lines), 0
    pending: list = []
    while i < n:
        if not pending:
            pending.extend(_openers(lines[i]))
            i += 1
            continue
        outer, outer_dash, _ = pending.pop(0)
        while i < n:
            text = lines[i]
            if (text.lstrip("\t") if outer_dash else text) == outer:
                i += 1  # the outer body ends here
                break
            for delimiter, _, shaped in _openers(text):
                if shaped:
                    detail = "closes the outer heredoc early" if delimiter == outer else "inside another heredoc's body"
                    out.append(Finding(NESTED, HEREDOC, i + 1, (), detail))
            i += 1
            if len(out) >= FINDINGS_MAX:
                return


# ── quoting carried across lines ────────────────────────────────────────────

_TRACK_SPECIAL = re.compile(r"[\\'\"`$()#<]")


def _track(s: str, stack: list) -> list:
    """Walk one physical line from the quoting in `stack` (changed in
    place to the quoting at its end) and return its heredoc operators as
    (delimiter, strips tabs). Bash reads a quoted string, a command
    substitution or a backtick substitution across newlines; a backtick
    substitution ends at the first unescaped backtick, whatever it holds."""
    found = []
    n, i = len(s), 0
    while i < n:
        kind = stack[-1][0] if stack else CODE
        if kind == SQ:
            j = s.find("'", i)
            if j < 0:
                break
            stack.pop()
            i = j + 1
        elif kind == ANSI or kind == BQ:
            m = (_ANSI_SPECIAL if kind == ANSI else _BQ_SPECIAL).search(s, i)
            if not m:
                break
            i = m.start() + 2 if m.group() == "\\" else m.start() + 1
            if m.group() != "\\":
                stack.pop()
        elif kind == DQ:
            m = _DQ_SPECIAL.search(s, i)
            if not m:
                break
            j, c = m.start(), m.group()
            i = j + 1
            if c == "\\":
                i = j + 2
            elif c == '"':
                stack.pop()
            elif c == "`":
                stack.append([BQ, j, 0])
            elif s.startswith("$((", j):
                stack.append([ARITH, j, 2])
                i = j + 3
            elif s.startswith("$(", j):
                stack.append([SUB, j, 0])
                i = j + 2
        elif kind == ARITH:
            m = _PARENS.search(s, i)
            if not m:
                break
            stack[-1][2] += 1 if m.group() == "(" else -1
            if stack[-1][2] <= 0:
                stack.pop()
            i = m.end()
        else:  # top-level code or a command substitution
            m = _TRACK_SPECIAL.search(s, i)
            if not m:
                break
            j, c = m.start(), m.group()
            i = j + 1
            if c == "<":
                if s.startswith("<<<", j):
                    i = j + 3
                elif s.startswith("<<", j):
                    k = j + 2
                    dash = s.startswith("-", k)
                    if dash:
                        k += 1
                    while k < n and s[k] in " \t":
                        k += 1
                    delimiter, _, i = _read_word(s, k, False)
                    if delimiter:
                        found.append((delimiter, dash))
                elif s.startswith("<(", j):
                    stack.append([SUB, j, 0])
                    i = j + 2
            elif c == "\\":
                i = j + 2
            elif c == "'":
                stack.append([SQ, j, 0])
            elif c == '"':
                stack.append([DQ, j, 0])
            elif c == "`":
                stack.append([BQ, j, 0])
            elif c == "$":
                if s.startswith("$((", j):
                    stack.append([ARITH, j, 2])
                    i = j + 3
                elif s.startswith("$(", j):
                    stack.append([SUB, j, 0])
                    i = j + 2
                elif s.startswith("$'", j):
                    stack.append([ANSI, j, 0])
                    i = j + 2
                elif s.startswith('$"', j):
                    stack.append([DQ, j, 0])
                    i = j + 2
            elif c == "(":
                if s.startswith("((", j):
                    stack.append([ARITH, j, 2])
                    i = j + 2
                elif j > 0 and s[j - 1] == ">":
                    stack.append([SUB, j, 0])
                elif kind == SUB:
                    stack[-1][2] += 1
            elif c == ")":
                if kind == SUB:
                    if stack[-1][2]:
                        stack[-1][2] -= 1
                    else:
                        stack.pop()
            elif j == 0 or s[j - 1] in _COMMENT_AFTER:  # `#` at a word start
                break
    return found


_REOPEN = {SQ: "'", DQ: '"', ANSI: "$'", BQ: "`"}
# a character that can leave quoting open at the end of a line (a command
# substitution alone holds code: _reopen leaves it out)
_OPENS = re.compile(r"['\"`]")
# what can end a double-quoted string or change how its content reads
_DQ_ACTIVE = re.compile(r'[\\"$`]')


def _reopen(stack: list) -> str:
    """A prefix that puts a line back into the quoting in `stack`. Command
    substitutions (and arithmetic) below the outermost quote are left out:
    their content is code, as at the top level."""
    k = 0
    while k < len(stack) and stack[k][0] in (SUB, ARITH):
        k += 1
    if len(stack) - k > MAX_DEPTH:
        raise ScanLimit("quoted code nested too deeply")
    return "".join(_REOPEN.get(kind) or "$" + "(" * (1 + depth if kind == SUB else depth)
                   for kind, _, depth in stack[k:])


def _same_reading(prefix: str, line: str) -> bool:
    """The reopened reading of `line` can't differ from the fresh one: it
    stays inside one string (or backticks) whose content reads as the
    line itself, and quoted code is scanned as code anyway. (Inside
    backticks, one difference remains: a `#` starting the line follows the
    reopened backtick, so that reading takes it for part of a word, where
    bash, like the fresh reading, starts a comment inside the substitution.
    Skipping keeps bash's reading.)"""
    if prefix == "'" or prefix == "$'":
        return "'" not in line
    if prefix == '"':
        return not _DQ_ACTIVE.search(line)
    if prefix == "`":
        return "`" not in line
    return False


def _line_starts(lines: list[str]):
    """For each physical line in turn: the quoting stack it starts in when
    an earlier line left a string, a command substitution or backticks open
    (None at top level and in heredoc bodies, which are not code). The
    stack is live: read it before taking the next line."""
    stack: list = []
    pending: list = []
    n, k = len(lines), 0
    while k < n:
        if pending and (not stack or stack[-1][0] == SUB):
            # a newline outside quotes: the heredoc bodies follow
            delimiter, dash = pending.pop(0)
            while k < n:
                text = lines[k]
                yield None
                k += 1
                if (text.lstrip("\t") if dash else text) == delimiter:
                    break
            continue
        yield stack or None
        pending.extend(_track(lines[k], stack))
        k += 1

# ── entry points ────────────────────────────────────────────────────────────

def scan_shell(text: str, found: list | None = None) -> list[Finding]:
    """The findings in `text`, by line: all of them, or the first
    FINDINGS_MAX found (the decision is the same; a dense input stops
    early). Raises ScanLimit on quoted code nested deeper than MAX_DEPTH
    (or than Python's recursion limit allows), rescanned beyond
    RESCAN_FACTOR x the text, or read a second time (below) beyond
    REOPEN_MAX bytes. The guard confirms on a ScanLimit, unless something
    was found before it: `found`, when given, receives each finding as it
    is found (in scan order), so the caller still has them when the scan
    raises, and takes the finding action on them (block, or confirm per
    guard_shell_rule: never weaker than a complete scan with those findings;
    in the default mode a known finding is never let through a confirm that
    host policy may approve).

    Each logical line is read twice when an earlier line left a string or
    backticks open (a command substitution alone reads as top-level code):
    from a fresh quoting (so a mis-tracked quote can't hide a line) and
    with that quoting reopened (so a line like `done'; rm -rf $X`, after a
    string that ran across lines, is read as bash reads it). Both
    readings' findings count, once each. The second reading is skipped
    where it can't differ: a line inside one string (or backticks) that
    doesn't end it or change how its content reads."""
    out: list[Finding] = [] if found is None else found
    try:
        _scan(text, out)
    except RecursionError:  # "$( nested hundreds deep: the extent search recurses
        raise ScanLimit("quoted code nested too deeply") from None
    out.sort(key=lambda f: f.line)
    del out[FINDINGS_MAX:]
    return out


def _scan(text: str, out: list[Finding]) -> None:
    lines = text.split("\n")
    budget = [int(RESCAN_FACTOR * len(text)) + RESCAN_SLACK]
    reopen = REOPEN_MAX
    starts = _line_starts(lines) if len(lines) > 1 and _OPENS.search(text) else None
    taken, stack = 0, None  # lines taken from `starts`; the last one's stack
    for line, logical in _logical_lines(lines):
        first = len(out)
        _scan_line(logical, line, out, 0, budget)
        if starts is not None:
            while taken < line:
                stack = next(starts)
                taken += 1
        prefix = ""
        if stack and len(out) < FINDINGS_MAX:
            budget[0] -= len(stack)  # reopening walks the stack
            if budget[0] < 0:
                raise ScanLimit("quoted code rescanned too often")
            prefix = _reopen(stack)
        if prefix and not _same_reading(prefix, logical):
            reopen -= len(logical)
            if reopen < 0:
                raise ScanLimit("too much text inside quoting carried across lines")
            reopened: list[Finding] = []
            try:
                _scan_line(prefix + logical, line, reopened, 0, budget)
            finally:  # kept when this reading stops at a limit too
                if reopened:
                    fresh = Counter(out[first:])
                    for f in reopened:
                        if fresh[f]:
                            fresh[f] -= 1
                        else:
                            out.append(f)
        if len(out) >= FINDINGS_MAX:
            break
    if "<<" in text and len(out) < FINDINGS_MAX:
        _heredocs(lines, out)


_SHELL_SUFFIXES = (".sh", ".bash", ".zsh", ".ksh")
_SHELLS = frozenset({"sh", "bash", "zsh", "ksh", "dash", "ash", "mksh"})


def is_shell_script(path, text) -> bool:
    """A shell script by its name (.sh .bash .zsh .ksh, any case) or by a
    shebang naming a shell (directly or through env)."""
    if isinstance(path, str) and path.lower().endswith(_SHELL_SUFFIXES):
        return True
    if not isinstance(text, str) or not text.startswith("#!"):
        return False
    words = text[2:256].split("\n", 1)[0].split()
    if not words:
        return False
    program = words[0].rsplit("/", 1)[-1]
    if program == "env":
        rest = [w for w in words[1:] if not w.startswith("-") and "=" not in w]
        program = rest[0].rsplit("/", 1)[-1] if rest else ""
    return program in _SHELLS
