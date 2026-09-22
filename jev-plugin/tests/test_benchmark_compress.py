"""Sequential offline production-hook benchmark contracts; never live API."""
import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import benchmark_compress as b
from jev.client import DecisionClient, JevError, _Retryable
from jev_ext import Extension


def response():
    result = b.ForcedCompact().decide({}, {}, op='compress')
    result.update(model=b.MODEL, usage={'input_tokens': 120, 'output_tokens': 12, 'total_tokens': 132})
    return result


class BenchmarkTests(unittest.TestCase):
    def test_offline_no_io(self):
        with patch('jev.keys.discover', side_effect=AssertionError('keys')), \
             patch.object(b, 'SingleAttemptClient', side_effect=AssertionError('client')), \
             patch('builtins.open', side_effect=AssertionError('files')), \
             patch('socket.socket', side_effect=AssertionError('network')), \
             patch('subprocess.Popen', side_effect=AssertionError('execution')), \
             contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(b.main([]), 0)
        report = json.loads(out.getvalue())
        self.assertIsNone(report['jev'])
        self.assertEqual(report['raw_baseline']['fold_count'], 0)
        self.assertEqual(report['deterministic_baseline']['fold_count'], 4)
        self.assertLess(len(out.getvalue()), 12000)
        for row in report['free_variants']:
            self.assertEqual(row['calls'], 0)
            self.assertTrue(row['roundtrip'])

    def test_fixtures_exact_and_eligible(self):
        cases = b.fixtures()
        self.assertEqual(len(cases), 4)
        self.assertEqual(len(cases[0]['params']['tool_output'].splitlines()), 2000)
        self.assertEqual(len(cases[1]['params']['tool_output'].splitlines()), 1000)
        for case in cases:
            raw = case['params']['tool_output']
            self.assertIsNone(case['expected'])
            self.assertEqual(case['params']['tool_input'], {'fixture': case['name']})
            self.assertTrue(6144 <= len(raw.encode()) <= 65536)
            self.assertIsNone(b.compress.MARKERS.search(raw))
            self.assertIsNone(b.compress._ERRORISH.search(raw))
            encoded = b.compress.encode_output(raw)
            self.assertEqual(b.compress.decode_output(encoded).encode(), raw.encode())
            row = b.observe(case, b.ForcedCompact())
            self.assertTrue(row['folded'])
            self.assertEqual((row['calls'], row['questions']), (1, 1))
            self.assertLessEqual(row['delta_bytes'], -1024)
            self.assertLessEqual(row['transmitted_output_bytes'], row['raw_bytes'] * .7)
        for case in cases[2:]:
            raw = case['params']['tool_output']
            self.assertEqual(raw.count('unique middle observation'), 1)
            self.assertTrue(.4 < raw.index('unique middle observation') / len(raw) < .6)
        self.assertFalse(cases[2]['params']['tool_output'].endswith('\n'))
        crlf = cases[3]['params']['tool_output']
        self.assertEqual(crlf.count('\n'), crlf.count('\r\n'))
        self.assertIn('中 🌱', crlf)

    def test_feature_off_extension(self):
        ext = Extension()
        sentinel = b.Sentinel()
        ext.client = sentinel
        ext.features = dict.fromkeys(ext.features, False)
        for case in b.fixtures():
            self.assertEqual(ext.hook(case['params']), {'action': 'continue'})
        self.assertEqual(sentinel.calls, 0)

    def test_production_transport_shape_budget_and_usage(self):
        requests = []
        def post(_client, body, *, timeout_s):
            requests.append(json.loads(body))
            return response()
        client = b.SingleAttemptClient('synthetic-not-a-key')
        with patch.object(DecisionClient, '_post', post):
            result = b.report(client)['jev']
            with self.assertRaises(JevError):
                client.decide({}, b.compress.questions(), op='compress')
        self.assertEqual(len(requests), 4)
        self.assertEqual(result['fold_count'], 4)
        self.assertEqual(result['questions'], 4)
        self.assertEqual(result['input_tokens'], 480)
        for request in requests:
            self.assertEqual(request['model'], b.MODEL)
            self.assertEqual(request['questions'], b.compress.questions())
            self.assertEqual(set(request['state']), {'runs', 'original_utf8_bytes'})
        for row in result['measurements']:
            self.assertEqual(row['model'], b.MODEL)
            self.assertEqual(row['total_tokens'], 132)
            self.assertGreaterEqual(row['network_latency_ms'], 0)
        with self.assertRaises(ValueError):
            b.report(client)

    def test_errors_never_retry_or_leak(self):
        for error in (_Retryable('sensitive upstream', 0), JevError('sensitive upstream'),
                      TimeoutError('sensitive upstream'), ValueError('sensitive upstream')):
            with self.subTest(error=type(error).__name__):
                client = b.SingleAttemptClient('synthetic-not-a-key')
                with patch.object(DecisionClient, '_post', side_effect=error) as post, \
                     patch('time.sleep', side_effect=AssertionError('retry')):
                    result = b.report(client)
                self.assertEqual(post.call_count, 4)
                self.assertEqual(result['jev']['keep_count'], 4)
                self.assertIsNone(result['jev']['input_tokens'])
                self.assertNotIn('sensitive', json.dumps(result))
                self.assertTrue(all(r['roundtrip'] for r in result['jev']['cases']))

    def test_metadata_and_malformed_answers(self):
        good = response()
        missing = copy.deepcopy(good)
        del missing['usage']
        del missing['model']
        extras = copy.deepcopy(good)
        extras['usage']['billing_detail'] = 1
        invalid = copy.deepcopy(good)
        invalid['answers']['format']['confidence'] = 'high'
        keep = copy.deepcopy(good)
        keep['answers']['format']['choice'] = 'keep'
        unknown_model = copy.deepcopy(missing)
        unknown_model['model'] = 'untrusted model text'
        for answer, folded in [(good, True), (missing, True), (extras, False),
                               (invalid, False), (keep, False), ({}, False),
                               ([], False), (unknown_model, True)]:
            client = b.SingleAttemptClient('synthetic-not-a-key')
            with patch.object(DecisionClient, '_post', return_value=answer):
                result = b.report(client)['jev']
            self.assertEqual(result['fold_count'], 4 if folded else 0)
            self.assertTrue(all(r['roundtrip'] for r in result['cases']))
            if answer in (missing, unknown_model):
                self.assertIsNone(result['input_tokens'])
                self.assertIsNone(result['estimated_jev_cost_usd'])
                self.assertTrue(all(r['model'] is None for r in result['measurements']))
            self.assertNotIn('untrusted model text', json.dumps(result))

    def test_percentiles(self):
        self.assertEqual(b.latencies([40, 10, 30, 20]), {'median_ms': 25, 'p95_ms': 38.5})
        self.assertIsNone(b.percentile([], .95))
        self.assertEqual(b.percentile([7], .95), 7)


if __name__ == '__main__':
    unittest.main()
