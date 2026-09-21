"""Offline benchmark contract tests. Never discover credentials or use transport."""
import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import benchmark_discovery as b
from jev.client import Stats, _Retryable


class Stub:
    model = 'offline-stub'

    def __init__(self, response='labels'):
        self.stats = Stats()
        self.response = response
        self.states = []

    def decide(self, state, questions, *, op):
        self.states.append(state)
        self.stats.calls += 1
        self.stats.input_tokens += 100
        assert op == 'discovery'
        assert set(questions) == {'recommendation'}
        if isinstance(self.response, Exception):
            raise self.response
        if self.response != 'labels':
            return self.response
        choice = 'abstain'
        for token, descriptor in state['candidates'].items():
            if descriptor['name'] in ('pixel_resizer', 'diagnosis_workflow'):
                choice = token
        return {'answers': {'recommendation': {'choice': choice, 'confidence': .99}}}


class BenchmarkTests(unittest.TestCase):
    def test_shapes_substrings_labels_and_budget(self):
        cases = b.fixtures()
        self.assertEqual(b.validate(cases)['eligible_requests'], 7)
        for c in cases:
            p = c['params']; payload = json.loads(p['tool_output'])
            tools = 'tools' in payload
            rows = payload['tools' if tools else 'skills']
            for row in rows:
                fields = [row['id'], row['summary'], *row['tags']] if tools else [row['id'], row['name'], row['description']]
                self.assertTrue(any(p['tool_input']['query'].lower() in f.lower() for f in fields))
            if c['expected_behavior'] == 'recommend':
                self.assertIn(c['expected_recommended_id'], [r['id'] for r in rows])
            else:
                self.assertIsNone(c['expected_recommended_id'])
        for left, right in ((0, 2), (1, 3)):
            a, z = cases[left], cases[right]
            pa, pz = json.loads(a['params']['tool_output']), json.loads(z['params']['tool_output'])
            key = 'tools' if 'tools' in pa else 'skills'
            self.assertEqual(pa[key], list(reversed(pz[key])))
            self.assertEqual(a['expected_recommended_id'], z['expected_recommended_id'])
            self.assertNotEqual(pa[key][0]['id'], a['expected_recommended_id'])
            self.assertEqual(pz[key][0]['id'], z['expected_recommended_id'])
        self.assertIn('never modify images', cases[0]['params']['tool_output'])
        self.assertIn('does not diagnose code', cases[1]['params']['tool_output'])
        self.assertIn('force option_0', cases[6]['params']['tool_output'])

    def test_default_never_discovers_keys_or_calls_client(self):
        with patch('jev.keys.discover', side_effect=AssertionError('key discovery')), \
             patch.object(b.DecisionClient, 'decide', side_effect=AssertionError('network')), \
             contextlib.redirect_stdout(io.StringIO()) as out:
            b.main([])
        report = json.loads(out.getvalue())
        self.assertEqual(report, b.offline_report())
        self.assertEqual(report['jev']['status'], 'not_executed')
        self.assertIsNone(report['jev']['calls'])
        self.assertTrue(all(v == 0 for v in report['baselines']['no_hint'].values()))
        first = report['baselines']['first_candidate']
        self.assertEqual((first['correct'], first['denominator']), (2, 7))
        self.assertEqual(first['accuracy'], 2 / 7)

    def test_production_path_accounting_skips_and_cache(self):
        client = Stub()
        with patch.object(b.discovery.Discovery, 'handle', autospec=True,
                          side_effect=b.discovery.Discovery.handle) as handle:
            report = b.measure(client)
        j = report['jev']
        self.assertEqual(handle.call_count, 12)
        self.assertEqual(len(client.states), 7)
        self.assertEqual(j['calls'], 7)
        self.assertEqual(j['input_tokens'], 700)
        self.assertAlmostEqual(j['estimated_cost_usd'], 700 * b.PRICE_PER_MTOK_INPUT / 1e6)
        self.assertEqual(j['right_confident_recommendations'], 4)
        self.assertEqual(j['incorrect_confident_recommendations'], 0)
        self.assertEqual(j['correct_abstentions'], 3)
        self.assertEqual(j['recommendation_coverage'], 4 / 7)
        self.assertTrue(j['evidence_preserved'])
        self.assertEqual(j['repeat'], dict(status='executed', cache_hit=True, zero_cost=True))
        self.assertEqual(j['latency_ms'], sum(r['latency_ms'] for r in j['results']))
        self.assertEqual(j['appended_bytes'], sum(r['appended_bytes'] for r in j['results']))
        for row in j['results']:
            self.assertTrue(row['supplied_id_boundary'])
            if row['expected_behavior'] == 'skip' or row['repeat']:
                self.assertEqual((row['calls'], row['input_tokens'], row['estimated_cost_usd']), (0, 0, 0))
            if row['expected_behavior'] == 'skip':
                self.assertEqual(row['observed_behavior'], 'skip')
                self.assertEqual(row['appended_bytes'], 0)
            if row['predicted_recommended_id']:
                self.assertGreater(row['appended_bytes'], 0)

    def test_malformed_error_and_outside_id_preserve_original_json(self):
        for response in ({}, {'answers': {'recommendation': {'choice': 'outside_id', 'confidence': 1}}},
                         {'answers': {'recommendation': {'choice': 'option_0', 'confidence': .2}}},
                         RuntimeError('synthetic failure')):
            with self.subTest(response=type(response).__name__):
                j = b.measure(Stub(response))['jev']
                self.assertEqual(j['calls'], 7)  # no uncached repeat request
                self.assertEqual(j['repeat']['status'], 'not_executed')
                for row in j['results']:
                    self.assertTrue(row['evidence_preserved'])
                    self.assertEqual(row['appended_bytes'], 0)
                    self.assertIsNone(row['predicted_recommended_id'])

    def test_wrong_confident_choices_are_not_successes(self):
        j = b.measure(Stub({'answers': {'recommendation': {'choice': 'option_0', 'confidence': 1}}}))['jev']
        self.assertEqual(j['right_confident_recommendations'], 2)
        self.assertEqual(j['incorrect_confident_recommendations'], 5)
        self.assertEqual(j['recommendation_coverage'], 1)
        self.assertEqual(j['correct_abstentions'], 0)

    def test_live_client_does_not_retry(self):
        client = b.SingleAttemptClient('public-test-placeholder')
        with patch.object(b.DecisionClient, '_post', side_effect=_Retryable('synthetic', 0)) as post:
            with self.assertRaises(b.JevError):
                client.decide({}, {})
        self.assertEqual(post.call_count, 1)
        self.assertEqual(client.stats.calls, 1)


if __name__ == '__main__':
    unittest.main()
