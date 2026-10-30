"""Offline sparse router policy/cache tests; no transport or credentials."""
import sys
from pathlib import Path
import unittest
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions'))
from jev.router import Router, RouterConfig, questions, plan_fill
from jev.audit import Audit


class RouterTests(unittest.TestCase):
    def setUp(self):
        self.router = Router()
        self.cfg = RouterConfig({'router_models': 'small=p/s,medium=p/m'})
        self.answers = {'role': {'choice': 'researcher', 'confidence': .99},
                        'needs_write': {'noul': 0}, 'tier': {'choice': 'small', 'confidence': .99}}
        self.client = Mock(model='jev-test')
        self.client.decide.side_effect = lambda *a, **kw: {'answers': self.answers}
        self.audit = Audit(None)
        self.audit.write = Mock()
        self.log = Mock()
        self.params = {'tool_name': 'subagent_start', 'session_id': 's', 'tool_input': {'task': 'Read docs'}}

    def run_hook(self, **kw):
        return self.router.handle(self.params, self.client, self.cfg, self.audit, self.log, **kw)

    def test_shapes(self):
        for mask in range(8):
            inp = {k: None for i, k in enumerate(('role', 'write_policy', 'model')) if mask & (1 << i)}
            q = questions(inp, self.cfg)
            self.assertEqual(set(q), {qk for k, qk in [('role', 'role'), ('write_policy', 'needs_write'), ('model', 'tier')] if k not in inp})
        self.assertEqual(questions({'role': 'reviewer', 'write_policy': {}}, RouterConfig({})), {})
        self.assertIn('unknown', questions({}, self.cfg)['role']['criteria'])

    def test_explicit_invalid_zero_calls_and_pure_preservation(self):
        for field in ('role', 'model', 'write_policy'):
            for value in (None, '', False, [], 123):
                self.params['tool_input'] = {'task': 'Read docs', field: value}
                self.assertEqual(self.run_hook()['action'], 'continue')
                self.assertNotIn(field, plan_fill(self.params['tool_input'], self.answers, self.cfg)[0])
        self.client.decide.assert_not_called()

    def test_preservation_and_outbound_privacy(self):
        original = {'task': 'Read docs password="hidden secret"', 'system_prompt': 'Bearer secret-value',
                    'model': 'exact/id', 'unknown': {'secret': 'never send'}, 'role': 'reviewer'}
        self.params['tool_input'] = original
        self.answers['unknown'] = {'evil': True}
        result = self.run_hook()['input']
        for k, v in original.items():
            self.assertEqual(result[k], v)
        state, q = self.client.decide.call_args.args
        self.assertEqual(set(state), {'task', 'system_prompt'})
        self.assertEqual(set(q), {'needs_write'})
        self.assertNotIn('hidden secret', str(state))
        self.assertNotIn('secret-value', str(state))
        self.audit.write.assert_not_called()
        self.log.assert_not_called()

    def test_malformed_siblings_no_cache(self):
        for bad in (True, float('nan'), float('inf'), 10**1000, '0', None, -1, 2):
            self.answers['needs_write'] = {'noul': bad}
            result = self.run_hook()
            self.assertEqual(result['input']['role'], 'researcher')
            self.assertNotIn('write_policy', result['input'])
        self.assertEqual(len(self.router.cache), 0)
        for bad in ([], {'choice': [], 'confidence': 1}, {'choice': 'researcher', 'confidence': True},
                    {'choice': 'researcher', 'confidence': 1, 'probabilities': {'researcher': float('nan')}}):
            self.answers['role'] = bad
            self.run_hook()
        self.assertEqual(len(self.router.cache), 0)

    def test_cache_context_and_order(self):
        self.run_hook(); self.run_hook()
        self.assertEqual(self.client.decide.call_count, 1)
        self.params = dict(reversed(list(self.params.items())))
        self.run_hook()
        self.assertEqual(self.client.decide.call_count, 1)
        changes = [('session_id', 's2'), ('tool_name', 'subagent')]
        for key, value in changes:
            self.params[key] = value
            self.run_hook()
        for key, value in [('task', 'Read other docs'), ('system_prompt', 'review'), ('extra', 1), ('role', 'reviewer')]:
            self.params['tool_input'][key] = value
            self.run_hook()
        self.client.model = 'different'; self.run_hook()
        self.cfg.min_conf = .9; self.run_hook()
        self.cfg.read_only_at = .1; self.run_hook()
        self.cfg.models['small'] = 'p/other'; self.run_hook()
        self.assertEqual(self.client.decide.call_count, 11)
        self.params['tool_input'] = dict(reversed(list(self.params['tool_input'].items())))
        self.run_hook()
        self.assertEqual(self.client.decide.call_count, 11)

    def test_abstention_errors_no_session_lru(self):
        self.answers = {'role': {'choice': 'unknown', 'confidence': .9}, 'needs_write': {'noul': 1}, 'tier': {'choice': 'frontier', 'confidence': 1}}
        self.run_hook(); self.run_hook()
        self.assertEqual(self.client.decide.call_count, 1)
        self.params.pop('session_id')
        self.run_hook(); self.run_hook()
        self.assertEqual(self.client.decide.call_count, 3)
        self.params['session_id'] = 'err'
        self.client.decide.side_effect = RuntimeError('private error')
        self.run_hook(); self.run_hook()
        self.assertEqual(self.client.decide.call_count, 5)
        self.log.assert_not_called()
        self.client.decide.side_effect = lambda *a, **kw: {'answers': self.answers}
        for i in range(130):
            self.params['session_id'] = str(i)
            self.run_hook()
        self.assertEqual(len(self.router.cache), 128)

    def test_skip_bounds_config(self):
        for text in ('a'*4000+' MUST EDIT', 'é'*2001, '\ud800'):
            self.params['tool_input']['task'] = text
            self.assertEqual(self.run_hook()['action'], 'continue')
        self.params['tool_input'] = {'task': 'read', 'system_prompt': 'é'*301}
        self.run_hook()
        self.params['tool_input'] = []
        self.run_hook()
        self.client.decide.assert_not_called()
        for value in ('NaN', True, [], 10**1000, 'inf', '-.1', '1.1'):
            cfg = RouterConfig({'router_min_conf': value, 'router_read_only_at': value})
            self.assertEqual((cfg.min_conf, cfg.read_only_at), (.8, .15))
        self.assertEqual(RouterConfig({'router_min_conf': '.9'}).min_conf, .9)
        for value in (None, {}, 'small=x', 'small=p/a b', 'small=p/a\x00', 'small=p/'+ 'x'*256):
            self.assertEqual(RouterConfig({'router_models': value}).models, {})

    def test_no_map_only_explicit_disabled_unrelated(self):
        self.cfg = RouterConfig({})
        self.params['tool_input'].update(role='reviewer', write_policy={'mode': 'read_only'})
        self.run_hook()
        self.params['tool_input'] = {'task': 'Read'}
        self.run_hook(enabled=False)
        self.params['tool_name'] = 'other'
        self.run_hook()
        self.params['tool_name'] = 'subagent'
        self.client = None
        self.run_hook()
        self.assertEqual(self.audit.counters.get('router.call', 0), 0)

    def test_host_write_modes_and_full_input_bound(self):
        wp = {'mode': 'non_overlapping_paths', 'scopes': ['src/', 'tests/']}
        self.params['tool_input']['write_policy'] = wp
        self.assertEqual(self.run_hook()['input']['write_policy'], wp)
        self.assertNotIn('needs_write', self.client.decide.call_args.args[1])
        self.client.decide.reset_mock()
        for invalid in ({'mode': 'shared'}, {'mode': 'non_overlapping_paths'},
                        {'mode': 'non_overlapping_paths', 'scopes': []},
                        {'mode': 'non_overlapping_paths', 'scopes': ['']},
                        {'mode': 'non_overlapping_paths', 'scopes': [None]}):
            self.params['tool_input']['write_policy'] = invalid
            self.assertEqual(self.run_hook()['action'], 'continue')
        self.params['tool_input'] = {'task': 'Read', 'unrelated': 'a'*32768}
        self.assertEqual(self.run_hook()['action'], 'continue')
        self.client.decide.assert_not_called()

    def test_optional_numeric_fields_malformed(self):
        for field in ('confidence', 'score'):
            for value in (True, float('nan'), float('inf'), 10**1000, '1'):
                self.answers['needs_write'] = {'noul': 0, field: value}
                self.assertNotIn('write_policy', self.run_hook()['input'])
        self.assertEqual(len(self.router.cache), 0)
