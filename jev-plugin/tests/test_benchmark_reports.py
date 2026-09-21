"""Synthetic, sequential, mocked transport only; no keys, host workers or API."""
import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import benchmark_reports as bench
from jev.client import DecisionClient, JevError, _Retryable
from jev_ext import Extension


def response(v='gap', c='none_reported', tokens=100):
    return dict(model=bench.MODEL, usage=dict(input_tokens=tokens), answers={
        q: dict(type='choice', choice=value, confidence=.95,
                probabilities={k: .95 if k == value else .05 / (len(criteria) - 1)
                               for k in criteria})
        for q, value, criteria in [('verification', v, bench.reports.CRITERIA['verification']),
                                   ('concern', c, bench.reports.CRITERIA['concern'])]})


class BenchmarkTests(unittest.TestCase):
    def test_default_no_discovery_io_or_client(self):
        with patch('jev.keys.discover', side_effect=AssertionError('key discovery')), \
             patch.object(bench, 'SingleAttemptClient', side_effect=AssertionError('client')), \
             patch('builtins.open', side_effect=AssertionError('file IO')), \
             patch('socket.socket', side_effect=AssertionError('network')), \
             patch('subprocess.Popen', side_effect=AssertionError('execution')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            bench.main([])
        result = json.loads(output.getvalue())
        self.assertEqual(result['mode'], 'offline')
        for key, value in result['jev'].items():
            if key != 'status':
                self.assertIsNone(value)
        self.assertEqual(len(result['variants']), 28)
        for r in result['variants']:
            self.assertEqual(r['calls'], 0)
            self.assertEqual(r['flags'], r['expected'])
            self.assertTrue(r['original_values_preserved'] and r['input_not_mutated'] and r['no_authority'])
            if not r['expected']:
                self.assertEqual((r['action'], r['delta_bytes']), ('continue', 0))
        self.assertEqual(result['baseline']['quality'], bench.quality(['a', 'b', 'c'], []))

    def test_live_opt_in_and_missing_key_are_mocked(self):
        with patch('jev.keys.discover', return_value=('public-placeholder', None)) as discover, \
             patch.object(bench, 'SingleAttemptClient') as client, \
             patch.object(bench, 'report', return_value={}), \
             contextlib.redirect_stdout(io.StringIO()):
            bench.main(['--live'])
        discover.assert_called_once_with()
        client.assert_called_once_with('public-placeholder')
        with patch('jev.keys.discover', return_value=(None, None)), \
             patch.object(bench, 'SingleAttemptClient') as client, \
             contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as exit:
            bench.main(['--live'])
        self.assertEqual(exit.exception.code, 2)
        client.assert_not_called()

    def test_fixed_bounds_labels_and_envelope(self):
        cases = bench.fixtures()
        self.assertEqual(len(cases), 4)
        self.assertEqual([c['expected'] for c in cases],
                         [['verification_gap'], ['conflicting_claims'], [], ['verification_gap']])
        for c in cases:
            raw, data = bench.reports.validate(c['params'])
            self.assertLessEqual(len(raw.encode()), 32768)
            self.assertLessEqual(len(data['output'].encode()), 8192)
            self.assertEqual(c['params']['kind'], 'after_tool_call')
        cases[0]['expected'].clear()
        self.assertEqual(bench.fixtures()[0]['expected'], ['verification_gap'])

    def test_production_batches_preservation_cache_and_measurements(self):
        choices = [('gap', 'none_reported'), ('claim_present', 'contradiction'),
                   ('claim_present', 'none_reported'), ('gap', 'none_reported')]
        bodies = []
        cases = bench.fixtures()
        def wire(body, *, timeout_s):
            req = json.loads(body)
            i = len(bodies)
            bodies.append(req)
            self.assertEqual(req['state'], {'report': json.loads(cases[i]['params']['tool_output'])['output']})
            self.assertEqual(req['model'], bench.MODEL)
            self.assertEqual(set(req['questions']), {'verification', 'concern'})
            self.assertTrue(all(q['type'] == 'choice' for q in req['questions'].values()))
            self.assertGreater(timeout_s, 0)
            self.assertLessEqual(timeout_s, 3)
            return response(*choices[i])
        client = bench.SingleAttemptClient('public-placeholder')
        with patch.object(DecisionClient, '_post', side_effect=wire):
            r = bench.report(client)['jev']
        self.assertEqual((len(bodies), r['calls'], r['questions']), (4, 4, 8))
        self.assertEqual(r['input_tokens'], 400)
        self.assertAlmostEqual(r['estimated_cost_usd'], 400 * .042 / 1_000_000)
        self.assertEqual(r['quality'], bench.quality(['a', 'b', 'c'], ['a', 'b', 'c']))
        for row, repeat in zip(r['cases'], r['repeats']):
            self.assertEqual(row['flags'], row['expected'])
            self.assertEqual((repeat['calls'], repeat['cache_hits']), (0, 1))
            self.assertEqual(row['flags'], repeat['flags'])
            self.assertTrue(row['original_values_preserved'] and row['input_not_mutated'] and row['no_authority'])
            self.assertEqual(row['delta_bytes'], row['output_bytes'] - row['input_bytes'])
        self.assertEqual(r['output_bytes'], sum(x['output_bytes'] for x in r['cases']))
        self.assertEqual(r['delta_bytes'], sum(x['delta_bytes'] for x in r['cases']))
        self.assertTrue(all(x['model'] == bench.MODEL and x['network_latency_ms'] >= 0 for x in r['measurements']))

    def test_errors_no_retry_or_cache_repeat_budget(self):
        for error in (_Retryable('private error', 0), RuntimeError('private error')):
            client = bench.SingleAttemptClient('public-placeholder')
            with patch.object(DecisionClient, '_post', side_effect=error) as wire, \
                 patch('time.sleep', side_effect=AssertionError('retry')):
                result = bench.report(client)
                self.assertEqual(wire.call_count, 4)
                with self.assertRaises(JevError):
                    client.decide({}, {}, op='reports')
                self.assertEqual(wire.call_count, 4)
            r = result['jev']
            self.assertEqual((r['calls'], r['questions']), (4, 8))
            self.assertTrue(all(x['status'] == 'not_run_initial_error' for x in r['repeats']))
            self.assertNotIn('private error', json.dumps(result))
            self.assertIsNone(r['input_tokens'])

    def test_unknown_abstentions_cached_and_malformed_response_not_repeated(self):
        for resp, error in [(response('unknown', 'unknown'), False), ({'answers': []}, True)]:
            client = bench.SingleAttemptClient('public-placeholder')
            with patch.object(DecisionClient, '_post', return_value=resp) as wire:
                result = bench.report(client)['jev']
            self.assertEqual(wire.call_count, 4)
            self.assertTrue(all(not r['flags'] for r in result['cases']))
            self.assertTrue(all(r['status'] == ('not_run_initial_error' if error else 'executed')
                                for r in result['repeats']))

    def test_missing_invalid_usage_and_model_allowlist(self):
        for tokens in (None, True, -1, 2**53, '100'):
            resp = response(tokens=tokens)
            resp['model'] = 'untrusted upstream prose'
            client = bench.SingleAttemptClient('public-placeholder')
            with patch.object(DecisionClient, '_post', return_value=resp):
                r = bench.report(client)['jev']
            self.assertIsNone(r['input_tokens'])
            self.assertIsNone(r['estimated_cost_usd'])
            self.assertTrue(all(s['model'] is None for s in r['measurements']))
        resp = response()
        del resp['usage']
        with patch.object(DecisionClient, '_post', return_value=resp):
            self.assertIsNone(bench.report(bench.SingleAttemptClient('public-placeholder'))['jev']['input_tokens'])

    def test_quality_arithmetic(self):
        self.assertEqual(bench.quality(['a', 'b'], ['a', 'c']),
                         dict(true_positive=1, false_positive=1, false_negative=1, precision=.5, recall=.5))
        self.assertIsNone(bench.quality([], [])['recall'])
        self.assertIsNone(bench.quality([], [])['precision'])

    def test_cache_differences_offline_only(self):
        class MockClient:
            model = bench.MODEL
            def __init__(self):
                self.calls = 0
            def decide(self, *args, **kwargs):
                self.calls += 1
                return response()
        client, handler = MockClient(), bench.reports.Reports()
        c = bench.fixtures()[0]
        for _ in range(2):
            bench.observe(c, handler, client)
        self.assertEqual(client.calls, 1)
        c['params']['session_id'] += '-other'
        bench.observe(c, handler, client)
        c['params']['tool_output'] += ' '
        bench.observe(c, handler, client)
        client.model = 'offline-other-model'
        bench.observe(c, handler, client)
        self.assertEqual(client.calls, 4)

    def test_real_extension_hook_no_compression_or_authority(self):
        ext = Extension()
        ext.features['reports'] = True
        ext.features['compress'] = True
        ext.client = bench.SingleAttemptClient('public-placeholder')
        params = bench.fixtures()[3]['params']
        before = copy.deepcopy(params)
        with patch.object(DecisionClient, '_post', return_value=response()), \
             patch('jev_ext.compress.handle', side_effect=AssertionError('compression')):
            result = ext.hook(params)
        self.assertEqual(params, before)
        data = json.loads(result['output'])
        self.assertEqual(data.pop('jev_advisory'), dict(flags=['verification_gap'], note=bench.reports.NOTE))
        self.assertEqual(data, json.loads(before['tool_output']))


if __name__ == '__main__':
    unittest.main()
