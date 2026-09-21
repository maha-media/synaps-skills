"""Offline discovery regressions: no credentials, config, or network."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions'))
from jev import discovery
from jev.audit import Audit
from jev.client import DecisionClient
from jev_ext import Extension


def catalog(tool='search_tools'):
    if tool == 'search_tools':
        return {'generation': 1, 'truncated': False, 'tools': [
            {'id': 'alpha', 'summary': 'Inspect failed assertions', 'tags': ['debug'],
             'source_class': 'builtin', 'schema_digest': 'abc'},
            {'id': 'beta', 'summary': 'Install dependencies', 'tags': [],
             'source_class': 'plugin', 'schema_digest': 'def'}]}
    return {'truncated': False, 'skills': [
        {'id': 'pkg:alpha', 'name': 'alpha', 'description': 'Inspect failed assertions'},
        {'id': 'pkg:beta', 'name': 'beta', 'description': 'Install dependencies'}]}


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.d = discovery.Discovery()
        self.a = Audit(None)
        self.a.write = Mock(side_effect=AssertionError('no audit payload'))
        self.c = Mock(model='fixture')
        self.c.decide.return_value = {'answers': {'recommendation': {'choice': 'option_0', 'confidence': discovery.MIN_CONFIDENCE}}}
        self.p = {'tool_runtime_name': 'search_tools', 'tool_name': 'alias', 'session_id': 's',
                  'tool_input': {'query': 'failed assertions'}, 'tool_output': json.dumps(catalog())}

    def run_hook(self, **overrides):
        return self.d.handle(dict(self.p, **overrides), self.c, True, self.a)

    def test_both_searches_preserve_every_field(self):
        for tool in discovery.TOOLS:
            payload = catalog(tool)
            payload['extra'] = {'unicode': 'é', 'nested': [1, True, None]}
            result = self.run_hook(tool_runtime_name=tool, tool_output=json.dumps(payload, indent=2))
            parsed = json.loads(result['output'])
            advice = parsed.pop('jev_advisory')
            self.assertEqual(parsed, payload)
            self.assertEqual(advice['recommended_id'], payload['tools' if tool == 'search_tools' else 'skills'][0]['id'])
            self.assertTrue(advice['advisory'])
            self.assertIn('not activation/permission', advice['note'])
            self.assertEqual(self.c.decide.call_args.kwargs, {'op': 'discovery'})

    def test_invalid_outputs_zero_calls(self):
        bad = ['no json', '[]', '{}', '{"truncated":false,"truncated":false}',
               json.dumps(catalog()).replace('"generation": 1', '"generation": NaN'),
               json.dumps(catalog()).replace('"generation": 1', '"generation": 1e999'),
               'x' * 32769]
        for update in [{'truncated': True}, {'generation': True}, {'generation': -1},
                       {'generation': 2**64}, {'jev_advisory': {}}, {'tools': []},
                       {'tools': catalog()['tools'][:1]}, {'tools': catalog()['tools'] * 9}]:
            bad.append(json.dumps(dict(catalog(), **update)))
        for field, value in [('id', 'beta'), ('summary', ''), ('summary', 'é'*129),
                             ('tags', 'tag'), ('tags', [None]), ('source_class', {}),
                             ('schema_digest', None)]:
            payload = catalog(); payload['tools'][0][field] = value
            bad.append(json.dumps(payload))
        for raw in bad:
            with self.subTest(raw=raw[:80]):
                self.assertEqual(self.run_hook(tool_output=raw), discovery.CONTINUE)
        self.c.decide.assert_not_called()

    def test_inputs_exact_names_and_no_key_off(self):
        for inp in [None, {}, {'query': ''}, {'query': 'alpha'}, {'query': ' ALPHA '},
                    {'query': 'x'*513}, {'query': 'é'*257}, {'query': []}, {'query': 'bad\x00query'}, {'query': 'x', 'goal': 'private'}]:
            self.assertEqual(self.run_hook(tool_input=inp), discovery.CONTINUE)
        self.assertEqual(self.d.handle(self.p, None, True, self.a), discovery.CONTINUE)
        self.assertEqual(self.d.handle(self.p, self.c, False, self.a), discovery.CONTINUE)
        self.c.decide.assert_not_called()
        ext = Extension(); ext.client = self.c
        ext.features['compress'] = True
        self.assertEqual(ext.hook(dict(self.p, kind='after_tool_call')), discovery.CONTINUE)
        self.c.decide.assert_not_called()

    def test_colon_names_controls_and_unknown_fields(self):
        payload = catalog()
        payload['tools'][0]['id'] = 'builtin:alpha'
        self.assertEqual(self.run_hook(tool_input={'query': 'alpha'}, tool_output=json.dumps(payload)), discovery.CONTINUE)
        for bad_id in ['bad\x00id', 'bad\x7fid']:
            payload['tools'][0]['id'] = bad_id
            self.assertEqual(self.run_hook(tool_output=json.dumps(payload)), discovery.CONTINUE)
        payload = catalog('search_skills')
        payload['skills'][0]['name'] = 'bad\nname'
        self.assertEqual(self.run_hook(tool_runtime_name='search_skills', tool_output=json.dumps(payload)), discovery.CONTINUE)
        self.c.decide.assert_not_called()

    def test_malformed_answers_and_errors(self):
        for answer in [None, [], {}, {'choice': 'invented', 'confidence': 1},
                       {'choice': 'alpha', 'confidence': 1}, {'choice': 'option_0', 'confidence': True},
                       {'choice': 'option_0', 'confidence': .799}, {'choice': 'option_0', 'confidence': float('nan')},
                       {'choice': 'option_0', 'confidence': 1, 'probabilities': []}]:
            self.c.decide.return_value = {'answers': {'recommendation': answer}}
            self.assertEqual(self.run_hook(), discovery.CONTINUE)
            self.assertFalse(self.d.cache)
        for error in [TimeoutError('private'), RuntimeError('secret')]:
            self.c.decide.side_effect = error
            self.assertEqual(self.run_hook(), discovery.CONTINUE)
            self.assertFalse(self.d.cache)
        self.assertGreaterEqual(self.a.counters['discovery.error'], 2)

    def test_confidence_boundary_and_invalid_high(self):
        self.assertEqual(discovery.MIN_CONFIDENCE, .8)
        for confidence, choice, action in ((.799, 'option_0', 'continue'),
                                           (.8, 'option_0', 'replace'),
                                           (1, 'outside_id', 'continue')):
            self.c.decide.return_value = {'answers': {'recommendation': {
                'choice': choice, 'confidence': confidence}}}
            self.assertEqual(self.run_hook(session_id=None)['action'], action)
        self.assertFalse(self.d.cache)

    def test_cache_invalidation_lru_and_abstention(self):
        self.run_hook(); self.run_hook()
        self.assertEqual(self.c.decide.call_count, 1)
        self.run_hook(session_id='other')
        self.run_hook(tool_input={'query': 'dependencies'})
        payload = catalog(); payload['generation'] = 2
        self.run_hook(tool_output=json.dumps(payload))
        payload['tools'][0]['schema_digest'] = 'changed'
        self.run_hook(tool_output=json.dumps(payload))
        self.c.model = 'other'; self.run_hook()
        self.run_hook(tool_runtime_name='search_skills', tool_output=json.dumps(catalog('search_skills')))
        self.assertEqual(self.c.decide.call_count, 7)
        self.run_hook(session_id=None); self.run_hook(session_id=None)
        self.assertEqual(self.c.decide.call_count, 9)
        for i in range(130): self.run_hook(session_id=str(i))
        self.assertEqual(len(self.d.cache), 128)
        self.c.decide.return_value = {'answers': {'recommendation': {'choice': 'abstain', 'confidence': 1}}}
        self.assertEqual(self.run_hook(session_id='abstain'), discovery.CONTINUE)
        count = self.c.decide.call_count
        self.assertEqual(self.run_hook(session_id='abstain'), discovery.CONTINUE)
        self.assertEqual(self.c.decide.call_count, count)
        self.assertTrue(all(isinstance(k, bytes) and v in (None, 'option_0') for k,v in self.d.cache.items()))

    def test_redaction_prompt_and_no_audit(self):
        payload = catalog(); payload['tools'][0]['summary'] = 'Inspect sk-fake123 failures'
        payload['tools'][0]['schema_digest'] = 'NEVER SENT'
        self.run_hook(tool_input={'query': 'Bearer fakecredential'}, tool_output=json.dumps(payload), goal='PRIVATE GOAL')
        state, questions = self.c.decide.call_args.args
        text = json.dumps([state, questions])
        for forbidden in ['fakecredential', 'sk-fake123', 'NEVER SENT', 'PRIVATE GOAL', 'schema_digest']:
            self.assertNotIn(forbidden, text)
        self.assertIn('memory/test/search', text)
        self.assertIn('candidate ordering', text)
        for token, value in questions['recommendation']['criteria'].items():
            if token != 'abstain': self.assertIn(token, value)
        self.a.write.assert_not_called()

    def test_real_client_fake_http_accounting(self):
        client = DecisionClient('offline-fake-key')
        client._bounded_post = Mock(return_value=self.c.decide.return_value)
        result = self.d.handle(self.p, client, True, self.a)
        self.assertEqual(result['action'], 'replace')
        self.assertEqual(client.stats.by_op, {'discovery': 1})
        self.assertEqual(client.stats.op_stats['discovery']['errors'], 0)


if __name__ == '__main__':
    unittest.main()
