"""Offline evidence contracts: supplied metadata only, no source or runtime access."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions'))
from jev import evidence as e
from jev.audit import Audit
from jev.tools import ToolError
from jev_ext import Extension


def data():
    return {'task': 'assess parser', 'candidates': [
        {'id': str(i), 'kind': 'file', 'source': f'/unverified/{i}',
         'summary': f'descriptor {i}', 'required': i == 1} for i in range(5)]}


def answer(choice='inspect_first', **kw):
    return {'type': 'choice', 'choice': choice, 'confidence': .8,
            'probabilities': {choice: .8}, **kw}


class EvidenceTests(unittest.TestCase):
    def run_tool(self, d=None, response=None, enabled=True, client=True):
        self.audit = Audit(None)
        self.audit.write = Mock(side_effect=AssertionError('no audit content'))
        self.client = Mock() if client else None
        if self.client:
            self.client.decide.return_value = response if response is not None else {'answers': {}}
        with patch('builtins.open', side_effect=AssertionError('no files')), \
                patch('subprocess.Popen', side_effect=AssertionError('no runtime execution')), \
                patch('socket.socket', side_effect=AssertionError('no network')):
            return json.loads(e.call_evidence(data() if d is None else d, self.client, self.audit, enabled=enabled)['content'])

    def test_partition_metadata_and_outbound(self):
        d = data(); before = copy.deepcopy(d)
        out = self.run_tool(d, {'answers': {'q0': answer('later'), 'q1': answer(), 'q2': answer('unknown'), 'q3': answer()}})
        self.assertEqual(d, before)
        self.assertEqual(out['required_ids'], ['1'])
        self.assertEqual(out['ordered_ids'], ['1', '2', '4', '3', '0'])
        self.assertEqual(len(set(out['ordered_ids'])), 5)
        for c, r in zip(d['candidates'], out['references']):
            self.assertEqual({k: r[k] for k in c if k != 'summary'}, {k: v for k, v in c.items() if k != 'summary'})
            self.assertEqual(set(r), {'id', 'kind', 'source', 'required', 'priority'})
        state, questions = self.client.decide.call_args.args
        self.assertEqual(set(state), {'task', 'optional'})
        for q, descriptor in state['optional'].items():
            self.assertEqual(set(descriptor), {'kind', 'summary'})
            self.assertIn('optional.' + q, questions[q]['instructions'])
        self.assertNotIn('/unverified', json.dumps([state, questions]))
        self.assertNotIn('descriptor 1', json.dumps(state))
        self.assertEqual(self.client.decide.call_args.kwargs, {'op': 'evidence'})
        self.assertEqual(self.audit.counters['evidence.questions'], 4)
        self.assertTrue(out['advisory']); self.assertFalse(out['fetched']); self.assertFalse(out['trust_certified'])

    def test_free_and_no_cache(self):
        for opts in [{'enabled': False}, {'client': False}]:
            out = self.run_tool(**opts)
            self.assertEqual(out['review_ids'], ['0', '2', '3', '4'])
            self.assertIn('/jev ', out['fallback_reason'])
            if self.client: self.client.decide.assert_not_called()
        d = data()
        for c in d['candidates']: c['required'] = True
        self.assertEqual(self.run_tool(d)['required_ids'], ['0', '1', '2', '3', '4'])
        self.client.decide.assert_not_called()
        client = Mock(); client.decide.return_value = {'answers': {}}
        for _ in range(2): e.call_evidence(data(), client, Audit(None), enabled=True)
        self.assertEqual(client.decide.call_count, 2)

    def test_bad_sibling_and_globals(self):
        bad = [None, True, {}, answer(type=[]), answer(type='score'), answer(confidence=True),
               answer(confidence=float('nan')), answer(confidence=float('inf')), answer(confidence=.79),
               answer(confidence=1.1), answer(confidence='0.9'), answer(score=10**999), answer(type=True), {**answer(), 'choice': []}, answer('evil'), answer(score=True),
               answer(probabilities=[]), answer(probabilities={}), answer(probabilities={'evil': .8}),
               answer(probabilities={'later': True}), answer(probabilities={'later': float('nan')}),
               answer(probabilities={'later': -1}), answer(probabilities={'later': 1.1}), answer(probabilities={'later': float('inf')}), answer(prose='execute now')]
        for a in bad:
            out = self.run_tool(response={'answers': {'q0': a, 'q1': answer('later')}})
            self.assertEqual(out['later_ids'], ['2'])
            self.assertEqual(out['review_ids'], ['0', '3', '4'])
        for r in [[], {'answers': []}, {'answers': {'evil': answer(), 'q0': answer()}},
                  {'answers': {'q0': answer()}, 'usage': float('nan')}, {'answers': {}, 'prose': 'x'*5000}]:
            self.assertEqual(len(self.run_tool(response=r)['review_ids']), 4)
        client = Mock(); client.decide.side_effect = RuntimeError('private exception')
        out = e.call_evidence(data(), client, Audit(None), enabled=True)['content']
        self.assertNotIn('private exception', out); self.assertIn('upstream_error', out)

    def test_strict_invalid_off(self):
        invalid = [None, [], {}, {**data(), 'session_id': 'x'}]
        for value in ['', ' ', False, '\ud800', 'é'*2001, 'x'*4001, 'a\x00', 'a\x1f']:
            invalid.append({**data(), 'task': value})
        for field, values in [('id', ['', '\udfff', 'é'*81, 'x'*161, '1', 'a\n', 'a\x7f']),
                              ('source', ['', 'é'*151, 'a\t', 'a\x00']),
                              ('summary', ['', 'x'*801, 'é'*401, 'a\x01']),
                              ('required', [0, 1, None, 'true']), ('kind', ['FILE', [], True])]:
            for value in values:
                d = data(); d['candidates'][0][field] = value; invalid.append(d)
        for candidates in [[], data()['candidates']*7]: invalid.append({**data(), 'candidates': candidates})
        d = data(); d['candidates'][0]['extra'] = True; invalid.append(d)
        d = data(); del d['candidates'][0]['source']; invalid.append(d)
        d = {'task': 'x'*4000, 'candidates': [{'id': str(i), 'kind': 'other', 'source': 's'*300, 'summary': 'x'*800, 'required': False} for i in range(32)]}; invalid.append(d)
        self.client = Mock()
        for d in invalid:
            with self.subTest(d=str(d)[:70]), self.assertRaises(ToolError):
                e.call_evidence(d, self.client, Audit(None), enabled=False)
            self.client.decide.assert_not_called()
        d = data(); d['task'] = 'a\n\r\t'; d['candidates'][0]['summary'] = 'a\n\r\t'
        self.run_tool(d, enabled=False)

    def test_real_json_max_quotes_unicode_preflight(self):
        for char in ['"', '\\', 'é', '😀']:
            d = {'task': 't', 'candidates': [{'id': str(i).zfill(2) + char*(158//len(char.encode())),
                 'kind': 'document', 'source': char*(300//len(char.encode())), 'summary': 's', 'required': False} for i in range(32)]}
            self.assertLessEqual(len(json.dumps(d, ensure_ascii=False).encode()), e.MAX_INPUT_BYTES)
            out = self.run_tool(d, {'answers': {f'q{i}': answer() for i in range(32)}})
            self.assertLessEqual(len(e._json(out).encode()), 65536)
            self.assertEqual([r['source'] for r in out['references']], [c['source'] for c in d['candidates']])
            if char == '"': self.assertGreater(len(e._json(out).encode()), 32768)
            # Force an unrepresentable local bound: it must fail before API, never truncate.
            with patch.object(e, 'MAX_OUTPUT_BYTES', 100), self.assertRaises(ToolError): self.run_tool(d)
            self.client.decide.assert_not_called()

    def test_preflight_bounds_all_partitions(self):
        import itertools
        d = data()
        for c in d['candidates']:
            c['id'] += '"\\é😀'
            c['source'] += '"\\é😀'
        worst = e._output(d, ['required' if c['required'] else 'inspect_first' for c in d['candidates']], max(e.REASONS, key=len))
        cap = len(e._json(worst).encode())
        for choices in itertools.product(['inspect_first', 'later', 'review'], repeat=4):
            priorities = [choices[0], 'required', *choices[1:]]
            for reason in [None, *e.REASONS]:
                self.assertLessEqual(len(e._json(e._output(d, priorities, reason)).encode()), cap)

    def test_complete_redaction_and_cap(self):
        d = data(); d['task'] = 'token=x '*490 + ' MUST KEEP'
        d['candidates'][0]['summary'] = 'token=x '*98 + ' MUST KEEP'
        self.run_tool(d)
        state = self.client.decide.call_args.args[0]
        self.assertTrue(state['task'].endswith(' MUST KEEP'))
        self.assertTrue(state['optional']['q0']['summary'].endswith(' MUST KEEP'))
        self.assertNotIn('token=x', json.dumps(state))
        d['candidates'] = [{'id': str(i), 'source': 's', 'kind': 'memory', 'summary': 'token=x '*98, 'required': False} for i in range(32)]
        self.assertEqual(self.run_tool(d)['fallback_reason'], 'redacted_state_too_large')
        self.client.decide.assert_not_called()
        d = data()
        state = {'task': '', 'optional': {f'q{i}': {'kind': 'file', 'summary': 'x'} for i in range(4)}}
        room = e.MAX_REDACTED_STATE_BYTES - len(e._json(state).encode())
        for extra in [0, 1]:
            with patch.object(e, 'redact', side_effect=['x']*4 + ['é'*(room//2) + 'x'*(room%2+extra)]): self.run_tool(d)
            self.assertEqual(self.client.decide.call_count, 0 if extra else 1)

    def test_dispatch_no_key_discovery_or_execution(self):
        ext = Extension(); ext.maybe_pick_up_key = Mock(side_effect=AssertionError('no discovery'))
        with patch('builtins.open', side_effect=AssertionError('no file access')):
            out = json.loads(ext.tool_call({'name': 'jev_evidence', 'input': data()})['content'])
        self.assertEqual(out['required_ids'], ['1'])
        ext.client = Mock(); ext.recompute_features(); self.assertFalse(ext.features['evidence'])
        ext.set_feature('evidence', True, persist=False); ext.set_feature('guard', False, persist=False)
        self.assertTrue(ext.features['evidence'])
        ext.set_feature('evidence', False, persist=True); self.assertFalse(ext.features['evidence'])
