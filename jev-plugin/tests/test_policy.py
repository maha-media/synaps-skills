#!/usr/bin/env python3
"""Pure-policy unit tests — no network, no API key.

    python3 tests/test_policy.py
"""
from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "extensions"))

from jev import commands, compress, guard, router, tools  # noqa: E402
import jev_ext  # noqa: E402


def score(s, conf, legend=None):
    legend = legend or {str(i): f"L{i}" for i in range(4)}
    n = len(legend)
    lvl = str(min(n - 1, max(0, round(s))))
    probs = {k: 0.0 for k in legend}
    probs[lvl] = 1.0
    return {"type": "score", "score": s, "confidence": conf, "legend": legend, "probabilities": probs}


def noul(p):
    return {"type": "noul", "noul": p}


def choice(c, conf, options):
    probs = {o: 0.0 for o in options}
    probs[c] = 1.0
    return {"type": "choice", "choice": c, "confidence": conf, "probabilities": probs}


class GuardPolicy(unittest.TestCase):
    cfg = guard.GuardConfig({})

    def test_safe_readonly_continues(self):
        r, _ = guard.decide({"risk": score(0.1, 0.95), "touches_secrets": noul(0.02), "leaves_workspace": noul(0.03)}, self.cfg)
        self.assertEqual(r["action"], "continue")

    def test_low_confidence_always_asks(self):
        r, _ = guard.decide({"risk": score(0.4, 0.5), "touches_secrets": noul(0.02), "leaves_workspace": noul(0.03)}, self.cfg)
        self.assertEqual(r["action"], "confirm")

    def test_secrets_override_readonly(self):
        r, _ = guard.decide({"risk": score(0.05, 0.97), "touches_secrets": noul(0.99), "leaves_workspace": noul(0.1)}, self.cfg)
        self.assertEqual(r["action"], "confirm")

    def test_escape_override(self):
        r, _ = guard.decide({"risk": score(1.0, 0.9), "touches_secrets": noul(0.1), "leaves_workspace": noul(0.9)}, self.cfg)
        self.assertEqual(r["action"], "confirm")

    def test_block_only_when_configured(self):
        hot = guard.GuardConfig({"guard_block_at": 2.8})
        r, _ = guard.decide({"risk": score(3.0, 1.0), "touches_secrets": noul(0.1), "leaves_workspace": noul(0.1)}, hot)
        self.assertEqual(r["action"], "block")
        r, _ = guard.decide({"risk": score(3.0, 1.0), "touches_secrets": noul(0.1), "leaves_workspace": noul(0.1)}, self.cfg)
        self.assertEqual(r["action"], "confirm", "default config never hard-blocks")

    def test_block_needs_confidence(self):
        hot = guard.GuardConfig({"guard_block_at": 2.8})
        r, _ = guard.decide({"risk": score(3.0, 0.4), "touches_secrets": noul(0.1), "leaves_workspace": noul(0.1)}, hot)
        self.assertEqual(r["action"], "confirm")

    def test_summarize_never_ships_full_bodies(self):
        s = guard.summarize_call("write", {"path": "x", "content": "A" * 10_000})
        self.assertEqual(len(s["content_preview"]), 400)
        self.assertEqual(s["content_bytes"], 10_000)


class RouterPolicy(unittest.TestCase):
    roles = list(router.ROLES)

    def test_fills_only_omitted(self):
        cfg = router.RouterConfig({})
        answers = {"role": choice("researcher", 0.99, self.roles), "needs_write": noul(0.05)}
        fills, _ = router.plan_fill({"task": "read docs"}, answers, cfg)
        self.assertEqual(fills, {"role": "researcher", "write_policy": {"mode": "read_only"}})
        fills, _ = router.plan_fill({"task": "x", "role": "planner", "write_policy": {"mode": "isolated_worktree"}}, answers, cfg)
        self.assertEqual(fills, {})

    def test_low_conf_role_not_filled(self):
        cfg = router.RouterConfig({})
        fills, _ = router.plan_fill({"task": "x"}, {"role": choice("tester", 0.5, self.roles), "needs_write": noul(0.9)}, cfg)
        self.assertEqual(fills, {})

    def test_never_sets_isolated_worktree(self):
        cfg = router.RouterConfig({})
        fills, _ = router.plan_fill({"task": "x"}, {"role": choice("implementer", 0.99, self.roles), "needs_write": noul(0.99)}, cfg)
        self.assertNotIn("write_policy", fills)

    def test_model_only_with_tier_map_and_confidence(self):
        no_map = router.RouterConfig({})
        answers = {"role": choice("implementer", 0.99, self.roles), "needs_write": noul(0.9),
                   "tier": choice("small", 0.99, list(router.TIERS))}
        fills, _ = router.plan_fill({"task": "x"}, answers, no_map)
        self.assertNotIn("model", fills)
        mapped = router.RouterConfig({"router_models": "small=prov/tiny, medium=prov/mid"})
        fills, _ = router.plan_fill({"task": "x"}, answers, mapped)
        self.assertEqual(fills["model"], "prov/tiny")
        answers["tier"] = choice("frontier", 0.99, list(router.TIERS))
        fills, _ = router.plan_fill({"task": "x"}, answers, mapped)
        self.assertNotIn("model", fills, "frontier always inherits")
        answers["tier"] = choice("small", 0.5, list(router.TIERS))
        fills, _ = router.plan_fill({"task": "x"}, answers, mapped)
        self.assertNotIn("model", fills, "unsure → inherit")


class CompressPolicy(unittest.TestCase):
    cfg = compress.CompressConfig({})
    legend = {str(i): l for i, l in enumerate(compress.NEED_LEVELS)}

    def test_failure_never_compressed(self):
        self.assertFalse(compress.should_compress({"need": score(0.1, 0.99, self.legend), "is_failure": noul(0.6)}, self.cfg))

    def test_only_low_need_with_confidence(self):
        self.assertTrue(compress.should_compress({"need": score(0.2, 0.9, self.legend), "is_failure": noul(0.02)}, self.cfg))
        self.assertTrue(compress.should_compress({"need": score(1.1, 0.8, self.legend), "is_failure": noul(0.02)}, self.cfg))
        self.assertFalse(compress.should_compress({"need": score(2.2, 0.9, self.legend), "is_failure": noul(0.02)}, self.cfg))

    def test_mass_collapses_equivalent_levels(self):
        split = {"type": "score", "score": 0.42, "confidence": 0.58, "legend": self.legend,
                 "probabilities": {"0": 0.59, "1": 0.41, "2": 0.0, "3": 0.0}}
        self.assertTrue(compress.should_compress({"need": split, "is_failure": noul(0.03)}, self.cfg),
                        "59/41 across two compressible levels is 100% compressible")
        spread = {"type": "score", "score": 1.4, "confidence": 0.3, "legend": self.legend,
                  "probabilities": {"0": 0.3, "1": 0.3, "2": 0.4, "3": 0.0}}
        self.assertFalse(compress.should_compress({"need": spread, "is_failure": noul(0.03)}, self.cfg))

    def test_render_keeps_head_tail_and_marker(self):
        out = "H" * 3000 + "M" * 5000 + "T" * 3000
        new = compress.render(out, score(0.1, 0.95, self.legend), self.cfg)
        self.assertTrue(new.startswith("H" * 1500))
        self.assertTrue(new.endswith("T" * 1000))
        self.assertIn("[jev: elided", new)
        self.assertLess(len(new), len(out))

    def test_errorish_regex(self):
        self.assertTrue(compress._ERRORISH.search("....\ntest foo ... FAILED\n"))
        self.assertTrue(compress._ERRORISH.search("thread 'main' panicked at"))
        self.assertFalse(compress._ERRORISH.search("all 42 tests passed\nok\n"))
        self.assertFalse(compress._ERRORISH.search("test result: ok. 240 passed; 0 failed; 0 ignored\n"))
        self.assertTrue(compress._ERRORISH.search("test result: FAILED. 239 passed; 1 failed\n"))


class ToolValidation(unittest.TestCase):
    def test_validate_questions(self):
        self.assertIsNone(tools.validate_questions({"q": {"type": "noul", "instructions": "x?"}}))
        self.assertIsNone(tools.validate_questions({"q": {"type": "choice", "instructions": "x?", "criteria": {"a": None, "b": "B"}}}))
        self.assertIsNone(tools.validate_questions({"q": {"type": "score", "instructions": "x?", "criteria": ["lo", "hi"]}}))
        self.assertIsNotNone(tools.validate_questions({}))
        self.assertIsNotNone(tools.validate_questions({"q": {"type": "essay", "instructions": "x"}}))
        self.assertIsNotNone(tools.validate_questions({"q": {"type": "choice", "instructions": "x", "criteria": {"only": None}}}))
        self.assertIsNotNone(tools.validate_questions({"q": {"type": "score", "instructions": "x", "criteria": ["one"]}}))
        self.assertIsNotNone(tools.validate_questions({f"q{i}": {"type": "noul", "instructions": "x"} for i in range(65)}))




class _FakeClient:
    class stats:
        last_model = None

    def snapshot(self):
        return {}


class FeatureToggles(unittest.TestCase):
    """`/jev guard off` etc.: session-only unless --save; never re-armed by
    a later activate(); persisted via host config.set."""

    def setUp(self):
        self.ext = jev_ext.Extension()
        self.ext.cfg = {"guard": True}
        self.ext.client = _FakeClient()
        self.ext.recompute_features()
        self.events = []
        self.host_calls = []

    def _send(self, o):
        self.events.append(o["params"]["event"])

    def _host(self, m, p):
        self.host_calls.append((m, p))
        return {"ok": True}

    def run_cmd(self, *args):
        self.events.clear()
        commands.handle({"request_id": "t", "args": list(args)}, self.ext, self._send, self._host)

    def test_defaults(self):
        self.assertEqual(self.ext.features, {"guard": True, "router": True, "compress": False, "triage": True, "discovery": False, "tools": True})

    def test_guard_off_is_session_only(self):
        self.run_cmd("guard", "off")
        self.assertFalse(self.ext.features["guard"])
        self.assertEqual(self.ext.session_overrides, {"guard": False})
        self.assertEqual(self.host_calls, [], "session-only must not touch config")
        # a later activate()/recompute must not re-arm the guard
        self.ext.recompute_features()
        self.assertFalse(self.ext.features["guard"])
        # guard hook is skipped entirely
        r = self.ext.hook({"kind": "before_tool_call", "tool_runtime_name": "bash", "tool_input": {"command": "rm -rf /"}})
        self.assertEqual(r, {"action": "continue"})

    def test_guard_on_save_persists_and_clears_override(self):
        self.run_cmd("guard", "off")
        self.run_cmd("guard", "on", "--save")
        self.assertIn(("config.set", {"key": "guard", "value": "true"}), self.host_calls)
        self.assertTrue(self.ext.features["guard"])
        self.assertNotIn("guard", self.ext.session_overrides)

    def test_all_off_keeps_tools(self):
        self.run_cmd("off")
        self.assertEqual(self.ext.features, {"guard": False, "router": False, "compress": False, "triage": False, "discovery": False, "tools": True})
        self.run_cmd("on")
        self.assertEqual(self.ext.features, {"guard": True, "router": True, "compress": True, "triage": True, "discovery": True, "tools": True})

    def test_bare_feature_shows_table(self):
        self.run_cmd("guard")
        self.assertTrue(any(e.get("kind") == "table" for e in self.events))

    def test_bad_value_errors(self):
        self.run_cmd("guard", "maybe")
        self.assertTrue(any(e.get("kind") == "error" for e in self.events))
        self.assertTrue(self.ext.features["guard"])

    def test_enable_without_key_errors(self):
        self.ext.client = None
        self.ext.recompute_features()
        self.run_cmd("guard", "on")
        self.assertTrue(any(e.get("kind") == "error" for e in self.events))

if __name__ == "__main__":
    unittest.main(verbosity=1)
