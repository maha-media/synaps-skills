#!/usr/bin/env python3
"""The guard's deterministic shell-safety rule (guard item 2(b), after the
16:52 `rm -rf /*` incident): a BLOCK, with the fix in the reason, for

- rm -r / find -delete / mv operands that expand a variable without `:?`;
- recursive-rm and find -delete operands that are `/`, `/*`, `~` or $HOME;
- a heredoc opened inside another heredoc's body;
- (10-27 22:38, kill(-1, SIGKILL) ended the desktop session) a literal
  kill/pkill/killall/killall5 shape that signals every process the user
  may signal. TEXT ONLY: these tests read commands, nothing runs them.

It scans the WHOLE text (bash commands; the content of shell scripts given
to write, edit and multi_edit), not the model's preview, and makes no model
call. Offline: a fake client records any call.

    python3 -B -m unittest discover -s tests -p 'test_shell_rule.py' -v
"""
from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "extensions"))
sys.path.insert(0, HERE)

import jev_test_home  # noqa: F401,E402  (keeps the suite out of the real Allow-once store)
from jev import audit as audit_mod  # noqa: E402
from jev import guard  # noqa: E402
from jev import shell_rules  # noqa: E402
from jev.shell_rules import scan_shell  # noqa: E402

UNGUARDED, ROOT_OP, HOME_OP, NESTED = "unguarded_variable", "root_operand", "home_operand", "nested_heredoc"
SIGNAL_ALL = "signal_all"


def shape(findings):
    return [(f.rule, f.command, f.names) for f in findings]


# (shell text, expected rule, command, variable names)
UNGUARDED_RM = [
    ('rm -rf "$FS"/*', ("FS",)),
    ("rm -rf $FS/*", ("FS",)),
    ('rm -r "$X"', ("X",)),
    ('rm -R "${X}"', ("X",)),
    ('rm --recursive "$X"', ("X",)),
    ('rm --rec "$X"', ("X",)),
    ('rm -fr "$X"', ("X",)),
    ('rm -rfv -- "$X"', ("X",)),
    ('rm -r -f "$X"', ("X",)),
    ('rm "$X" -rf', ("X",)),
    ('/bin/rm -rf "$X"', ("X",)),
    ('/usr/bin/rm -rf "$X"', ("X",)),
    (r'\rm -rf "$X"', ("X",)),
    ('sudo rm -rf "$X"', ("X",)),
    ('timeout 5 rm -rf "$X"', ("X",)),
    ('rm -rf "${X:-}"', ("X",)),
    ('rm -rf "${X%/}"', ("X",)),
    ('rm -rf "${X}/sub"', ("X",)),
    ('rm -rf "${X?}"', ("X",)),
    ('rm -rf "$1"', ("1",)),
    ('rm -rf "$@"', ("@",)),
    ('rm -rf "/tmp/$USER/x"', ("USER",)),
    ('rm -rf a "$X"', ("X",)),
    ('rm -rf "${OK:?}" "$BAD"', ("BAD",)),
    ('rm -rf "$A/$B"', ("A", "B")),
    ('rm -rf "${OK:?}/$SUB"', ("SUB",)),
    ('cd /x && rm -rf "$X"', ("X",)),
    ('true; rm -rf "$X"', ("X",)),
    ('(rm -rf "$X")', ("X",)),
    ('if a; then rm -rf "$X"; fi', ("X",)),
    ('f() { rm -rf "$1"; }', ("1",)),
    ('x=$(rm -rf "$X")', ("X",)),
    ('rm -rf "$X" 2>/dev/null', ("X",)),
    ('rm -rf "$X" && echo done', ("X",)),
    ("trap 'rm -rf \"$tmp\"' EXIT", ("tmp",)),
    (r'bash -c "rm -rf \"\$X\""', ("X",)),
    ('git rm -r "$X"', ("X",)),
    ('rm -rf -- "-$X"', ("X",)),  # after --, a word starting with - is an operand
    # arrays (r1): the subscript is part of what the fix guards
    ('rm -rf "${arr[@]}"', ("arr[@]",)),
    ("rm -rf ${arr[*]}/x", ("arr[*]",)),
    ('rm -rf "${arr[0]}"', ("arr[0]",)),
    ('rm -rf "${arr[$i]}"', ("arr[$i]",)),
    ('rm -rf "${arr[@]:-}"', ("arr[@]",)),
    ('rm -rf "${arr[$((i + 1))]}"', ("arr[…]",)),  # a subscript that is not a name is not shown
    ('rm -rf "${arr[@]}" "${arr[0]:?}"', ("arr[@]",)),
]

UNGUARDED_FIND = [
    ('find "$D" -delete', ("D",)),
    ("find $D -name '*.o' -delete", ("D",)),
    ('find "${D}" -type f -exec rm -f {} +', ("D",)),
    (r'find "$D" -execdir rm -rf {} \;', ("D",)),
    ('find -L "$D" -delete', ("D",)),
    ('find "$D" -mindepth 1 -delete', ("D",)),
    ('find a "$D" -delete', ("D",)),
]

UNGUARDED_MV = [
    ('mv "$A" /tmp/x', ("A",)),
    ('mv /tmp/x "$B"', ("B",)),
    ('mv -t "$D" a b', ("D",)),
    ('mv --target-directory="$D" a', ("D",)),
    ('mv -vt "$D" a', ("D",)),
    ('mv -t"$D" a', ("D",)),
    ('mv -f "$A" "${B:?}"', ("A",)),
    ('mv "$f.tmp" "$f"', ("f",)),
]

ROOT_OPERANDS = ["rm -rf /", "rm -rf /*", "rm -rf --no-preserve-root /", 'rm -rf "/"', "rm -rf //",
                 "rm -rf /.", "rm -rf / tmp", "sudo rm -rf /*", "find / -delete", "find /* -delete"]
HOME_OPERANDS = ["rm -rf ~", "rm -rf ~/", "rm -rf ~/*", "rm -rf $HOME", 'rm -rf "$HOME"', 'rm -rf "${HOME}"',
                 'rm -rf "${HOME:?}"', 'rm -rf "${HOME:?}"/*', "rm -rf $HOME/", "find ~ -name x -delete",
                 'find "$HOME" -delete']

QUIET = [
    'rm -rf "${FS:?}"/*',
    'rm -rf "${D:?}/${name:?}.done" "${D:?}/${name:?}.h1rc"',
    'rm -rf -- "${X:?}"',
    'rm -rf "${1:?}"',
    'rm -rf "${X:?missing dir}"/sub',
    "rm -rf /var/tmp/synapscli-v/x",
    "rm -rf build/ ./target",
    'rm -rf "/tmp/x.$$"',
    'rm "$f"', 'rm -f "$f"', 'rm -i "$X"', 'rm -v -- "$X"', 'rm -fv "$X"',
    'rmdir "$X"', 'norm -rf "$X"', 'rm_old -rf "$X"', 'charm -r "$X"', 'grep -rf pats "$X"', "farm -r $X",
    'find "$D" -name x -print', 'find "${D:?}" -delete', "find . -delete", "find /var/tmp/synapscli-v/x -delete",
    'find "$D" -type f -exec grep -l x {} +',
    'mv "${A:?}" "${B:?}"', "mv a b", 'mv -t "${D:?}" "${F:?}"', 'mv -S "$SUF" a b', 'mv --suffix "$SUF" a b',
    "rm -rf ~/.cache/x", 'rm -rf "${HOME:?}/x"', 'rm -rf ./x > "$LOG"', 'mv a b 2> "$LOG"',
    '# rm -rf "$X"', 'ls  # then rm -rf "$X"', "echo 'done'",
    'echo "$X"', "rm -rf ./x  # cleanup of $X",
    # arrays guarded after the subscript (r1)
    'rm -rf "${arr[@]:?}"', 'rm -rf "${arr[*]:?}"/x', 'rm -rf "${arr[0]:?}"', 'rm -rf "${arr[$i]:?}"',
    'rm -rf "${arr[@]:?no dirs}"', 'find "${dirs[@]:?}" -delete', 'mv "${src[@]:?}" "${dst:?}"',
    'rm -rf "${#arr[@]}"',  # a length is not a path
    'rm -rf "${arr:?}[@]"',  # a guarded scalar, then a literal [@]
]

# (r1 finding 5) a command word spelled with quotes or backslashes, made of
# literal characters only, is the command bash runs: (text, rule, command, names)
SPELLED_COMMANDS = [
    ("'rm' -rf \"$X\"", UNGUARDED, "rm -r", ("X",)),
    ('"rm" -rf "$X"', UNGUARDED, "rm -r", ("X",)),
    ('r""m -rf "$X"', UNGUARDED, "rm -r", ("X",)),
    ("r''m -rf \"$X\"", UNGUARDED, "rm -r", ("X",)),
    (r'r\m -rf "$X"', UNGUARDED, "rm -r", ("X",)),
    (r'\rm -rf "$X"', UNGUARDED, "rm -r", ("X",)),
    ("'r'm -rf \"$X\"", UNGUARDED, "rm -r", ("X",)),
    ("r'm' -rf \"$X\"", UNGUARDED, "rm -r", ("X",)),
    ("$'rm' -rf \"$X\"", UNGUARDED, "rm -r", ("X",)),
    ('$"rm" -rf "$X"', UNGUARDED, "rm -r", ("X",)),
    ("'/bin/rm' -rf \"$X\"", UNGUARDED, "rm -r", ("X",)),
    ('"/usr/bin/"rm -rf "$X"', UNGUARDED, "rm -r", ("X",)),
    ("sudo 'rm' -rf \"$X\"", UNGUARDED, "rm -r", ("X",)),
    ("'rm'\"\" -rf \"$X\"", UNGUARDED, "rm -r", ("X",)),
    ("x=$('rm' -rf \"$X\")", UNGUARDED, "rm -r", ("X",)),
    ("trap '\"rm\" -rf \"$tmp\"' EXIT", UNGUARDED, "rm -r", ("tmp",)),
    ("'rm' -rf /", ROOT_OP, "rm -r", ()),
    ('"rm" -rf ~', HOME_OP, "rm -r", ()),
    ("'find' \"$D\" -delete", UNGUARDED, "find -delete", ("D",)),
    ("f''ind \"$D\" -delete", UNGUARDED, "find -delete", ("D",)),
    ('"find" / -delete', ROOT_OP, "find -delete", ()),
    ('"mv" "$A" b', UNGUARDED, "mv", ("A",)),
    (r'm\v "$A" b', UNGUARDED, "mv", ("A",)),
    # friction, as for the plain word (any word mv is a command)
    ('grep "mv" "$F"', UNGUARDED, "mv", ("F",)),
]
# not the word rm/find/mv once dequoted, or built with an expansion (a
# known miss: $RM, ${R}m)
QUIET_SPELLINGS = [
    "'rm'", '"rm" -i "$X"', "'rm' -f \"$X\"",
    '"$RM" -rf "$X"', '$RM -rf "$X"', '${R}m -rf "$X"', 'r"$m" -rf "$X"', 'r$(echo m) -rf "$X"',
    "'norm' -rf \"$X\"", "'rmdir' \"$X\"", '"r m" -rf "$X"', "'\\rm' -rf \"$X\"", r'\\rm -rf "$X"',
    "'rm\"\"x' -rf \"$X\"", '"rmx" -rf "$X"', "'farm' -r $X", '"mvx" "$A"', r'rm\ -rf "$X"', "rm$'x' -rf \"$X\"",
    "echo 'r'", 'x="" y=""', "printf '%s' \"\" ''",
    # letters glued after the closing quote make another word; an expansion
    # or an unknown ANSI-C escape between the letters is no rm; a word cut
    # at an escaped space is one word ("rm x")
    "'rm'x -rf \"$X\"", 'r$m -rf "$X"', "$'r\\m' -rf \"$X\"", r'rm\ x -rf "$X"',
    # quoted text after the letters up to the word's end is read with the
    # word: "rm"'\' is the word rm\ (the plain rm'\' keeps the glued
    # reading of the plain pattern: friction, bash runs no rm in either)
    "\"rm\"'\\' -rf \"$X\"",
]

NESTED_HEREDOCS = {
    "different delimiters": "cat > run.sh <<'EOF'\nset -euo pipefail\npython3 - <<'PY'\nprint(1)\nPY\nEOF\nbash run.sh\n",
    "same delimiter closes the outer early": "cat > run.sh <<EOF\npython3 - <<EOF\nprint(1)\nEOF\necho after\nEOF\n",
    "tab-stripped inner": "cat > run.sh <<'EOF'\nf() {\n\tcat <<-INNER\n\tx\n\tINNER\n}\nEOF\n",
    "inner on a pipeline": "bash <<'SH'\ncat <<'TXT' | wc -l\na\nTXT\nSH\n",
    # (r1 finding 3, as ruled) an opener in a body is a finding whether or
    # not its terminator follows: unterminated, it is left open in the
    # script written out
    "no inner terminator": "cat <<A\ncat <<B\nA\n",
    "reused delimiter, no terminator": "cat <<EOF\ncat <<EOF\nx\n",
    "inner terminator after the outer one": "cat > a.sh <<'OUT'\npython3 - <<'PY'\nOUT\nprint(1)\nPY\n",
    "quoted words": "cat <<'A'\ncat <<\"B\"\ncat <<-'C'\ncat << _d\ncat <<\\E\nA\n",
}
# the opener shape, as ruled: these are findings by design (friction)
NESTED_BY_SHAPE = {
    "c++ in a body": "cat > a.cc <<'CC'\nstd::cout << endl;\nstd::cout << \"x\" << y;\nCC\n",
    "repeated operators, no terminator": "x << y << z\n" * 200,
}

QUIET_HEREDOCS = {
    "sequential": "cat > a <<'A'\nx\nA\ncat > b <<'B'\ny\nB\n",
    "shift operator in a body": "python3 - <<'PY'\nx = 1 << 2\nprint(x << 3)\nmask = x<<2\nPY\n",
    "arithmetic in a body": "cat > a.sh <<'SH'\necho $((a << b))\n(( x <<= y ))\nlet \"x <<= y\"\nSH\n",
    "here-string in a body": "cat > a.sh <<'SH'\ncat <<< \"$x\"\ncat <<<word\nSH\n",
    "an opener word starting otherwise": "cat > a.sh <<'SH'\ncat <<1\ncat <<$X\ncat <<\nSH\n",
    "arithmetic before a heredoc": "echo $((1 << 2))\ncat <<'EOF'\nx\nEOF\n",
    "here-string": 'cat <<< "$x"\ncat <<EOF\ny\nEOF\n',
    "quoted operator": 'echo "use <<EOF"\necho EOF\ncat <<END\nz\nEND\n',
    "single-quoted operator": "echo 'use <<EOF'\necho EOF\ncat <<END\nz\nEND\n",
    "quoted operator in a body": "cat > a.sh <<'SH'\necho \"use <<EOF\"\necho 'or <<-EOF'\nSH\n",
    "dash heredocs in sequence": "cat <<-A\n\tx\n\tA\ncat <<-B\n\ty\n\tB\n",
    "two on one line": "paste <(cat <<A\n1\nA\n) <(cat <<B\n2\nB\n)\n",
    "comment": "# cat <<EOF inside a comment\necho hi\n",
    "comment, then a heredoc": "# cat <<A\ncat <<B\nx\nB\n",
    "comment in a body": "cat > a.sh <<'SH'\n# cat <<EOF\necho hi\nSH\n",
}

# The commands inside quoted code and substitutions are scanned, wherever
# they sit (an operand, a default value, a find test, a process substitution).
SUBSTITUTIONS = [
    ("x \"rm a $(echo $'a\\'b')\" ; rm -rf \"$X\"", ("X",)),  # $'..\'..' is one ANSI string
    ("rm a $(rm -rf $X)", ("X",)),
    ('rm "$(rm -rf $X)"', ("X",)),
    ('mv a "$(rm -rf $X)"', ("X",)),
    ("rm a `rm -rf $X`", ("X",)),
    ('rm -f "${Y:-$(rm -rf $X)}"', ("X",)),
    ('find . -name "$(rm -rf $X)" -print', ("X",)),
    ("cat <(rm -rf $X)", ("X",)),
    ("rm a <(rm -rf $X)", ("X",)),
    ('x=`echo a # b`; rm -rf "$X"', ("X",)),  # a comment inside backticks ends at the backtick
]
# A substitution's value used as an operand is opaque: not a variable.
QUIET_SUBSTITUTIONS = [
    'rm -rf "${D:?}/$(basename "${F:?}")"',
    'x "rm a $(echo b # )"',
    "rm -rf $(dirname /tmp/x)",
]

# Strings, substitutions and backticks that run across lines: a line that
# starts inside one is read both fresh and with the quoting carried from
# the lines before; heredoc bodies carry none. (text, [(line, names)])
ACROSS_LINES = [
    ("ssh host 'cd /x\nrm -f /tmp/y'; rm -rf $D\n", [(2, ("D",))]),
    ('git commit -m "fix: x\n\nRefs #123"; rm -rf $D\n', [(3, ("D",))]),
    ('git commit -m "fix\nCloses #12" && rm -rf "$T"\n', [(2, ("T",))]),
    ("echo 'a\nb #c'; rm -rf $Q\n", [(2, ("Q",))]),
    ("x='(\n)rm'; rm -rf $Q\n", [(2, ("Q",))]),  # the closing quote's line starts inside the string
    ("x=$(cd /x &&\n  ls) ; rm -rf $Y\n", [(2, ("Y",))]),
    ("x=`ls\n# y` ; rm -rf $Y\n", [(2, ("Y",))]),
    ("x=$'a\n#b'; rm -rf $Y\n", [(2, ("Y",))]),
    # a substitution inside a double-quoted string carried across lines runs
    # in bash, also after a `#` (its `$` makes the line read again)
    ('echo "a\n # $(rm -rf $S)\n"\n', [(2, ("S",))]),
    # escapes inside the carried quoting
    ("x=$'it\\'s\nb \\' # c'; rm -rf $Y\n", [(2, ("Y",))]),
    ("x=`echo \\n` 'a\nb # c'; rm -rf $Z\n", [(2, ("Z",))]),
    ('git commit -m "say \\"hi\nRefs #1"; rm -rf $D\n', [(2, ("D",))]),
    # quoting nested in quoting
    ("x=\"$(echo 'a\nb # c')\"; rm -rf $Z\n", [(2, ("Z",))]),
    ("x=\"`echo '\"'`\nb # c\"; rm -rf $Z\n", [(2, ("Z",))]),  # a backtick hides its quotes
    ("sh -c '\nrm -rf $X\n'\n", [(2, ("X",))]),
    ("sh -c 'a\nrm -rf $X'; rm -rf $Y\n", [(2, ("X",)), (2, ("Y",))]),
    ('bash -c "\n  rm -rf \\$X\n"\n', [(2, ("X",))]),
    ("echo 'rm -rf $X\n'\n", [(1, ("X",))]),  # quoted text is scanned as code (README friction)
    ("x=\"$(cat <<'EOF'\nit's\nEOF\n)\"; rm -rf $X\n", [(4, ("X",))]),
    # heredoc bodies carry no quoting
    ("cat <<EOF\nit's\nEOF\nrm -rf $X\n", [(4, ("X",))]),
    ("cat <<'EOF'\ndon't\nEOF\necho 'a\nb # c'; rm -rf $Z\n", [(5, ("Z",))]),
    ('cat <<EOF "a\nb"\nline\nEOF\nrm -rf $W\n', [(5, ("W",))]),
    # a heredoc body starts at the first newline outside quotes, also inside $( )
    ('cat <<EOF "a\nb"\nit\'s\nEOF\necho \'a\nb # c\'; rm -rf $Z\n', [(6, ("Z",))]),
    ("x=$(cat <<'EOF'\nit's\nEOF\n)\necho 'a\nb # c'; rm -rf $Z\n", [(6, ("Z",))]),
    ("cat <<-EOF\n\tit's\n\tEOF\necho 'a\nb # c'; rm -rf $Z\n", [(5, ("Z",))]),
    # comments and arithmetic open no quoting
    ("# don't\necho 'a\nb # c'; rm -rf $Z\n", [(3, ("Z",))]),
    ("echo $((1 << 2))\necho 'a\nb # c'; rm -rf $Z\n", [(3, ("Z",))]),
    ("(( n = 1 << 2 ))\necho 'a\nb # c'; rm -rf $Z\n", [(3, ("Z",))]),
]
QUIET_ACROSS_LINES = [
    "python3 -c '\nimport os\nos.remove(\"x\")  # rm\n'\nrm -rf \"${OK:?}\"\n",
    "echo \"it's\nfine\" # don't rm -rf $X\n",
    "# don't\nrm -rf \"${OK:?}\"\n",
    "cat <<'EOF'\nit's\nEOF\nrm -rf \"${OK:?}\"\n",
    # a closed string carries nothing: `it's` after the comment is not a quote
    "echo 'a'\necho b # it's rm -rf $X\n",
    # a comment inside a substitution carried across lines (bash runs no rm
    # here); the parens inside the substitution are counted
    "x=\"$(echo $(date) 'a\nb' # x)\"; rm -rf $Z\n)\"\n",
    "x=\"$( (true) ; echo 'a\nb' # x)\"; rm -rf $Z\n)\"\n",
    "x=\"$( (echo 'a\nb') # x)\"; rm -rf $Z\n)\"\n",
]


# (10-27 22:38: a test binary called kill(-1, SIGKILL) and ended JR's whole
# desktop session.) Literal shapes that signal every process the user may
# signal: (shell text, command). Text only: nothing here is ever run.
SIGNAL_ALL_SHAPES = [
    # a pid operand of literal -1, after bash's and util-linux's option parsing
    ("kill -9 -1", "kill"),
    ("kill -- -1", "kill"),
    ("kill -s KILL -1", "kill"),
    ("kill -n 9 -1", "kill"),
    ("kill --signal KILL -1", "kill"),
    ("kill -KILL -1", "kill"),
    ("kill -SIGTERM -1", "kill"),
    ("kill -sKILL -1", "kill"),
    ("kill -1 -1", "kill"),  # the first -1 is SIGHUP, the second the pid
    ("kill 123 -1", "kill"),
    ("kill -9 -- -1", "kill"),
    ("kill -s KILL -s TERM -1", "kill"),
    ("kill -9 -01", "kill"),
    ("kill -9 -0001", "kill"),
    ("kill -9 123 -1 456", "kill"),
    # the operand quoted
    ('kill -9 "-1"', "kill"),
    ("kill -9 '-1'", "kill"),
    (r"kill -9 \-1", "kill"),
    ('kill -9 -"1"', "kill"),
    ('kill "-9" "-1"', "kill"),
    # the command word spelled as rm's can be
    ("/bin/kill -9 -1", "kill"),
    ("/usr/bin/kill -9 -1", "kill"),
    (r"\kill -9 -1", "kill"),
    ("'kill' -9 -1", "kill"),
    ('"kill" -9 -1', "kill"),
    ('k""ill -9 -1', "kill"),
    (r"k\ill -9 -1", "kill"),
    ("$'kill' -9 -1", "kill"),
    ("'/bin/kill' -9 -1", "kill"),
    ("kill'' -9 -1", "kill"),
    # kill is a prefix of killall and killall5: a quote glued after it may
    # spell the longer name (bash reads kill'all'5 as killall5)
    ("kill'all'5", "killall5"),
    ('kill"all"5 -9', "killall5"),
    ("kill'all' -u jr", "killall -u"),
    ("/sbin/kill\"all\"5", "killall5"),
    ('killall"5"', "killall5"),
    ("kill'-9' -1", "kill"),  # a glued quoted argument is still kill's
    # after a command runner
    ("sudo kill -9 -1", "kill"),
    ("sudo -u jr kill -9 -1", "kill"),
    ("env kill -9 -1", "kill"),
    ("command kill -9 -1", "kill"),
    ("builtin kill -9 -1", "kill"),
    ("timeout 5 kill -9 -1", "kill"),
    ("nice -n 5 kill -9 -1", "kill"),
    ("nohup kill -9 -1 &", "kill"),
    # where it stands
    ("bash -c 'kill -9 -1'", "kill"),
    ('sh -c "kill -9 -1"', "kill"),
    ("trap 'kill -9 -1' EXIT", "kill"),
    ("cat > stop.sh <<'EOF'\necho stopping\nkill -9 -1\nEOF\n", "kill"),
    ("x=$(kill -9 -1)", "kill"),
    ('echo "$(kill -9 -1)"', "kill"),
    ("echo `kill -9 -1`", "kill"),
    ("true && kill -9 -1", "kill"),
    ("false || kill -9 -1", "kill"),
    ("true; kill -9 -1", "kill"),
    ("echo x | kill -9 -1", "kill"),
    ("(kill -9 -1)", "kill"),
    ("{ kill -9 -1; }", "kill"),
    ("if x; then kill -9 -1; fi", "kill"),
    ("kill -9 -1 2>/dev/null", "kill"),
    ("kill -9 \\\n  -1", "kill"),  # a continued line
    # killall5 (any arguments): every process outside its own session
    ("killall5", "killall5"),
    ("killall5 -9", "killall5"),
    ("/sbin/killall5 -15", "killall5"),
    ("sudo killall5 -9", "killall5"),
    ("'killall5' -9", "killall5"),
    # pkill / killall selecting by user alone (no pattern, no process name)
    ("pkill -u jr", "pkill -u"),
    ("pkill -U jr", "pkill -u"),
    ("pkill -9 -u jr", "pkill -u"),
    ("pkill -KILL -u jr", "pkill -u"),
    ("pkill --signal KILL -u jr", "pkill -u"),
    ("pkill --uid jr", "pkill -u"),
    ("pkill --euid jr", "pkill -u"),
    ("pkill --euid=jr", "pkill -u"),
    ("pkill -ujr", "pkill -u"),
    ("pkill -e -u jr", "pkill -u"),
    ("pkill -fu jr", "pkill -u"),
    ("pkill -u jr --", "pkill -u"),
    ('pkill -u "$USER"', "pkill -u"),
    ("pkill -u $(id -un)", "pkill -u"),
    ("sudo pkill -u jr", "pkill -u"),
    ("/usr/bin/pkill -u jr", "pkill -u"),
    ("'pkill' -u jr", "pkill -u"),
    ("killall -u jr", "killall -u"),
    ("killall -9 -u jr", "killall -u"),
    ("killall -s KILL -u jr", "killall -u"),
    ("killall --user jr", "killall -u"),
    ("killall --user=jr", "killall -u"),
    ("killall -KILL --user jr", "killall -u"),
    ('"killall" -u jr', "killall -u"),
]

# Not every process: a specific pid, a process group, a variable (an unset
# one gives a harmless usage error), a listing, a pattern or a process name.
QUIET_KILLS = [
    "kill -1 123",  # SIGHUP to pid 123
    "kill -1",      # a usage error: no pid
    "kill -HUP 123", "kill -9 123 456", "kill 0", "kill -0 $p", "kill $p", 'kill "$p"', "kill -9 $p",
    "kill -TERM -- -$G", 'kill -TERM -- "-$G"', "kill -9 -- -1234", "kill -- -12", "kill -9 -10", "kill -9 -11",
    "kill -9 -$N", 'kill -9 "-${N}"', "kill -s KILL $p", "kill -n 9 -- -$G",
    "kill -l 1", "kill -l", "kill -L", "kill --list", "kill -l -1",
    "kill %1", "kill -9 %1", "kill -9 $(cat app.pid)", "kill -9 `cat app.pid`",
    "systemctl kill --signal=KILL app.service", "docker kill $c", "tmux kill-session -t x", "tmux kill-server",
    "pkill -f foo", "pkill foo", "pkill -u jr foo", "pkill -9 -u jr foo", "pkill -u jr -- foo",
    'pkill -u jr -f "python3 x.py"', "pkill -U jr -x node", "pkill -P 123", "pkill -t pts/1 x",
    'pkill -u jr "$PAT"', "pkill -fu jr worker", "pkill --euid=jr worker", "pkill --signal KILL -u jr foo",
    "pgrep -u jr", "ps -u jr",
    "killall foo", "killall -u jr foo", "killall -9 foo", "killall -u jr -- foo", "killall -s KILL -u jr foo",
    "killall --user=jr foo",
    "skill", "mykill -9 -1", "kill_all -9 -1", "kill-all -9 -1", "killall5x", "xkill", "echo killed -1",
    "pkill_x -u jr", "'killx' -9 -1", "kill'all'x -u jr",
    "# kill -9 -1", "ls  # then kill -9 -1",
]


def benign_kill_script(count=300):
    """A long stop script in the fleet's style: every kill names a variable,
    a specific pid or a process group > 1, every pkill/killall a pattern."""
    lines = ["#!/usr/bin/env bash", "set -euo pipefail"]
    for i in range(count):
        lines += [f'p=$(cat "/var/tmp/w{i}/pid")',
                  'if kill -0 "$p"; then kill -TERM "$p"; fi',
                  "kill $p || true",
                  f'kill -TERM -- "-$G{i}"',
                  'kill -s KILL "$p" 2>/dev/null || true',
                  f"kill -1 {1000 + i}",
                  f"kill -9 -- -{1234 + i}",
                  f'pkill -u "$USER" -f "worker-{i}"',
                  f"killall -u jr worker{i}"]
    return "\n".join(lines) + "\n"


def carried_lines(count):
    """A single-quoted string over `count` lines of 16 characters that each
    end it and open it again (so every line after the first is read a
    second time, charged 16 bytes each), a closing line of 16, then an
    unguarded rm: 16 x count bytes read a second time in all."""
    return "'" + "rm -r a 'b'cdefg\n" * count + "'" + "x" * 15 + "\nrm -rf $Z\n"


AT_REOPEN_MAX = shell_rules.REOPEN_MAX // 16  # carried_lines(AT_REOPEN_MAX): exactly REOPEN_MAX


def rescanned_twice(count):
    """Quoted code inside quoted code, `x "rm $(y "rm xx…")"` with `count`
    x's, then an unguarded rm on line 2. The text is count + 28 long; its
    two rescans (the outer string, then the inner one) cover exactly
    2 x count + 16 bytes."""
    return 'x "rm $(y "rm ' + "x" * count + '")"\nrm -rf $Z\n'


def rescan_budget(length):
    """The bytes all rescans of a text `length` long may cover: 1.5 x the
    text + 64 KiB (BLOCK r2, fix 9). Written out here, not read from
    RESCAN_FACTOR / RESCAN_SLACK, so a change to either shows."""
    return length * 3 // 2 + 64 * 1024


def at_rescan_budget():
    """The largest count whose rescanned_twice the rescan budget still
    covers (count + 1 is past it, by one byte)."""
    count = 2 * 64 * 1024
    while 2 * (count + 1) + 16 <= rescan_budget(count + 1 + 28):
        count += 1
    while 2 * count + 16 > rescan_budget(count + 28):
        count -= 1
    return count


def limit_texts():
    """(name, text, ScanLimit text): each stops the scan (the guard confirms)."""
    chain = (256 * 1024 - 64) // 12  # inside the guard's size limit with a short first line
    return [
        ("carried quoting nested too deeply", '"$(' * 32 + '"' + "\nx\n", "quoted code nested too deeply"),
        # a substitution chain deep past the interpreter's recursion limit
        ("quoted code nested too deeply", "\"'rm' $(y " * chain + ')"' * chain, "quoted code nested too deeply"),
        ("rescanned too often", "\"'rm' $(y " * 63 + "() " * 20000 + ')"' * 63, "quoted code rescanned too often"),
        # reopening a deep stack on every line is charged to the same budget
        ("deep carried quoting on many lines", '"$(' * 32 + "\n" + "x\n" * 2000, "quoted code rescanned too often"),
        ("carried text over the cap", carried_lines(AT_REOPEN_MAX + 1),
         "too much text inside quoting carried across lines"),
    ]


def nested_rm(levels):
    """rm -rf $X inside `levels` of quoted code ("rm $( ... )" each)."""
    text = "rm -rf $X"
    for _ in range(levels):
        text = 'x "rm $(' + text + ')"'
    return text


def capped_then_deep():
    """(r1 survivor) FINDINGS_MAX findings, then on the same line a command
    nested far past MAX_DEPTH."""
    return "rm -r $X;" * shell_rules.FINDINGS_MAX + "rm -rf " + '$("' * 600 + "rm -r $Y" + '")' * 600


def found_when_reopened_then_deep():
    """Line 2 starts inside the string line 1 left open: read fresh it is a
    comment; read as bash reads it (reopened), `$(rm -rf $LATE)` runs, and
    quoted code past MAX_DEPTH follows."""
    return 'echo "a\n# $(rm -rf $LATE)" ; ' + nested_rm(shell_rules.MAX_DEPTH + 1) + "\n"



def incident_script():
    """The 16:52 shape: one bash call, ~8,400 characters, 99 lines, several
    heredocs; FS is assigned inside a python heredoc (so bash never runs the
    assignment) and a later shell line runs rm -rf "$FS"/* past character 5,000."""
    lines = ["python3 - <<'PY'"]
    lines += [f"# step {i}: " + "x" * 70 for i in range(1, 55)]
    lines.append("FS=$T/fssh")  # line 56: inside the python heredoc
    lines += [f"print({i})" for i in range(56, 58)]
    lines.append("PY")  # line 59 closes it
    lines += [f"echo step {i} " + "y" * 60 for i in range(59, 64)]
    lines += ["cat > \"$T/job.env\" <<EOF", "A=1", "EOF"]
    lines += [f"echo more {i} " + "z" * 60 for i in range(67, 73)]
    lines.append('reset; rm -rf "$FS"/* "$T/job.env" "$RH/pd"')  # line 74
    lines += [f"echo tail {i} " + "w" * 60 for i in range(75, 97)]
    lines += ["cat <<EOF", "done", "EOF"]
    return "\n".join(lines) + "\n"


INCIDENT_LINE = 74


class ShellRuleTable(unittest.TestCase):
    def assert_finds(self, text, rule, command, names=None):
        found = scan_shell(text)
        self.assertTrue(found, f"no finding for {text!r}")
        rules = [(f.rule, f.command) for f in found]
        self.assertIn((rule, command), rules, f"{text!r}: {shape(found)}")
        if names is not None:
            got = sorted({n for f in found if f.rule == rule for n in f.names})
            self.assertEqual(got, sorted(names), f"{text!r}: {shape(found)}")

    def test_recursive_rm_with_an_unguarded_variable(self):
        for text, names in UNGUARDED_RM:
            with self.subTest(text):
                self.assert_finds(text, UNGUARDED, "rm -r", names)

    def test_find_delete_with_an_unguarded_variable(self):
        for text, names in UNGUARDED_FIND:
            with self.subTest(text):
                self.assert_finds(text, UNGUARDED, "find -delete", names)

    def test_mv_with_an_unguarded_variable(self):
        for text, names in UNGUARDED_MV:
            with self.subTest(text):
                self.assert_finds(text, UNGUARDED, "mv", names)

    def test_root_and_home_operands(self):
        for text in ROOT_OPERANDS:
            with self.subTest(text):
                command = "find -delete" if text.startswith("find") else "rm -r"
                self.assert_finds(text, ROOT_OP, command)
        for text in HOME_OPERANDS:
            with self.subTest(text):
                command = "find -delete" if text.startswith("find") else "rm -r"
                self.assert_finds(text, HOME_OP, command)
                # $HOME is reported as home, never as "add :?" (that would
                # still delete the home directory)
                self.assertNotIn(UNGUARDED, [f.rule for f in scan_shell(text)])

    def test_guarded_literal_and_other_commands_are_quiet(self):
        for text in QUIET:
            with self.subTest(text):
                self.assertEqual(shape(scan_shell(text)), [])

    def test_a_command_word_spelled_with_quotes_is_the_command(self):
        for text, rule, command, names in SPELLED_COMMANDS:
            with self.subTest(text):
                self.assert_finds(text, rule, command, names)
        for text in QUIET_SPELLINGS:
            with self.subTest(text):
                self.assertEqual(shape(scan_shell(text)), [])

    def test_a_spelled_command_reads_its_arguments_after_the_whole_word(self):
        # the word ends after its closing quotes; the next word is the first argument
        self.assertEqual(shape(scan_shell('"rm"\'\' -rf "$X" "$Y"')), [(UNGUARDED, "rm -r", ("X",)),
                                                                      (UNGUARDED, "rm -r", ("Y",))])
        # text glued after it starts the arguments, as for a plain word
        # (`rm'x' -rf "$X"` reads as rm, then x): conservative, never quieter
        for text in ("rm'x' -rf \"$X\"", "'rm''x' -rf \"$X\"", "'rm'\"$Y\" -rf \"$X\""):
            with self.subTest(text):
                self.assert_finds(text, UNGUARDED, "rm -r")
        # a quoted string that only starts like a command word is still read as code
        self.assertEqual(shape(scan_shell("x 'rm -rf $X'")), [(UNGUARDED, "rm -r", ("X",))])
        self.assertEqual(shape(scan_shell('x "rm -rf $X"')), [(UNGUARDED, "rm -r", ("X",))])

    def test_nested_heredocs(self):
        for name, text in {**NESTED_HEREDOCS, **NESTED_BY_SHAPE}.items():
            with self.subTest(name):
                self.assert_finds(text, NESTED, "heredoc")

    def test_every_opener_in_a_body_is_a_finding_at_its_line(self):
        # as ruled (r1 finding 3): each opener of the shape in a body,
        # whether or not its terminator follows
        self.assertEqual([f.line for f in scan_shell(NESTED_HEREDOCS["quoted words"])], [2, 3, 4, 5])
        self.assertEqual([f.line for f in scan_shell(NESTED_HEREDOCS["no inner terminator"])], [2])
        self.assertEqual([f.line for f in scan_shell(NESTED_HEREDOCS["inner terminator after the outer one"])],
                         [2])
        self.assertEqual([f.detail for f in scan_shell(NESTED_HEREDOCS["reused delimiter, no terminator"])],
                         ["closes the outer heredoc early"])
        # the outer body ends at its delimiter line: what follows is code
        self.assertEqual(scan_shell("cat <<A\nx\nA\ncat <<B\ny\nB\n"), [])
        self.assertEqual(scan_shell("cat <<-A\n\tx\n\tA\ncat <<B\ny\nB\n"), [])

    def test_sequential_and_lookalike_heredocs_are_quiet(self):
        for name, text in QUIET_HEREDOCS.items():
            with self.subTest(name):
                self.assertEqual(shape(scan_shell(text)), [])

    def test_line_numbers(self):
        text = 'echo a\necho b\nrm -rf "$X"\n'
        self.assertEqual([f.line for f in scan_shell(text)], [3])
        # a continued line is reported where the command starts
        self.assertEqual([f.line for f in scan_shell('echo a\nrm -rf \\\n  "$X"\n')], [2])
        nested = NESTED_HEREDOCS["different delimiters"]
        self.assertEqual([f.line for f in scan_shell(nested)], [3])

    def test_a_heredoc_body_is_scanned_too(self):
        # A body is often the script being written; a mis-tracked heredoc
        # must never hide a line either.
        text = "cat > clean.sh <<'EOF'\nset -euo pipefail\nrm -rf \"$X\"/*\nEOF\n"
        found = scan_shell(text)
        self.assertEqual(shape(found), [(UNGUARDED, "rm -r", ("X",))])
        self.assertEqual(found[0].line, 3)

    def test_the_incident_script(self):
        text = incident_script()
        self.assertGreater(len(text), 7000)
        self.assertGreater(text.index("rm -rf"), 5000)
        self.assertEqual(text.count("\n"), 99)
        found = scan_shell(text)
        self.assertEqual({f.line for f in found}, {INCIDENT_LINE})
        self.assertEqual(sorted(n for f in found for n in f.names), ["FS", "RH", "T"])

    def test_every_operand_is_reported_once(self):
        found = scan_shell('rm -rf "$A" "$B" "${C:?}" /')
        self.assertEqual(sorted((f.rule, f.names) for f in found),
                         [(ROOT_OP, ()), (UNGUARDED, ("A",)), (UNGUARDED, ("B",))])

    def test_a_dense_text_stops_at_the_cap(self):
        # one finding decides; a text with thousands stops at FINDINGS_MAX,
        # keeping the first ones by line
        cap = shell_rules.FINDINGS_MAX
        self.assertEqual(cap, 256)
        found = scan_shell('rm -rf "$X"\n' * 1000)
        self.assertEqual([f.line for f in found], list(range(1, cap + 1)))
        found = scan_shell("cat <<A\n" + "y <<A\n" * 1000 + "A\n")  # each one closes the outer early
        self.assertEqual(len(found), cap)
        self.assertEqual({f.rule for f in found}, {NESTED})
        found = scan_shell("cat <<A\n" + "y <<B\nB\n" * 1000 + "A\n")
        self.assertEqual(len(found), cap)
        # below the cap, everything is reported
        self.assertEqual(len(scan_shell('rm -rf "$X"\n' * (cap - 1))), cap - 1)

    def test_commands_inside_quoted_code_and_substitutions(self):
        for text, names in SUBSTITUTIONS:
            with self.subTest(text):
                self.assert_finds(text, UNGUARDED, "rm -r", names)
        for text in QUIET_SUBSTITUTIONS:
            with self.subTest(text):
                self.assertEqual(shape(scan_shell(text)), [])

    def test_strings_and_substitutions_across_lines(self):
        for text, expected in ACROSS_LINES:
            with self.subTest(text):
                found = scan_shell(text)
                self.assertEqual(sorted((f.line, f.names) for f in found), sorted(expected),
                                 f"{text!r}: {[(f.rule, f.line, f.names) for f in found]}")
                self.assertEqual({f.rule for f in found}, {UNGUARDED})
        for text in QUIET_ACROSS_LINES:
            with self.subTest(text):
                self.assertEqual(shape(scan_shell(text)), [])
        # a root operand (no `$` on the line): the closing quote alone makes
        # the line read again
        found = scan_shell('echo "a\nb #c"; rm -rf /\n')
        self.assertEqual([(f.rule, f.line) for f in found], [(ROOT_OP, 2)])
        # backticks in a double-quoted string carried across lines run too,
        # also after a `#` (the backtick alone makes the line read again)
        found = scan_shell('echo "a\n # `rm -rf /`\n"\n')
        self.assertEqual([(f.rule, f.line) for f in found], [(ROOT_OP, 2)])

    def test_a_fact_both_readings_find_is_reported_once(self):
        # line 2 read fresh and with the carried quote finds both operands;
        # each is reported once
        found = scan_shell("sh -c 'a\nrm -rf $X'; rm -rf $Y\n")
        self.assertEqual(sorted(f.names for f in found), [("X",), ("Y",)])
        # the same fact twice on one line is two findings in both readings
        found = scan_shell("echo '\n'; rm -rf $Y; rm -rf $Y\n")
        self.assertEqual([(f.line, f.names) for f in found], [(2, ("Y",)), (2, ("Y",))])
        # ... also when the fresh reading finds one of them and the second
        # reading both: one is added
        found = scan_shell("echo '\na' ; rm -rf $Y ; echo ' #' ; rm -rf $Y\n")
        self.assertEqual([(f.line, f.names) for f in found], [(2, ("Y",)), (2, ("Y",))])

    def test_limits_stop_the_scan_instead_of_clearing_it(self):
        for name, text, message in limit_texts():
            with self.subTest(name):
                with self.assertRaises(shell_rules.ScanLimit) as caught:
                    scan_shell(text)
                self.assertEqual(str(caught.exception), message)
        # exactly at the second reading's cap: scanned to the end
        at_cap = carried_lines(AT_REOPEN_MAX)
        self.assertEqual(16 * AT_REOPEN_MAX, shell_rules.REOPEN_MAX)
        found = scan_shell(at_cap)
        self.assertEqual([(f.line, f.names) for f in found], [(at_cap.count("\n"), ("Z",))])
        # as deep as MAX_DEPTH: scanned
        found = scan_shell('"$(' * 32 + "\nrm -rf $X\n")
        self.assertEqual([(f.line, f.names) for f in found], [(2, ("X",))])
        # substitutions carried across lines hold code, as at the top level:
        # no depth limit and no second reading
        deep = "x=" + "$(" * 100 + "\nrm -rf $Y" + ")" * 100 + "\necho 'a'\n"
        self.assertEqual([(f.line, f.names) for f in scan_shell(deep)], [(2, ("Y",))])
        # quoted code nested as deep as MAX_DEPTH is scanned; one level more stops
        def nested(levels):
            text = "rm -rf $X"
            for _ in range(levels):
                text = 'x "rm $(' + text + ')"'
            return text
        self.assertEqual([f.names for f in scan_shell(nested(shell_rules.MAX_DEPTH))], [("X",)])
        with self.assertRaises(shell_rules.ScanLimit):
            scan_shell(nested(shell_rules.MAX_DEPTH + 1))

    def test_rescans_stop_past_one_and_a_half_times_the_text(self):
        # BLOCK r2, fix 9: quoted code may be rescanned for 1.5 x the text
        # + 64 KiB in all; past that the scan stops (the guard confirms)
        count = at_rescan_budget()
        at = rescanned_twice(count)
        self.assertEqual(len(at), count + 28)
        self.assertEqual(2 * count + 16, rescan_budget(len(at)))  # exactly at it
        # at the budget: scanned to the end, line 2's rm is found
        self.assertEqual([(f.line, f.names) for f in scan_shell(at)], [(2, ("Z",))])
        # one byte past it: stopped on line 1, before the rm
        found = []
        with self.assertRaises(shell_rules.ScanLimit) as caught:
            scan_shell(rescanned_twice(count + 1), found)
        self.assertEqual(str(caught.exception), "quoted code rescanned too often")
        self.assertEqual(found, [])

    def test_the_findings_cap_stops_before_a_deep_tail(self):
        # (r1 finding 2) at FINDINGS_MAX the scan returns: a command nested
        # past MAX_DEPTH later on the same line is never read
        cap = shell_rules.FINDINGS_MAX
        self.assertEqual(len(scan_shell(capped_then_deep())), cap)

    def test_findings_before_a_limit_are_kept(self):
        # R-FINDINGS-WIN: `found` holds what the scan found before it stopped
        for name, tail, message in limit_texts():
            with self.subTest(name):
                found = []
                with self.assertRaises(shell_rules.ScanLimit) as caught:
                    scan_shell('rm -rf "$EARLY"\n' + tail, found)
                self.assertEqual(str(caught.exception), message)
                self.assertEqual([(f.line, f.names) for f in found], [(1, ("EARLY",))])
        # found only by the second reading of a line (its quoting carried
        # from the line before), which then stops
        found = []
        with self.assertRaises(shell_rules.ScanLimit):
            scan_shell(found_when_reopened_then_deep(), found)
        self.assertEqual([(f.line, f.names) for f in found], [(2, ("LATE",))])

    def test_a_long_string_across_lines_is_read_once(self):
        # a line inside one string that neither ends it nor changes how its
        # content reads is not read again (or charged to REOPEN_MAX)
        body = 4 * shell_rules.REOPEN_MAX
        for name, open_, line, close in (("single", "'", "x = 1  # a\n", "'"),
                                        ("ansi", "$'", "x = 1  # a\n", "'"),
                                        ("double", '"', "x = 1  # a\n", '"'),
                                        ("backticks", "`", "echo 1\n", "`")):
            with self.subTest(name):
                text = "y=" + open_ + "\n" + line * (body // len(line)) + close + "\nrm -rf $Z\n"
                found = scan_shell(text)
                self.assertEqual([(f.line, f.names) for f in found], [(text.count("\n"), ("Z",))])


class SignalAllTable(unittest.TestCase):
    """signal_all: literal shapes that signal every process the user may
    signal. Text only: scan_shell reads the commands, nothing runs them."""

    def test_every_signal_all_shape_is_found(self):
        for text, command in SIGNAL_ALL_SHAPES:
            with self.subTest(text):
                self.assertEqual(shape(scan_shell(text)), [(SIGNAL_ALL, command, ())], repr(text))

    def test_a_specific_pid_a_group_a_variable_or_a_pattern_is_quiet(self):
        for text in QUIET_KILLS:
            with self.subTest(text):
                self.assertEqual(shape(scan_shell(text)), [], repr(text))

    def test_a_long_benign_kill_script_is_clean(self):
        text = benign_kill_script()
        self.assertGreater(text.count("kill $p"), 250)
        self.assertEqual(scan_shell(text), [])
        # one kill -1 among them is found, at its line
        lines = text.split("\n")
        lines.insert(500, "kill -KILL -1")
        found = scan_shell("\n".join(lines))
        self.assertEqual([(f.rule, f.command, f.line) for f in found], [(SIGNAL_ALL, "kill", 501)])

    def test_details_and_line_numbers(self):
        for text, detail in (("kill -9 -1", "pid -1"), ("pkill -u jr", "selects by user alone"),
                             ("killall -u jr", "selects by user alone"), ("killall5 -9", "every process")):
            with self.subTest(text):
                self.assertEqual([f.detail for f in scan_shell(text)], [detail])
        heredoc = "cat > stop.sh <<'EOF'\necho stopping\nkill -9 -1\nEOF\n"
        self.assertEqual([f.line for f in scan_shell(heredoc)], [3])
        # one finding per command, however many -1 operands it has
        self.assertEqual(len(scan_shell("kill -9 -1 -1 -01")), 1)
        # next to the other rules, each finding once
        self.assertEqual(sorted(shape(scan_shell('rm -rf "$X"; kill -9 -1'))),
                         [(SIGNAL_ALL, "kill", ()), (UNGUARDED, "rm -r", ("X",))])
        # a line read with the quoting carried from the line before (a
        # fresh reading takes it for a comment)
        found = scan_shell('git commit -m "fix\nCloses #12" && kill -9 -1\n')
        self.assertEqual([(f.rule, f.line) for f in found], [(SIGNAL_ALL, 2)])


class ShellScriptTargets(unittest.TestCase):
    def test_shell_script_by_suffix_or_shebang(self):
        for path, text in (("a.sh", ""), ("x/b.bash", ""), ("c.zsh", ""), ("d.ksh", ""), ("E.SH", ""),
                           ("bin/tool", "#!/usr/bin/env bash\necho"), ("bin/t2", "#!/bin/sh\n"),
                           ("t3", "#! /bin/bash -e\n"), ("t4.py", "#!/usr/bin/env bash\n")):
            with self.subTest(path):
                self.assertTrue(shell_rules.is_shell_script(path, text))
        for path, text in (("a.py", 'import os\nos.system("rm -rf $X")'), ("b.md", "rm -rf $X"),
                           ("c.txt", ""), ("Makefile", "\trm -rf $(X)"), ("bin/tool", "#!/usr/bin/env python3\n"),
                           ("d", "echo #!/bin/sh"), ("a.shx", "")):
            with self.subTest(path):
                self.assertFalse(shell_rules.is_shell_script(path, text))


# ── through the guard ───────────────────────────────────────────────────────

SAFE = {"risk": {"type": "score", "score": 0.1, "confidence": 0.95, "legend": {str(i): f"L{i}" for i in range(4)},
                 "probabilities": {"0": 1.0, "1": 0.0, "2": 0.0, "3": 0.0}},
        "leak": {"type": "noul", "noul": 0.02}, "leaves_workspace": {"type": "noul", "noul": 0.03}}
CANARY = "CANARY-SHELL-5d1c"


class RecordingClient:
    def __init__(self):
        self.calls = []

    def decide(self, state, questions, *, op="decide", **kw):
        self.calls.append((copy.deepcopy(state), list(questions)))
        answers = {}
        for key in questions:
            base = key.rsplit("_", 1)[0] if key[-1:].isdigit() else key
            answers[key] = copy.deepcopy(SAFE[base])
        return {"answers": answers, "model": "fake", "usage": {"input_tokens": 1}}


class ShellRuleGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="jev-shell-")
        self.addCleanup(self.tmp.cleanup)
        self.ws = Path(self.tmp.name) / "ws"
        self.ws.mkdir()
        self.audit_path = Path(self.tmp.name) / "audit.jsonl"
        self.audit = audit_mod.Audit(str(self.audit_path))
        self.logs = []

    def run_guard(self, tool, tool_input, cfg=None, **extra_cfg):
        client = RecordingClient()
        cfg = cfg or guard.GuardConfig({"project_root": str(self.ws), "guard_confirm": "prompt", **extra_cfg})
        params = {"kind": "before_tool_call", "tool_name": tool, "tool_runtime_name": tool,
                  "tool_input": tool_input, "session_id": "sess-1", "cwd": str(self.ws)}
        return guard.handle(params, client, cfg, self.audit, self.logs.append), client

    def audit_rows(self):
        if not self.audit_path.exists():
            return []
        return [json.loads(x) for x in self.audit_path.read_text().splitlines() if x.strip()]

    def assert_blocked(self, result, client):
        self.assertEqual(result["action"], "block", result)
        self.assertEqual(client.calls, [], "the rule must decide without a model call")
        return result["reason"]

    def test_the_incident_script_is_blocked_without_a_call(self):
        result, client = self.run_guard("bash", {"command": incident_script()})
        reason = self.assert_blocked(result, client)
        self.assertIn(f"line {INCIDENT_LINE}", reason)
        self.assertIn('"${FS:?}"', reason)
        self.assertIn("literal path", reason)

    def test_a_signal_to_every_process_is_blocked_without_a_call(self):
        # 10-27 22:38: kill(-1, SIGKILL) ended JR's desktop session. Text
        # only: the guard reads these commands, nothing runs them.
        for command, says in (
                ("kill -9 -1", "line 1: kill with pid -1 signals every process you own (it killed the desktop "
                               "session on 10-27). Signal a specific pid or a process group > 1 instead"),
                ("echo ok\nsudo pkill -u jr", "line 2: pkill -u with a user and no pattern signals every process"),
                ("killall -u jr", "line 1: killall -u with a user and no process name signals every process"),
                ("killall5 -9", "line 1: killall5 signals every process outside its own session")):
            with self.subTest(command):
                reason = self.assert_blocked(*self.run_guard("bash", {"command": command}))
                self.assertIn(says, reason)
                self.assertIn("10-27", reason)
        # a shell script written with it
        reason = self.assert_blocked(*self.run_guard(
            "write", {"path": str(self.ws / "stop.sh"), "content": "#!/bin/bash\nkill -TERM -- -1\n"}))
        self.assertIn("line 2: kill with pid -1", reason)
        # a variable, a specific pid or a pattern goes on to the model as before
        for command in ("kill -TERM -- -$G", 'kill "$p"', "kill -1 123", "pkill -u jr worker", benign_kill_script(20)):
            with self.subTest(command[:40]):
                result, client = self.run_guard("bash", {"command": command})
                self.assertEqual((result["action"], len(client.calls)), ("continue", 1))

    def test_the_signal_rule_carries_no_text_and_follows_the_switch(self):
        command = f"# {CANARY}\nkill -9 -1\n"
        result, client = self.run_guard("bash", {"command": command})
        reason = self.assert_blocked(result, client)
        row = self.audit_rows()[-1]
        self.assertEqual((row["action"], row["rule"]), ("block", "shell_safety"))
        self.assertEqual(row["findings"], [{"rule": SIGNAL_ALL, "command": "kill", "line": 2, "where": "command"}])
        text = reason + "\n".join(self.logs) + self.audit_path.read_text()
        self.assertNotIn(CANARY, text)
        self.assertNotIn("kill -9", text)
        self.assertIn("signal_all command line 2", "\n".join(self.logs))
        # guard_shell_rule = confirm asks with the same text; off skips it
        result, client = self.run_guard("bash", {"command": "kill -9 -1"}, guard_shell_rule="confirm")
        self.assertEqual((result["action"], client.calls), ("confirm", []))
        self.assertIn("line 1: kill with pid -1 signals every process you own", result["message"])
        result, client = self.run_guard("bash", {"command": "kill -9 -1"}, guard_shell_rule="off")
        self.assertEqual((result["action"], len(client.calls)), ("continue", 1))

    def test_a_guarded_command_goes_to_the_model_as_before(self):
        result, client = self.run_guard("bash", {"command": 'rm -rf "${FS:?}"/*'})
        self.assertEqual(result["action"], "continue")
        self.assertEqual(len(client.calls), 1)

    def test_an_unterminated_inner_heredoc_blocks(self):
        # (r1 finding 3, as ruled) the shape that leaves a heredoc open in
        # the script written out
        reason = self.assert_blocked(*self.run_guard("bash", {"command": "cat <<A\ncat <<B\nA"}))
        self.assertIn("line 2: heredoc heredoc opened inside another heredoc's body", reason)
        reason = self.assert_blocked(*self.run_guard(
            "write", {"path": str(self.ws / "gen.sh"), "content": "cat > run.sh <<'EOF'\npython3 - <<'PY'\nEOF\n"}))
        self.assertIn("line 2", reason)

    def test_the_reasons_say_how_to_fix_each_kind(self):
        reason = self.assert_blocked(*self.run_guard("bash", {"command": "rm -rf ~/*"}))
        self.assertIn("home", reason)
        self.assertIn("narrower", reason)
        reason = self.assert_blocked(*self.run_guard("bash", {"command": "rm -rf /"}))
        self.assertIn("root", reason)
        reason = self.assert_blocked(*self.run_guard("bash", {"command": NESTED_HEREDOCS["different delimiters"]}))
        self.assertIn("heredoc", reason)
        self.assertIn("write tool", reason)
        reason = self.assert_blocked(*self.run_guard("bash", {"command": 'mv "$A" "$B"'}))
        self.assertIn('"${A:?}"', reason)
        self.assertIn('"${B:?}"', reason)

    def test_an_array_reason_keeps_the_subscript(self):
        # (r1) "${arr:?}" would turn the array into its first element
        reason = self.assert_blocked(*self.run_guard("bash", {"command": 'rm -rf "${dirs[@]}"/build'}))
        self.assertIn("expands ${dirs[@]} with no empty-check", reason)
        self.assertIn('write "${dirs[@]:?}"', reason)
        self.assertNotIn("${dirs:?}", reason)
        reason = self.assert_blocked(*self.run_guard("bash", {"command": f'rm -rf "${{a[$(echo {CANARY})]}}"'}))
        self.assertIn('"${a[…]:?}"', reason)
        self.assertNotIn(CANARY, reason + "\n".join(self.logs) + self.audit_path.read_text())
        result, client = self.run_guard("bash", {"command": 'rm -rf "${dirs[@]:?}"/build'})
        self.assertEqual((result["action"], len(client.calls)), ("continue", 1))

    def test_the_reason_names_at_most_a_few_findings(self):
        command = "\n".join(f'rm -rf "$V{i}"' for i in range(20))
        reason = self.assert_blocked(*self.run_guard("bash", {"command": command}))
        self.assertIn("and 14 more", reason)

    def test_a_dense_text_is_blocked_with_a_lower_bound(self):
        cap = shell_rules.FINDINGS_MAX
        reason = self.assert_blocked(*self.run_guard("bash", {"command": 'rm -rf "$X"\n' * 1000}))
        self.assertIn(f"and {cap - guard.NAMED_IN_MESSAGE}+ more", reason)
        row = self.audit_rows()[-1]
        self.assertEqual((row["findings_total"], row["findings_capped"]), (cap, True))
        self.assertEqual(len(row["findings"]), guard.AUDIT_FINDINGS_MAX)
        # exactly at the cap from two texts: the count is still a lower bound
        edits = [{"path": "a.sh", "op": "append", "text": 'rm -rf "$X"\n' * cap},
                 {"path": "b.sh", "op": "append", "text": 'rm -rf "$Y"\n'}]
        reason = self.assert_blocked(*self.run_guard("multi_edit", {"edits": edits}))
        self.assertIn(f"and {cap + 1 - guard.NAMED_IN_MESSAGE}+ more", reason)
        self.assertEqual(self.audit_rows()[-1]["findings_capped"], True)

    def test_write_scans_shell_scripts_only(self):
        bad = '#!/usr/bin/env bash\nset -euo pipefail\nrm -rf "$OUT"/*\n'
        for path in ("clean.sh", "bin/clean"):
            with self.subTest(path):
                self.assert_blocked(*self.run_guard("write", {"path": str(self.ws / path), "content": bad}))
        for path, content in (("notes.md", 'rm -rf "$OUT"/*\n'), ("gen.py", 'CMD = \'rm -rf "$OUT"/*\'\n')):
            with self.subTest(path):
                result, client = self.run_guard("write", {"path": str(self.ws / path), "content": content})
                self.assertEqual(result["action"], "continue")
                self.assertEqual(len(client.calls), 1)

    def test_edit_scans_the_new_text_of_a_shell_script(self):
        path = str(self.ws / "clean.sh")
        self.assert_blocked(*self.run_guard("edit", {"path": path, "old_string": "x", "new_string": 'rm -rf "$D"'}))
        # fixing the line is never blocked
        result, client = self.run_guard("edit", {"path": path, "old_string": 'rm -rf "$D"',
                                                 "new_string": 'rm -rf "${D:?}"'})
        self.assertEqual(result["action"], "continue")
        self.assertEqual(len(client.calls), 1)

    def test_multi_edit_scans_shell_targets_and_names_them(self):
        edits = [{"path": "a.py", "op": "replace", "anchor": "old", "text": 'rm -rf "$D"'},
                 {"path": "b.sh", "op": "append", "text": 'echo ok\nrm -rf "$D"/*\n'}]
        reason = self.assert_blocked(*self.run_guard("multi_edit", {"edits": edits}))
        self.assertIn("edits[1]", reason)
        self.assertIn("b.sh", reason)
        self.assertNotIn("edits[0]", reason)
        result, client = self.run_guard("multi_edit", {"edits": edits[:1]})
        self.assertEqual(result["action"], "continue")

    def test_malformed_multi_edit_still_confirms_first(self):
        result, client = self.run_guard("multi_edit", {"edits": [{"path": "b.sh", "op": "append"}]})
        self.assertEqual(result["action"], "confirm")
        self.assertEqual(client.calls, [])

    def test_read_and_send_events_are_not_scanned(self):
        result, client = self.run_guard("read", {"path": 'rm -rf "$X"'})
        self.assertEqual(result["action"], "continue")
        result, client = self.run_guard("send_events", {"source": "v", "messages": [
            {"session": "s", "body": 'run rm -rf "$X"/* please'}]})
        self.assertEqual(result["action"], "continue")

    def test_a_tool_outside_guard_tools_is_untouched(self):
        result, client = self.run_guard("bash", {"command": 'rm -rf "$X"'}, guard_tools="read")
        self.assertEqual(result, {"action": "continue"})
        self.assertEqual(client.calls, [])

    def test_the_audit_row_carries_metadata_only(self):
        command = f"# {CANARY}\n" + 'rm -rf "$FS"/*\n'
        result, client = self.run_guard("bash", {"command": command})
        self.assert_blocked(result, client)
        rows = self.audit_rows()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row["tool"], row["action"], row["rule"]), ("bash", "block", "shell_safety"))
        self.assertEqual(row["findings"], [{"rule": UNGUARDED, "command": "rm -r", "line": 2, "where": "command"}])
        self.assertEqual((row["findings_total"], row["findings_capped"]), (1, False))
        text = self.audit_path.read_text() + "\n".join(self.logs)
        self.assertNotIn(CANARY, text)
        self.assertNotIn("rm -rf", text)
        self.assertNotIn(CANARY, result["reason"])

    def test_config_confirm_off_and_unknown(self):
        bad = {"command": 'rm -rf "$X"'}
        result, client = self.run_guard("bash", bad, guard_shell_rule="confirm")
        self.assertEqual(result["action"], "confirm")
        self.assertIn('"${X:?}"', result["message"])
        self.assertEqual(client.calls, [])
        result, client = self.run_guard("bash", bad, guard_shell_rule="off")
        self.assertEqual(result["action"], "continue")
        self.assertEqual(len(client.calls), 1)
        for value in ("bogus", "", "OFF "):
            with self.subTest(value):
                result, client = self.run_guard("bash", bad, guard_shell_rule=value)
                expected = "continue" if value.strip().lower() == "off" else "block"
                self.assertEqual(result["action"], expected)

    def test_a_scanner_failure_confirms_without_a_call(self):
        def boom(text, found=None):
            raise RuntimeError(f"scanner bug near {text[:20]}")
        original = guard.scan_shell
        guard.scan_shell = boom
        try:
            result, client = self.run_guard("bash", {"command": f'echo {CANARY}; rm -rf "$X"'})
        finally:
            guard.scan_shell = original
        self.assertEqual(result["action"], "confirm")
        self.assertEqual(client.calls, [])
        self.assertNotIn(CANARY, result["message"] + "\n".join(self.logs) + self.audit_path.read_text())

    def test_a_text_past_the_scan_limits_confirms_without_a_call(self):
        for name, text, _ in limit_texts():
            with self.subTest(name):
                self.audit_path.unlink(missing_ok=True)
                self.logs.clear()
                result, client = self.run_guard("bash", {"command": f"echo {CANARY}\n" + text})
                self.assertEqual((result["action"], client.calls), ("confirm", []))
                self.assertIn("too complex to check", result["message"])
                rows = self.audit_rows()
                self.assertEqual([(r["action"], r.get("error")) for r in rows],
                                 [("confirm", "shell text too complex to check")])
                self.assertNotIn(CANARY, result["message"] + "\n".join(self.logs) + self.audit_path.read_text())

    def test_a_text_past_the_rescan_budget_confirms(self):
        # BLOCK r2, fix 9: one byte past the rescan budget the scan stops
        # before line 2's rm, so the call confirms (it never goes on); at
        # the budget the scan reaches the rm and blocks
        count = at_rescan_budget()
        result, client = self.run_guard("bash", {"command": rescanned_twice(count + 1)})
        self.assertEqual((result["action"], client.calls), ("confirm", []))
        self.assertIn("too complex to check", result["message"])
        self.assertEqual([(r["action"], r.get("error")) for r in self.audit_rows()],
                         [("confirm", "shell text too complex to check")])
        result, client = self.run_guard("bash", {"command": rescanned_twice(count)})
        self.assertIn("line 2: rm -r operand expands $Z", self.assert_blocked(result, client))

    def assert_blocked_then_stopped(self, result, client, line, name, stopped="shell text too complex to check"):
        reason = self.assert_blocked(result, client)
        self.assertIn(f"line {line}: rm -r operand expands ${name}", reason)
        self.assertIn(f"the rest of the text could not be checked ({stopped})", reason)
        row = self.audit_rows()[-1]
        self.assertEqual((row["action"], row["stopped"]), ("block", stopped))
        self.assertNotIn(CANARY, reason + "\n".join(self.logs) + self.audit_path.read_text())
        return reason

    def test_a_finding_before_a_limit_blocks(self):
        # R-FINDINGS-WIN: host policy may approve a confirm (allow-all, the
        # session latch), so in the default (block) mode a scan that stops
        # after a finding blocks on what it found, and says the rest was not
        # checked (confirm mode: test_a_finding_then_a_scanner_error_...)
        for name, tail, _ in limit_texts():
            with self.subTest(name):
                command = f"echo {CANARY}\n" + 'rm -rf "$EARLY"\n' + tail
                self.assert_blocked_then_stopped(*self.run_guard("bash", {"command": command}), 2, "EARLY")
                self.assertEqual(self.audit.counters.get("guard.shell_stopped", 0) > 0, True)
        with self.subTest("found only by the second reading"):
            self.assert_blocked_then_stopped(
                *self.run_guard("bash", {"command": found_when_reopened_then_deep()}), 2, "LATE")
        with self.subTest("an earlier text of the call"):
            edits = [{"path": "a.sh", "op": "append", "text": 'rm -rf "$EARLY"\n'},
                     {"path": "b.sh", "op": "append", "text": limit_texts()[0][1]}]
            reason = self.assert_blocked(*self.run_guard("multi_edit", {"edits": edits}))
            self.assertIn("edits[0]", reason)
            self.assertIn("could not be checked", reason)
        # the cap is a decision, not a limit: 256 findings, then quoted code
        # nested past MAX_DEPTH on the same line, block as capped
        reason = self.assert_blocked(*self.run_guard("bash", {"command": capped_then_deep()}))
        self.assertNotIn("could not be checked", reason)
        row = self.audit_rows()[-1]
        self.assertEqual((row["findings_capped"], row["stopped"]), (True, None))

    def test_any_scan_failure_after_a_finding_blocks(self):
        def stops(error):
            def scan(text, found=None):
                found.append(shell_rules.Finding(UNGUARDED, "rm -r", 3, ("EARLY",), "unguarded expansion"))
                raise error
            return scan
        original = guard.scan_shell
        for error, category in ((RuntimeError(f"bug {CANARY}"), "internal error"),
                                (guard.BudgetSpent(), "hook budget spent"),
                                (RecursionError(), "internal error")):
            with self.subTest(category=category, error=type(error).__name__):
                guard.scan_shell = stops(error)
                try:
                    result, client = self.run_guard("bash", {"command": f"echo {CANARY}"})
                finally:
                    guard.scan_shell = original
                self.assert_blocked_then_stopped(result, client, 3, "EARLY", category)
        # the confirm mode confirms on them instead
        guard.scan_shell = stops(shell_rules.ScanLimit("quoted code nested too deeply"))
        try:
            result, client = self.run_guard("bash", {"command": "x"}, guard_shell_rule="confirm")
        finally:
            guard.scan_shell = original
        self.assertEqual((result["action"], client.calls), ("confirm", []))
        self.assertIn("line 3", result["message"])
        self.assertIn("could not be checked", result["message"])

    def test_a_finding_then_a_scanner_error_takes_the_finding_action(self):
        # BLOCK r2 blocker 2, as ruled: a scan that stops after a finding
        # never takes a weaker action than a complete scan with that finding
        # would: block by default, confirm when guard_shell_rule = confirm
        # (the operator's action for any finding). The real scanner finds
        # line 2's rm, then fails inside (an injected RuntimeError, not a
        # ScanLimit: the reviewer's non-limit case).
        original = shell_rules._scan_line

        def fails_after_a_finding(s, line, out, depth, budget):
            original(s, line, out, depth, budget)
            if out:
                raise RuntimeError(f"bug {CANARY}")

        command = f"echo {CANARY}\n" + 'rm -rf "$EARLY"\necho ok\n'
        for mode in ("block", "confirm"):
            with self.subTest(mode):
                self.audit_path.unlink(missing_ok=True)
                self.logs.clear()
                shell_rules._scan_line = fails_after_a_finding
                try:
                    result, client = self.run_guard("bash", {"command": command}, guard_shell_rule=mode)
                finally:
                    shell_rules._scan_line = original
                self.assertEqual((result["action"], client.calls), (mode, []))
                text = result["reason" if mode == "block" else "message"]
                self.assertIn("line 2: rm -r operand expands $EARLY", text)
                self.assertIn('"${EARLY:?}"', text)
                self.assertIn("the rest of the text could not be checked (internal error)", text)
                row = self.audit_rows()[-1]
                self.assertEqual((row["action"], row["stopped"], row["findings_total"]), (mode, "internal error", 1))
                self.assertNotIn(CANARY, text + "\n".join(self.logs) + self.audit_path.read_text())
        # the same text scanned to the end takes the same action in each mode
        for mode in ("block", "confirm"):
            with self.subTest("complete scan", mode=mode):
                result, client = self.run_guard("bash", {"command": command}, guard_shell_rule=mode)
                self.assertEqual((result["action"], client.calls), (mode, []))

    def test_an_oversized_text_confirms_without_a_call(self):
        command = "echo x\n" * (guard.SHELL_SCAN_MAX_BYTES // 7 + 1)
        result, client = self.run_guard("bash", {"command": command})
        self.assertEqual(result["action"], "confirm")
        self.assertEqual(client.calls, [])
        self.assertIn("too large", result["message"])

    def test_the_size_limit_counts_utf8_bytes_of_all_texts(self):
        limit = guard.SHELL_SCAN_MAX_BYTES
        self.assertEqual(limit, 256 * 1024)  # the measured bound (README); raising it needs a new measurement
        tail = 'rm -rf "$X"\n'
        at_limit = "#" * (limit - len(tail) - 1) + "\n" + tail
        self.assertEqual(len(at_limit.encode()), limit)
        self.assert_blocked(*self.run_guard("bash", {"command": at_limit}))  # scanned
        result, client = self.run_guard("bash", {"command": "#" + at_limit})
        self.assertEqual((result["action"], client.calls), ("confirm", []))
        self.assertIn("too large", result["message"])
        # bytes, not characters: 2-byte characters over the limit in bytes only
        wide = "#" + "é" * (limit // 2) + "\n" + tail
        self.assertLess(len(wide), limit)
        result, client = self.run_guard("bash", {"command": wide})
        self.assertEqual((result["action"], client.calls), ("confirm", []))
        # all shell texts of one call together
        half = "#" * (limit // 2) + "\n"
        edits = [{"path": "a.sh", "op": "append", "text": half}, {"path": "b.sh", "op": "append", "text": half}]
        result, client = self.run_guard("multi_edit", {"edits": edits})
        self.assertEqual((result["action"], client.calls), ("confirm", []))
        self.assertIn("too large", result["message"])

    def test_a_non_string_command_keeps_todays_path(self):
        result, client = self.run_guard("bash", {"command": ["rm", "-rf", "$X"]})
        self.assertEqual(len(client.calls), 1)


# ── cost: the whole text, every time (same 0.5 s scale as the body scan) ───

class _DeniedClient:
    """A client whose every decision is refused (a spent budget or an open
    circuit), recording the attempts."""
    def __init__(self, reason):
        from jev.policy import PolicyDenied
        self.error, self.calls = PolicyDenied(reason), []

        class stats:
            last_model = None
        self.stats = stats

    def snapshot(self):
        return {}

    def decide(self, state, questions, **kw):
        self.calls.append(list(questions))
        raise self.error


class ShellRuleGate(unittest.TestCase):
    """R-GATE: the rule needs no model, so it runs whatever the API key,
    the budget, the error circuit or the guard switch; only
    guard_shell_rule = off stops it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="jev-gate-")
        self.addCleanup(self.tmp.cleanup)
        self.ws = Path(self.tmp.name) / "ws"
        self.ws.mkdir()
        self.audit_path = Path(self.tmp.name) / "audit.jsonl"
        patcher = mock.patch("jev_ext.keys.discover", return_value=(None, "none"))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.real_ask = guard._ask
        asked = mock.patch.object(guard, "_ask", side_effect=AssertionError("a model call"))
        self.ask = asked.start()
        self.addCleanup(asked.stop)

    def extension(self, **cfg):
        import jev_ext
        ext = jev_ext.Extension()
        ext.initialize({"config": {"project_root": str(self.ws), "audit_file": str(self.audit_path),
                                   "guard_confirm": "prompt", **cfg}})
        return ext

    def hook(self, ext, tool, tool_input):
        return ext.hook({"kind": "before_tool_call", "tool_name": tool, "tool_runtime_name": tool,
                         "tool_input": tool_input, "session_id": "sess-1", "cwd": str(self.ws)})

    def assert_incident_blocked(self, ext):
        result = self.hook(ext, "bash", {"command": incident_script()})
        self.assertEqual(result["action"], "block", result)
        self.assertIn(f"line {INCIDENT_LINE}", result["reason"])
        self.assertIn('"${FS:?}"', result["reason"])
        self.ask.assert_not_called()

    def test_no_key_still_blocks_the_incident_without_a_call(self):
        ext = self.extension()
        self.assertIsNone(ext.client)
        self.assertFalse(ext.features["guard"])
        self.assert_incident_blocked(ext)
        self.assertEqual(ext.audit.counters.get("guard.shell_only"), 1)
        rows = [json.loads(x) for x in self.audit_path.read_text().splitlines()]
        self.assertEqual([(r["action"], r["rule"]) for r in rows], [("block", "shell_safety")])
        # write and multi_edit too; a multi_edit is scanned unvalidated
        # (with the model guard off nothing would confirm it as malformed)
        bad = 'set -euo pipefail\nrm -rf "$OUT"/*\n'
        result = self.hook(ext, "write", {"path": str(self.ws / "x.sh"), "content": bad})
        self.assertEqual(result["action"], "block")
        result = self.hook(ext, "multi_edit", {"edits": [{"path": "x.sh", "op": "append", "text": bad,
                                                          "unknown_field": 1}]})
        self.assertEqual(result["action"], "block")
        self.assertIn("edits[0]", result["reason"])
        # a limit confirms, as with the model guard on
        result = self.hook(ext, "bash", {"command": limit_texts()[0][1]})
        self.assertEqual(result["action"], "confirm")
        self.assertIn("too complex to check", result["message"])
        self.ask.assert_not_called()

    def test_nothing_found_goes_on_as_without_the_guard(self):
        ext = self.extension()
        for tool, tool_input in (("bash", {"command": 'rm -rf "${D:?}"/x'}), ("read", {"path": "/etc/hosts"}),
                                 ("write", {"path": str(self.ws / "a.txt"), "content": 'rm -rf "$X"'}),
                                 ("send_events", {"messages": []}), ("bash", "not a dict")):
            with self.subTest(tool=tool):
                self.assertEqual(self.hook(ext, tool, tool_input), {"action": "continue"})
        self.assertTrue(ext.audit.counters.get("guard.inert"))

    def test_the_guard_switched_off_still_blocks(self):
        ext = self.extension()
        ext.client = _DeniedClient("budget_calls")
        ext.recompute_features()
        self.assertTrue(ext.features["guard"])
        ext.set_feature("guard", False, persist=False)  # `/jev guard off`
        self.assertFalse(ext.features["guard"])
        self.assert_incident_blocked(ext)
        self.assertEqual(ext.client.calls, [])
        ext = self.extension(guard=False)  # off in config
        self.assert_incident_blocked(ext)

    def test_a_spent_budget_or_an_open_circuit_still_blocks(self):
        self.ask.side_effect = self.real_ask  # the client is reached only after the rule
        for reason in ("budget_calls", "circuit_open"):
            with self.subTest(reason):
                ext = self.extension()
                ext.client = _DeniedClient(reason)
                ext.recompute_features()
                result = self.hook(ext, "bash", {"command": incident_script()})
                self.assertEqual(result["action"], "block", result)
                self.assertEqual(ext.client.calls, [])
                # with nothing found the model is asked, and its refusal confirms
                result = self.hook(ext, "bash", {"command": "ls"})
                self.assertEqual(result["action"], "confirm")
                self.assertEqual(len(ext.client.calls), 1)

    def test_only_the_rule_switch_turns_it_off(self):
        ext = self.extension(guard_shell_rule="off")
        self.assertEqual(self.hook(ext, "bash", {"command": incident_script()}), {"action": "continue"})
        ext = self.extension(guard_shell_rule="confirm")
        result = self.hook(ext, "bash", {"command": incident_script()})
        self.assertEqual(result["action"], "confirm")
        self.assertIn(f"line {INCIDENT_LINE}", result["message"])
        # a tool taken out of guard_tools is not checked
        ext = self.extension(guard_tools="read,write")
        self.assertEqual(self.hook(ext, "bash", {"command": incident_script()}), {"action": "continue"})
        self.ask.assert_not_called()


def _scan_units():
    # Near misses that walk every word, dense findings (stopped by the
    # cap), heredoc and quoting shapes
    big = guard.SHELL_SCAN_MAX_BYTES
    units = {
        "plain script": "echo step; cd /var/tmp/x && make -j4 >> log 2>&1\n",
        "guarded deletes": 'rm -rf "${D:?}/${n:?}.done" "${D:?}/x"\n',
        "unguarded deletes": 'rm -rf "$D"/* "$E"\n',
        "short mv finding": "mv $A\n",
        "short rm finding": "rm -r $A\n",
        "rm words": "rm " * 40 + "\n",
        "rm word lines": "rm\n",
        "one long rm line": None,
        "mv words": "mv -t " * 30 + "\n",
        "find words": "find $D -name x " * 10 + "-delete\n",
        "find delete lines": "find $D -delete\n",
        "heredoc operators": "x << y << z\n",
        "heredoc lines": "cat <<A\nA\n",
        "nested candidates": "cat <<A\n" + "y << B\n" * 40 + "A\n",
        "nested findings": "cat <<A\ny <<B\nB\nA\n",
        "shifts in a body": ("cat <<'A'\n", "x = a << 1 << 2 <<< b << $c\n"),
        "quotes": "rm -rf '" + "a'b'" * 40 + "\n",
        "dq words": 'rm -rf ' + '"a" ' * 40 + "\n",
        "dollar braces": "rm -rf ${" * 40 + "\n",
        "dollar runs": "rm -rf " + "$A" * 100 + "\n",
        "backslashes": "rm -rf " + "\\" * 80 + "\n",
        "quoted code": "trap 'rm -rf \"$tmp\"' EXIT\n",
        "dq code": 'bash -c "rm -rf \\"\\$X\\""\n',
        "continuations": "rm -rf \\\n",
        "comments": "# rm -rf $X\n",
        "subst": "x=$(rm -rf $(echo $(echo a)))\n",
        # command words spelled with quotes (r1 finding 5): each one read as
        # a word, a string that only starts like one, one long word of them,
        # quote runs and noise between letters
        "spelled rm lines": "'rm';r\"\"m -r a\n",
        "quoted strings starting with rm": '"rm x" ',
        "spelled rm in one word": "'rm'",
        "quote runs": "''''''''\"\"\"\"\"\"\"\"r ",
        "noise between letters": "'r" * 40 + "\n",
        # kill / pkill / killall (10-27): option words, spelled words that
        # are near misses, options of a pkill with a pattern
        "kill words": "kill -9 " * 30 + "\n",
        "kill operand lines": "kill -9 -12\n",
        "spelled kill near misses": "'kill' $p;k\"\"ill -0 $q;'pkill' -u x y\n",
        "pkill options": "pkill " + "-fu jr -t x " * 20 + "p\n",
        # strings and backticks carried across lines (read twice), below and
        # past the second reading's cap (REOPEN_MAX: ScanLimit, the guard confirms)
        "sq lines, near miss": ("'", "rm -r a b\n"),
        "carried sq lines": ("'", "rm -r a 'b'c\n"),
        "carried dq lines": ('"', "rm -r a b ${x:?}\n"),
        "carried bq lines": ("`", "rm -r `x` a\n"),
        "nested sq rescans": ("'", "x 'rm \"$(rm a)\"' rm\n"),
        "deep carried quoting": ("$(\"" * 30 + "\n", "rm -r a\n"),
        "short lines in dq": ('"', "rm -r a ${b:?}\n"),
        # the costliest mix: a second reading just under its cap, then the
        # costliest single reading to the end
        "carried dq to the cap": ('"' + "rm -r a b ${x:?}\n" * ((shell_rules.REOPEN_MAX - 64) // 17) + '"\n',
                                  "rm -r a b\n"),
        "carried sq to the cap": ("'" + "rm -r a 'b'c\n" * ((shell_rules.REOPEN_MAX - 64) // 14) + "'\n",
                                  "rm -r a b\n"),
    }
    out = {}
    for name, unit in units.items():
        if unit is None:
            out[name] = ("rm -rf " + '"a" ' * (big // 4))[:big - 1]
        else:
            head, unit = unit if isinstance(unit, tuple) else ("", unit)
            room = big - 1 - len(head)
            out[name] = head + (unit * (room // len(unit) + 1))[:room]
    return out


def _scan_or_limit(text):
    """A scan that stops with ScanLimit is a result too (the guard confirms)."""
    try:
        return scan_shell(text)
    except shell_rules.ScanLimit:
        return None


class ShellRuleCost(unittest.TestCase):
    def test_the_largest_text_scans_fast(self):
        # One scan of the largest text against the guard's relative speed
        # bound (test_guard_parity: R x the prose reference, Q1 retry).
        from test_guard_parity import assert_scan_under_bound, time_pair  # noqa: E402
        for name, body in _scan_units().items():
            with self.subTest(name):
                assert_scan_under_bound(self, name, lambda: time_pair(body, _scan_or_limit, 1))


if __name__ == "__main__":
    unittest.main()
