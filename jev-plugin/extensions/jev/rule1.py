"""rule1 — the rule-1 guard's scanner (fleet safety rule 1: scripts and file
content are written with the write/edit tools, never generated inside a
shell call; an `rm -rf /*` incident came from such a script).

scan_rule1(text) lists the shapes rule 1 forbids, at COMMAND level only
(outside quotes, comments, arithmetic and heredoc bodies):

  H1 heredoc        `<<WORD`, `<<-WORD` (the word quoted or not)
  H2 here-string    `<<<`
  E1 in-place edit  sed/gsed with -i, -i<suffix>, a cluster holding i, or
                    --in-place (and its abbreviations); perl with an option
                    cluster holding i (-i, -pi, -i.bak, -0pi ...)
  S1 stdin script   python[N[.M]] with `-` (or /dev/stdin) as the script,
                    or with no script while its stdin is fed (a pipe, a
                    heredoc, a here-string, a `<` file other than
                    /dev/null); a shell (sh bash dash zsh ksh ash mksh)
                    with -s or `-`, or with no script while fed
  S2 long inline    python -c (-B -c, -Bc, -I -S -c ...) whose code holds
     python         a newline or is over S2_MAX_CHARS characters

COMMAND level is what this tokenizer reads as code: the top level, the
bodies of $(...), `...`, <(...), >(...) (also inside double quotes),
subshells and ${...} words. Wrappers (sudo, env, timeout, nice, setsid,
taskset, xargs, command, exec ...) and find -exec are unwrapped. DESCENT:
the -c string of a shell, ssh's remote command, eval's arguments and the
command strings of env -S, flock -c, watch, su/runuser -c and script -c
are scanned again as scripts of their own (at most MAX_DESCENT deep);
their hits carry the line of the outer command. Backtick bodies are read
in place, without undoing bash's backtick escapes (an approximation: an
escaped inner backtick is read as data).

A stdin feed reaches the commands of a `( ... )` group: a pipe into the
group, or a redirect after it (`( python3 ) < f`). It does not reach the
inner commands of a `{ ...; }` group or a loop (a documented miss: only
the first command of a piped brace group is seen as fed).

The tokenizer follows worker V's rule-1 counter (r10/rule1-counts.py, the
corpus numbers in the proposal), hardened for the guard: no recursion past
MAX_DEPTH, descents within a rescan budget (RESCAN_FACTOR x the text +
RESCAN_SLACK), at most HITS_MAX hits (one is enough to decide). Past a
limit it raises Rule1Limit (its own class: never read as a BLOCK-rule
ScanLimit), with the hits made before it in `found` when the caller passes
a list.

Pure: no I/O, no model, never executes anything. Hits carry fixed tokens
(the family's operator or the command name and option), never text.
"""

from __future__ import annotations

import bisect
import re
from typing import NamedTuple


class Rule1Limit(ValueError):
    """A text past one of the rule-1 scan's shape limits (nesting, descent,
    the re-read budget). Its message is one of the fixed texts below, never
    input text. Not a shell_rules.ScanLimit, on purpose."""


FAMILIES = ("H1", "H2", "E1", "S1", "S2")
MAX_DEPTH = 64          # nested code (quotes, $( ), ` `, ( ), ${ }) including descents
MAX_DESCENT = 8         # a -c string inside a -c string ...
RESCAN_FACTOR = 1.5     # descended text read again, as a share of the text
RESCAN_SLACK = 64 * 1024
HITS_MAX = 256
S2_MAX_CHARS = 200


class Hit(NamedTuple):
    family: str     # H1 H2 E1 S1 S2
    token: str      # a fixed shape: "<<", "<<-", "<<<", "sed -i", "python3 -c" ...
    line: int       # 1-based line in the scanned text (the outer command's for a descent)
    descent: bool   # found in a -c string, ssh command or eval argument


class _Enough(Exception):
    """HITS_MAX reached: the scan stops (not a limit; the hits decide)."""


OPAQUE = "\x00"  # an expansion inside a word; NUL never reaches a command (the text's own are blanked)
CODE_STOP = frozenset(" \t\r\n;&|()<>")
PLAIN = re.compile(r"[^ \t\r\n;&|()<>'\"`\\$]+")
DQ_PLAIN = re.compile(r'[^\\"$`]+')
NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]")
REDIR = re.compile(r"(\d+|&)?(<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)")
ASSIGN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=")
PARENS = re.compile(r"[()]")
ANSI_SPECIAL = re.compile(r"[\\']")
ANSI_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", "'": "'", '"': '"', "a": "\a", "e": "\x1b",
                "E": "\x1b", "v": "\v", "f": "\f", "b": "\b"}
PREFIX_WORDS = frozenset({"if", "then", "else", "elif", "do", "while", "until", "!", "{", "time"})
PY = re.compile(r"python(?:[0-9]+(?:\.[0-9]+)*t?)?")
SHELLS = frozenset({"sh", "bash", "zsh", "ksh", "dash", "ash", "mksh"})
STDIN_PATHS = frozenset({"-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"})
FIND_EXEC = frozenset({"-exec", "-execdir", "-ok", "-okdir"})
SED_ARG = frozenset({"-e", "-f", "-l", "--expression", "--file", "--line-length"})
SSH_ARG = frozenset("bcDEeFIiJLlmOopQRSWw")
# wrapper: (options that take the next word, positional words before the command, takes VAR=x)
WRAPPERS = {
    "sudo": (frozenset({"-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"}), 0, False),
    "doas": (frozenset({"-u", "-C"}), 0, False),
    "env": (frozenset({"-u", "-C", "-S", "--unset", "--chdir", "--split-string"}), 0, True),
    "nohup": (frozenset(), 0, False),
    "exec": (frozenset({"-a"}), 0, False),
    "command": (frozenset(), 0, False),
    "builtin": (frozenset(), 0, False),
    "time": (frozenset(), 0, False),
    "nice": (frozenset({"-n", "--adjustment"}), 0, False),
    "timeout": (frozenset({"-s", "-k", "--signal", "--kill-after"}), 1, False),
    "setsid": (frozenset(), 0, False),
    "stdbuf": (frozenset({"-i", "-o", "-e"}), 0, False),
    "taskset": (frozenset(), 1, False),
    "ionice": (frozenset({"-c", "-n", "-p", "-P", "-u"}), 0, False),
    "chrt": (frozenset(), 1, False),
    "xargs": (frozenset({"-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "--max-args", "--max-procs",
                         "--delimiter", "--arg-file", "--replace"}), 0, False),
    "flock": (frozenset({"-w", "-E", "--timeout", "--conflict-exit-code"}), 1, False),
    "watch": (frozenset({"-n", "--interval"}), 0, False),
    "heavy1": (frozenset({"--lease", "--cancel"}), 0, False),
}
INPUT_OPS = {"<<": "heredoc", "<<-": "heredoc", "<<<": "herestring", "<": "file", "<>": "file", "<&": "file"}
FED = frozenset({"heredoc", "herestring", "file", "pipe"})


class W(str):
    """A dequoted word (expansions as OPAQUE) and its source span."""
    __slots__ = ("start", "end")


def _word(value: str, start: int, end: int) -> W:
    w = W(value)
    w.start, w.end = start, end
    return w


def _basename(v: str) -> str:
    return v.rsplit("/", 1)[-1]


def _skip_wrapper(name: str, argv: list, spec, strings: list) -> list:
    """The words after a wrapper's options and positionals. A command
    STRING the wrapper runs (env -S, flock -c, watch) goes to `strings`, to
    be scanned as a script of its own."""
    with_arg, positionals, assignments = spec
    k = 0
    while k < len(argv):
        a = argv[k]
        if a == "--":
            k += 1
            break
        if a.startswith("-") and len(a) > 1:
            if name == "env":
                if a in ("-S", "--split-string") and k + 1 < len(argv):
                    strings.append(argv[k + 1])
                elif a.startswith("--split-string="):
                    strings.append(a.split("=", 1)[1])
                elif a.startswith("-S") and len(a) > 2:
                    strings.append(a[2:])
            k += 2 if a in with_arg else 1
            continue
        if assignments and ASSIGN.match(a):
            k += 1
            continue
        break
    rest = argv[k + positionals:]
    if name == "flock" and rest and rest[0] in ("-c", "--command"):
        if len(rest) > 1:
            strings.append(rest[1])
        return []
    if name == "watch" and rest:
        strings.append(" ".join(rest))  # watch runs its words through sh -c
    return rest


def _unwrap(argv: list, strings: list) -> tuple[list, bool]:
    """The command under its wrappers, and whether xargs runs it (xargs
    appends arguments and gives it /dev/null as stdin: never "no script")."""
    via_xargs = False
    for _ in range(16):
        if not argv:
            break
        name = _basename(argv[0])
        spec = WRAPPERS.get(name)
        if spec is None:
            break
        via_xargs = via_xargs or name == "xargs"
        argv = _skip_wrapper(name, argv[1:], spec, strings)
    return argv, via_xargs


def _resolve(words: list, strings: list) -> list:
    """(argv, via_xargs, is_main) for each command a simple command runs:
    the command after assignments and wrappers, plus find -exec commands.
    Command strings run by wrappers go to `strings`."""
    k = 0
    while k < len(words) and ASSIGN.match(words[k]):
        k += 1
    out = []
    argv, via = _unwrap(words[k:], strings)
    if argv:
        out.append((argv, via, True))
        if _basename(argv[0]) == "find":
            j = 1
            while j < len(argv):
                if argv[j] in FIND_EXEC:
                    e = j + 1
                    sub = []
                    while e < len(argv) and argv[e] not in (";", "+"):
                        sub.append(argv[e])
                        e += 1
                    sub, sub_via = _unwrap(sub, strings)
                    if sub:
                        out.append((sub, sub_via, False))
                    j = e
                j += 1
    return out


def _py_mode(args: list):
    """('dash'|'c'|'module'|'info'|'script'|'noscript', code or None)."""
    k = 0
    while k < len(args):
        a = args[k]
        if a in STDIN_PATHS:
            return "dash", None
        if a == "--":
            if k + 1 < len(args):
                return ("dash" if args[k + 1] in STDIN_PATHS else "script"), None
            return "noscript", None
        if a.startswith("--"):
            if a in ("--version", "--help", "--help-env", "--help-xoptions", "--help-all"):
                return "info", None
            k += 2 if a == "--check-hash-based-pycs" else 1
            continue
        if a.startswith("-") and len(a) > 1:
            letters = a[1:]
            for idx, ch in enumerate(letters):
                if ch == "c":
                    rest = letters[idx + 1:]
                    if rest:
                        return "c", _word(rest, a.start, a.end) if isinstance(a, W) else rest
                    return "c", args[k + 1] if k + 1 < len(args) else None
                if ch == "m":
                    return "module", None
                if ch in "Vh?":
                    return "info", None
                if ch in "WXQ":
                    if idx == len(letters) - 1:
                        k += 1
                    break
            k += 1
            continue
        return "script", None
    return "noscript", None


def _sh_mode(args: list):
    """('c'|'s'|'dash'|'info'|'script'|'noscript', index of the -c string)."""
    k, mode = 0, None
    while k < len(args):
        a = args[k]
        if a == "-":
            return "dash", k
        if a == "--":
            k += 1
            break
        if a in ("--rcfile", "--init-file"):
            k += 2
            continue
        if a in ("--version", "--help"):
            return "info", k
        if a.startswith("--"):
            k += 1
            continue
        if (a.startswith("-") or a.startswith("+")) and len(a) > 1:
            letters = a[1:]
            if a.startswith("-") and "c" in letters and mode is None:
                mode = "c"
            elif a.startswith("-") and "s" in letters and mode is None:
                mode = "s"
            if letters[-1] in "oO":
                k += 1
            k += 1
            continue
        break
    if mode:
        return mode, k
    if k < len(args):
        return ("dash" if args[k] in STDIN_PATHS else "script"), k
    return "noscript", k


def _sed_in_place(args: list) -> str | None:
    k = 0
    while k < len(args):
        a = args[k]
        if a == "--":
            return None
        if a in SED_ARG:
            k += 2
            continue
        if a.startswith("--") and len(a) > 2:
            name = a.split("=", 1)[0]
            if len(name) >= 3 and "--in-place".startswith(name):
                return "sed --in-place"
        elif re.fullmatch(r"-[nrEsuzb]*i.*", a, re.S):
            return "sed -i"
        k += 1
    return None


def _perl_in_place(args: list) -> bool:
    k = 0
    while k < len(args):
        a = args[k]
        if a == "--" or not a.startswith("-") or a == "-":
            return False
        takes = False
        for ch in a[1:]:
            if ch == "i":
                return True
            if ch in "eEMmIFxCdD":
                takes = ch in "eE" and a.endswith(ch)
                break
        k += 2 if takes else 1
    return False


def _command_string(args: list):
    """The -c / --command string of su, runuser or script, or None."""
    for k, a in enumerate(args):
        if a in ("-c", "--command") and k + 1 < len(args):
            return args[k + 1]
        if a.startswith("--command="):
            return a.split("=", 1)[1]
    return None


class _Scan:
    """State shared by a scan and its descents."""
    __slots__ = ("found", "budget", "depth", "hits_max", "on_command")

    def __init__(self, found: list, budget: int) -> None:
        self.found = found
        self.budget = budget
        self.depth = 0
        self.hits_max = HITS_MAX
        # access.scan_access's visitor: called with (parser, cmd) for each
        # simple command, before rule 1's own checks; None for rule 1 alone
        self.on_command = None


class _Cmd:
    __slots__ = ("words", "redirs", "pipe_in", "start", "group", "collector")

    def __init__(self, pipe_in: bool, collector) -> None:
        self.words = []     # W values (expansions as OPAQUE)
        self.redirs = []    # (op, fd, target, offset)
        self.pipe_in = pipe_in
        self.start = None   # offset of the command's first token
        self.group = None   # S1 candidates of a ( ... ) group this command is
        self.collector = collector  # where unfed candidates go (the enclosing group), or None


class _Parser:
    def __init__(self, s: str, scan: _Scan, descent: int, line: int | None, remote: bool = False) -> None:
        self.s, self.n = s, len(s)
        self.scan = scan
        self.descent = descent
        self.remote = remote  # ssh's remote command (or code nested in one)
        self.line = line  # a descent's hits take the outer command's line
        self.pending: list = []
        self._nl = None

    def run(self) -> None:
        self.scan.budget -= self.n
        if self.scan.budget < 0:
            raise Rule1Limit("descended code read again too often")
        self.parse_list(0, None, False, None)

    def line_at(self, offset: int) -> int:
        if self.line is not None:
            return self.line
        if self._nl is None:
            self._nl = [m.start() for m in re.finditer("\n", self.s)]
        return bisect.bisect_left(self._nl, offset) + 1

    def enter(self) -> None:
        self.scan.depth += 1
        if self.scan.depth > MAX_DEPTH:
            raise Rule1Limit("code nested too deeply")

    def leave(self) -> None:
        self.scan.depth -= 1

    def hit(self, family: str, token: str, offset: int) -> None:
        self.scan.found.append(Hit(family, token, self.line_at(offset), self.descent > 0))
        if len(self.scan.found) >= self.scan.hits_max:
            raise _Enough()

    # ── code
    def parse_list(self, i: int, stop, inherit: bool, collector) -> int:
        """Commands up to `stop` (")" or "`", None: the end). `inherit`: the
        list's stdin is fed (a pipe into a ( ) group); `collector`: the
        group's list of unfed S1 candidates (a redirect after the group
        feeds them)."""
        self.enter()
        try:
            return self._parse_list(i, stop, inherit, collector)
        finally:
            self.leave()

    def _parse_list(self, i: int, stop, inherit: bool, collector) -> int:
        s, n = self.s, self.n
        cmd = _Cmd(inherit, collector)
        while i < n:
            c = s[i]
            if c == " " or c == "\t" or c == "\r":
                i += 1
                continue
            if c == "\n":
                self.finish(cmd)
                cmd = _Cmd(inherit, collector)
                i += 1
                if self.pending:
                    i = self.bodies(i)
                continue
            if c == "#":
                j = s.find("\n", i)
                i = n if j < 0 else j
                continue
            if c == ";":
                self.finish(cmd)
                cmd = _Cmd(inherit, collector)
                i += 1
                continue
            if c == "&":
                if s.startswith("&>", i):
                    i = self.redirect(cmd, i)
                    continue
                self.finish(cmd)
                cmd = _Cmd(inherit, collector)
                i += 2 if s.startswith("&&", i) else 1
                continue
            if c == "|":
                if s.startswith("||", i):
                    self.finish(cmd)
                    cmd = _Cmd(inherit, collector)
                    i += 2
                    continue
                self.finish(cmd)
                cmd = _Cmd(True, collector)
                i += 2 if s.startswith("|&", i) else 1
                continue
            if c == "(":
                if s.startswith("((", i) and (not cmd.words or (len(cmd.words) == 1 and cmd.words[0] == "for")):
                    if cmd.start is None:
                        cmd.start = i
                    i = self.arith_end(i + 2)
                    continue
                if not cmd.words and not cmd.redirs and cmd.group is None:
                    # a ( ... ) group: its commands share the group's stdin
                    if cmd.start is None:
                        cmd.start = i
                    cmd.group = []
                    i = self.parse_list(i + 1, ")", cmd.pipe_in, cmd.group)
                    continue
                self.finish(cmd)
                cmd = _Cmd(inherit, collector)
                i = self.parse_list(i + 1, ")", False, None)
                continue
            if c == ")":
                self.finish(cmd)
                if stop == ")":
                    return i + 1
                cmd = _Cmd(inherit, collector)
                i += 1
                continue
            if c == "`" and stop == "`":
                self.finish(cmd)
                return i + 1
            if c == "<" or c == ">":
                if i + 1 < n and s[i + 1] == "(":
                    if cmd.start is None:
                        cmd.start = i
                    i = self.parse_list(i + 2, ")", False, None)
                    cmd.words.append(_word(OPAQUE, i, i))
                    continue
                i = self.redirect(cmd, i)
                continue
            if c.isdigit():
                m = REDIR.match(s, i)
                if m and m.group(1):
                    i = self.redirect(cmd, i)
                    continue
            start = i
            value, quoted, i = self.word(i, stop)
            if i == start:  # cannot happen; never loop
                i += 1
                continue
            if not value and not quoted:  # a line continuation only
                continue
            if not cmd.words and not quoted and value in PREFIX_WORDS:
                continue
            if cmd.start is None:
                cmd.start = start
            cmd.words.append(_word(value, start, i))
        self.finish(cmd)
        return n

    def bodies(self, i: int) -> int:
        s, n = self.s, self.n
        for delim, dash in self.pending:
            while i < n:
                j = s.find("\n", i)
                line = s[i:] if j < 0 else s[i:j]
                i = n if j < 0 else j + 1
                if (line.lstrip("\t") if dash else line) == delim:
                    break
        self.pending = []
        return i

    def arith_end(self, i: int) -> int:
        s, n = self.s, self.n
        depth = 2
        while i < n:
            m = PARENS.search(s, i)
            if not m:
                return n
            depth += 1 if m.group() == "(" else -1
            i = m.end()
            if depth <= 0:
                return i
        return n

    # ── words
    def word(self, i: int, stop):
        s, n = self.s, self.n
        parts: list = []
        quoted = False
        while i < n:
            c = s[i]
            if c in CODE_STOP:
                break
            if c == "`":
                if stop == "`":
                    break
                i = self.parse_list(i + 1, "`", False, None)
                parts.append(OPAQUE)
                continue
            if c == "\\":
                if s.startswith("\n", i + 1):
                    i += 2
                    continue
                parts.append(s[i + 1:i + 2])
                quoted = True
                i += 2
                continue
            if c == "'":
                j = s.find("'", i + 1)
                j = n if j < 0 else j
                parts.append(s[i + 1:j])
                quoted = True
                i = j + 1
                continue
            if c == '"':
                i = self.dq(i + 1, parts)
                quoted = True
                continue
            if c == "$":
                if s[i + 1:i + 2] in ("'", '"'):
                    quoted = True
                i = self.dollar(i, parts, False)
                continue
            m = PLAIN.match(s, i)
            parts.append(m.group())
            i = m.end()
        return "".join(parts), quoted, i

    def dq(self, i: int, parts: list) -> int:
        self.enter()
        try:
            return self._dq(i, parts)
        finally:
            self.leave()

    def _dq(self, i: int, parts: list) -> int:
        s, n = self.s, self.n
        while i < n:
            m = DQ_PLAIN.match(s, i)
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
                if nxt in ('"', "\\", "$", "`"):
                    parts.append(nxt)
                elif nxt != "\n":
                    parts.append("\\" + nxt)
                i += 2
                continue
            if c == "`":
                i = self.parse_list(i + 1, "`", False, None)
                parts.append(OPAQUE)
                continue
            i = self.dollar(i, parts, True)
        return n

    def dollar(self, i: int, parts: list, in_dq: bool) -> int:
        s, n = self.s, self.n
        nxt = s[i + 1:i + 2]
        if s.startswith("$((", i):
            parts.append(OPAQUE)
            return self.arith_end(i + 3)
        if nxt == "(":
            parts.append(OPAQUE)
            return self.parse_list(i + 2, ")", False, None)
        if nxt == "{":
            parts.append(OPAQUE)
            return self.brace_end(i + 2)
        if nxt == "'" and not in_dq:
            j, out = i + 2, []
            while True:
                m = ANSI_SPECIAL.search(s, j)
                if not m:
                    out.append(s[j:])
                    j = n
                    break
                out.append(s[j:m.start()])
                if m.group() == "\\":
                    esc = s[m.start() + 1:m.start() + 2]
                    out.append(ANSI_ESCAPES.get(esc, "\\" + esc))
                    j = m.start() + 2
                    continue
                j = m.start() + 1
                break
            parts.append("".join(out))
            return j
        if nxt == '"' and not in_dq:
            return self.dq(i + 2, parts)
        if nxt == "[":
            j = s.find("]", i + 2)
            parts.append(OPAQUE)
            return n if j < 0 else j + 1
        m = NAME.match(s, i + 1)
        if m:
            parts.append(OPAQUE)
            return m.end()
        parts.append("$")
        return i + 1

    def brace_end(self, i: int) -> int:
        self.enter()
        try:
            return self._brace_end(i)
        finally:
            self.leave()

    def _brace_end(self, i: int) -> int:
        s, n = self.s, self.n
        depth = 1
        while i < n:
            c = s[i]
            if c == "}":
                depth -= 1
                i += 1
                if depth == 0:
                    return i
            elif c == "{":
                depth += 1
                i += 1
            elif c == "\\":
                i += 2
            elif c == "'":
                j = s.find("'", i + 1)
                i = n if j < 0 else j + 1
            elif c == '"':
                i = self.dq(i + 1, [])
            elif c == "$":
                i = self.dollar(i, [], False)
            elif c == "`":
                i = self.parse_list(i + 1, "`", False, None)
            else:
                i += 1
        return n

    def redirect(self, cmd: _Cmd, i: int) -> int:
        s, n = self.s, self.n
        m = REDIR.match(s, i)
        if not m:  # a lone & or digit: never here
            return i + 1
        if cmd.start is None:
            cmd.start = i
        fd_text, op = m.group(1), m.group(2)
        at = m.start(2)
        if op in INPUT_OPS:
            fd = 0 if fd_text is None else (int(fd_text) if fd_text.isdigit() and len(fd_text) < 6 else -1)
        else:
            fd = 1
        i = m.end()
        while i < n and s[i] in " \t":
            i += 1
        start = i
        value, quoted, i = self.word(i, None)
        value = _word(value, start, i)  # with its source span (access reads $HOME targets)
        if op in ("<<", "<<-"):
            if value:
                self.pending.append((value, op == "<<-"))
            self.hit("H1", op, at)
        elif op == "<<<":
            self.hit("H2", op, at)
        cmd.redirs.append((op, fd, value, at))
        return i

    # ── one simple command
    def stdin(self, cmd: _Cmd) -> str | None:
        """What feeds the command's stdin: heredoc, herestring, file, pipe or None."""
        state = None
        for op, fd, target, _ in cmd.redirs:
            if fd != 0 or op not in INPUT_OPS:
                continue
            kind = INPUT_OPS[op]
            if op == "<" and target == "/dev/null":
                kind = "devnull"
            elif op == "<&" and target == "-":
                kind = "closed"
            state = kind
        if state is None and cmd.pipe_in:
            state = "pipe"
        return state

    def finish(self, cmd: _Cmd) -> None:
        state = self.stdin(cmd)
        fed = state in FED
        if cmd.group is not None:
            if fed:  # a redirect after the group (or a pipe into it) feeds its unfed interpreters
                for token, offset in cmd.group:
                    self.hit("S1", token, offset)
            elif state is None and cmd.collector is not None:
                cmd.collector.extend(cmd.group)
        if self.scan.on_command is not None:
            self.scan.on_command(self, cmd)
        if not cmd.words:
            return
        # an interpreter with no stdin of its own waits for its group's
        candidate = state is None and cmd.collector is not None
        strings: list = []
        resolved = _resolve(cmd.words, strings)
        first = cmd.words[0]
        at0 = first.start if isinstance(first, W) else (cmd.start or 0)
        for text in strings:
            self.descend(text, at0)
        for argv, via_xargs, _main in resolved:
            head = argv[0]
            if OPAQUE in head:
                continue
            name = _basename(head)
            args = argv[1:]
            at = head.start if isinstance(head, W) else (cmd.start or 0)
            if name in ("sed", "gsed"):
                token = _sed_in_place(args)
                if token:
                    self.hit("E1", token, at)
            elif name == "perl":
                if _perl_in_place(args):
                    self.hit("E1", "perl -i", at)
            elif PY.fullmatch(name):
                shown = name if len(name) <= 16 else "python"
                mode, code = _py_mode(args)
                if mode == "c":
                    if self.s2_long(code):
                        self.hit("S2", f"{shown} -c", at)
                elif mode == "dash":
                    self.hit("S1", f"{shown} -", at)
                elif mode == "noscript" and not via_xargs:
                    if fed:
                        self.hit("S1", f"{shown} (stdin)", at)
                    elif candidate:
                        cmd.collector.append((f"{shown} (stdin)", at))
            elif name in SHELLS:
                mode, k = _sh_mode(args)
                if mode == "s":
                    self.hit("S1", f"{name} -s", at)
                elif mode == "dash":
                    self.hit("S1", f"{name} -", at)
                elif mode == "noscript" and not via_xargs:
                    if fed:
                        self.hit("S1", f"{name} (stdin)", at)
                    elif candidate:
                        cmd.collector.append((f"{name} (stdin)", at))
                elif mode == "c" and k < len(args):
                    self.descend(args[k], at)
            elif name == "ssh":
                k = 0
                while k < len(args) and args[k].startswith("-") and len(args[k]) > 1:
                    a = args[k]
                    k += 2 if (len(a) == 2 and a[-1] in SSH_ARG) else 1
                if k + 1 < len(args):
                    self.descend(" ".join(args[k + 1:]), at, remote=True)
            elif name == "eval" and args:
                self.descend(" ".join(args), at)
            elif name in ("su", "runuser", "script"):
                text = _command_string(args)
                if text:
                    self.descend(text, at)

    def s2_long(self, code) -> bool:
        if code is None:
            return False
        if OPAQUE in code:
            # an expansion of unknown length: measure the word's source
            raw = self.s[code.start:code.end] if isinstance(code, W) else code
            return "\n" in raw or len(raw) > S2_MAX_CHARS
        return "\n" in code or len(code) > S2_MAX_CHARS

    def descend(self, text: str, at: int, remote: bool = False) -> None:
        if not text:
            return
        if self.descent >= MAX_DESCENT:
            raise Rule1Limit("scripts nested too deeply")
        line = self.line_at(at)
        _Parser(text.replace(OPAQUE, "x"), self.scan, self.descent + 1, line, self.remote or remote).run()


def scan_rule1(text: str, found: list | None = None) -> list[Hit]:
    """The rule-1 hits in one shell text, in the order found (at most
    HITS_MAX). Raises Rule1Limit past a limit; `found` (if given) then holds
    the hits made before it."""
    found = [] if found is None else found
    if not text:
        return found
    if OPAQUE in text:
        text = text.replace(OPAQUE, " ")
    scan = _Scan(found, int(len(text) * (1 + RESCAN_FACTOR)) + RESCAN_SLACK)
    try:
        _Parser(text, scan, 0, None).run()
    except _Enough:
        pass
    except RecursionError:
        raise Rule1Limit("code nested too deeply") from None
    return found


def pty_text(text: str) -> str:
    """A shell_send input as the shell reads it: CR (Enter) and the other
    control characters (Ctrl-C, Ctrl-U, Ctrl-D ... end or drop a line) as
    line ends; TAB kept."""
    text = text.replace("\r\n", "\n")
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "\n", text)
