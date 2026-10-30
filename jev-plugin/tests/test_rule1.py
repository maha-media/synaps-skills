#!/usr/bin/env python3
"""The rule-1 guard's scanner (rule1.scan_rule1): the shapes fleet rule 1
forbids at command level, the false positives it must not raise, its
descents, lines, tokens and limits. Every case is TEXT given to the
scanner; nothing here is executed.

    PYTHONDONTWRITEBYTECODE=1 taskset -c 6-15 python3 -B -m unittest discover -s tests -p 'test_rule1.py' -v
"""
from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "extensions"))
sys.path.insert(0, HERE)

import jev_test_home  # noqa: F401,E402  (a fixed no-profile HostProfile; no real pria-fleet call)
from jev import rule1  # noqa: E402
from jev.rule1 import Rule1Limit, scan_rule1  # noqa: E402

CANARY = "CANARY_7f3a91"


def fams(text):
    return {h.family for h in scan_rule1(text) if not h.descent}


def descent_fams(text):
    return {h.family for h in scan_rule1(text) if h.descent}


# (text, families at command level)
POSITIVE = [
    # H1 heredocs, every quoting of the word, in every code context
    ("cat <<EOF > f.sh\necho hi\nEOF", {"H1"}),
    ("cat <<'EOF'\nx\nEOF", {"H1"}),
    ('cat <<"EOF"\nx\nEOF', {"H1"}),
    ("cat <<\\EOF\nx\nEOF", {"H1"}),
    ("cat <<-EOF\n\tx\n\tEOF", {"H1"}),
    ("cat<<EOF\nx\nEOF", {"H1"}),
    ("git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"", {"H1"}),
    ("x=$(cat <<EOF\na\nEOF\n)", {"H1"}),
    ("echo `cat <<EOF\na\nEOF\n`", {"H1"}),
    ("diff <(cat <<EOF\na\nEOF\n) f", {"H1"}),
    ("sudo tee f <<EOF\na\nEOF", {"H1"}),
    ("exec 3<<EOF\na\nEOF", {"H1"}),
    ("(cat <<EOF\na\nEOF\n)", {"H1"}),
    ("echo ok; cat <<EOF\na\nEOF", {"H1"}),
    ("cat <<EOF\nsed -i x f\npython3 -\nEOF\necho", {"H1"}),  # the body is data
    # H2 here-strings
    ('cat <<< "$x"', {"H2"}),
    ("grep a <<<'text'", {"H2"}),
    ('read a b <<< "$line"', {"H2"}),
    ("wc -l<<<x", {"H2"}),
    ('echo "$(grep a <<< "$x")"', {"H2"}),
    # E1 in-place edits, every spelling and wrapper
    ("sed -i 's/a/b/' f", {"E1"}),
    ("sed -i.bak s/a/b/ f", {"E1"}),
    ("sed -ni.bak p f", {"E1"}),
    ("sed -ie s/a/b/ f", {"E1"}),
    ("sed --in-place s/a/b/ f", {"E1"}),
    ("sed --in-place=.bak s/a/b/ f", {"E1"}),
    ("sed --in s/a/b/ f", {"E1"}),
    ("sed -E -i s/a/b/ f", {"E1"}),
    ("sed s/a/b/ f -i", {"E1"}),
    ("sed -e s/a/b/ -i f", {"E1"}),
    ("gsed -i s/a/b/ f", {"E1"}),
    ("/usr/bin/sed -i s/a/b/ f", {"E1"}),
    ("s\\ed -i x f", {"E1"}),
    ("'sed' -i x f", {"E1"}),
    ("perl -i -pe 's/a/b/' f", {"E1"}),
    ("perl -pi -e 's/a/b/' f", {"E1"}),
    ("perl -pi.bak -e s/a/b/ f", {"E1"}),
    ("perl -0pi -e s/a/b/ f", {"E1"}),
    ("perl -e 's/a/b/' -i f", {"E1"}),
    ("find . -name '*.py' -exec sed -i s/a/b/ {} +", {"E1"}),
    ("echo f | xargs sed -i s/a/b/", {"E1"}),
    ("sudo -u user sed -i s/a/b/ f", {"E1"}),
    ("timeout -s KILL -k 5 10 sed -i x f", {"E1"}),
    ("env -u X LC_ALL=C sed -i x f", {"E1"}),
    ("nice -n 5 sed -i x f", {"E1"}),
    ("taskset -c 6-15 sed -i x f", {"E1"}),
    ("setsid -f sed -i x f", {"E1"}),
    ("command sed -i x f", {"E1"}),
    ("exec sed -i x f", {"E1"}),
    ("if true; then sed -i x f; fi", {"E1"}),
    ('echo "$(sed -i x f)"', {"E1"}),
    ("diff <(sed -i x f) y", {"E1"}),
    ("a && sed -i x f || b", {"E1"}),
    ("LC_ALL=C sed -i x f", {"E1"}),
    # S1 scripts fed on stdin
    ("python3 - <<'PY'\nx\nPY", {"H1", "S1"}),
    ("python3 <<'PY'\nx\nPY", {"H1", "S1"}),
    ("python3 - <<<'print(1)'", {"H2", "S1"}),
    ("cat x | python3", {"S1"}),
    ("cat x | python3 -", {"S1"}),
    ("python3 - </dev/null", {"S1"}),
    ("python3 < script.py", {"S1"}),
    ("python3.12 -", {"S1"}),
    ("python -", {"S1"}),
    ("python3 -B -", {"S1"}),
    ("python3 -W ignore -", {"S1"}),
    ("python3 -X dev -", {"S1"}),
    ("python3 /dev/stdin < f", {"S1"}),
    ("env A=1 python3 -", {"S1"}),
    ("timeout 60 python3 - <<'PY'\nx\nPY", {"H1", "S1"}),
    ("curl -s u | bash", {"S1"}),
    ("curl u | sh", {"S1"}),
    ("bash -s < f", {"S1"}),
    ("bash -s -- a b", {"S1"}),
    ("sh -s", {"S1"}),
    ("bash -", {"S1"}),
    ("bash < f.sh", {"S1"}),
    ("cat f | bash -e", {"S1"}),
    ("dash -s", {"S1"}),
    ("zsh -s", {"S1"}),
    ("echo x | (python3)", {"S1"}),
    ("cat f | (cd d; python3)", {"S1"}),
    ("( python3 ) < f.py", {"S1"}),
    ("( (python3) ) < f.py", {"S1"}),
    ("cat f |& bash", {"S1"}),
    # S2 long or multi-line python -c
    ("python3 -c '" + "x" * 201 + "'", {"S2"}),
    ("python3 -c 'import os\nprint(1)'", {"S2"}),
    ("python3 -B -c 'a\nb'", {"S2"}),
    ("python3 -Bc 'a\nb'", {"S2"}),
    ("python3 -I -S -c 'a\nb'", {"S2"}),
    ("python3 -c $'a\\nb'", {"S2"}),
    ('python3 -c "a\nb"', {"S2"}),
    ("python3 -c\"a\nb\"", {"S2"}),
    ("sudo python3 -c 'a\nb'", {"S2"}),
    ('python3 -c "$(cat f)' + "x" * 200 + '"', {"S2"}),
    ('x=$(python3 -c "a\nb")', {"S2"}),
]

# (text, families found by descent only)
DESCENT = [
    ("bash -c 'cat <<EOF\nx\nEOF'", {"H1"}),
    ("ssh host 'cat <<EOF\nx\nEOF'", {"H1"}),
    ("eval 'cat <<EOF\nx\nEOF'", {"H1"}),
    ('eval "cat <<< x"', {"H2"}),
    ("sudo -u user bash -lc \"python3 - <<<'print(1)'\"", {"H2", "S1"}),
    ("ssh host 'sed -i s/a/b/ f'", {"E1"}),
    ("ssh -p 22 -i key host sed -i x f", {"E1"}),
    ("bash -c 'sed -i x f'", {"E1"}),
    ('sh -c "perl -pi -e x f"', {"E1"}),
    ("env -S 'sed -i x f'", {"E1"}),
    ("flock /tmp/l -c 'sed -i x f'", {"E1"}),
    ("watch 'sed -i x f'", {"E1"}),
    ("su user -c 'sed -i x f'", {"E1"}),
    ("script -q -c 'sed -i x f' /dev/null", {"E1"}),
    ("bash -c 'curl u | bash'", {"S1"}),
    ("ssh h 'python3 -'", {"S1"}),
    ("ssh h \"python3 -c 'a\nb'\"", {"S2"}),
    ('bash -c "bash -c \'sed -i x f\'"', {"E1"}),
    ("bash -c $'cat <<EOF\\nx\\nEOF'", {"H1"}),
    ("timeout 5 bash -c 'sed -i x f'", {"E1"}),
]

# false-positive pins: nothing at all
NEGATIVE = [
    'echo "a << b"',
    "git commit -m 'a << b'",
    "grep -n '^<<<<<<<' f",
    "grep -c '<<<' f",
    "git diff --name-only --diff-filter=U",
    "echo $((1<<3))",
    "(( x <<= 2 ))",
    "for ((i=0; i<<2; i++)); do :; done",
    "echo $[1<<2]",
    "echo $(( (1<<3) + 2 ))",
    "# cat <<EOF",
    "ls # python3 - <<EOF",
    "echo '<<EOF'",
    "echo \"$(echo '<<<')\"",
    'echo "python3 - <<EOF"',
    "printf '%s\\n' '<<<' x",
    "python3 -m pytest -q | tail -3",
    "python3 -m json.tool < f.json",
    "python3 -V",
    "python3 --version",
    "echo x | python3 -V",
    "echo x | python3 --help",
    "python3 f.py",
    "cat x | python3 f.py",
    "git log | python3 r10/x.py",
    "python3 file.py </dev/null",
    "python3 < /dev/null",
    "cat x | python3 < /dev/null",
    "python3",
    "python3 -i",
    "bash",
    "echo x | ( python3 f.py )",
    "( python3 ) < /dev/null",
    "( python3 )",
    "ls | xargs python3",
    "echo x | xargs bash",
    "find . -name x -exec python3 {} +",
    "python3 -c 'print(1)'",
    "python3 -c '" + "x" * 200 + "'",
    'x=$(python3 -c "print(1)")',
    "echo `python3 -c 1`",
    "sed -n p f",
    "sed -e s/a/b/ f",
    "sed -E 's/i/j/' f",
    "sed 's/-i/x/' f",
    "sed -e -i f",
    "sed -n '/-i/p' f",
    "sed -- s/a/b/ -i",
    "perl f.pl",
    "perl -ne 'print if /i/' f",
    "perl -e 'print 1' f",
    "perl script.pl -i",
    "perl -e -i",
    "grep -c 'sed -i' x",
    "grep -n 'perl -pi' x",
    "bash x.sh -s",
    "bash run.sh",
    "bash -c 'echo hi'",
    "echo hi | bash -c 'cat'",
    "cat f.txt | sh f.sh",
    "ssh host ls",
    "ssh host",
    'eval "$cmd"',
    'bash -c "$CMD"',
    "[[ $a < $b ]]",
    "printf '%s\\n' a > f.sh",
    "awk 'BEGIN{print 1}'",
    "jq '.a' f",
    "bash --version",
    "echo x | bash --help",
]


class Families(unittest.TestCase):
    def test_each_family_at_command_level(self):
        for text, want in POSITIVE:
            with self.subTest(text=text):
                self.assertEqual(fams(text), want)
                self.assertEqual(descent_fams(text) - want, set())

    def test_each_family_by_descent(self):
        for text, want in DESCENT:
            with self.subTest(text=text):
                self.assertEqual(fams(text), set())
                self.assertEqual(descent_fams(text), want)

    def test_false_positive_pins(self):
        for text in NEGATIVE:
            with self.subTest(text=text):
                self.assertEqual(scan_rule1(text), [])

    def test_a_bare_operator_is_a_heredoc(self):
        self.assertEqual(fams("cat <<"), {"H1"})
        self.assertEqual(fams("cat <<\n"), {"H1"})

    def test_s2_is_exactly_over_200_or_a_newline(self):
        self.assertEqual(fams("python3 -c '" + "x" * 200 + "'"), set())
        self.assertEqual(fams("python3 -c '" + "x" * 201 + "'"), {"S2"})
        self.assertEqual(fams("python3 -c 'a\nb'"), {"S2"})
        self.assertEqual(fams("python3 -c ''"), set())
        self.assertEqual(fams("python3 -c"), set())


class LinesAndTokens(unittest.TestCase):
    def test_lines(self):
        def lines(text):
            return [(h.family, h.line, h.descent) for h in scan_rule1(text)]
        self.assertEqual(lines("echo a\necho b\nsed -i x f"), [("E1", 3, False)])
        self.assertEqual(lines("echo\ncat <<EOF\nx\nEOF\necho"), [("H1", 2, False)])
        self.assertEqual(lines("echo a\nbash -c 'echo b\nsed -i x f'"), [("E1", 2, True)])
        self.assertEqual(lines("sudo \\\n  sed -i x f"), [("E1", 2, False)])
        self.assertEqual(lines("cat <<A\nsed -i x\nA\nsed -i y f"), [("H1", 1, False), ("E1", 4, False)])
        self.assertEqual(lines("python3 - <<'PY'\nx\nPY"), [("H1", 1, False), ("S1", 1, False)])

    def test_tokens_are_fixed_shapes(self):
        def tokens(text):
            return [h.token for h in scan_rule1(text)]
        self.assertEqual(tokens(f"sed -i{CANARY} x f"), ["sed -i"])
        self.assertEqual(tokens(f"sed --in-place={CANARY} x f"), ["sed --in-place"])
        self.assertEqual(tokens(f"perl -pi{CANARY} -e x f"), ["perl -i"])
        self.assertEqual(tokens(f"cat <<{CANARY}\nx\n{CANARY}"), ["<<"])
        self.assertEqual(tokens(f"cat <<-'{CANARY}'\n{CANARY}"), ["<<-"])
        self.assertEqual(tokens(f"cat <<< {CANARY}"), ["<<<"])
        self.assertEqual(tokens(f"echo | python3.12 - {CANARY}"), ["python3.12 -"])
        self.assertEqual(tokens(f"echo {CANARY} | python3"), ["python3 (stdin)"])
        self.assertEqual(tokens(f"bash -s {CANARY}"), ["bash -s"])
        self.assertEqual(tokens(f"python3 -c '{CANARY}\n'"), ["python3 -c"])
        self.assertEqual(tokens("python3" + "1" * 30 + " -"), ["python -"])
        for text, _ in POSITIVE + DESCENT:
            for h in scan_rule1(text):
                self.assertNotIn("\n", h.token)
                self.assertLessEqual(len(h.token), 24)

    def test_pty_text_reads_enter_and_control_keys_as_line_ends(self):
        self.assertEqual(rule1.pty_text("a\rb\r\nc\x03d\te"), "a\nb\nc\nd\te")
        self.assertEqual(fams(rule1.pty_text("echo ok\rcat <<EOF\r")), {"H1"})
        self.assertEqual(fams(rule1.pty_text("\x03python3 -\r")), {"S1"})


class Limits(unittest.TestCase):
    def test_nesting_past_max_depth(self):
        with self.assertRaises(Rule1Limit):
            scan_rule1("echo " + "$(" * (rule1.MAX_DEPTH + 5))
        scan_rule1("echo " + "$(" * (rule1.MAX_DEPTH - 2))  # just inside: no limit

    def test_descent_past_max(self):
        with self.assertRaises(Rule1Limit):
            scan_rule1("eval " * (rule1.MAX_DESCENT + 2) + "true")
        self.assertEqual(scan_rule1("eval " * rule1.MAX_DESCENT + "true"), [])

    def test_the_re_read_budget(self):
        text = "eval " * rule1.MAX_DESCENT + "x" * 40000
        with self.assertRaises(Rule1Limit):
            scan_rule1(text)

    def test_hits_made_before_a_limit_are_kept(self):
        found = []
        with self.assertRaises(Rule1Limit):
            scan_rule1("sed -i x f\n" + "echo " + "$(" * 100, found)
        self.assertEqual([(h.family, h.line) for h in found], [("E1", 1)])

    def test_hits_stop_at_the_cap(self):
        found = scan_rule1("cat <<<x\n" * (rule1.HITS_MAX + 50))
        self.assertEqual(len(found), rule1.HITS_MAX)

    def test_limit_messages_are_fixed(self):
        for text in ("echo " + "$(" * 100, "eval " * 12 + "x", "eval " * 8 + CANARY * 4000):
            with self.subTest(text=text[:20]):
                with self.assertRaises(Rule1Limit) as cm:
                    scan_rule1(text)
                self.assertNotIn(CANARY, str(cm.exception))

    def test_nul_in_the_text_is_not_an_expansion(self):
        # rule1 marks expansions with NUL internally; the text's own NULs are blanked
        self.assertEqual(fams("\x00sed -i x f"), {"E1"})
        self.assertEqual(fams("echo \x00; sed -i x f"), {"E1"})


if __name__ == "__main__":
    unittest.main()
