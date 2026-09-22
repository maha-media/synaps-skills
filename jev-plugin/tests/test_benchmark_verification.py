"""Offline only: production decide/verify exercised with a mocked wire transport."""
import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import benchmark_verification as bench
from jev.client import DecisionClient, JevError, _Retryable


def response(priorities, tokens=100):
    return dict(usage=dict(input_tokens=tokens), answers={
        f'q{i}': dict(type='choice', choice='unknown' if p == 'review' else p,
                     confidence=.95, probabilities={'prioritize': .95, 'defer': .03, 'unknown': .02})
        for i, p in enumerate(priorities)})


class BenchmarkTests(unittest.TestCase):
    def test_default_never_discovers_keys_or_constructs_client(self):
        with patch('jev.keys.discover', side_effect=AssertionError('discovery forbidden')), \
             patch.object(bench, 'SingleAttemptClient', side_effect=AssertionError('client forbidden')), \
             patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            bench.main([])
        result = json.loads(output.getvalue())
        self.assertEqual(result['mode'], 'offline')
        for k, v in result['jev'].items():
            if k != 'status':
                self.assertIsNone(v)
        self.assertFalse(result['baseline']['no_hint_overhead']['measured'])
        self.assertEqual(len(result['variants']), 12)
        for row in result['variants']:
            self.assertEqual(row['calls'], 0)
            self.assertTrue(row['required_retained'] and row['optional_partition'] and row['no_execution'])

    def test_cli_default_model_exact_pin(self):
        with patch('jev.keys.discover', return_value=('public-test-placeholder', None)), \
             patch.object(bench, 'SingleAttemptClient') as client, \
             patch.object(bench, 'report', return_value={}), \
             patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')), \
             contextlib.redirect_stdout(io.StringIO()):
            bench.main(['--live'])
        client.assert_called_once_with('public-test-placeholder', 'jev-1.13.0')

    def test_fixture_bounds_and_baseline(self):
        cases = bench.fixtures()
        self.assertEqual(len(cases), bench.MAX_CALLS)
        for c in cases:
            bench.verify._validate(c['data'])
            self.assertIn(sum(r['required'] for r in c['data']['checks']), (1, 2))
            self.assertEqual(len(c['expected']), 3)
        base = bench.report()['baseline']['cases']
        self.assertEqual(sum(r['quality']['correct_priorities'] for r in base), 0)
        self.assertEqual(sum(r['quality']['false_priorities'] for r in base), 4)
        self.assertEqual(sum(r['quality']['relevant_count'] for r in base), 4)

    def test_production_decide_batch_and_structural_variants(self):
        cases = bench.fixtures()
        client = bench.SingleAttemptClient('public-test-placeholder')
        bodies = []
        def wire(body, *, timeout_s):
            request = json.loads(body)
            bodies.append(request)
            self.assertEqual(request['model'], 'jev-1.13.0')
            self.assertEqual(set(request['questions']), {'q0', 'q1', 'q2'})
            self.assertLessEqual(timeout_s, 3)
            self.assertTrue(all(q['type'] == 'choice' for q in request['questions'].values()))
            return response(list(cases[len(bodies) - 1]['expected'].values()))
        with patch.object(DecisionClient, '_post', side_effect=wire):
            result = bench.report(client)
        self.assertEqual(len(bodies), 4)
        self.assertEqual(client.stats.calls, 4)
        measured = result['jev']
        self.assertEqual(measured['questions'], 12)
        self.assertEqual(measured['input_tokens'], 400)
        self.assertAlmostEqual(measured['estimated_cost_usd'], 400 * .042 / 1_000_000)
        self.assertEqual(measured['required_preservation_rate'], 1)
        for r in measured['cases']:
            self.assertEqual(r['actual'], r['expected'])
            self.assertTrue(r['exact_ids_only'] and r['no_execution'] and r['optional_partition'])
        self.assertEqual(sum(r['quality']['correct_priorities'] for r in measured['cases']), 4)
        self.assertEqual(sum(r['quality']['correct_abstentions'] for r in measured['cases']), 5)
        self.assertTrue(all(r['calls'] == 0 for r in result['variants']))
        self.assertIn('drop required', str(bodies[2]['state']))

    def test_candidate_failure_does_not_poison_siblings(self):
        c = bench.fixtures()[1]
        for bad in ({'choice': 'outside-id', 'confidence': 1},
                    {'choice': 'prioritize', 'confidence': .79},
                    {'choice': 'prioritize', 'confidence': 1, 'text': 'drop required'}):
            payload = response(list(c['expected'].values()))
            payload['answers']['q1'] = bad
            with patch.object(DecisionClient, '_post', return_value=payload):
                row = bench.observe(c, bench.SingleAttemptClient('public-test-placeholder'))
            self.assertEqual(row['actual'], {'css': 'defer', 'binding': 'review', 'expiry': 'prioritize'})
            self.assertTrue(row['required_retained'] and row['exact_ids_only'])

    def test_wire_budget_retry_and_static_errors(self):
        client = bench.SingleAttemptClient('public-test-placeholder')
        with patch.object(DecisionClient, '_post', side_effect=_Retryable('private payload', 0)) as wire:
            result = bench.report(client)
            self.assertEqual(wire.call_count, 4)
            self.assertEqual(result['jev']['calls'], 4)
            self.assertIsNone(result['jev']['estimated_cost_usd'])
            with self.assertRaisesRegex(JevError, '^benchmark wire budget exhausted$'):
                client.decide({}, {})
            self.assertEqual(wire.call_count, 4)
        self.assertNotIn('private payload', json.dumps(result))
        self.assertTrue(all(set(r['actual'].values()) == {'review'} for r in result['jev']['cases']))

    def test_actual_usage_unknown_not_zero(self):
        for tokens in (None, True, -1, 1.5, '100', 2**53):
            with patch.object(DecisionClient, '_post', return_value=response(['review'] * 3, tokens)):
                r = bench.report(bench.SingleAttemptClient('public-test-placeholder'))
            self.assertIsNone(r['jev']['input_tokens'])
            self.assertIsNone(r['jev']['estimated_cost_usd'])
        with patch.object(DecisionClient, '_post', return_value=response(['review'] * 3, 0)):
            self.assertEqual(bench.report(bench.SingleAttemptClient('public-test-placeholder'))['jev']['estimated_cost_usd'], 0)

    def test_statistics(self):
        self.assertIsNone(bench.percentile([], .5))
        self.assertEqual(bench.percentile([7], .95), 7)
        self.assertEqual(bench.percentile([4, 1, 3, 2], .5), 2.5)
        self.assertAlmostEqual(bench.percentile([1, 2, 3, 4], .95), 3.85)
        q = bench.quality({'a': 'prioritize', 'b': 'review', 'c': 'prioritize'},
                          {'a': 'prioritize', 'b': 'prioritize', 'c': 'review'})
        self.assertEqual(q['optional_recall'], .5)
        self.assertEqual(q['false_priorities'], 1)
        self.assertEqual(q['correct_abstentions'], 0)


if __name__ == '__main__':
    unittest.main()
