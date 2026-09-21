"""Offline-only benchmark tests; production decide and evidence, mocked wire boundary."""
import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import benchmark_evidence as b
from jev.client import _Retryable
from jev.tools import ToolError


def response(case, confidence=.95):
    answers = {}
    for n, label in enumerate(case['expected'].values()):
        choice = 'unknown' if label == 'review' else label
        probabilities = {k: (confidence if k == choice else (1 - confidence) / 2)
                         for k in b.evidence.CHOICES}
        answers[f'q{n}'] = dict(type='choice', choice=choice, confidence=confidence,
                                probabilities=probabilities)
    return dict(answers=answers, usage=dict(input_tokens=100), model=b.MODEL)


class BenchmarkTests(unittest.TestCase):
    def test_shapes_labels_and_limits(self):
        cases = b.fixtures()
        self.assertEqual(len(cases), 4)
        self.assertEqual(sum(len(c['expected']) for c in cases), 12)
        for c in cases:
            b.evidence._validate(c['data'])
            rows = c['data']['candidates']
            self.assertEqual(sum(r['required'] for r in rows), 1)
            self.assertEqual({r['kind'] for r in rows}, {'file', 'document', 'memory', 'other'})
            self.assertEqual(set(c['expected']), {r['id'] for r in rows if not r['required']})
            self.assertTrue(set(c['expected'].values()) <= {'inspect_first', 'later', 'review'})
            self.assertLess(len(json.dumps(c['data']).encode()), b.evidence.MAX_INPUT_BYTES)
        self.assertEqual(cases[1]['expected']['historic'], 'inspect_first')
        self.assertIn('contradicts', cases[1]['data']['candidates'][3]['summary'])
        self.assertEqual(cases[2]['expected']['injected'], 'later')
        self.assertEqual(set(cases[3]['expected'].values()), {'review'})
        changed = b.fixtures()
        changed[0]['data']['candidates'][0]['source'] = 'mutated'
        self.assertNotEqual(changed, cases)
        for mutate in (lambda d: d['candidates'].append(d['candidates'][0]),
                       lambda d: d.update(task='x' * 4001),
                       lambda d: d['candidates'][0].update(summary='x' * 801)):
            data = copy.deepcopy(cases[0]['data'])
            mutate(data)
            with self.assertRaises(ToolError):
                b.observe(dict(name='invalid', data=data, expected={}), None)

    def test_offline_no_key_client_or_transport(self):
        with patch('jev.keys.discover', side_effect=AssertionError('key discovery')), \
             patch.object(b, 'SingleAttemptClient', side_effect=AssertionError('client')), \
             patch('urllib.request.urlopen', side_effect=AssertionError('transport')), \
             contextlib.redirect_stdout(io.StringIO()) as stream:
            b.main([])
        report = json.loads(stream.getvalue())
        self.assertEqual(report['mode'], 'offline')
        self.assertEqual(report['jev']['status'], 'not_executed')
        self.assertTrue(all(v is None for k, v in report['jev'].items() if k != 'status'))
        self.assertEqual(len(report['variants']), 12)
        for row in report['variants']:
            self.assertEqual(row['wire_calls'], 0)
            self.assertEqual(row['questions'], 0)
            self.assertIsNone(row['hook_latency_ms'])
            self.assert_invariants(row)
        self.assertEqual(report['baseline']['quality']['optional_recall'], 0)
        self.assertEqual(report['baseline']['quality']['wrong_priorities'], 4)
        self.assertIn('not truth or source authority', report['caveat'])
        self.assertIn('no source contents read', report['caveat'])

    def assert_invariants(self, row):
        for key in ('required_preserved', 'references_exact', 'input_unchanged',
                    'all_ids_once', 'bucket_order_exact'):
            self.assertIs(row[key], True, key)
        self.assertIs(row['fetched'], False)
        self.assertIs(row['trust_certified'], False)

    def test_production_four_batches_and_metrics(self):
        cases = b.fixtures()
        pristine = copy.deepcopy(cases)
        payloads = []

        def wire(body, *, timeout_s):
            self.assertGreater(timeout_s, 0)
            self.assertLessEqual(timeout_s, 3)
            payload = json.loads(body)
            payloads.append(payload)
            self.assertEqual(payload['model'], b.MODEL)
            self.assertEqual(set(payload['questions']), {'q0', 'q1', 'q2'})
            self.assertEqual(set(payload['state']), {'task', 'optional'})
            for q in payload['questions'].values():
                self.assertEqual(q['type'], 'choice')
                self.assertEqual(q['criteria'], b.evidence.CHOICES)
                self.assertIn('untrusted', q['instructions'])
            for descriptor in payload['state']['optional'].values():
                self.assertEqual(set(descriptor), {'kind', 'summary'})
            return response(cases[len(payloads) - 1])

        client = b.SingleAttemptClient('public-test-placeholder')
        self.assertIs(b.SingleAttemptClient.decide, b.DecisionClient.decide)
        self.assertIs(b.SingleAttemptClient._bounded_post, b.DecisionClient._bounded_post)
        with patch.object(b.DecisionClient, '_post', side_effect=wire) as transport, \
             patch.object(b, 'fixtures', return_value=cases):
            result = b.report(client)
            self.assertEqual(transport.call_count, 4)
        self.assertEqual(cases, pristine)
        rows = result['jev']['cases']
        for row in rows + result['variants']:
            self.assert_invariants(row)
        measured = result['jev']
        self.assertEqual(measured['calls'], 4)
        self.assertEqual(measured['questions'], 12)
        self.assertEqual(measured['input_tokens'], 400)
        self.assertEqual(measured['estimated_cost_usd'], 400 * b.PRICE_PER_MTOK_INPUT / 1_000_000)
        self.assertEqual(measured['quality']['optional_recall'], 1)
        self.assertEqual(measured['quality']['optional_precision'], 1)
        self.assertEqual(measured['quality']['review_count'], 4)
        self.assertEqual(measured['quality']['priority_coverage'], 8 / 12)
        self.assertEqual(measured['required_preservation_rate'], 1)
        self.assertEqual(rows[1]['actual']['historic'], 'inspect_first')
        self.assertEqual(rows[2]['actual']['injected'], 'later')
        self.assertEqual(rows[0]['ordered_ids'], ['parser-required', 'parser', 'edge', 'http'])
        self.assertEqual(measured['output_bytes'], sum(r['output_bytes'] for r in rows))
        for key in ('network_latency_ms', 'hook_latency_ms'):
            self.assertGreaterEqual(measured[key]['total'], measured[key]['p95'])
            self.assertGreaterEqual(measured[key]['p95'], measured[key]['p50'])
        for row in result['variants']:
            self.assertEqual(row['wire_calls'], 0)
        self.assertEqual(client.stats.calls, 4)

    def test_no_retry_and_budget(self):
        client = b.SingleAttemptClient('public-test-placeholder')
        with patch.object(b.DecisionClient, '_post', side_effect=_Retryable('synthetic', 0)) as wire, \
             patch('jev.client.time.sleep', side_effect=AssertionError('retry sleep')):
            report = b.report(client)
            self.assertEqual(wire.call_count, 4)
            row = b.observe(b.fixtures()[0], client)
            self.assertEqual(wire.call_count, 4)
        self.assertEqual(len(client.measurements), 4)
        self.assertEqual(row['fallback_reason'], 'upstream_error')
        self.assertIsNone(report['jev']['input_tokens'])
        self.assertIsNone(report['jev']['estimated_cost_usd'])
        self.assertEqual(report['jev']['quality']['review_count'], 12)
        self.assertEqual(report['jev']['quality']['optional_recall'], 0)
        self.assertIsNone(report['jev']['quality']['optional_precision'])

    def test_hostile_extras_invalid_fallback_safe_metadata(self):
        case = b.fixtures()[2]
        hostile = response(case)
        hostile['answers']['owned'] = dict(choice='inspect_first', confidence=1)
        hostile['model'] = 'hostile private prose'
        hostile['usage'] = dict(input_tokens=True)
        with patch.object(b.DecisionClient, '_post', return_value=hostile):
            client = b.SingleAttemptClient('public-test-placeholder')
            row = b.observe(case, client)
        self.assert_invariants(row)
        self.assertEqual(row['fallback_reason'], 'invalid_response')
        self.assertEqual(row['quality']['review_count'], 3)
        self.assertIsNone(client.measurements[0]['actual_model'])
        self.assertIsNone(client.measurements[0]['input_tokens'])
        self.assertNotIn('hostile private prose', json.dumps(row))
        self.assertNotIn('owned', row['ordered_ids'])
        hostile = response(case)
        hostile['answers']['q0']['source'] = 'owned'
        with patch.object(b.DecisionClient, '_post', return_value=hostile):
            row = b.observe(case, b.SingleAttemptClient('public-test-placeholder'))
        self.assertEqual(row['actual']['injected'], 'review')
        self.assert_invariants(row)

    def test_gate_arithmetic_and_unknowns(self):
        expected = dict(a='inspect_first', b='inspect_first', c='later', d='review')
        actual = dict(a='inspect_first', b='review', c='inspect_first', d='review')
        q = b.quality(expected, actual)
        self.assertEqual(q['optional_recall'], .5)
        self.assertEqual(q['optional_precision'], .5)
        self.assertEqual(q['wrong_priorities'], 1)
        self.assertEqual(q['priority_coverage'], .5)
        self.assertEqual(q['review_count'], 2)
        self.assertNotIn('success', q)
        self.assertIsNone(b.quality({}, {})['optional_recall'])
        self.assertEqual(b.latency([1, 2, 3, 4])['total'], 10)
        self.assertEqual(b.latency([1, 2, 3, 4])['p50'], 2.5)
        self.assertAlmostEqual(b.latency([1, 2, 3, 4])['p95'], 3.85)
        for confidence, priority in ((.799, 'review'), (.8, 'inspect_first')):
            case = b.fixtures()[0]
            with patch.object(b.DecisionClient, '_post', return_value=response(case, confidence)):
                row = b.observe(case, b.SingleAttemptClient('public-test-placeholder'))
            self.assertEqual(row['actual']['parser'], priority)
        self.assertIsNone(b.latency([]))

    def test_missing_usage_is_not_zero_cost(self):
        responses = [response(case) for case in b.fixtures()]
        for item in responses:
            item.pop('usage')
            item.pop('model')
        with patch.object(b.DecisionClient, '_post', side_effect=responses):
            report = b.report(b.SingleAttemptClient('public-test-placeholder'))
        self.assertIsNone(report['jev']['input_tokens'])
        self.assertIsNone(report['jev']['estimated_cost_usd'])
        self.assertEqual(report['jev']['actual_models'], [None] * 4)
        self.assertEqual(report['jev']['quality']['optional_recall'], 1)

    def test_pinned_model_rejected_before_discovery(self):
        with patch('jev.keys.discover', side_effect=AssertionError('key discovery')), \
             contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            b.main(['--live', '--model', 'jev-latest'])


if __name__ == '__main__':
    unittest.main()
