#!/usr/bin/env python3
"""The suite never writes the REAL Allow-once store (jev_test_home.py).

1. Every test module that imports jev_ext or the guard imports jev_test_home
   (directly, or through test_guard_parity).
2. With jev_test_home imported, the store for the real home is a temp dir,
   and a temp home keeps the real formula.
3. An access block driven through guard.handle with the real $HOME records
   its request in the temp store, and nothing at the real path.

Run: python3 -B -m unittest discover -s tests -p 'test_store_isolation.py' -v
"""
from __future__ import annotations

import ast
import os
import re
import tempfile
import unittest
from pathlib import Path

import jev_test_home  # noqa: F401  (keeps the suite out of the real Allow-once store)
from test_guard_parity import GuardCase  # noqa: E402

from jev import allow_once, guard  # noqa: E402

HERE = Path(__file__).resolve().parent
USES_GUARD = re.compile(r"^\s*(import jev_ext|from jev_ext|from jev import .*\bguard\b|from jev\.guard|import jev\.guard)",
                        re.M)


class EveryGuardModuleIsIsolated(unittest.TestCase):
    def test_each_module_that_imports_the_guard_imports_jev_test_home(self):
        # A TOP-LEVEL import (AST), not the text: a subprocess bootstrap string that holds the
        # line doesn't count.
        missing = []
        for path in sorted(HERE.glob("test_*.py")):
            text = path.read_text()
            if not USES_GUARD.search(text):
                continue
            top = ast.parse(text).body
            if not any((isinstance(n, ast.Import) and any(a.name == "jev_test_home" for a in n.names))
                       or (isinstance(n, ast.ImportFrom) and n.module == "test_guard_parity") for n in top):
                missing.append(path.name)
        self.assertEqual(missing, [], "these modules reach the guard without jev_test_home")


class TheRealStoreIsRedirected(unittest.TestCase):
    def test_the_real_home_maps_to_the_run_dir(self):
        for home in jev_test_home.REAL_HOMES:
            got = allow_once.root(home)
            self.assertTrue(got.startswith(jev_test_home.RUN_DIR + os.sep), got)
            self.assertNotIn(got, jev_test_home.REAL_ROOTS)

    def test_a_temp_home_keeps_the_real_formula(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertEqual(allow_once.root(home), os.path.join(home, ".synaps-cli", "memory", "jev", "access"))


class ABlockUnderTheRealHomeStaysInTheRunDir(GuardCase):
    def test_an_access_block_records_its_request_in_the_temp_store_only(self):
        self.assertIn(os.path.realpath(os.environ["HOME"]), jev_test_home.REAL_HOMES,
                      "this test needs the real $HOME, as the leaking tests had")
        # Precondition, checked BEFORE the guard runs: never drive a block at the real store.
        self.assertTrue(allow_once.root(os.environ["HOME"]).startswith(jev_test_home.RUN_DIR + os.sep))
        # The leaking case of test_stderr_log ('bash high risk'): an rm of the root dir, which
        # holds the synaps sandbox policy, so the access rule (run by jev_ext before the guard)
        # blocks it with a request. Nothing runs it.
        params = {"kind": "before_tool_call", "tool_name": "bash", "tool_runtime_name": "bash",
                  "tool_input": {"command": "rm -r" + "f /"}, "session_id": "sess-iso", "cwd": str(self.ws)}
        decision = guard.access_check(params, self.cfg, self.audit, self.logs.append)
        text = repr(decision)
        found = re.search(r"Request ([0-9a-f]{32})", text)
        self.assertIsNotNone(found, f"expected an access block with a request id, got {text[:400]}")
        rid = found.group(1)
        stored = os.path.join(allow_once.root(os.environ["HOME"]), "requests", f"{rid}.json")
        self.assertTrue(os.path.exists(stored), stored)
        for real_root in jev_test_home.REAL_ROOTS:
            self.assertFalse(os.path.lexists(os.path.join(real_root, "requests", f"{rid}.json")), real_root)


if __name__ == "__main__":
    unittest.main()
