#!/usr/bin/env python3
"""Allow once: the access rule's request records and
the owner's answers (extensions/jev/allow_once.py, guard.access_check). Offline;
every command is TEXT given to the scanner, never executed. The store lives
in a temporary HOME.

    PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s tests -p 'test_allow_once.py' -v

Fixtures for Pria Desktop's reader (tests/fixtures/access-ask/) are the
guard's own bytes; regenerate them with JEV_ACCESS_FIXTURES_WRITE=1.
"""
from __future__ import annotations

import json
import os
import re
import stat
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "extensions"))
import jev_test_home  # noqa: F401,E402  (keeps the suite out of the real Allow-once store)
sys.path.insert(0, HERE)

import test_access as ta  # noqa: E402  (HomeCase only: it holds no tests)
from jev import access, allow_once, guard  # noqa: E402
from jev import audit as audit_mod  # noqa: E402

SESSION = "20261020-000000-aaaa"
CHMOD = "chmod g-w ~/Projects"
REQUEST = re.compile(r"Request ([0-9a-f]{32})")
FIXTURES = Path(HERE) / "fixtures" / "access-ask"


class Case(ta.HomeCase):
    def setUp(self):
        super().setUp()
        self.audit_path = Path(self.tmp.name) / "audit.jsonl"
        self.audit = audit_mod.Audit(str(self.audit_path))
        self.logs = []
        self.store = Path(allow_once.root(str(self.home)))
        allow_once._last_prune = 0.0

    def check(self, tool, tool_input, session=SESSION, cwd=None, subagent=None, **cfg):
        params = {"kind": "before_tool_call", "tool_name": tool, "tool_runtime_name": tool,
                  "tool_input": tool_input, "session_id": session, "cwd": str(cwd or self.work)}
        if subagent is not None:
            params["subagent_id"] = subagent
        return guard.access_check(params, guard.GuardConfig(cfg), self.audit, self.logs.append)

    def bash(self, command, **kw):
        return self.check("bash", {"command": command}, **kw)

    def rows(self):
        if not self.audit_path.exists():
            return []
        return [json.loads(x) for x in self.audit_path.read_text().splitlines() if x.strip()]

    def rid(self, result):
        m = REQUEST.search(result["reason"])
        self.assertIsNotNone(m, result["reason"])
        return m.group(1)

    def request(self, rid):
        return json.loads((self.store / "requests" / f"{rid}.json").read_text())

    def answer(self, rid, decision="allow_once", at=None, **over):
        rec = self.request(rid)
        obj = {"v": 1, "id": rid, "fingerprint": rec["fingerprint"], "decision": decision,
               "answered_at": at or allow_once.iso(time.time()), "by": "owner_ui"}
        obj.update(over)
        obj = {k: v for k, v in obj.items() if v is not ...}
        fd = os.open(self.store / "answers" / f"{rid}.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f)
        return obj

    def backdate(self, rid, seconds):
        rec = self.request(rid)
        rec["ts"] = allow_once.iso(time.time() - seconds)
        (self.store / "requests" / f"{rid}.json").write_text(json.dumps(rec))


class Records(Case):
    def test_a_block_writes_one_private_request_record(self):
        result = self.bash(CHMOD)
        self.assertEqual(result["action"], "block")
        self.assertTrue(result["reason"].startswith(ta.HEAD))
        rid = self.rid(result)
        self.assertIn("If they allow it once, run exactly this call again, unchanged, within 30 minutes",
                      result["reason"])
        for d in (self.store, *(self.store / n for n in allow_once.DIRS)):
            self.assertEqual(stat.S_IMODE(os.lstat(d).st_mode), 0o700, d)
        path = self.store / "requests" / f"{rid}.json"
        self.assertEqual(stat.S_IMODE(os.lstat(path).st_mode), 0o600)
        rec = self.request(rid)
        self.assertEqual(rec["fingerprint"], allow_once.fingerprint(SESSION, "bash", str(self.work),
                                                                    {"command": CHMOD}))
        self.assertEqual((rec["v"], rec["id"], rec["kind"], rec["session"], rec["tool"], rec["cwd"]),
                         (1, rid, "block", SESSION, "bash", str(self.work)))
        self.assertEqual((rec["command"], rec["truncated"], rec["allow_once_possible"]), (CHMOD, False, True))
        self.assertEqual(rec["reason"], result["reason"])
        self.assertEqual(allow_once.parse_time(rec["expires_at"]) - allow_once.parse_time(rec["ts"]), 24 * 3600)
        self.assertEqual([h["token"] for h in rec["hits"]], ["chmod"])
        self.assertEqual(os.listdir(self.store / "requests"), [f"{rid}.json"])
        row = self.rows()[-1]
        self.assertEqual((row["rule"], row["action"], row["request"], row["answer"]), ("access", "block", rid, "new"))

    def test_a_retry_before_the_answer_reuses_the_request(self):
        rid = self.rid(self.bash(CHMOD))
        again = self.bash(CHMOD)
        self.assertEqual(self.rid(again), rid)
        self.assertIn("is already waiting for the owner's answer", again["reason"])
        self.assertEqual(len(os.listdir(self.store / "requests")), 1)
        self.assertNotEqual(self.rid(self.bash(CHMOD, session="20261020-000000-bbbb")), rid)

    def test_fingerprint_is_canonical_and_binds_the_call(self):
        a = allow_once.fingerprint("s", "write", "/w", {"path": "p", "content": "c"})
        self.assertEqual(a, allow_once.fingerprint("s", "write", "/w", {"content": "c", "path": "p"}))
        for other in (("t", "write", "/w", {"path": "p", "content": "c"}),
                      ("s", "edit", "/w", {"path": "p", "content": "c"}),
                      ("s", "write", "/x", {"path": "p", "content": "c"}),
                      ("s", "write", "/w", {"path": "p", "content": "c "})):
            self.assertNotEqual(a, allow_once.fingerprint(*other), other)

    def test_a_credential_or_long_text_is_deny_only_and_withheld(self):
        token = "ghp_" + "A1b2C3d4" * 5
        result = self.bash(f"chmod g-w ~/Projects; export GITHUB_TOKEN={token}")
        self.assertIn("can't be allowed once (it holds a credential or is too long", result["reason"])
        rid = self.rid(result)
        rec = self.request(rid)
        self.assertIsNone(rec["command"])
        self.assertIn("holds a credential", rec["withheld"])
        self.assertFalse(rec["allow_once_possible"])
        self.assertNotIn(token, (self.store / "requests" / f"{rid}.json").read_text())
        self.answer(rid)
        self.assertEqual(self.bash(f"chmod g-w ~/Projects; export GITHUB_TOKEN={token}")["action"], "block")
        long = CHMOD + " # " + "x" * 5000
        rec = self.request(self.rid(self.bash(long)))
        self.assertEqual((rec["truncated"], rec["allow_once_possible"], len(rec["command"])), (True, False, 4096))

    def test_shell_send_and_file_tools_show_what_they_change(self):
        rec = self.request(self.rid(self.check("shell_send", {"session_id": "shell_7", "input": CHMOD + "\n"})))
        self.assertEqual((rec["tool"], rec["shell_session"]), ("shell_send", "shell_7"))
        self.assertIn("shell's own cwd may differ", rec["cwd_note"])
        self.assertFalse(rec["allow_once_possible"], "a live shell's cwd can't be bound")
        self.assertIn("can't be allowed once (it is typed into a live shell", rec["reason"])
        unit = self.units / "limit.service"
        unit.write_text("[Service]\nMemoryMax=1G\n")
        rec = self.request(self.rid(self.check("edit", {"path": str(unit), "old_string": "1G", "new_string": "8G"})))
        self.assertEqual(rec["files"], [{"path": str(unit), "op": "change"}])
        self.assertEqual(json.loads(rec["change"])["new_string"], "8G")
        self.assertTrue(rec["allow_once_possible"])

    def test_a_credential_in_a_path_is_withheld_with_the_paths(self):
        token = "ghp_" + "A1b2C3d4" * 5
        result = self.check("write", {"path": str(self.home / ".ssh" / token), "content": "x"})
        rid = self.rid(result)
        text = (self.store / "requests" / f"{rid}.json").read_text()
        self.assertNotIn(token, text)
        rec = json.loads(text)
        self.assertEqual((rec["files"], rec["change"], rec["allow_once_possible"]), ([], None, False))
        self.assertIn("holds a credential", rec["withheld"])
        Path(access.switch_path(str(self.home))).write_text("auto\n")
        (self.sessions / f"{token}.conf").write_text("mode = enforce\n")
        self.assertIsNone(self.check("write", {"path": f"{self.sessions}/{token}.conf", "content": "x"}))
        self.assertEqual(self.rows()[-1]["rule"], "access_auto")
        auto = self.store / "requests" / f"{self.rows()[-1]['request']}.json"
        self.assertNotIn(token, auto.read_text())
        self.assertEqual(json.loads(auto.read_text())["files"], [])

    def test_each_layer_on_its_own(self):
        token = "ghp_" + "A1b2C3d4" * 5
        shown, allowable = allow_once.call_text("write", {"path": f"/x/{token}", "content": "c"})
        self.assertEqual((shown["files"], shown["change"], allowable), ([], None, False))
        allow_once.record_block(str(self.home), "a" * 32, session=SESSION, tool="shell_send", cwd=str(self.work),
                                tool_input={"session_id": "shell_7", "input": CHMOD}, fp="f" * 64, hits=[],
                                reason="r", possible=True, now=time.time())
        self.assertFalse(self.request("a" * 32)["allow_once_possible"])

    def test_no_record_is_written_with_a_credential_left_in_it(self):
        cwd = self.work / ("ghp_" + "A1b2C3d4" * 5)
        result = self.bash(CHMOD, cwd=cwd)
        self.assertIn("(Request not recorded: the request would hold a credential.", result["reason"])
        self.assertEqual(os.listdir(self.store / "requests"), [])

    def test_auto_pass_writes_an_fyi_record_without_text(self):
        Path(access.switch_path(str(self.home))).write_text("auto\n")
        self.assertIsNone(self.check("edit", {"path": f"{self.sessions}/old.conf", "old_string": "mode",
                                              "new_string": "mode"}))
        row = self.rows()[-1]
        self.assertEqual(row["rule"], "access_auto")
        rec = self.request(row["request"])
        self.assertEqual(rec["kind"], "auto")
        self.assertEqual(rec["files"], [{"path": f"{self.sessions}/old.conf", "op": "change"}])
        self.assertNotIn("command", rec)
        self.assertNotIn("change", rec)

    def test_a_store_that_cannot_be_used_still_blocks(self):
        self.store.parent.mkdir(parents=True, exist_ok=True)
        self.store.write_text("not a directory")
        result = self.bash(CHMOD)
        self.assertEqual(result["action"], "block")
        self.assertIn("(Request not recorded: the request store", result["reason"])
        self.assertIsNone(REQUEST.search(result["reason"]))
        self.store.unlink()
        self.store.mkdir(mode=0o750)
        os.chmod(self.store, 0o750)  # the test's own temp dir
        self.assertIn("is not a private directory", self.bash(CHMOD)["reason"])

    def test_prune_removes_week_old_records_only(self):
        rid = self.rid(self.bash(CHMOD))
        old = self.store / "used" / ("e" * 32 + ".json")
        old.write_text("{}")
        week = time.time() - 8 * 24 * 3600
        os.utime(old, (week, week))
        allow_once._last_prune = 0.0
        self.rid(self.bash("chmod o-r ~/Projects"))
        self.assertFalse(old.exists())
        self.assertTrue((self.store / "requests" / f"{rid}.json").exists())


class Answers(Case):
    def test_allow_once_passes_that_exact_call_once(self):
        rid = self.rid(self.bash(CHMOD))
        self.answer(rid)
        self.assertIsNone(self.bash(CHMOD))
        row = self.rows()[-1]
        self.assertEqual((row["rule"], row["action"], row["request"]), ("access_allowed_once", "continue", rid))
        self.assertFalse((self.store / "answers" / f"{rid}.json").exists())
        self.assertTrue((self.store / "used" / f"{rid}.json").exists())
        self.assertEqual(self.audit.counters.get("guard.access.allowed_once"), 1)
        third = self.bash(CHMOD)
        self.assertEqual(third["action"], "block")
        self.assertNotEqual(self.rid(third), rid)

    def test_an_answer_covers_no_other_call(self):
        rid = self.rid(self.bash(CHMOD))
        self.answer(rid)
        for kw in ({"command": CHMOD + " "}, {"command": CHMOD, "session": "20261020-000000-bbbb"},
                   {"command": CHMOD, "cwd": self.shallow}):
            with self.subTest(kw=kw):
                command = kw.pop("command")
                self.assertEqual(self.bash(command, **kw)["action"], "block")
        self.assertTrue((self.store / "answers" / f"{rid}.json").exists(), "not consumed by another call")
        self.assertIsNone(self.bash(CHMOD))

    def test_shell_send_is_never_allowed_once(self):
        call = {"session_id": "shell_7", "input": "sudo chmod g-w .\n"}
        rid = self.rid(self.check("shell_send", call))
        self.answer(rid)
        rec = self.request(rid)
        rec["allow_once_possible"] = True       # even a record that says so
        (self.store / "requests" / f"{rid}.json").write_text(json.dumps(rec))
        self.assertIsNone(self.check("shell_send", {"session_id": "shell_7", "input": "cd /tmp\n"}))
        self.assertEqual(self.check("shell_send", call)["action"], "block")
        self.assertTrue((self.store / "answers" / f"{rid}.json").exists())

    def test_deny_keeps_blocking_without_a_new_request(self):
        rid = self.rid(self.bash(CHMOD))
        self.answer(rid, "deny")
        result = self.bash(CHMOD)
        self.assertIn(f"The owner said no (request {rid}): don't retry it or work around it.", result["reason"])
        self.assertEqual(len(os.listdir(self.store / "requests")), 1)
        self.assertEqual(self.rows()[-1]["answer"], "deny")

    def test_bad_answers_are_ignored(self):
        cases = {
            "extra key": {"note": "x"},
            "by": {"by": "agent"},
            "fingerprint": {"fingerprint": "0" * 64},
            "decision": {"decision": "allow"},
            "version": {"v": 2},
            "no zone": {"answered_at": "2026-10-20T00:00:00"},
            "missing by": {"by": ...},
        }
        for name, over in cases.items():
            with self.subTest(name=name):
                rid = self.rid(self.bash(f"chmod g-w ~/Projects # {name}"))
                self.answer(rid, **over)
                result = self.bash(f"chmod g-w ~/Projects # {name}")
                self.assertEqual(result["action"], "block")
                self.assertTrue((self.store / "answers" / f"{rid}.json").exists())

    def test_answer_files_must_be_plain_small_files(self):
        rid = self.rid(self.bash(CHMOD))
        real = Path(self.tmp.name) / "elsewhere.json"
        rec = self.request(rid)
        real.write_text(json.dumps({"v": 1, "id": rid, "fingerprint": rec["fingerprint"], "decision": "allow_once",
                                    "answered_at": allow_once.iso(time.time()), "by": "owner_ui"}))
        (self.store / "answers" / f"{rid}.json").symlink_to(real)
        self.assertEqual(self.bash(CHMOD)["action"], "block")
        (self.store / "answers" / f"{rid}.json").unlink()
        rid2 = self.rid(self.bash("chmod o-r ~/Projects"))
        rec = self.request(rid2)
        valid = json.dumps({"v": 1, "id": rid2, "fingerprint": rec["fingerprint"], "decision": "allow_once",
                            "answered_at": allow_once.iso(time.time()), "by": "owner_ui"})
        (self.store / "answers" / f"{rid2}.json").write_text(valid + " " * (4097 - len(valid)))
        self.assertEqual(self.bash("chmod o-r ~/Projects")["action"], "block", "a valid answer over 4 KiB")
        (self.store / "answers" / f"{rid2}.json").write_text(valid + " " * (4096 - len(valid)))
        self.assertIsNone(self.bash("chmod o-r ~/Projects"), "the same answer at exactly 4 KiB")

    def test_time_windows(self):
        rid = self.rid(self.bash(CHMOD))
        self.backdate(rid, 3600)
        self.answer(rid, at=allow_once.iso(time.time() - 31 * 60))
        self.assertEqual(self.bash(CHMOD)["action"], "block", "the retry came 31 minutes after the answer")
        rid = self.rid(self.bash("chmod o-r ~/Projects"))
        self.backdate(rid, 25 * 3600)
        self.answer(rid, at=allow_once.iso(time.time() - 60))
        self.assertEqual(self.bash("chmod o-r ~/Projects")["action"], "block", "answered after its 24 h")
        rid = self.rid(self.bash("chmod o-w ~/Projects"))
        self.backdate(rid, 23 * 3600)
        self.answer(rid, at=allow_once.iso(time.time() - 60))
        self.assertIsNone(self.bash("chmod o-w ~/Projects"), "answered within 24 h, retried at once")
        rid = self.rid(self.bash("chmod o-x ~/Projects"))
        self.backdate(rid, 600)
        self.answer(rid, at=allow_once.iso(time.time() - 900))
        self.assertEqual(self.bash("chmod o-x ~/Projects")["action"], "block", "answered before the request")
        rid = self.rid(self.bash("chmod u-x ~/Projects"))
        self.answer(rid, at=allow_once.iso(time.time() + 300))
        self.assertEqual(self.bash("chmod u-x ~/Projects")["action"], "block", "answered in the future")

    def test_changed_hits_block_again(self):
        rid = self.rid(self.bash(CHMOD))
        rec = self.request(rid)
        rec["hits"][0]["why"] = "something else"
        (self.store / "requests" / f"{rid}.json").write_text(json.dumps(rec))
        self.answer(rid)
        result = self.bash(CHMOD)
        self.assertEqual(result["action"], "block")
        self.assertNotEqual(self.rid(result), rid)

    def test_an_edited_preview_with_the_fingerprint_kept_stays_blocked(self):
        """A review finding: a same-user rewrite of the request record can keep its
        fingerprint and show the owner a harmless preview. An Allow once answered
        on such a record is not consumed, and the retried call stays
        blocked under a NEW, honest request."""
        unit = self.units / "limit.service"
        unit.write_text("[Service]\nMemoryMax=1G\n")
        edit = {"path": str(unit), "old_string": "1G", "new_string": "8G"}
        cases = [
            ("bash", {"command": CHMOD}, "command", "echo harmless"),
            ("bash", {"command": CHMOD}, "reason", "nothing to see"),
            ("bash", {"command": CHMOD}, "cwd", "/tmp"),
            ("bash", {"command": CHMOD}, "session", "20261020-000000-bbbb"),
            ("bash", {"command": CHMOD}, "working_directory", "/tmp"),
            ("bash", {"command": CHMOD}, "truncated", True),
            ("edit", edit, "files", [{"path": "/tmp/notes.txt", "op": "change"}]),
            ("edit", edit, "change", json.dumps({"path": "/tmp/notes.txt"})),
        ]
        for tool, tool_input, field, forged in cases:
            with self.subTest(tool=tool, field=field):
                rid = self.rid(self.check(tool, tool_input))
                rec = self.request(rid)
                rec[field] = forged
                (self.store / "requests" / f"{rid}.json").write_text(json.dumps(rec))
                self.answer(rid)
                result = self.check(tool, tool_input)
                self.assertIsNotNone(result, "an Allow once on an edited record must not pass")
                self.assertEqual(result["action"], "block")
                self.assertNotEqual(self.rid(result), rid)
                self.assertTrue((self.store / "answers" / f"{rid}.json").exists(), "not consumed")
                self.assertFalse((self.store / "used" / f"{rid}.json").exists())
        self.assertIsNone(self.audit.counters.get("guard.access.allowed_once"))

    def test_an_unedited_record_still_allows_each_tool_once(self):
        unit = self.units / "limit.service"
        unit.write_text("[Service]\nMemoryMax=1G\n")
        for tool, tool_input in (("bash", {"command": CHMOD}),
                                 ("edit", {"path": str(unit), "old_string": "1G", "new_string": "8G"})):
            with self.subTest(tool=tool):
                rid = self.rid(self.check(tool, tool_input))
                self.answer(rid)
                self.assertIsNone(self.check(tool, tool_input))
                self.assertTrue((self.store / "used" / f"{rid}.json").exists())

    def forge_consistent(self, rid, **over):
        """Rewrite a record the way a careful forger would: allow_once_possible
        True and the refusal text's last line swapped for the open ask, so
        only the layer under test can still refuse it."""
        rec = self.request(rid)
        base = rec["reason"].rsplit("\n", 1)[0]
        rec["reason"] = f"{base}\n{guard._ASK_OPEN.format(id=rid)}"
        rec.update(over)
        (self.store / "requests" / f"{rid}.json").write_text(json.dumps(rec))

    def test_a_consistent_forgery_still_cannot_allow_shell_send(self):
        call = {"session_id": "shell_7", "input": CHMOD + "\n"}
        rid = self.rid(self.check("shell_send", call))
        self.forge_consistent(rid, allow_once_possible=True)
        self.answer(rid)
        self.assertEqual(self.check("shell_send", call)["action"], "block")
        self.assertTrue((self.store / "answers" / f"{rid}.json").exists())

    def test_a_consistent_forgery_still_cannot_allow_a_withheld_call(self):
        command = f"chmod g-w ~/Projects; export GITHUB_TOKEN={'ghp_' + 'A1b2C3d4' * 5}"
        rid = self.rid(self.bash(command))
        self.forge_consistent(rid, allow_once_possible=True)
        self.answer(rid)
        self.assertEqual(self.bash(command)["action"], "block")
        self.assertTrue((self.store / "answers" / f"{rid}.json").exists())

    def test_a_stopped_scan_stays_deny_only_even_with_the_open_ask_forged(self):
        with mock.patch.object(access, "scan_access", side_effect=RuntimeError("boom")):
            rid = self.rid(self.bash("sudo ls"))
            self.assertFalse(self.request(rid)["allow_once_possible"])
            self.forge_consistent(rid)              # allow_once_possible stays False
            self.answer(rid)
            self.assertEqual(self.bash("sudo ls")["action"], "block")
        self.assertTrue((self.store / "answers" / f"{rid}.json").exists())

    def test_a_failed_consume_stays_blocked(self):
        rid = self.rid(self.bash(CHMOD))
        self.answer(rid)
        with mock.patch.object(allow_once.os, "rename", side_effect=OSError("busy")):
            self.assertEqual(self.bash(CHMOD)["action"], "block")
        self.assertIsNone(self.bash(CHMOD))

    def test_store_errors_never_allow(self):
        rid = self.rid(self.bash(CHMOD))
        self.answer(rid)
        with mock.patch.object(allow_once, "lookup", side_effect=RuntimeError("boom " + ta.CANARY)):
            result = self.bash(CHMOD)
        self.assertEqual(result["action"], "block")
        self.assertIn("could not be read", result["reason"])
        self.assertNotIn(ta.CANARY, json.dumps(self.rows()) + " ".join(self.logs))

    def test_warn_mode_writes_nothing(self):
        self.assertIsNone(self.bash(CHMOD, guard_access="warn"))
        self.assertFalse(self.store.exists())

    def extension(self, **cfg):
        import jev_ext
        ext = jev_ext.Extension()
        ext.initialize({"config": {"project_root": str(self.work), "audit_file": str(self.audit_path), **cfg}})
        return ext

    def test_allow_once_skips_only_the_access_rule(self):
        for patcher in (mock.patch("jev_ext.keys.discover", return_value=(None, "none")),
                        mock.patch.object(guard, "_ask", side_effect=AssertionError("a model call"))):
            patcher.start()
            self.addCleanup(patcher.stop)
        ext = self.extension(guard_rule1_scope="all")
        command = "cat > f <<'EOF'\nx\nEOF\nchmod g-w ~/Projects"
        params = {"kind": "before_tool_call", "tool_name": "bash", "tool_runtime_name": "bash",
                  "tool_input": {"command": command}, "session_id": SESSION, "cwd": str(self.work)}
        first = ext.hook(dict(params), None)
        self.assertTrue(first["reason"].startswith(ta.HEAD))
        self.answer(self.rid(first))
        second = ext.hook(dict(params), None)
        self.assertEqual(second["action"], "block", "rule 1 still refuses the heredoc")
        self.assertFalse(second["reason"].startswith(ta.HEAD), second["reason"])
        self.assertEqual(len(os.listdir(self.store / "used")), 1)


class Subagents(Case):
    """A builder's call (a worker's before_tool_call: the caller's session_id
    plus `subagent_id` "sa_N") records its subagent_id, and an Allow once for
    it can be spent only by that same builder: not by its lead, not by
    another builder. A foreground call's record and fingerprint stay
    byte-equal to the format before the field, so records waiting across
    the install still match."""

    @staticmethod
    def blob_fp(**fields):
        import hashlib
        blob = json.dumps({"v": 1, **fields}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def test_a_foreground_record_and_fingerprint_are_unchanged(self):
        want = self.blob_fp(session=SESSION, tool="bash", cwd=str(self.work), tool_input={"command": CHMOD})
        self.assertEqual(allow_once.fingerprint(SESSION, "bash", str(self.work), {"command": CHMOD}), want)
        self.assertEqual(allow_once.fingerprint(SESSION, "bash", str(self.work), {"command": CHMOD},
                                                subagent_id=None), want)
        rec = self.request(self.rid(self.bash(CHMOD)))
        self.assertEqual(rec["fingerprint"], want)
        self.assertNotIn("subagent_id", rec)
        params = {"kind": "before_tool_call", "tool_name": "bash", "tool_runtime_name": "bash",
                  "tool_input": {"command": "chmod o-r ~/Projects"}, "session_id": SESSION, "cwd": str(self.work),
                  "subagent_id": None}
        rid = self.rid(guard.access_check(params, guard.GuardConfig({}), self.audit, self.logs.append))
        self.assertNotIn("subagent_id", self.request(rid), "a null subagent_id is the session's own call")

    def test_the_hosts_worker_event_through_the_frame_entry_point(self):
        # a worker's before_tool_call exactly as the host serializes it
        # (train 25, agent-engine hooks/events.rs HookEvent: every field, with
        # tool_call_id, cwd and subagent_id present) through jev_ext.dispatch,
        # the frame loop's entry point; the foreground form omits subagent_id
        import jev_ext
        for patcher in (mock.patch("jev_ext.keys.discover", return_value=(None, "none")),
                        mock.patch.object(guard, "_ask", side_effect=AssertionError("a model call"))):
            patcher.start()
            self.addCleanup(patcher.stop)
        ext = Answers.extension(self)
        wire = ('{"jsonrpc":"2.0","id":41,"method":"hook.handle","params":{"kind":"before_tool_call",'
                '"tool_name":"bash","tool_runtime_name":"bash","tool_input":{"command":%s},"tool_output":null,'
                '"message":null,"session_id":%s,"tool_call_id":"toolu_01AbCdEfGh","cwd":%s,%s"transcript":null,'
                '"data":null}}')
        for command, sub in [(CHMOD, '"subagent_id":"sa_12",'), ("chmod o-r ~/Projects", "")]:
            with self.subTest(sub=sub):
                frame = json.loads(wire % (json.dumps(command), json.dumps(SESSION), json.dumps(str(self.work)), sub))
                sent = []
                with mock.patch.object(jev_ext, "send", sent.append):
                    self.assertTrue(jev_ext.dispatch(ext, frame))
                self.assertEqual(sent[0]["id"], 41)
                result = sent[0]["result"]
                self.assertEqual(result["action"], "block")
                self.assertTrue(result["reason"].startswith(ta.HEAD), result["reason"])
                rec = self.request(self.rid(result))
                fields = dict(session=SESSION, tool="bash", cwd=str(self.work), tool_input={"command": command})
                if sub:
                    self.assertEqual((rec["session"], rec["subagent_id"]), (SESSION, "sa_12"))
                    self.assertEqual(rec["fingerprint"], self.blob_fp(**fields, subagent_id="sa_12"))
                else:
                    self.assertNotIn("subagent_id", rec)
                    self.assertEqual(rec["fingerprint"], self.blob_fp(**fields))

    def test_a_builders_block_records_its_subagent_id(self):
        result = self.bash(CHMOD, subagent="sa_7")
        rec = self.request(self.rid(result))
        self.assertEqual((rec["session"], rec["subagent_id"], rec["allow_once_possible"]), (SESSION, "sa_7", True))
        want = self.blob_fp(session=SESSION, tool="bash", cwd=str(self.work), tool_input={"command": CHMOD},
                            subagent_id="sa_7")
        self.assertEqual(rec["fingerprint"], want)
        self.assertEqual(allow_once.fingerprint(SESSION, "bash", str(self.work), {"command": CHMOD},
                                                subagent_id="sa_7"), want)
        self.assertNotEqual(want, allow_once.fingerprint(SESSION, "bash", str(self.work), {"command": CHMOD}))
        self.assertNotEqual(want, allow_once.fingerprint(SESSION, "bash", str(self.work), {"command": CHMOD},
                                                         subagent_id="sa_8"))
        self.assertIn("If they allow it once, run exactly this call again", result["reason"])

    def test_a_builders_allow_once_is_spent_only_by_that_builder(self):
        rid = self.rid(self.bash(CHMOD, subagent="sa_7"))
        self.answer(rid)
        for kw in ({}, {"subagent": "sa_8"}, {"subagent": "sa_70"}, {"subagent": "sa_7", "session": "20261020-000000-bbbb"}):
            with self.subTest(kw=kw):
                result = self.bash(CHMOD, **kw)
                self.assertEqual(result["action"], "block")
                self.assertNotEqual(self.rid(result), rid)
                self.assertTrue((self.store / "answers" / f"{rid}.json").exists(), "not spent by another caller")
        self.assertIsNone(self.bash(CHMOD, subagent="sa_7"))
        self.assertTrue((self.store / "used" / f"{rid}.json").exists())
        self.assertEqual(self.bash(CHMOD, subagent="sa_7")["action"], "block", "once")

    def test_a_leads_allow_once_is_not_spent_by_its_builders(self):
        rid = self.rid(self.bash(CHMOD))
        self.answer(rid)
        for sa in ("sa_1", "sa_2"):
            with self.subTest(subagent=sa):
                self.assertEqual(self.bash(CHMOD, subagent=sa)["action"], "block")
                self.assertTrue((self.store / "answers" / f"{rid}.json").exists())
        self.assertIsNone(self.bash(CHMOD))

    def test_a_waiting_request_is_per_caller(self):
        rid = self.rid(self.bash(CHMOD, subagent="sa_7"))
        again = self.bash(CHMOD, subagent="sa_7")
        self.assertEqual(self.rid(again), rid)
        self.assertIn("is already waiting for the owner's answer", again["reason"])
        lead = self.bash(CHMOD)
        self.assertNotEqual(self.rid(lead), rid)
        self.assertNotIn("is already waiting", lead["reason"])
        self.assertNotEqual(self.rid(self.bash(CHMOD, subagent="sa_8")), rid)
        self.assertEqual(len(os.listdir(self.store / "requests")), 3)

    def test_an_edited_subagent_id_stays_blocked(self):
        """The card the owner answers must name the caller that retries: a record
        whose subagent_id was changed or dropped (fingerprint kept) is not
        consumed."""
        for forged in ("sa_8", None, ...):
            with self.subTest(forged=forged):
                command = f"chmod g-w ~/Projects # {forged!r}"
                rid = self.rid(self.bash(command, subagent="sa_7"))
                rec = self.request(rid)
                if forged is ...:
                    del rec["subagent_id"]
                else:
                    rec["subagent_id"] = forged
                (self.store / "requests" / f"{rid}.json").write_text(json.dumps(rec))
                self.answer(rid)
                self.assertEqual(self.bash(command, subagent="sa_7")["action"], "block")
                self.assertTrue((self.store / "answers" / f"{rid}.json").exists(), "not consumed")
        lead_rid = self.rid(self.bash(CHMOD))
        Answers.forge_consistent(self, lead_rid, subagent_id="sa_7")
        self.answer(lead_rid)
        self.assertEqual(self.bash(CHMOD)["action"], "block", "a lead's record given a builder's name")
        self.assertTrue((self.store / "answers" / f"{lead_rid}.json").exists())
        self.assertIsNone(self.audit.counters.get("guard.access.allowed_once"))

    def test_a_malformed_subagent_id_is_deny_only(self):
        for bad in ("", "sa 7", "sa_7\n", "../sa_7", "x" * 65, 7, ["sa_7"], {"id": "sa_7"}, True):
            with self.subTest(bad=bad):
                command = f"chmod g-w ~/Projects # {bad!r}"
                result = self.bash(command, subagent=bad)
                self.assertEqual(result["action"], "block")
                self.assertIn("can't be allowed once", result["reason"])
                rid = self.rid(result)
                rec = self.request(rid)
                self.assertFalse(rec["allow_once_possible"])
                self.assertEqual(rec["subagent_id"], "unrecognized")
                Answers.forge_consistent(self, rid, allow_once_possible=True)
                self.answer(rid)
                self.assertEqual(self.bash(command, subagent=bad)["action"], "block")
                self.assertTrue((self.store / "answers" / f"{rid}.json").exists(), "not consumed")

    def test_an_auto_record_carries_the_subagent_id(self):
        Path(access.switch_path(str(self.home))).write_text("auto\n")
        call = {"path": f"{self.sessions}/old.conf", "content": "mode = enforce\n"}
        self.assertIsNone(self.check("write", call, subagent="sa_4"))
        self.assertEqual(self.request(self.rows()[-1]["request"])["subagent_id"], "sa_4")
        self.assertIsNone(self.check("write", call))
        self.assertNotIn("subagent_id", self.request(self.rows()[-1]["request"]))


class Fixtures(Case):
    """The four request kinds (and a builder's block) and both answers, as
    the guard writes them."""

    def generate(self) -> dict:
        out = {}
        rid = self.rid(self.bash(CHMOD))
        out["block.json"] = self.request(rid)
        out["answer-allow.json"] = self.answer(rid)
        rid = self.rid(self.bash("chmod g-w ~/Projects; export GITHUB_TOKEN=ghp_" + "A1b2C3d4" * 5))
        out["block-deny-only.json"] = self.request(rid)
        out["answer-deny.json"] = self.answer(rid, "deny")
        out["shell_send.json"] = self.request(self.rid(self.check("shell_send",
                                                                   {"session_id": "shell_7", "input": CHMOD + "\n"})))
        out["block-subagent.json"] = self.request(self.rid(self.bash(CHMOD, subagent="sa_3")))
        Path(access.switch_path(str(self.home))).write_text("auto\n")
        self.check("write", {"path": f"{self.sessions}/old.conf", "content": "mode = enforce\n"})
        out["auto.json"] = self.request(self.rows()[-1]["request"])
        return out

    def test_fixtures_match_what_the_guard_writes(self):
        fresh = self.generate()
        if os.environ.get("JEV_ACCESS_FIXTURES_WRITE") == "1":
            FIXTURES.mkdir(parents=True, exist_ok=True)
            for name, obj in fresh.items():
                text = json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False).replace(str(self.home), "/home/user")
                (FIXTURES / name).write_text(text + "\n")
        for name, obj in fresh.items():
            with self.subTest(name=name):
                kept = json.loads((FIXTURES / name).read_text())
                self.assertEqual(sorted(kept), sorted(obj))
                self.assertEqual({k: type(v).__name__ for k, v in kept.items()},
                                 {k: type(v).__name__ for k, v in obj.items()})


if __name__ == "__main__":
    unittest.main()
