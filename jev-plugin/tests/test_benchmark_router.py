"""Offline only: no credentials, HTTP, or worker dispatch."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/benchmark_router.py'
spec = importlib.util.spec_from_file_location('benchmark_router', SCRIPT)
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class Transport:
    model = 'jev-synthetic-test'
    timeout_s = 1

    def __init__(self, arm, order, failure=None):
        self.arm, self.order, self.failure = arm, order, failure
        self.requests = []

    def _bounded_post(self, body, remaining):
        request = json.loads(body)
        self.requests.append(request)
        self.order.append(self.arm)
        if self.failure == 'error':
            raise RuntimeError('SECRET exception payload')
        if self.failure == 'malformed':
            return {'answers': []}
        task = request['state']['task']
        role = 'reviewer' if task.startswith('Review') else 'researcher'
        answers = {'role': {'choice': role, 'confidence': .99},
                   'needs_write': {'noul': 1 if task.startswith('Edit') else 0}}
        return {'answers': {k: answers[k] for k in request['questions']},
                'usage': {'input_tokens': 100 * len(request['questions'])}}


class BenchmarkTests(unittest.TestCase):
    def clients(self, failure=None, limit=12):
        self.order = []
        self.budget = b.Budget(limit)
        self.transports = {a: Transport(a, self.order, failure) for a in ('baseline', 'optimized')}
        return {a: b.SingleAttemptClient(t, self.budget) for a, t in self.transports.items()}

    def test_offline_plan_and_no_client_or_credentials_import(self):
        code = f'''import runpy, sys
sys.argv = [{str(SCRIPT)!r}]
runpy.run_path({str(SCRIPT)!r}, run_name='benchmark_offline_test')['main']([])
assert 'jev.client' not in sys.modules
assert 'jev.keys' not in sys.modules
'''
        result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, check=True)
        report = json.loads(result.stdout)
        self.assertEqual(report['totals']['baseline']['planned_calls'], 6)
        self.assertEqual(report['totals']['optimized']['planned_calls'], 4)
        self.assertEqual(report['totals']['baseline']['planned_questions'], 12)
        self.assertEqual(report['totals']['optimized']['planned_questions'], 5)
        for row in report['rows']:
            for arm in ('baseline', 'optimized'):
                for key in ('calls', 'questions', 'input_tokens', 'cost_usd', 'latency_ms', 'assessment'):
                    self.assertIsNone(row[arm][key])

    def test_hooks_sparse_cache_preservation_math(self):
        report = b.run(self.clients())
        self.assertEqual(self.budget.used, 10)
        self.assertEqual(self.order, ['baseline', 'optimized'] * 4 + ['baseline'] * 2)
        self.assertEqual([list(r['questions']) for r in self.transports['optimized'].requests],
                         [['needs_write'], ['needs_write'], ['role'], ['role', 'needs_write']])
        self.assertTrue(all(list(r['questions']) == ['role', 'needs_write'] for r in self.transports['baseline'].requests))
        self.assertEqual(report['audit']['optimized']['router.cache'], 2)
        self.assertEqual(report['audit']['optimized']['router.skip'], 1)
        for row in report['rows']:
            for arm in ('baseline', 'optimized'):
                a = row[arm]['assessment']
                self.assertEqual(a['status'], 'correct')
                self.assertEqual(a['preserved'], a['explicit_fields'])
                self.assertTrue(a['no_model'])
                self.assertFalse(a['critical'])
        self.assertEqual(report['totals']['baseline']['input_tokens'], 1200)
        self.assertEqual(report['totals']['optimized']['input_tokens'], 500)
        self.assertAlmostEqual(report['totals']['baseline']['cost_usd'], 1200 * .042 / 1e6)
        self.assertEqual(report['baseline_minus_optimized']['unique']['input_tokens'], 300)
        self.assertEqual(report['baseline_minus_optimized']['repeat']['input_tokens'], 400)
        self.assertEqual(report['baseline_minus_optimized']['unique']['calls'], 0)
        self.assertEqual(report['baseline_minus_optimized']['repeat']['calls'], 2)

    def test_failure_malformed_no_cache_no_payload_no_retry(self):
        for failure in ('error', 'malformed'):
            with self.subTest(failure=failure):
                report = b.run(self.clients(failure))
                self.assertEqual(self.budget.used, 12)
                self.assertNotIn('SECRET', json.dumps(report))
                self.assertEqual(report['audit']['optimized']['router.error'], 6)
                self.assertNotIn('router.cache', report['audit']['optimized'])
                self.assertIsNone(report['totals']['optimized']['input_tokens'])
                self.assertEqual(report['rows'][0]['optimized']['assessment']['status'], 'abstain')

    def test_budget(self):
        clients = self.clients(limit=1)
        client = clients['baseline']
        client.decide({'task': 'Read'}, {'role': {}}, op='router')
        for _ in range(3):
            with self.assertRaises(RuntimeError):
                client.decide({}, {}, op='router')
        self.assertEqual(len(self.transports['baseline'].requests), 1)
        with self.assertRaises(ValueError):
            b.Budget(13)

    def test_assessment_full_sets_abstention_critical_explicit(self):
        original = {'task': 'Read'}
        allowed = [{'role': 'reviewer', 'write_policy': b.READ_ONLY}]
        self.assertEqual(b.assess(original, {'action': 'continue'}, allowed, False)['status'], 'abstain')
        wrong = {'action': 'modify', 'input': {**original, 'role': 'implementer'}}
        self.assertEqual(b.assess(original, wrong, allowed, False)['status'], 'incorrect')
        wrong['input'] = {**original, 'write_policy': b.READ_ONLY}
        self.assertTrue(b.assess(original, wrong, [{}], True)['critical'])
        wrong['input'] = {'task': 'Changed'}
        self.assertEqual(b.assess(original, wrong, [{}], False)['status'], 'incorrect')
        wrong['input'] = {**original, 'model': 'fake/model'}
        self.assertFalse(b.assess(original, wrong, [{}], False)['no_model'])

    def test_frozen_questions_and_old_state_hook(self):
        old = b.baseline()
        self.assertNotIn('unknown', old['questions'](False)['role']['criteria'])
        self.assertEqual(old['questions'](False)['role']['instructions'], 'Which worker role fits `task` best?')
        clients = self.clients()
        inp = {'task': 'Read docs', 'system_prompt': 'Read only', 'role': 'researcher'}
        old['handle']({'tool_name': 'subagent', 'tool_input': inp}, clients['baseline'], old['RouterConfig']({}), b.Audit(), lambda _: None)
        self.assertEqual(self.transports['baseline'].requests[0]['state'],
                         {'task': 'Read docs', 'worker_system_prompt_head': 'Read only'})

    def test_usage_validation(self):
        self.assertIsNone(b.metrics([{'calls': 1, 'questions': 1, 'input_tokens': None,
                                    'cost_usd': None, 'latency_ms': 2}])['cost_usd'])
        self.assertEqual(b.metrics([])['input_tokens'], 0)


if __name__ == '__main__':
    unittest.main()
