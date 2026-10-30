#!/usr/bin/env python3
"""Guard parity through the real extension process (JSON-RPC framing,
initialize with no guard_tools so the default applies). Offline: only the
HTTP boundary is stubbed and any socket use is fatal.

    python3 -B -m unittest discover -s tests -p 'test_guard_parity_protocol.py' -v
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import time
import unittest
from pathlib import Path

import jev_test_home  # noqa: F401  (keeps the suite out of the real Allow-once store)
import test_features_protocol as tfp

BOOTSTRAP = r'''
import json, sys
sys.path.insert(0, sys.argv[1])
def no_network(event, args):
    if event.startswith("socket."):
        raise RuntimeError("network forbidden in offline protocol tests")
sys.addaudithook(no_network)
from jev.client import DecisionClient
def offline_post(self, body, *, timeout_s):
    req = json.loads(body)
    call = req["state"]["call"]
    tripped = set()
    for f in call.get("files", []):
        if "TRIP" in f["path"]:
            tripped.add(f["file"])
    answers = {}
    for q in req["questions"]:
        base, _, idx = q.rpartition("_")
        hot = idx.isdigit() and int(idx) in tripped
        if base == "risk":
            answers[q] = {"type": "score", "score": 0.1, "confidence": 0.95,
                          "legend": {"0": "L0", "1": "L1", "2": "L2", "3": "L3"},
                          "probabilities": {"0": 1.0, "1": 0.0, "2": 0.0, "3": 0.0}}
        elif base == "leak":
            answers[q] = {"type": "noul", "noul": 0.9 if hot else 0.02}
        elif base == "leaves_workspace":
            answers[q] = {"type": "noul", "noul": 0.03}
    return {"answers": answers, "model": "offline-fixture", "usage": {"input_tokens": 10}}
DecisionClient._post = offline_post
import jev_ext
jev_ext.main()
'''


class GuardParityProtocol(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="jev-parity-proto-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.ws = self.base / "ws"
        self.ws.mkdir()
        self.audit = self.base / "audit.jsonl"
        saved, tfp.BOOTSTRAP = tfp.BOOTSTRAP, BOOTSTRAP
        try:
            self.h = tfp.OfflineHost(self.base, config={"project_root": str(self.ws),
                                                         "audit_file": str(self.audit),
                                                         "guard_confirm": "prompt"})  # today's confirms
        finally:
            tfp.BOOTSTRAP = saved
        self.addCleanup(self.h.close)

    def hook(self, tool, tool_input, **extra):
        extra.setdefault("cwd", str(self.ws))  # HookEvent.cwd, as a current host sends it
        if extra["cwd"] is None:
            del extra["cwd"]
        return self.h.hook("before_tool_call", tool_name=tool, tool_runtime_name=tool,
                           tool_input=tool_input, session_id="proto-1", **extra)

    def test_new_builtins_are_guarded_by_default_end_to_end(self):
        r = self.hook("multi_edit", {"edits": [
            {"path": "ok.txt", "op": "append", "text": "x"},
            {"path": "TRIP.env", "op": "replace", "anchor": "a", "text": "b"}]})
        self.assertEqual(r["action"], "confirm")
        self.assertIn("TRIP.env", r["message"])
        self.assertNotIn("ok.txt", r["message"])

        r = self.hook("multi_edit", {"edits": [{"path": "ok.txt", "op": "append", "text": "x"}]})
        self.assertEqual(r, {"action": "continue"})

        r = self.hook("send_events", {"source": "worker-v", "messages": [{"session": "s", "body": "status: done"}]})
        self.assertEqual(r, {"action": "continue"})

        secret = "ghp_" + "Zy9x" * 9
        r = self.hook("send_events", {"source": "worker-v", "messages": [{"session": "s", "body": "ok"},
                                                   {"session": "t", "body": "token " + secret}]})
        self.assertEqual(r["action"], "confirm")
        self.assertIn("messages[1] (github_token)", r["message"])
        self.assertNotIn(secret, r["message"])

        r = self.hook("send_events", {"source": "worker-v", "messages": []})
        self.assertEqual(r["action"], "confirm")

        # An older host sends no cwd: a relative target cannot be resolved.
        r = self.hook("multi_edit", {"edits": [{"path": "ok.txt", "op": "append", "text": "x"}]}, cwd=None)
        self.assertEqual(r["action"], "confirm")
        self.assertIn("session cwd", r["message"])

        # Two multi_edit calls and one clean send_events reached Jev; the
        # pattern hit, the malformed call and the unresolvable target were
        # decided locally.
        self.assertEqual(self.h.status()["by_op"], {"guard": 3})
        audit = self.audit.read_text()
        self.assertNotIn(secret, audit)
        self.assertNotIn("status: done", audit)

    def test_a_full_stderr_pipe_never_delays_the_reply(self):
        """Review r2 R2-3(b), end to end: the extension makes its stderr pipe
        non-blocking at start. With that pipe full (the host not reading),
        the guard still replies at once and the lost lines are counted."""
        proc = Path(f"/proc/{self.h.p.pid}")
        if not (proc / "fdinfo" / "2").exists():
            self.skipTest("needs Linux /proc")
        flags = int(re.search(r"^flags:\s*([0-7]+)", (proc / "fdinfo" / "2").read_text(), re.M).group(1), 8)
        self.assertTrue(flags & os.O_NONBLOCK, "fd 2 is non-blocking once the extension runs")
        w = os.open(proc / "fd" / "2", os.O_WRONLY | os.O_NONBLOCK)  # the same pipe, our own description
        try:
            for size in (65536, 4096, 1):
                while True:
                    try:
                        os.write(w, b"z" * size)
                    except BlockingIOError:
                        break
        finally:
            os.close(w)
        t0 = time.monotonic()
        r = self.hook("multi_edit", {"edits": [{"path": "ok.txt", "op": "append", "text": "x"}]})
        self.assertEqual(r, {"action": "continue"})
        self.assertLess(time.monotonic() - t0, 1.0)
        # a continue is a routine line: jev.log only, so nothing is lost on stderr
        self.assertEqual(self.h.status()["counters"].get("log.dropped", 0), 0)
        # a block is a notice: stderr (full, so dropped and counted) and jev.log
        t0 = time.monotonic()
        r = self.hook("bash", {"command": "rm -rf /"})
        self.assertEqual(r["action"], "block")
        self.assertLess(time.monotonic() - t0, 1.0)
        status = self.h.status()
        self.assertGreaterEqual(status["counters"].get("log.dropped", 0), 1)
        self.assertEqual(status["log_file"], str(self.base / "memory" / "jev" / "jev.log"))
        text = Path(status["log_file"]).read_text()
        self.assertIn("[jev] guard multi_edit: continue (", text)
        self.assertIn("[jev] guard bash: block (", text)


if __name__ == "__main__":
    unittest.main()
