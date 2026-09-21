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

    def test_quoted_credentials_outbound_only(self):
        values = ['fake json pass', 'fake token value', 'fake assignment words',
                  'fake single words', 'fakeplain', 'fake escaped \\"quote']
        text = ('{"password":"fake json pass","access_token":"fake token value"}\n'
                '"api_key"="fake assignment words" secret=\'fake single words\'\n'
                'PASSWORD=fakeplain "secret":"fake escaped \\"quote"')
        output = self.p['tool_output'] + '\n' + text
        with patch.object(self.audit, 'write') as audit_write:
            result = self.run_triage(tool_output=output)
        audit_write.assert_not_called()
        self.assertTrue(result['output'].startswith(output))
        outbound = self.c.calls[0][0]['failure_output']
        for value in values:
            self.assertNotIn(value, outbound)
            self.assertNotIn(value, json.dumps(self.audit.counters))
        self.assertNotIn('assignment words', outbound)

    def test_direct_nonfailure_is_free(self):
        for params in [{}, None, {'tool_name': 'read', 'tool_output': CASES[0][0]},
                       dict(self.p, tool_output='all tests passed'),
                       dict(self.p, tool_output=None)]:
            self.assertEqual(self.t.handle(params, self.c, True, self.audit), triage.CONTINUE)
        self.assertEqual(self.c.calls, [])

    def test_validator_malformed_fields_and_huge_integers(self):
        huge = 10**1000
        good = {'choice': 'syntax', 'confidence': 1}
        for field, values in {
            'confidence': [huge, -huge, {}, [], None, True, float('inf')],
            'score': [huge, -huge, {}, [], None, True, float('nan')],
            'probabilities': [huge, [], None, True, {}, {'syntax': huge},
                              {'syntax': -0.1}, {'syntax': 1.1}, {'syntax': []}]
        }.items():
            for value in values:
                with self.subTest(field=field, value_type=type(value).__name__):
                    self.assertIsNone(triage.valid_choice(dict(good, **{field: value}), ['syntax']))
        self.assertEqual(triage.valid_choice(dict(good, score=2, probabilities={'syntax': 1}), ['syntax']), 'syntax')

    def test_selection_invalid_siblings_do_not_erase_valid(self):
        decision = {'instruction': 'Choose', 'candidates': [
            {'id': 'syntax', 'description': 'source'}, {'id': 'tests', 'description': 'tests'}]}
        for field in ['score', 'confidence', 'probabilities']:
            bad = {'choice': 'syntax', 'confidence': 1, field: 10**1000}
            if field == 'probabilities':
                bad[field] = {'syntax': 10**1000}
            with patch.object(self.c, 'decide', return_value={'answers': {
                '0': bad, '1': {'choice': 'syntax', 'confidence': 1}}}):
                result = json.loads(tools.call_select({'context': 'synthetic', 'decisions': [decision]*2}, self.c, self.audit)['content'])
            self.assertEqual([r['id'] for r in result['decisions']], [None, 'syntax'])

    def test_transport_decode_errors_and_invalid_usage(self):
        from unittest.mock import MagicMock
        c = DecisionClient('apikey_FAKE')
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'\xff'
        with patch('jev.client.urllib.request.urlopen', return_value=response):
            with self.assertRaises(JevError) as raised:
                c.decide('synthetic', {}, op='triage')
        self.assertNotIn('apikey_FAKE', str(raised.exception))
        with patch.object(c, '_post', side_effect=RuntimeError('fake credential value')):
            with self.assertRaises(JevError) as raised:
                c.decide('synthetic', {}, op='triage')
        self.assertNotIn('fake credential value', str(raised.exception))
        self.assertEqual(c.stats.errors, 2)
        self.assertEqual(c.stats.op_stats['triage']['errors'], 2)
        for usage in [None, [], 'invalid', {'input_tokens': 10**1000},
                      {'input_tokens': []}, {'input_tokens': True}, {'input_tokens': -1}]:
            with patch.object(c, '_post', return_value={'usage': usage, 'model': {'bad': 1}}):
                c.decide('synthetic', {}, op='select')
            json.dumps(c.stats.snapshot())
        self.assertEqual(c.stats.input_tokens, 0)
        self.assertEqual(c.stats.calls, 9)

    def test_benchmark_labels_timing_and_no_raw_errors(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('benchmark_synthetic', Path(__file__).resolve().parents[1] / 'scripts' / 'benchmark_synthetic.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        c = DecisionClient('apikey_FAKE')
        with patch.object(c, '_post', side_effect=RuntimeError('fake credential value')):
            result = module.measure(c)
        self.assertEqual(result['cases'], 8)
        self.assertEqual(c.stats.calls, 7)
        self.assertEqual(result['abstain'], 8)
        for row in result['results']:
            self.assertEqual(set(row), {'case', 'expected', 'predicted', 'abstain', 'latency_ms'})
        self.assertGreaterEqual(result['p95_latency_ms'], result['p50_latency_ms'])
        self.assertNotIn('fake credential value', json.dumps(result))
