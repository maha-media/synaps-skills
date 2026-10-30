#!/usr/bin/env python3
"""The rule-1 guard's wiring (guard.rule1_check, roster.FleetRoster and the
extension's before_tool_call): refusal texts, the texts it reads (bash and
shell_start commands, shell_send inputs; never write/edit content), scope by
the fleet roster (fail closed), modes, limits, R-GATE (no key, guard off,
a denied budget), the shared hook budget, audit and status. Offline; every
command is TEXT given to the guard, never executed.

    PYTHONDONTWRITEBYTECODE=1 taskset -c 6-15 python3 -B -m unittest discover -s tests -p 'test_rule1_guard.py' -v
"""
from __future__ import annotations

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
import jev_test_home  # noqa: F401,E402  (keeps the suite out of the real Allow-once store)
sys.path.insert(0, HERE)

from jev import audit as audit_mod  # noqa: E402
from jev import commands, guard, roster, rule1, shell_rules  # noqa: E402
from test_shell_rule import RecordingClient, _DeniedClient  # noqa: E402

CANARY = "CANARY_51c0de"
MASTER = "20261019-000000-aaaa"
FOREMAN = "20261019-000000-ffff"
WORKER = "20261019-000000-bbbb"
NESTED_WORKER = "20261019-000000-cccc"
JR = "20261019-000000-jjjj"

ROSTER = (f'schema = "pria.fleet.roster/2"\n\n[master]\nsession = "{MASTER}"\n\n'
          f'[[team]]\nproject = "p"\nforeman = "{FOREMAN}"\n')
TEAM = (f'schema = "pria.fleet.team/1"\nforeman = "{FOREMAN}"\n\n'
        f'[[worker]]\nsession = "{WORKER}"\nname = "Y"\n\n[[worker]]\nsession = ""\nname = "unset"\n')
NESTED_TEAM = f'foreman = "{FOREMAN}"\n[[worker]]\nsession = "{NESTED_WORKER}"\n'

HEREDOC = "cat > f.sh <<'EOF'\necho hi\nEOF"
HEAD = "jev: blocked by the rule-1 guard (decided locally, no model call)"
ROSTER_NOTE = "(the fleet roster could not be read, so this rule applies to every session)"


def make_fleet(base: Path) -> Path:
    fleet = base / "fleet"
    (fleet / "projects" / "a").mkdir(parents=True)
    (fleet / "projects" / "b" / "teams" / "c").mkdir(parents=True)
    (fleet / "roster.toml").write_text(ROSTER)
    (fleet / "projects" / "a" / "team.toml").write_text(TEAM)
    (fleet / "projects" / "b" / "teams" / "c" / "team.toml").write_text(NESTED_TEAM)
    return fleet


def bump_mtime(path: Path) -> None:
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))


class FleetCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="jev-rule1-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.fleet = make_fleet(self.base)
        patcher = mock.patch.object(roster, "FLEET_DIR", str(self.fleet))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.audit_path = self.base / "audit.jsonl"
        self.audit = audit_mod.Audit(str(self.audit_path))
        self.logs = []
        self.cfg = guard.GuardConfig({"guard_confirm": "prompt"})  # today's confirms (auto: test_guard_confirm_auto)

    def check(self, tool, tool_input, session=WORKER, cfg=None, started=None, **extra):
        cfg = cfg or (guard.GuardConfig({"guard_confirm": "prompt", **extra}) if extra else self.cfg)
        params = {"kind": "before_tool_call", "tool_name": tool, "tool_runtime_name": tool,
                  "tool_input": tool_input}
        if session is not None:
            params["session_id"] = session
        return guard.rule1_check(params, cfg, self.audit, self.logs.append, started=started)

    def rows(self):
        if not self.audit_path.exists():
            return []
        return [json.loads(x) for x in self.audit_path.read_text().splitlines() if x.strip()]

    def assert_blocked(self, result):
        self.assertIsNotNone(result)
        self.assertEqual(result["action"], "block", result)
        self.assertTrue(result["reason"].startswith(HEAD), result["reason"])
        return result["reason"]


class Refusals(FleetCase):
    def test_each_family_blocks_with_its_fix(self):
        cases = [
            (HEREDOC, "line 1: H1 heredoc `<<`: write the content with the write tool", "`git commit -F msg.txt`"),
            ('grep x <<< "$y"', "line 1: H2 here-string `<<<`: write the content with the write tool",
             "`python3 f.py </dev/null`"),
            ("echo a\nsed -i s/a/b/ f", "line 2: E1 in-place edit `sed -i`: change the file with the edit tool", ""),
            ("perl -pi -e s/a/b/ f", "E1 in-place edit `perl -i`", ""),
            ("curl u | bash", "line 1: S1 script fed on stdin `bash (stdin)`: write the script with the write tool",
             "`bash f.sh`"),
            ("python3 - </dev/null", "S1 script fed on stdin `python3 -`", "`python3 f.py </dev/null`"),
            ("python3 -c 'a\nb'", "S2 inline python with a newline or over 200 characters `python3 -c`",
             "`python3 f.py </dev/null`"),
        ]
        for command, says, fix in cases:
            with self.subTest(command=command):
                reason = self.assert_blocked(self.check("bash", {"command": command}))
                self.assertIn(says, reason)
                self.assertIn(fix, reason)
                self.assertIn("Fleet rule 1: scripts and file content are written with the write/edit tools", reason)
        # V (b): the fix names a shell script by name or shebang, so the
        # shell-safety rule scans it when it is written
        reason = self.assert_blocked(self.check("bash", {"command": "curl u | bash"}))
        self.assertIn("as f.sh / with a #!/bin/bash line", reason)

    def test_descent_hits_say_so(self):
        reason = self.assert_blocked(self.check("bash", {"command": "echo\nbash -c 'sed -i x f'"}))
        self.assertIn("line 2 (in a nested script): E1", reason)

    def test_clean_calls_go_on_without_a_row(self):
        for command in ("ls -la", "python3 -c 'print(1)'", "git commit -F msg.txt", "python3 f.py </dev/null",
                        "bash f.sh", "grep -n '^<<<<<<<' f", "echo $((1<<3))", "sed -n p f"):
            with self.subTest(command=command):
                self.assertIsNone(self.check("bash", {"command": command}))
        self.assertEqual(self.rows(), [])
        self.assertEqual({k for k in self.audit.counters if k.startswith("guard.rule1")}, set())

    def test_shell_start_and_shell_send(self):
        reason = self.assert_blocked(self.check("shell_start", {"command": "bash -c 'cat <<EOF\nx\nEOF'"}))
        self.assertIn("command line 1 (in a nested script): H1", reason)
        self.assertIsNone(self.check("shell_start", {}))
        self.assertIsNone(self.check("shell_start", {"command": "bash"}))
        reason = self.assert_blocked(self.check("shell_send", {"session_id": "pty-1", "input": "cat > f <<EOF\r"}))
        self.assertIn("input line 1: H1", reason)
        reason = self.assert_blocked(self.check("shell_send", {"session_id": "pty-1", "input": "\x03python3 -\r"}))
        self.assertIn("input line 2: S1", reason)
        self.assertIsNone(self.check("shell_send", {"session_id": "pty-1", "input": "ls\r"}))
        self.assertIsNone(self.check("shell_send", {"session_id": "pty-1", "input": "\x03"}))

    def test_write_edit_and_other_tools_are_never_read(self):
        script = "#!/bin/bash\nset -euo pipefail\n" + HEREDOC + "\nsed -i x f\n"
        for tool, tool_input in (("write", {"path": "x.sh", "content": script}),
                                 ("edit", {"path": "x.sh", "old_string": "a", "new_string": script}),
                                 ("multi_edit", {"edits": [{"path": "x.sh", "op": "append", "text": script}]}),
                                 ("read", {"path": HEREDOC}),
                                 ("send_events", {"messages": [{"session": "s", "body": HEREDOC}]}),
                                 ("subagent_start", {"task": HEREDOC}),
                                 ("bash", "not a dict"), ("bash", {"command": None}), ("bash", {})):
            with self.subTest(tool=tool):
                self.assertIsNone(self.check(tool, tool_input))

    def test_one_hit_per_place(self):
        reason = self.assert_blocked(self.check("bash", {"command": "sed -i x f; sed -i y f"}))
        self.assertEqual(reason.count("E1 in-place edit"), 1)
        reason = self.assert_blocked(self.check("bash", {"command": "\n".join(f"sed -i x{i} f" for i in range(9))}))
        self.assertIn("and 3 more", reason)


class Modes(FleetCase):
    def test_mode_and_scope_values(self):
        for value, mode in ((None, "block"), ("block", "block"), ("Warn", "warn"), (" off ", "off"),
                            ("bogus", "block"), ("", "block"), (0, "block")):
            with self.subTest(guard_rule1=value):
                self.assertEqual(guard.GuardConfig({"guard_rule1": value}).rule1, mode)
        for value, scope in ((None, "fleet"), ("all", "all"), ("ALL ", "all"), ("everyone", "fleet"), ("", "fleet")):
            with self.subTest(guard_rule1_scope=value):
                self.assertEqual(guard.GuardConfig({"guard_rule1_scope": value}).rule1_scope, scope)

    def test_warn_logs_and_counts_only(self):
        self.assertIsNone(self.check("bash", {"command": HEREDOC + "\nsed -i x f"}, guard_rule1="warn"))
        self.assertEqual(self.audit.counters.get("guard.rule1.warn"), 1)
        self.assertEqual((self.audit.counters.get("guard.rule1.H1"), self.audit.counters.get("guard.rule1.E1")),
                         (1, 1))
        self.assertIsNone(self.audit.counters.get("guard.rule1.block"))
        row = self.rows()[-1]
        self.assertEqual((row["action"], row["rule"]), ("warn", "rule1"))
        self.assertTrue(any("warn" in line and "rule-1 guard" in line for line in self.logs))
        # a limit in warn mode goes on too
        self.assertIsNone(self.check("bash", {"command": "echo " + "$(" * 100}, guard_rule1="warn"))

    def test_off_reads_nothing(self):
        with mock.patch.object(rule1, "scan_rule1", side_effect=AssertionError("scanned")):
            self.assertIsNone(self.check("bash", {"command": HEREDOC}, guard_rule1="off"))
        self.assertEqual(self.rows(), [])

    def test_unknown_mode_blocks(self):
        self.assert_blocked(self.check("bash", {"command": HEREDOC}, guard_rule1="bogus"))


class Scope(FleetCase):
    def test_roster_sessions_are_in_scope(self):
        for session in (MASTER, FOREMAN, WORKER, NESTED_WORKER):
            with self.subTest(session=session):
                self.assert_blocked(self.check("bash", {"command": HEREDOC}, session=session))

    def test_other_sessions_are_not(self):
        self.assertIsNone(self.check("bash", {"command": HEREDOC}, session=JR))
        self.assertIsNone(self.check("bash", {"command": HEREDOC}, session="another-session"))
        self.assertEqual(self.audit.counters.get("guard.rule1.out_of_scope"), 2)
        self.assertEqual(self.rows(), [])

    def test_scope_all_covers_every_session(self):
        self.assert_blocked(self.check("bash", {"command": HEREDOC}, session=JR, guard_rule1_scope="all"))

    def test_a_missing_session_id_is_in_scope(self):
        for session in (None, "", "  "):
            with self.subTest(session=session):
                self.assert_blocked(self.check("bash", {"command": HEREDOC}, session=session))
        self.assertEqual(self.audit.counters.get("guard.rule1.no_session"), 3)

    def test_an_unreadable_roster_fails_closed_and_warns_once_per_change(self):
        team = self.fleet / "projects" / "a" / "team.toml"
        team.write_text("foreman = [unclosed\n")
        bump_mtime(team)
        for _ in range(2):
            reason = self.assert_blocked(self.check("bash", {"command": HEREDOC}, session=JR))
            self.assertTrue(reason.endswith(ROSTER_NOTE), reason)
        warns = [line for line in self.logs if "WARN fleet roster unreadable" in line]
        self.assertEqual(len(warns), 1)
        self.assertIn("cannot parse projects/a/team.toml", warns[0])
        self.assertEqual(self.audit.counters.get("guard.rule1.roster_unreadable"), 2)
        team.write_text(TEAM)
        bump_mtime(team)
        self.assertIsNone(self.check("bash", {"command": HEREDOC}, session=JR))
        self.assertEqual(sum("readable again" in line for line in self.logs), 1)

    def test_each_kind_of_bad_roster_fails_closed(self):
        roster_toml = self.fleet / "roster.toml"
        for name, text in (("no master", '[[team]]\nforeman = "x"\n'), ("bad toml", "[master\n"),
                           ("not utf-8", None)):
            with self.subTest(name):
                if text is None:
                    roster_toml.write_bytes(b"\xff\xfe[master]\n")
                else:
                    roster_toml.write_text(text)
                bump_mtime(roster_toml)
                self.assert_blocked(self.check("bash", {"command": HEREDOC}, session=JR,
                                               cfg=guard.GuardConfig({})))
        roster_toml.unlink()
        self.assert_blocked(self.check("bash", {"command": HEREDOC}, session=JR, cfg=guard.GuardConfig({})))
        roster_toml.write_text(ROSTER)
        (self.fleet / "projects").rename(self.fleet / "projects-away")
        self.assert_blocked(self.check("bash", {"command": HEREDOC}, session=JR, cfg=guard.GuardConfig({})))

    def test_a_changed_team_file_is_read_again(self):
        self.assertIsNone(self.check("bash", {"command": HEREDOC}, session=JR))
        team = self.fleet / "projects" / "a" / "team.toml"
        team.write_text(TEAM + f'\n[[worker]]\nsession = "{JR}"\n')
        bump_mtime(team)
        self.assert_blocked(self.check("bash", {"command": HEREDOC}, session=JR))

    def test_a_new_team_file_is_found_on_a_miss(self):
        now = [100.0]
        r = roster.FleetRoster(self.fleet, clock=lambda: now[0])
        self.assertEqual(r.lookup(JR), (False, "unlisted"))
        (self.fleet / "projects" / "new").mkdir()
        (self.fleet / "projects" / "new" / "team.toml").write_text(f'foreman = "{JR}"\n')
        now[0] += roster.MISS_REWALK_S / 2
        self.assertEqual(r.lookup(JR), (False, "unlisted"))  # searched again at most every MISS_REWALK_S
        now[0] += roster.MISS_REWALK_S
        self.assertEqual(r.lookup(JR), (True, "listed"))
        # a removed team file drops its sessions on the next search
        (self.fleet / "projects" / "new" / "team.toml").unlink()
        self.assertEqual(r.lookup(JR), (False, "unlisted"))
        self.assertEqual(r.lookup(WORKER), (True, "listed"))

    def test_no_fleet_on_the_host_matches_no_session(self):
        cfg = guard.GuardConfig({})
        cfg.roster = roster.FleetRoster(self.base / "no-such-fleet")
        for session in (JR, WORKER, None):
            self.assertIsNone(self.check("bash", {"command": HEREDOC}, session=session, cfg=cfg))
        self.assertEqual(sum("no fleet on this host" in line for line in self.logs), 1)

    def test_the_roster_is_read_only_when_there_is_something_to_refuse(self):
        self.cfg.roster = mock.Mock(wraps=self.cfg.roster)
        self.assertIsNone(self.check("bash", {"command": "ls -la"}))
        self.cfg.roster.lookup.assert_not_called()
        self.assert_blocked(self.check("bash", {"command": HEREDOC}))
        self.assertEqual(self.cfg.roster.lookup.call_count, 1)


class Limits(FleetCase):
    def test_a_shape_limit_blocks_with_the_fix(self):
        reason = self.assert_blocked(self.check("bash", {"command": "echo " + "$(" * 100}))
        self.assertIn("could not be checked (too complex to check: code nested too deeply)", reason)
        self.assertIn("write the script with the write tool", reason)
        big = "echo " + "x" * guard.SHELL_SCAN_MAX_BYTES
        reason = self.assert_blocked(self.check("bash", {"command": big}))
        self.assertIn("too large", reason)
        self.assertEqual(self.audit.counters.get("guard.rule1.limit"), 2)

    def test_hits_before_a_limit_decide(self):
        reason = self.assert_blocked(self.check("bash", {"command": "sed -i x f\necho " + "$(" * 100}))
        self.assertIn("line 1: E1", reason)
        self.assertIn("the rest of the text could not be checked", reason)

    def test_a_limit_is_its_own_class(self):
        self.assertFalse(issubclass(rule1.Rule1Limit, shell_rules.ScanLimit))

    def test_the_host_stopping_the_scan_confirms(self):
        with mock.patch.object(guard, "hard_timer_available", return_value=False):
            result = self.check("bash", {"command": HEREDOC})
        self.assertEqual(result["action"], "confirm")
        self.assertIn("could not check this bash call (deadline unavailable)", result["message"])
        result = self.check("bash", {"command": HEREDOC}, started=time.monotonic() - 60)
        self.assertEqual(result["action"], "confirm")
        self.assertIn("(hook budget spent)", result["message"])

    def test_an_internal_error_confirms_without_its_text(self):
        with mock.patch.object(rule1, "scan_rule1", side_effect=RuntimeError(CANARY)):
            result = self.check("bash", {"command": f"echo {CANARY}"})
        self.assertEqual(result["action"], "confirm")
        self.assertIn("(internal error)", result["message"])
        self.assertNotIn(CANARY, result["message"] + "\n".join(self.logs) + json.dumps(self.rows()))


class AuditRows(FleetCase):
    def test_metadata_only(self):
        command = f"# {CANARY}\ncat <<'{CANARY}'\n{CANARY}\n{CANARY}\nsed -i{CANARY} x f"
        reason = self.assert_blocked(self.check("bash", {"command": command}))
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row["op"], row["tool"], row["action"], row["rule"]), ("guard", "bash", "block", "rule1"))
        self.assertEqual(row["hits"], [{"family": "H1", "token": "<<", "line": 2, "descent": False,
                                        "where": "command"},
                                       {"family": "E1", "token": "sed -i", "line": 5, "descent": False,
                                        "where": "command"}])
        self.assertEqual((row["hits_total"], row["stopped"], row["scope"], row["scope_match"], row["session"]),
                         (2, None, "fleet", "listed", WORKER))
        text = self.audit_path.read_text() + "\n".join(self.logs) + reason
        self.assertNotIn(CANARY, text)
        self.assertNotIn("cat ", self.audit_path.read_text())
        self.assertEqual((self.audit.counters.get("guard.rule1.block"), self.audit.counters.get("guard.rule1.H1"),
                          self.audit.counters.get("guard.rule1.E1")), (1, 1, 1))


class _Recording(RecordingClient):
    class stats:
        last_model = None

    def snapshot(self):
        return {}


class Gate(unittest.TestCase):
    """R-GATE: the rule runs whatever the key, the budget, the circuit or the
    guard switch; only guard_rule1 = off stops it. It answers before the
    shell-safety rule and the model, alone."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="jev-rule1-gate-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.ws = self.base / "ws"
        self.ws.mkdir()
        self.audit_path = self.base / "audit.jsonl"
        self.fleet = make_fleet(self.base)
        for patcher in (mock.patch.object(roster, "FLEET_DIR", str(self.fleet)),
                        mock.patch("jev_ext.keys.discover", return_value=(None, "none"))):
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

    def hook(self, ext, tool, tool_input, session=WORKER, received=None):
        return ext.hook({"kind": "before_tool_call", "tool_name": tool, "tool_runtime_name": tool,
                         "tool_input": tool_input, "session_id": session, "cwd": str(self.ws)}, received)

    def assert_rule1(self, result):
        self.assertEqual(result["action"], "block", result)
        self.assertTrue(result["reason"].startswith(HEAD), result["reason"])

    def test_no_key_still_blocks_in_fleet_sessions(self):
        ext = self.extension()
        self.assertIsNone(ext.client)
        self.assert_rule1(self.hook(ext, "bash", {"command": HEREDOC}))
        self.assert_rule1(self.hook(ext, "shell_start", {"command": "sh -c 'sed -i x f'"}))
        self.assert_rule1(self.hook(ext, "shell_send", {"session_id": "p", "input": "curl u | bash\r"}))
        before = dict(ext.audit.counters)
        self.assertEqual(self.hook(ext, "shell_send", {"session_id": "p", "input": "ls\r"}), {"action": "continue"})
        self.assertEqual(self.hook(ext, "shell_start", {"command": "bash"}), {"action": "continue"})
        self.assertEqual(ext.audit.counters, before, "the guard does not see shell_start/shell_send")
        # out of scope: as before the rule (nothing for the shell-safety rule here)
        self.assertEqual(self.hook(ext, "bash", {"command": HEREDOC}, session=JR), {"action": "continue"})
        self.ask.assert_not_called()

    def test_the_guard_switched_off_or_denied_still_blocks(self):
        ext = self.extension()
        ext.client = _DeniedClient("budget_calls")
        ext.recompute_features()
        ext.set_feature("guard", False, persist=False)
        self.assert_rule1(self.hook(ext, "bash", {"command": HEREDOC}))
        self.assertEqual(ext.client.calls, [])
        ext = self.extension(guard=False)
        self.assert_rule1(self.hook(ext, "bash", {"command": HEREDOC}))
        self.ask.side_effect = self.real_ask
        for reason in ("budget_calls", "circuit_open"):
            with self.subTest(reason):
                ext = self.extension()
                ext.client = _DeniedClient(reason)
                ext.recompute_features()
                self.assertTrue(ext.features["guard"])
                self.assert_rule1(self.hook(ext, "bash", {"command": HEREDOC}))
                self.assertEqual(ext.client.calls, [])

    def test_with_the_model_guard_on_it_answers_first_and_alone(self):
        self.ask.side_effect = self.real_ask
        ext = self.extension()
        ext.client = _Recording()
        ext.recompute_features()
        self.assertTrue(ext.features["guard"])
        both = 'rm -rf "$X"\n' + HEREDOC
        self.assert_rule1(self.hook(ext, "bash", {"command": both}))
        self.assertEqual(ext.client.calls, [])
        # out of scope, the shell-safety rule answers as before
        result = self.hook(ext, "bash", {"command": both}, session=JR)
        self.assertEqual(result["action"], "block")
        self.assertIn("shell-safety rule", result["reason"])
        # nothing to refuse: the model is asked as before
        self.assertEqual(self.hook(ext, "bash", {"command": "ls"})["action"], "continue")
        self.assertEqual(len(ext.client.calls), 1)

    def test_only_guard_rule1_off_stops_it(self):
        ext = self.extension(guard_rule1="off")
        self.assertEqual(self.hook(ext, "bash", {"command": HEREDOC}), {"action": "continue"})
        ext = self.extension(guard_rule1="warn")
        self.assertEqual(self.hook(ext, "bash", {"command": HEREDOC}), {"action": "continue"})
        self.assertEqual(ext.audit.counters.get("guard.rule1.warn"), 1)
        ext = self.extension(guard_tools="read")  # guard_tools does not narrow it
        self.assert_rule1(self.hook(ext, "bash", {"command": HEREDOC}))

    def test_the_budget_runs_from_frame_receipt(self):
        ext = self.extension()
        result = self.hook(ext, "bash", {"command": HEREDOC}, received=time.monotonic() - 60)
        self.assertEqual(result["action"], "confirm")
        self.assertIn("hook budget spent", result["message"])

    def test_the_manifest_hooks_the_pty_tools_for_this_rule_only(self):
        manifest = json.loads((Path(ROOT) / ".synaps-plugin" / "plugin.json").read_text())["extension"]
        hooked = {h.get("tool") for h in manifest["hooks"] if h["hook"] == "before_tool_call"}
        self.assertTrue({"bash", "shell_start", "shell_send"} <= hooked)
        keys = {c["key"]: c for c in manifest["config"]}
        self.assertEqual((keys["guard_rule1"]["default"], keys["guard_rule1_scope"]["default"]), ("block", "fleet"))
        self.assertFalse({"shell_start", "shell_send"} & guard.GuardConfig({}).tools)
        default = {t.strip() for t in keys["guard_tools"]["default"].split(",")}
        self.assertFalse({"shell_start", "shell_send"} & default)


class Replies(unittest.TestCase):
    def setUp(self):
        import jev_ext
        self.ext = jev_ext.Extension()
        self.ext.cfg = {"guard": True}
        self.ext.client = _Recording()
        self.ext.recompute_features()
        self.events = []

    def run_cmd(self, *args):
        self.events.clear()
        commands.handle({"request_id": "t", "args": list(args)}, self.ext,
                        lambda o: self.events.append(o["params"]["event"]), lambda m, p: {"ok": True})
        return json.dumps(self.events)

    def test_guard_off_says_what_the_rule1_guard_does(self):
        for cfg, says in (({}, "The rule-1 guard keeps running: in fleet sessions it blocks heredocs"),
                          ({"guard_rule1_scope": "all"}, "in every session it blocks"),
                          ({"guard_rule1": "warn"}, "it logs (warn mode)"),
                          ({"guard_rule1": "off"}, "The rule-1 guard is switched off as well (`guard_rule1 = off`).")):
            for args in (("guard", "off"), ("off",)):
                with self.subTest(cfg=cfg, args=args):
                    self.ext.guard_cfg = guard.GuardConfig(cfg)
                    text = self.run_cmd(*args)
                    self.assertIn(says, text)
                    if cfg.get("guard_rule1") != "off":
                        self.assertIn("set `guard_rule1 = off` to stop it", text)
        self.assertNotIn("rule-1", self.run_cmd("guard", "on"))

    def test_status_shows_the_per_family_counters(self):
        for key in ("guard.rule1.H1", "guard.rule1.H1", "guard.rule1.S2", "guard.rule1.block"):
            self.ext.audit.bump(key)
        self.ext.client = None
        with mock.patch("jev.commands.keys.discover", return_value=(None, "none")):
            text = self.run_cmd("status")
        self.assertIn("rule-1 guard", text)
        self.assertIn("block, scope fleet", text)
        self.assertIn("H1 2 \\u00b7 H2 0 \\u00b7 E1 0 \\u00b7 S1 0 \\u00b7 S2 1", text)
        self.assertIn("blocked 1", text)


if __name__ == "__main__":
    unittest.main()
