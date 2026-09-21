"""Synthetic offline regressions; fake transport and credentials only."""
import json
import sys
import signal
import time
from pathlib import Path
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions'))
from jev import triage, tools
from jev.audit import Audit
from jev.client import DecisionClient, JevError, _Retryable
from jev_ext import Extension

CASES = [
    ('Command failed (exit 127):\nbash: widget: command not found', 'dependency'),
    ('Command failed (exit 1):\nSyntaxError: invalid syntax', 'syntax'),
    ('Command failed (exit 1):\nAssertionError: expected 2, got 3', 'assertion'),
    ('Command failed (exit 1):\nPermission denied', 'permission'),
    ('Command timed out after 30s', 'timeout'),
    ('BUILD FAILED\nmissing SDK version', 'environment'),
    ('Tool execution failed: Command failed (exit 2):\nunexplained', 'unknown'),
]

class Stub:
    def __init__(self, answer=None):
        self.answer = answer or {'choice': 'syntax', 'confidence': .95}
        self.calls = []
    def decide(self, state, questions, **kwargs):
        self.calls.append((state, questions, kwargs))
        return {'answers': {k: self.answer for k in questions}}

class Decisions(unittest.TestCase):
    def setUp(self):
        self.t = triage.Triage()
        self.c = Stub()
        self.audit = Audit(None)
        self.p = {'tool_name': 'bash', 'session_id': 's', 'tool_output': CASES[1][0]}
    def run_triage(self, **overrides):
        return self.t.handle(dict(self.p, **overrides), self.c, True, self.audit)
    def test_envelopes_and_normal_mentions(self):
        for text, _ in CASES:
            self.assertTrue(triage.recognized(dict(self.p, tool_output=text)))
        for text in ['all tests passed', 'Docs mention Command failed (exit 1):\nx', 'error: example', 'Command failed (exit 0):\nx']:
            self.assertFalse(triage.recognized(dict(self.p, tool_output=text)))
        self.assertFalse(triage.recognized(dict(self.p, tool_name='read')))
    def test_preservation_and_redaction(self):
        secrets = ['apikey_FAKE123', 'sk-FAKE123', 'Bearer FAKEVALUE', 'password=fakepass', '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----']
        output = self.p['tool_output'] + '\n' + '\n'.join(secrets)
        result = self.run_triage(tool_output=output, tool_input={'command': 'private command'})
        self.assertTrue(result['output'].startswith(output))
        self.assertLessEqual(len(result['output']) - len(output), 350)
        sent = json.dumps(self.c.calls)
        for secret in secrets:
            self.assertNotIn(secret, sent)
        self.assertNotIn('private command', sent)
        self.assertNotIn('fakepass', json.dumps(self.audit.counters))
    def test_abstain_cache_and_bounds(self):
        for a in [{'choice': 'unknown', 'confidence': 1}, {'choice': 'syntax', 'confidence': float('nan')}, {'choice': 'syntax', 'confidence': .1}, {'choice': 'syntax', 'confidence': 1, 'score': float('inf')}, []]:
            self.c.answer = a
            self.assertEqual(self.run_triage(session_id=None), triage.CONTINUE)
        self.c.answer = {'choice': 'syntax', 'confidence': 1}
        self.run_triage(); n = len(self.c.calls); self.run_triage()
        self.assertEqual(len(self.c.calls), n)
        self.run_triage(session_id='other'); self.assertEqual(len(self.c.calls), n+1)
        self.run_triage(session_id=None); self.run_triage(session_id=None)
        self.assertEqual(len(self.c.calls), n+3)
        for i in range(150):
            self.run_triage(session_id=str(i))
        self.assertEqual(len(self.t.cache), triage.CACHE_SIZE)
    def test_no_cost_disabled_huge_truncated_or_normal(self):
        self.assertEqual(self.t.handle(self.p, self.c, False, self.audit), triage.CONTINUE)
        for text in [self.p['tool_output'] + 'x'*5000, self.p['tool_output'] + '\n[truncated]']:
            self.assertEqual(self.run_triage(tool_output=text), triage.CONTINUE)
        e = Extension(); e.client = self.c; e.recompute_features()
        for text in ['all tests passed', 'documentation: Command failed (exit 1):\nx']:
            self.assertEqual(e.hook(dict(self.p, kind='after_tool_call', tool_output=text)), triage.CONTINUE)
        self.assertEqual(len(self.c.calls), 0)
    def test_compression_never_runs_even_off_or_abstaining(self):
        e = Extension(); e.client = self.c; e.recompute_features(); e.features['compress'] = True
        for enabled in [False, True]:
            e.features['triage'] = enabled
            with patch('jev_ext.compress.handle', side_effect=AssertionError('compression called')):
                self.assertEqual(e.hook(dict(self.p, kind='after_tool_call', tool_output='Command timed out after 30s\n'+'x'*7000)), triage.CONTINUE)
    def test_timeout_exact_continue(self):
        with patch.object(self.c, 'decide', side_effect=JevError('fake secret')):
            self.assertEqual(self.run_triage(), triage.CONTINUE)
    def test_select_validation_and_results(self):
        data = {'context': 'synthetic syntax error', 'decisions': [{'instruction': 'Which file?', 'candidates': [{'id': 'syntax', 'description': 'source'}, {'id': 'tests', 'description': 'test'}]}]}
        result = json.loads(tools.call_select(data, self.c, self.audit)['content'])
        self.assertEqual(result['decisions'][0]['id'], 'syntax')
        self.assertIn(tools.ABSTAIN, self.c.calls[0][1]['0']['criteria'])
        for a in [{'choice': 'invented', 'confidence': 1}, {'choice': 'syntax', 'confidence': float('nan')}, {'choice': tools.ABSTAIN, 'confidence': 1}]:
            self.c.answer = a
            self.assertIsNone(json.loads(tools.call_select(data, self.c, self.audit)['content'])['decisions'][0]['id'])
        for bad in [[], data['decisions']*33, [{'instruction': 'x', 'candidates': [{'id': tools.ABSTAIN, 'description': 'x'}]*2}]]:
            n = len(self.c.calls)
            with self.assertRaises(tools.ToolError):
                tools.call_select(dict(data, decisions=bad), self.c, self.audit)
            self.assertEqual(n, len(self.c.calls))
    def test_retry_remaining_budget_and_stats(self):
        c = DecisionClient('apikey_FAKE', timeout_s=4)
        clock = [0.0]; budgets = []
        def post(body, *, timeout_s):
            budgets.append(timeout_s)
            if len(budgets) == 1:
                clock[0] += 2.8
                raise _Retryable('rate limit', .3)
            clock[0] += .1
            return {'usage': {'input_tokens': 20}}
        with patch('jev.client.time.monotonic', side_effect=lambda: clock[0]), patch('jev.client.time.sleep', side_effect=lambda t: clock.__setitem__(0, clock[0]+t)), patch.object(c, '_post', side_effect=post):
            c.decide('x', {}, op='triage')
        self.assertAlmostEqual(budgets[1], .9)
        self.assertEqual(c.stats.snapshot()['op_stats']['triage']['input_tokens'], 20)
        self.assertEqual(c.stats.snapshot()['by_op'], {'triage': 1})

    def test_hard_deadline_and_timer_cleanup(self):
        c = DecisionClient('apikey_FAKE', timeout_s=.1)
        original = signal.getsignal(signal.SIGALRM)
        with patch.object(c, '_post', side_effect=lambda *a, **kw: time.sleep(.4)):
            with self.assertRaises(JevError):
                c.decide('synthetic', {}, op='select')
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
        self.assertEqual(signal.getsignal(signal.SIGALRM), original)
        self.assertEqual(c.stats.snapshot()['op_stats']['select']['errors'], 1)

    def test_no_key_and_abstention_cached(self):
        self.assertEqual(self.t.handle(self.p, None, True, self.audit), triage.CONTINUE)
        self.c.answer = {'choice': 'unknown', 'confidence': 1}
        self.run_triage(); self.run_triage()
        self.assertEqual(len(self.c.calls), 1)
        self.assertEqual(self.audit.counters['triage.cache'], 1)
