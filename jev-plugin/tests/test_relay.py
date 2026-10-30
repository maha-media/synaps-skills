#!/usr/bin/env python3
"""Relay mode (contract J1 r1.1): jev.decide through the Pria desktop's
fleet.sock instead of a local key. A fake threaded AF_UNIX server in a temp
dir stands in for the app; the real ~/.local/state/pria-desktop is never
touched, nothing goes to the network, and every command is TEXT given to
the guard, never executed.

    TMPDIR=/var/tmp PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest test_relay -v   (from tests/)
"""
from __future__ import annotations

import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
import sys  # noqa: E402
sys.path.insert(0, os.path.join(ROOT, "extensions"))
import jev_test_home  # noqa: F401,E402  (keeps the suite out of the real Allow-once store and Pria dir)
sys.path.insert(0, HERE)

import jev_ext  # noqa: E402
from jev import audit as audit_mod  # noqa: E402
from jev import commands, compress, context, diagnose, discovery, evidence, relay, reports, roster, router, tools, triage, verify  # noqa: E402
from jev.client import DecisionClient  # noqa: E402
from test_rule1_guard import HEAD, HEREDOC, WORKER, make_fleet  # noqa: E402

TOKEN = "feedc0de" * 8          # 64 hex: a fixture, never a real token
UPSTREAM = "UPSTREAM_TEXT_7f3a"  # refusal messages must never surface
SERVER_CODES = ("not_signed_in", "needs_sign_in", "busy", "secret_in_state", "invalid_request", "unavailable",
                "unauthorized", "line_too_long", "bad_request", "unknown_verb", "not_available", "internal",
                "restarting")
Q = {"ok": {"type": "noul", "instructions": "Is `note` a self-test?"}}
RESULT = {"model": "jev-fixture", "answers": {"ok": {"noul": 0.9}}, "usage": {"input_tokens": 7}}


def ok(result=None):
    return lambda req: {"id": req["id"], "ok": True, "result": RESULT if result is None else result}


def refuse(code):
    return lambda req: {"id": req["id"], "ok": False, "error": {"code": code, "message": UPSTREAM}}


class FakeRelay:
    """The app's side: hello → welcome → one request → one reply. Records
    every connection, hello and raw request line (bytes)."""

    def __init__(self, directory: Path, *, reply=None, verbs=("hello", "jev.decide"), welcome=None,
                 stall=0.0, token=TOKEN):
        self.dir = directory
        self.path = directory / "fleet.sock"
        self.reply = reply or ok()
        self.verbs, self.welcome, self.stall, self.token = list(verbs), welcome, stall, token
        self.connections, self.hellos, self.lines, self.requests, self.closed_after = 0, [], [], [], []
        self.errors = []
        self.active = 0
        self.cond = threading.Condition()
        self.stop_event = threading.Event()
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(str(self.path))
        os.chmod(self.path, 0o600)
        self.sock.listen(16)
        self.sock.settimeout(0.05)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.thread.join(5)
        self.sock.close()
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass

    def idle(self, timeout=3.0):
        with self.cond:
            return self.cond.wait_for(lambda: self.active == 0, timeout)

    def _serve(self):
        while not self.stop_event.is_set():
            try:
                conn, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with self.cond:
                self.connections += 1
                self.active += 1
            try:
                self._handle(conn)
            except Exception as e:  # noqa: BLE001 — a client that went away mid-reply
                self.errors.append(type(e).__name__)
            finally:
                conn.close()
                with self.cond:
                    self.active -= 1
                    self.cond.notify_all()

    def _send(self, conn, obj):
        conn.sendall(obj if isinstance(obj, bytes) else json.dumps(obj).encode() + b"\n")

    def _handle(self, conn):
        conn.settimeout(5)
        f = conn.makefile("rb")
        line = f.readline()
        if not line:
            return
        hello = json.loads(line)
        self.hellos.append(hello)
        if hello.get("token") != self.token:
            self._send(conn, {"ok": False, "error": {"code": "unauthorized", "message": UPSTREAM}})
            return
        if self.welcome == b"":
            return  # close instead of welcoming
        self._send(conn, self.welcome if self.welcome is not None else
                   {"ok": True, "result": {"api": 1, "server": "fake-pria", "verbs": self.verbs}})
        line = f.readline()
        if not line:
            return
        self.lines.append(line)
        req = json.loads(line)
        self.requests.append(req)
        if self.stall:
            self.stop_event.wait(self.stall)
        out = self.reply(req)
        if out is None:
            return  # close without a reply
        self._send(conn, out)
        self.closed_after.append(f.readline() == b"")


class RelayCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="jev-relay-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.pria = self.base / "home" / ".local" / "state" / "pria-desktop"
        self.pria.mkdir(parents=True, mode=0o700)
        (self.pria / "fleet.token").write_text(TOKEN + "\n")
        os.chmod(self.pria / "fleet.token", 0o600)
        self.ws = self.base / "ws"
        self.ws.mkdir()
        self.audit_path = self.base / "audit.jsonl"
        self.logs = []
        self.discover = mock.Mock(return_value=(None, "none"))
        for patcher in (mock.patch.object(relay, "STATE_DIR", str(self.pria)),
                        mock.patch.object(roster, "FLEET_DIR", str(make_fleet(self.base))),
                        mock.patch("jev_ext.keys.discover", self.discover),
                        mock.patch("jev_ext.log", side_effect=self.logs.append)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def serve(self, **kw):
        server = FakeRelay(self.pria, **kw)
        self.addCleanup(server.stop)
        return server

    def client(self, **kw):
        kw.setdefault("timeout_s", 2.0)
        return relay.RelayClient(state_dir=str(self.pria), log=self.logs.append, **kw)

    def off(self, client, state=None, questions=Q, **kw):
        with self.assertRaises(relay.RelayOff) as cm:
            client.decide({"note": "x"} if state is None else state, questions, **kw)
        return cm.exception

    def extension(self, **cfg):
        ext = jev_ext.Extension()
        # today's confirms: guard_confirm = auto is test_guard_confirm_auto's
        ext.initialize({"config": {"project_root": str(self.ws), "audit_file": str(self.audit_path),
                                   "guard_confirm": "prompt", **cfg}})
        return ext

    def hook(self, ext, tool="bash", tool_input=None, session="sess-1", **extra):
        return ext.hook({"kind": "before_tool_call", "tool_name": tool, "tool_runtime_name": tool,
                         "tool_input": {"command": "ls -la"} if tool_input is None else tool_input,
                         "session_id": session, "cwd": str(self.ws), **extra})


class Wire(RelayCase):
    def test_success_passthrough_one_connection_no_model_session_closed_after(self):
        server = self.serve()
        client = self.client()
        with relay.session("sess-1"):
            resp = client.decide({"note": "x"}, Q, op="decide")
        self.assertIsNone(relay.SESSION.get())
        self.assertEqual(resp, RESULT)
        server.idle()
        self.assertEqual(server.connections, 1)
        self.assertEqual(server.hellos, [{"verb": "hello", "token": TOKEN, "api": 1,
                                          "client": f"jev-relay/{relay.VERSION}"}])
        (req,) = server.requests
        self.assertEqual(set(req), {"id", "verb", "args"})
        self.assertEqual(req["verb"], "jev.decide")
        self.assertIs(type(req["id"]), int)
        self.assertEqual(req["args"], {"state": {"note": "x"}, "questions": Q, "session": "sess-1"})
        self.assertNotIn(b'"model"', server.lines[0])
        self.assertTrue(server.lines[0].endswith(b"\n") and server.lines[0].count(b"\n") == 1)
        self.assertEqual(server.closed_after, [True])
        self.assertEqual(client.stats.snapshot()["input_tokens"], 7)
        self.assertEqual(client.relay_code, "ok")
        # no session set (or an invalid one): the key is omitted; one connection per decision
        client.decide({"note": "y"}, Q)
        with relay.session("bad\nsession"):
            client.decide({"note": "z"}, Q)
        with relay.session("s" * 257):
            client.decide({"note": "z"}, Q)
        server.idle()
        self.assertEqual(server.connections, 4)
        self.assertTrue(all("session" not in r["args"] for r in server.requests[1:]))
        self.assertEqual(len({r["id"] for r in server.requests}), 4)

    def test_request_line_is_json_dumps_of_the_parsed_objects_never_spliced_text(self):
        # Review 28b rule 1: a string state stays a JSON string value; escape-obfuscated
        # text is serialized by json.dumps, never spliced raw into the line.
        server = self.serve()
        client = self.client()
        obfuscated = '{"api_key": "\\u0073k-\\u006c\\u0069ve-123", "x": 1}'
        client.decide(obfuscated, Q)
        nested = {"note": "\\u0073ecret \\\" quote", "list": ["\\n", 1]}
        client.decide(nested, Q)
        server.idle()
        first, second = (json.loads(line) for line in server.lines)
        self.assertIs(type(first["args"]["state"]), str)
        self.assertEqual(first["args"]["state"], obfuscated)
        self.assertNotIn(b'"state":{', server.lines[0])
        self.assertNotIn(b'"state": {', server.lines[0])
        self.assertIn(json.dumps(obfuscated).encode(), server.lines[0])
        self.assertEqual(second["args"]["state"], nested)

    def test_reply_is_parsed_json_equal_not_byte_identical(self):
        # Review 28b rule 2: other whitespace and key order give the same result.
        def spaced(req):
            return (b'{ "result" : { "usage" : { "input_tokens" : 7 } , "answers" : {"ok": {"noul": 0.9}},'
                    b' "model" : "jev-fixture" } , "ok" : true , "id" : ' + str(req["id"]).encode() + b' }\n')
        self.serve(reply=spaced)
        self.assertEqual(self.client().decide({"note": "x"}, Q), RESULT)

    def test_usage_null_or_absent_is_unknown_never_zero(self):
        for result in ({**RESULT, "usage": None}, {"model": "m", "answers": {"ok": {"noul": .1}}}):
            with self.subTest(result=result):
                server = self.serve(reply=ok(result))
                client = self.client()
                self.assertEqual(client.decide({"note": "x"}, Q), result)
                snap = client.stats.snapshot()
                self.assertIsNone(snap["input_tokens"])
                self.assertIsNone(snap["cost_usd"])
                self.assertEqual(snap["unknown_usage_calls"], 1)
                server.stop()

    def test_each_refusal_code_is_relay_off_with_its_code_and_fixed_text(self):
        for code in SERVER_CODES + ("some_new_code",):
            with self.subTest(code=code):
                server = self.serve(reply=refuse(code))
                client = self.client()
                e = self.off(client)
                self.assertEqual(e.code, code if code in SERVER_CODES else "unknown_code")
                self.assertNotIn(UPSTREAM, str(e) + repr(e.args))
                server.idle()
                self.assertEqual(len(server.requests), 1)
                server.stop()

    def test_welcome_without_the_verb_sends_no_request(self):
        server = self.serve(verbs=["hello", "fleet.status"])
        client = self.client()
        self.assertEqual(self.off(client).code, "no_relay")
        server.idle()
        self.assertEqual((server.connections, server.lines), (1, []))

    def test_bad_token_file_or_refused_hello_sends_no_request(self):
        server = self.serve()
        for content, code in (("short", "no_token"), ("g" * 64, "no_token"), (None, "no_token")):
            with self.subTest(content=content):
                if content is None:
                    (self.pria / "fleet.token").unlink()
                else:
                    (self.pria / "fleet.token").write_text(content)
                self.assertEqual(self.off(self.client()).code, code)
        (self.pria / "fleet.token").write_text("0" * 64)  # well-formed, but not the app's token
        self.assertEqual(self.off(self.client()).code, "unauthorized")
        server.idle()
        self.assertEqual(server.lines, [])

    def test_line_over_65536_bytes_sends_nothing(self):
        server = self.serve()
        client = self.client()
        e = self.off(client, state={"blob": "x" * relay.MAX_LINE})
        self.assertEqual(e.code, "too_large")
        server.idle()
        self.assertEqual(server.connections, 0)

    def test_server_stall_is_relay_off_within_the_budget(self):
        self.serve(stall=5.0)
        client = self.client(timeout_s=0.5)
        t0 = time.monotonic()
        self.assertEqual(self.off(client).code, "deadline")
        self.assertLess(time.monotonic() - t0, 0.9)

    def test_malformed_wrong_id_closed_and_oversized_replies(self):
        big = b'{"pad":"' + b"a" * (relay.MAX_REPLY + 16)
        cases = (
            (lambda req: b"not json\n", "malformed"),
            (lambda req: {"id": req["id"] + 1, "ok": True, "result": RESULT}, "malformed"),
            (lambda req: {"id": True, "ok": True, "result": RESULT}, "malformed"),
            (lambda req: {"id": req["id"], "ok": True, "result": {"model": "m"}}, "malformed"),
            (lambda req: {"id": req["id"], "ok": True, "result": {**RESULT, "usage": 3}}, "malformed"),
            (lambda req: {"id": req["id"], "ok": "yes", "result": RESULT}, "malformed"),
            (lambda req: None, "closed"),
            (lambda req: big, "unavailable"),
        )
        for reply, code in cases:
            with self.subTest(code=code):
                server = self.serve(reply=reply)
                self.assertEqual(self.off(self.client()).code, code)
                server.stop()
        for welcome, code in ((b"[]\n", "malformed"), ({"ok": True, "result": {"api": 2, "verbs": ["jev.decide"]}},
                                                        "malformed"), (b"", "closed")):
            with self.subTest(welcome=welcome):
                server = self.serve(welcome=welcome)
                self.assertEqual(self.off(self.client()).code, code)
                server.stop()

    def test_negative_cache_suppresses_reconnects_and_logs_one_line_per_transition(self):
        self.assertEqual(relay.HOLD_S, {"no_socket": 60, "no_relay": 60, "unknown_verb": 60, "not_available": 60,
                                        "unauthorized": 30, "not_signed_in": 30, "needs_sign_in": 30,
                                        "restarting": 10, "busy": 2, "deadline": 5, "unavailable": 5,
                                        "internal": 5, "closed": 5, "malformed": 5, "error": 5})
        counters = {}
        client = self.client(bump=lambda name: counters.__setitem__(name, counters.get(name, 0) + 1))
        for _ in range(3):  # no socket at all
            self.assertEqual(self.off(client).code, "no_socket")
        self.assertEqual((counters["relay.no_socket"], counters["relay.cached"]), (3, 2))
        server = self.serve(reply=refuse("busy"))
        now = time.monotonic()
        with mock.patch.object(relay, "_clock", return_value=now + 61):
            self.assertEqual(self.off(client).code, "busy")
            self.assertEqual(self.off(client).code, "busy")  # held 2 s
        server.idle()
        self.assertEqual(server.connections, 1)
        server.reply = ok()
        with mock.patch.object(relay, "_clock", return_value=now + 64):
            client.decide({"note": "x"}, Q)
            client.decide({"note": "x"}, Q)
        server.idle()
        self.assertEqual(server.connections, 3)
        relay_lines = [line for line in self.logs if line.startswith("relay")]
        self.assertEqual(len(relay_lines), 3, relay_lines)  # no_socket, busy, ok

    def test_a_deadline_holds_five_seconds_then_reconnects(self):
        server = self.serve(stall=0.6)
        client = self.client(timeout_s=0.3)
        now = time.monotonic()
        self.assertEqual(self.off(client).code, "deadline")
        server.idle()  # the stall is over: a reconnect now would be accepted and counted
        with mock.patch.object(relay, "_clock", return_value=now + 4.9):
            self.assertEqual(self.off(client).code, "deadline")  # held: no reconnect
        server.idle()
        self.assertEqual(server.connections, 1)
        server.stall, server.reply = 0.0, ok()
        with mock.patch.object(relay, "_clock", return_value=now + 6):
            client.decide({"note": "x"}, Q)
        server.idle()
        self.assertEqual((server.connections, client.relay_code), (2, "ok"))

    def test_version_matches_the_plugin_manifest(self):
        manifest = json.loads((Path(ROOT) / ".synaps-plugin" / "plugin.json").read_text())
        self.assertEqual(relay.VERSION, manifest["version"])
        self.assertIn("transport", {c["key"] for c in manifest["extension"]["config"]}
                      if "extension" in manifest else {c["key"] for c in manifest["config"]})


class Guard(RelayCase):
    def test_each_refusal_code_continues_not_confirm_with_one_request(self):
        for code in SERVER_CODES:
            with self.subTest(code=code):
                server = self.serve(reply=refuse(code))
                ext = self.extension(transport="relay")
                self.assertTrue(ext.features["guard"])
                self.assertEqual(self.hook(ext), {"action": "continue"})
                server.idle()
                self.assertEqual(len(server.requests), 1)
                self.assertEqual(server.requests[0]["args"]["session"], "sess-1")
                self.assertEqual(ext.audit.counters.get("guard.relay_off"), 1)
                self.assertNotIn("guard.error", ext.audit.counters)
                self.assertNotIn("guard.confirm", ext.audit.counters)
                self.assertEqual(ext.audit.explanations()[-1], {**ext.audit.explanations()[-1],
                                                               "op": "guard", "reason": "continue"})
                server.stop()

    def test_multi_edit_and_send_events_continue_and_deterministic_rules_still_win(self):
        server = self.serve(reply=refuse("invalid_request"))  # not held: both handlers reach the relay
        ext = self.extension(transport="relay")
        edits = {"edits": [{"path": str(self.ws / "a.txt"), "op": "append", "text": "hello\n"}]}
        self.assertEqual(self.hook(ext, "multi_edit", edits), {"action": "continue"})
        events = {"source": "worker-v", "messages": [{"session": "s", "body": "status ok"}]}
        result = self.hook(ext, "send_events", events)
        self.assertEqual(result["action"], "continue", result)
        # a secret pattern confirms locally, before any model call
        events = {"source": "worker-v", "messages": [{"session": "s", "body": "token ghp_" + "Zy9x" * 9}]}
        self.assertEqual(self.hook(ext, "send_events", events)["action"], "confirm")
        # the shell-safety rule blocks locally
        result = self.hook(ext, "bash", {"command": 'set -euo pipefail\nrm -rf "$OUT"/*\n'})
        self.assertEqual(result["action"], "block")
        server.idle()
        self.assertEqual(len(server.requests), 2)
        self.assertEqual(ext.audit.counters.get("guard.relay_off"), 2)

    def test_stalled_server_continues_within_the_hook_budget(self):
        self.serve(stall=5.0)
        ext = self.extension(transport="relay", timeout_ms=500)
        t0 = time.monotonic()
        self.assertEqual(self.hook(ext), {"action": "continue"})
        self.assertLess(time.monotonic() - t0, 1.0)

    def test_rule1_blocks_a_heredoc_in_relay_mode_while_the_server_refuses(self):
        server = self.serve(reply=refuse("unauthorized"))
        ext = self.extension(transport="relay")
        result = self.hook(ext, "bash", {"command": HEREDOC}, session=WORKER)
        self.assertEqual(result["action"], "block", result)
        self.assertTrue(result["reason"].startswith(HEAD), result["reason"])
        server.idle()
        self.assertEqual(server.connections, 0)


class Consumers(RelayCase):
    """Every other client.decide consumer: RelayOff behaves as no client."""

    def test_tools_and_advice_consumers_fall_back_like_no_key(self):
        server = self.serve(reply=refuse("invalid_request"))  # not held: every consumer reaches the relay
        ext = self.extension(transport="relay", verification=True, evidence=True, diagnosis=True)
        for name, tool_input in (("jev_decide", {"state": {"a": 1}, "questions": Q}),
                                 ("jev_select", {"context": "pick", "decisions": [{"instruction": "pick one",
                                  "candidates": [{"id": "a", "description": "A"}, {"id": "b", "description": "B"}]}]})):
            with self.subTest(name=name), self.assertRaises(tools.ToolError) as cm:
                ext.tool_call({"name": name, "input": tool_input})
            self.assertNotIn(UPSTREAM, str(cm.exception))
            self.assertIn("relay", str(cm.exception))
        checks = [{"id": "unit", "description": "unit tests", "required": False}]
        out = json.loads(ext.tool_call({"name": "jev_verify", "input": {
            "task": "t", "changes": ["c"], "checks": checks}})["content"])
        self.assertEqual(out["fallback_reason"], verify.RELAY_OFF)
        out = json.loads(ext.tool_call({"name": "jev_evidence", "input": {"task": "t", "candidates": [
            {"id": "e", "kind": "file", "source": "s", "summary": "x", "required": False}]}})["content"])
        self.assertEqual(out["fallback_reason"], verify.RELAY_OFF)
        out = json.loads(ext.tool_call({"name": "jev_diagnose", "input": {"task": "t", "evidence": "e",
            "hypotheses": [{"id": "h", "description": "d"}], "checks": checks}})["content"])
        self.assertEqual(out["fallback_reason"], "relay_off")
        c = ext.audit.counters
        for op in ("verification", "evidence", "diagnose"):
            self.assertEqual((c.get(f"{op}.skip"), c.get(f"{op}.error")), (1, None), op)
        server.idle()
        self.assertEqual(len(server.requests), 5)

    def test_hook_consumers_skip_and_cache_nothing(self):
        server = self.serve(reply=refuse("invalid_request"))  # not held: every consumer reaches the relay
        ext = self.extension(transport="relay", compress=True, discovery=True, reports=True)
        self.assertEqual(self.hook(ext, "subagent_start", {"task": "Read docs"}), {"action": "continue"})
        after = {"kind": "after_tool_call", "session_id": "sess-1"}
        bash_fail = dict(after, tool_name="bash", tool_input={"command": "make"},
                         tool_output="Command failed (exit 2):\nmake: *** [all] Error 2\n")
        catalog = {"generation": 1, "truncated": False, "tools": [
            {"id": "alpha", "summary": "Inspect failed assertions", "tags": [], "source_class": "builtin",
             "schema_digest": "abc"},
            {"id": "beta", "summary": "Install deps", "tags": [], "source_class": "plugin", "schema_digest": "d"}]}
        report = {"handle_id": "sa_1", "status": "completed", "output": "Tests not run.", "model": "m",
                  "terminal_cause": {"reason": "done"}, "authorization": {"allowed": True}, "collected": False}
        for params in (bash_fail,
                       dict(after, tool_name="search_tools", tool_input={"query": "failed assertions"},
                            tool_output=json.dumps(catalog)),
                       dict(after, tool_name="subagent_collect", tool_input={"handle_id": "sa_1"},
                            tool_output=json.dumps(report)),
                       dict(after, tool_name="bash", tool_input={"command": "ls"},
                            tool_output="routine progress\n" * 600),
                       {"kind": "on_message_complete", "message": "Done: implemented and tested.",
                        "session_id": "sess-1", "data": {"content_block_count": 1, "has_tool_use": False,
                        "context_management": {"enabled": True, "band": "pressure", "phase": "execute"}}}):
            with self.subTest(tool=params.get("tool_name", params["kind"])):
                self.assertEqual(ext.hook(params), {"action": "continue"})
        c = ext.audit.counters
        for op in ("router", "triage", "discovery", "reports", "compress", "context"):
            self.assertEqual(c.get(f"{op}.skip"), 1, (op, c))
            self.assertIsNone(c.get(f"{op}.error"), op)
        for component in (ext.router, ext.triage, ext.discovery, ext.reports):
            self.assertEqual(len(component.cache), 0)
        server.idle()
        self.assertEqual(len(server.requests), 6)
        self.assertTrue(all(r["reason"] in audit_mod.GLOSS for r in ext.audit.explanations()))
        self.assertIn("relayoff", {r["reason"] for r in ext.audit.explanations()})

    def test_commands_in_relay_mode(self):
        self.serve(reply=refuse("not_signed_in"))
        ext = self.extension(transport="relay")
        sent, host_call = [], mock.Mock(side_effect=AssertionError("no host call"))
        with mock.patch.object(commands, "DecisionClient", side_effect=AssertionError("no key validation")):
            commands.handle({"args": ["key", "apikey_" + "k" * 30]}, ext, sent.append, host_call)
            commands.handle({"args": ["key"]}, ext, sent.append, host_call)
        commands.handle({"args": ["status"]}, ext, sent.append, host_call)
        commands.handle({"args": ["test"]}, ext, sent.append, host_call)
        events = [s["params"]["event"] for s in sent]
        text = json.dumps(events)
        self.assertEqual([e["kind"] for e in events if e["kind"] == "error"], ["error", "error", "error"])
        self.assertIn("relay", text)
        self.assertNotIn(UPSTREAM, text)
        self.assertNotIn(TOKEN, text)
        self.discover.assert_not_called()
        self.assertFalse((self.base / "plugins").exists())


class Selection(RelayCase):
    def test_auto_with_pria_dir_and_a_key_is_relay_and_never_discovers_keys(self):
        ext = self.extension(api_key="apikey_" + "k" * 30)
        self.assertIsInstance(ext.client, relay.RelayClient)
        self.assertEqual((ext.transport, ext.key_source), ("relay", "relay"))
        self.hook(ext)
        ext.maybe_pick_up_key()
        self.discover.assert_not_called()
        caps = {c["name"]: c["modes"] for c in ext.info()["capabilities"]}
        self.assertEqual(caps["transport"][0], "relay")

    def test_direct_is_the_key_path(self):
        ext = self.extension(transport="direct", api_key="apikey_" + "k" * 30)
        self.assertIs(type(ext.client), DecisionClient)
        self.assertEqual(ext.transport, "direct")
        ext = self.extension(transport="direct")
        self.assertIsNone(ext.client)
        self.discover.assert_called()

    def test_auto_without_pria_dir_is_the_key_path(self):
        for value in ("auto", "bogus", None):
            with self.subTest(value=value), mock.patch.object(relay, "STATE_DIR", str(self.base / "absent")):
                cfg = {"api_key": "apikey_" + "k" * 30} | ({} if value is None else {"transport": value})
                ext = self.extension(**cfg)
                self.assertIs(type(ext.client), DecisionClient)
                self.assertEqual(ext.transport, "direct")

    def test_transport_is_chosen_first_and_an_unrecognised_value_is_logged_never_echoed(self):
        ext = jev_ext.Extension()  # reviewer finding 1: a later config error must not leave relay mode
        with self.assertRaises(ValueError):
            ext.initialize({"config": {"transport": "relay", "guard_ask_at": "high",
                                       "api_key": "apikey_" + "k" * 30}})
        self.assertEqual(ext.transport, "relay")
        ext.maybe_pick_up_key()
        self.assertIsNone(ext.client)
        self.discover.assert_not_called()
        with mock.patch.object(relay, "STATE_DIR", str(self.base / "absent")):
            for value, lines in (("rleay", 1), (7, 1), ("auto", 0), (" Direct ", 0), ("", 0), (None, 0)):
                with self.subTest(value=value):
                    self.logs.clear()
                    ext = self.extension(**({} if value is None else {"transport": value}))
                    self.assertEqual(ext.transport, "direct")
                    self.assertEqual(self.logs.count(jev_ext.TRANSPORT_UNRECOGNISED), lines, self.logs)
                    self.assertNotIn("rleay", "\n".join(self.logs))

    def test_relay_without_a_socket_is_jev_off_per_call(self):
        with mock.patch.object(relay, "STATE_DIR", str(self.base / "absent")):
            ext = self.extension(transport="relay")
            self.assertIsInstance(ext.client, relay.RelayClient)
            for _ in range(3):
                self.assertEqual(self.hook(ext), {"action": "continue"})
                with self.assertRaises(tools.ToolError):
                    ext.tool_call({"name": "jev_decide", "input": {"state": {"a": 1}, "questions": Q}})
        self.assertEqual(ext.audit.counters.get("guard.relay_off"), 3)
        self.assertEqual(ext.client.relay_code, "no_socket")
        self.discover.assert_not_called()


class TokenNeverLeaks(RelayCase):
    def test_logs_audit_stats_exceptions_status_and_object(self):
        seen = []
        server = self.serve()
        ext = self.extension(transport="relay", timeout_ms=600)
        self.hook(ext)  # a guarded call with the fixture's answers missing: still never the token
        ext.tool_call({"name": "jev_decide", "input": {"state": {"a": 1}, "questions": Q}})
        for reply in (refuse("unauthorized"), lambda req: b"junk\n", lambda req: None):
            server.reply = reply
            ext.client._hold_until = 0.0
            try:
                ext.tool_call({"name": "jev_decide", "input": {"state": {"a": 1}, "questions": Q}})
            except Exception as e:  # noqa: BLE001
                seen.append(f"{e!s} {e!r} {e.__cause__!r} {e.__context__!r}")
        server.stop()
        self.serve(stall=5.0)
        ext.client._hold_until = 0.0
        self.assertEqual(self.hook(ext), {"action": "continue"})
        status = ext.tool_call({"name": "jev_status", "input": {}})["content"]
        self.assertEqual(json.loads(status)["transport"], "relay")
        self.assertIn("relay_code", json.loads(status))
        blobs = ["\n".join(self.logs), self.audit_path.read_text() if self.audit_path.exists() else "",
                 json.dumps(ext.stats.snapshot()), json.dumps(ext.audit.counters), json.dumps(ext.info()),
                 json.dumps(ext.audit.explanations()), status, "\n".join(seen), repr(vars(ext.client))]
        for blob in blobs:
            self.assertNotIn(TOKEN, blob)
        self.assertTrue(seen)


if __name__ == "__main__":
    unittest.main()
