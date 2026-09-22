#!/usr/bin/env python3
"""Offline feature regressions: real extension process/framing, stubbed HTTP.

Run: python3 -B -m unittest discover -s tests -p 'test_features_protocol.py' -v
No keys, sockets, installed plugin, or user configuration are used.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest

from e2e_keys import Host, ROOT

# Only the HTTP boundary is replaced: production dispatch, policy, accounting,
# command events and persistence all run in the child. Any socket use is fatal.
BOOTSTRAP = r'''
import json, sys
sys.path.insert(0, sys.argv[1])
def no_network(event, args):
    if event.startswith("socket."):
        raise RuntimeError("network forbidden in offline protocol tests")
sys.addaudithook(no_network)
from jev.client import DecisionClient
def offline_post(self, body, *, timeout_s):
    questions = json.loads(body)["questions"]
    answers = {
        "risk": {"score": 3, "confidence": 1},
        "touches_secrets": {"noul": 0},
        "leaves_workspace": {"noul": 0},
        "role": {"choice": "reviewer", "confidence": 1},
        "needs_write": {"noul": 0},
        "tier": {"choice": "small", "confidence": 1},
        "format": {"type": "choice", "choice": "compact", "confidence": 1},
        "is_failure": {"noul": 0},
        "ok": {"noul": 1},
        "verification": {"choice": "gap", "confidence": .9},
        "concern": {"choice": "none_reported", "confidence": .9},
        "category": {"choice": "syntax", "confidence": 1},
        "boundary": {"type": "choice", "choice": "completed", "confidence": .9,
                     "probabilities": {"completed": .9, "paused": .04, "partial": .04, "unclear": .02}},
        "recommendation": {"choice": "option_0", "confidence": .9},
        "0": {"choice": "source", "confidence": 1},
        "q0": {"type": "choice", "choice": "prioritize", "confidence": .9,
               "probabilities": {"prioritize": .9, "defer": .05, "unknown": .05}},
    }
    if "q0" in questions and "inspect_first" in questions["q0"].get("criteria", {}):
        answers["q0"] = {"type": "choice", "choice": "inspect_first", "confidence": .9,
                         "probabilities": {"inspect_first": .9, "later": .05, "unknown": .05}}
    for q, spec in questions.items():
        if q.startswith("h") and "plausible" in spec.get("criteria", {}):
            answers[q] = {"choice": "plausible", "confidence": .85}
        if q.startswith("c") and "inspect" in spec.get("criteria", {}):
            answers[q] = {"choice": "inspect", "confidence": .8}
    if "h1" in questions:
        answers["h1"] = {"choice": "plausible", "confidence": True}
    answers["q1"] = {**answers["q0"], "type": None}
    answers["q2"] = {"type": "choice", "choice": "defer", "confidence": .9,
                     "probabilities": {"prioritize": .05, "defer": .9, "unknown": .05}}
    return {"answers": {k: answers[k] for k in questions},
            "model": "offline-fixture", "usage": {"input_tokens": 10}}
DecisionClient._post = offline_post
import jev_ext
jev_ext.main()
'''


class OfflineHost(Host):
    """Reuse Host's hook/command helpers, with hermetic boot and bounded I/O."""

    def __init__(self, base, config=None, *, reject_save=False):
        self.base = str(base)
        self.store = Path(base) / 'plugins' / 'jev' / 'config'
        self.persisted = dict(config or {})
        self.reject_save = reject_save
        self.config_sets = []
        self.notifications = []
        self.n = 0
        self.buffer = b''
        env = {'SYNAPS_BASE_DIR': str(base), 'HOME': str(base),
               'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1'}
        self.p = subprocess.Popen(
            [sys.executable, '-B', '-u', '-c', BOOTSTRAP, str(Path(ROOT) / 'extensions')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=base, env=env)
        try:
            self.init = self.request('initialize', {'plugin_id': 'jev', 'plugin_root': ROOT,
                'config': {'api_key': 'offline-fake-key', 'audit_file': '', **self.persisted}})
        except BaseException:
            self.close()
            raise

    def read(self, deadline):
        while True:
            header, sep, body = self.buffer.partition(b'\r\n\r\n')
            if sep:
                size = int(header.split(b':', 1)[1])
                if len(body) >= size:
                    self.buffer = body[size:]
                    return json.loads(body[:size])
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.p.stdout], [], [], remaining)[0]:
                raise TimeoutError('extension protocol response timed out')
            chunk = os.read(self.p.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError('extension closed protocol stream')
            self.buffer += chunk

    def request(self, method, params):
        self.n += 1
        rid = f'h{self.n}'
        self._write({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params})
        deadline = time.monotonic() + 5
        while True:
            message = self.read(deadline)
            if message.get('id') == rid and 'method' not in message:
                return message
            if 'method' in message and message.get('id') is not None:
                if message['method'] != 'config.set':
                    raise AssertionError('unexpected host RPC: ' + message['method'])
                key, value = message['params']['key'], message['params']['value']
                self.config_sets.append((key, value))
                response = {'jsonrpc': '2.0', 'id': message['id']}
                if self.reject_save:
                    response['error'] = {'code': -32601, 'message': 'config.set unavailable'}
                else:
                    # Fake host persistence; next initialize explicitly supplies it.
                    self.persisted[key] = value
                    response['result'] = {'ok': True}
                self._write(response)
            elif 'method' in message:
                self.notifications.append(message)

    def close(self):
        if self.p.poll() is None:
            self.p.terminate()
            try:
                self.p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.p.kill()
                self.p.wait(timeout=3)
        for stream in (self.p.stdin, self.p.stdout, self.p.stderr):
            stream.close()

    def status(self):
        return json.loads(self.request('tool.call', {'name': 'jev_status', 'input': {}})['result']['content'])


class FeatureProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='jev-features-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def host(self, **kwargs):
        host = OfflineHost(self.base, **kwargs)
        self.addCleanup(host.close)
        return host

    def command(self, host, *args):
        response, events = host.command(*args)
        self.assertEqual(response['result'], {'ok': True})
        self.assertTrue(events)
        self.assertEqual(events[-1], {'kind': 'done'})
        self.assertNotIn('error', [e['kind'] for e in events])
        self.assertTrue(all(n['params']['request_id'] == 'req-1'
                            for n in host.notifications if n['method'] == 'command.output'))
        return events

    def test_reports_opt_in_saved_guard_independent_and_lifecycle(self):
        h = self.host(config={'compress': True, 'compress_tools': 'subagent_collect'})
        self.assertEqual(len(h.init['result']['capabilities']['tools']), 6)
        data = {'handle_id': 'sa_1', 'status': 'completed', 'output': 'Tests skipped.',
                'model': 'fixture', 'terminal_cause': None, 'authorization': {'allowed': True},
                'collected': False, 'note': 'UNRECONCILED read', 'extra': [1, False]}
        def collect(value):
            return h.hook('after_tool_call', tool_runtime_name='subagent_collect',
                          tool_input={'handle_id': 'sa_1', 'reconciled': True},
                          tool_output=json.dumps(value), session_id='report-session')
        self.assertFalse(h.status()['features']['reports'])
        self.assertEqual(collect(data), {'action': 'continue'})
        self.assertEqual(h.status()['calls'], 0)
        self.command(h, 'guard', 'off')
        self.command(h, 'reports', 'on', '--save')
        self.assertIn(('reports', 'true'), h.config_sets)
        result = collect(data)
        annotated = json.loads(result['output'])
        self.assertEqual(annotated.pop('jev_advisory')['flags'], ['verification_gap'])
        self.assertEqual(annotated, data)
        self.assertEqual(collect(data), result)
        self.assertEqual(h.status()['by_op'], {'reports': 1})
        self.assertEqual(h.status()['counters']['reports.questions'], 2)
        for status in ('failed', 'timed_out', 'cancelled'):
            terminal = {**data, 'status': status, 'collected': True, 'output': 'Success!'}
            annotated = json.loads(collect(terminal)['output'])
            self.assertEqual(annotated.pop('jev_advisory')['flags'], ['worker_' + status])
            self.assertEqual(annotated, terminal)
        for status in ('running', 'expired'):
            self.assertEqual(collect({**data, 'status': status}), {'action': 'continue'})
        self.assertEqual(h.status()['by_op'], {'reports': 1})
        self.command(h, 'reports', 'off')
        self.assertEqual(collect(data), {'action': 'continue'})
        self.assertEqual(h.status()['by_op'], {'reports': 1})
        restarted = self.host(config=h.persisted)
        self.assertTrue(restarted.status()['features']['reports'])

    def test_context_boundary_protocol_pressure_only_and_off_yields_zero_calls(self):
        h = self.host()
        self.command(h, 'guard', 'off')
        self.assertTrue(h.status()['features']['context'])
        def turn_end(band='pressure', has_tool_use=False, message='Done. Tests pass. What next?', cm=True):
            data = {'content_block_count': 1, 'has_tool_use': has_tool_use}
            if cm:
                data['context_management'] = {'enabled': True, 'band': band, 'phase': 'execute'}
            return h.hook('on_message_complete', message=message, session_id=None, data=data)
        h.hook('before_message', message='Finish the feature')
        self.assertEqual(turn_end(), {'action': 'context_phase', 'phase': 'new_task'})
        status = h.status()
        self.assertEqual(status['by_op'], {'context': 1})
        self.assertEqual(status['counters']['context.report'], 1)
        self.assertEqual(status['counters']['context.questions'], 1)
        self.assertEqual(status['explanations'][-1]['reason'], 'accepted')
        for kwargs in [dict(band='normal'), dict(band='rollover'), dict(band='hard_limit'),
                       dict(has_tool_use=True), dict(message='   '), dict(cm=False)]:
            with self.subTest(**kwargs):
                self.assertEqual(turn_end(**kwargs), {'action': 'continue'})
        self.assertEqual(h.status()['by_op'], {'context': 1})
        self.command(h, 'context', 'off')
        self.assertFalse(h.status()['features']['context'])
        self.assertEqual(turn_end(), {'action': 'continue'})
        self.assertEqual(h.status()['by_op'], {'context': 1})
        self.assertEqual(h.status()['explanations'][-1], {'sequence': h.status()['explanations'][-1]['sequence'],
                                                          'op': 'context', 'reason': 'disabled'})
        self.assertEqual(h.config_sets, [])
        self.command(h, 'context', 'off', '--save')
        self.assertIn(('context', 'false'), h.config_sets)
        restarted = self.host(config=h.persisted)
        self.assertFalse(restarted.status()['features']['context'])
        self.assertIn('context', json.dumps(self.command(restarted, 'help')))

    def test_guard_off_skips_all_reviews_with_zero_calls(self):
        h = self.host()
        events = self.command(h, 'guard', 'off')
        self.assertIn('no longer reviewed', json.dumps(events))
        for tool, value in [('bash', {'command': 'rm -rf /fictional'}),
                            ('read', {'path': '/fictional/private'}),
                            ('write', {'path': '/fictional/file', 'content': 'x'}),
                            ('edit', {'path': '/fictional/file', 'old_string': 'x', 'new_string': 'y'})]:
            with self.subTest(tool=tool):
                self.assertEqual(h.hook('before_tool_call', tool_runtime_name=tool,
                                        tool_input=value), {'action': 'continue'})
        self.assertEqual(h.hook('on_session_start')['action'], 'inject')
        status = h.status()
        self.assertEqual(status['calls'], 0)
        self.assertEqual(status['errors'], 0)
        self.assertEqual(status['cost_usd'], 0)
        self.assertEqual(status['by_op'], {})
        self.assertFalse(any(k.startswith('guard.') for k in status['counters']))
        self.command(h, 'guard', 'on')
        self.assertEqual(h.hook('on_session_start')['action'], 'inject')
        self.assertEqual(h.hook('before_tool_call', tool_runtime_name='bash',
                                tool_input={'command': 'echo fixture'})['action'], 'confirm')
        self.assertEqual(h.status()['by_op'], {'guard': 1})

    def test_sparse_router_protocol(self):
        h = self.host(config={'router_models': 'small=provider/tiny'})
        inp = {'task': 'Read docs', 'role': 'reviewer',
               'write_policy': {'mode': 'non_overlapping_paths', 'scopes': ['docs/']},
               'unknown': {'keep': True}}
        def route(value):
            return h.hook('before_tool_call', tool_runtime_name='subagent_start',
                          session_id='sparse', tool_input=value)
        result = route(inp)
        self.assertEqual(result['input'], {**inp, 'model': 'provider/tiny'})
        self.assertEqual(route(inp), result)
        status = h.status()
        self.assertEqual(status['by_op'], {'router': 1})
        self.assertEqual(status['counters']['router.questions'], 1)
        self.assertEqual(status['counters']['router.cache'], 1)
        self.assertEqual(route({**inp, 'model': None})['action'], 'continue')
        self.assertEqual(route(result['input'])['action'], 'continue')
        self.assertEqual(h.status()['by_op'], {'router': 1})
        other = self.host()
        no_map = other.hook('before_tool_call', tool_runtime_name='subagent',
                            tool_input=inp)
        self.assertEqual(no_map['action'], 'continue')
        self.assertEqual(other.status()['calls'], 0)
        mixed = other.hook('before_tool_call', tool_runtime_name='subagent',
                           tool_input={'task': 'Read docs', 'role': 'reviewer', 'model': 'exact/id'})
        self.assertEqual(mixed['input']['model'], 'exact/id')
        self.assertEqual(other.status()['counters']['router.questions'], 1)

    def test_other_features_and_tools_remain_independent(self):
        h = self.host(config={'compress': True})
        self.command(h, 'guard', 'off')
        self.assertEqual(h.status()['features'],
                         {'guard': False, 'router': True, 'compress': True, 'triage': True, 'discovery': False, 'verification': False, 'evidence': False, 'diagnosis': False, 'reports': False, 'context': True, 'tools': True})
        result = h.hook('before_tool_call', tool_runtime_name='subagent_start',
                        tool_input={'task': 'Review the fixture'})
        self.assertEqual(result['action'], 'modify')
        self.assertEqual(result['input']['role'], 'reviewer')
        output = 'routine output\n' * 600
        fold = h.hook('after_tool_call', tool_runtime_name='bash', tool_output=output)
        self.assertEqual(fold['action'], 'replace')
        from jev.compress import decode_output
        self.assertEqual(decode_output(fold['output']), output)
        self.assertEqual(h.status()['counters']['compress.fold'], 1)
        self.assertEqual(h.status()['counters']['compress.saved_bytes'],
                         len(output.encode()) - len(fold['output'].encode()))
        before = h.status()['calls']
        unique = ''.join(f'unique line {i}\n' for i in range(1000))
        self.assertEqual(h.hook('after_tool_call', tool_runtime_name='bash',
                                tool_output=unique)['action'], 'continue')
        self.assertEqual(h.status()['calls'], before)
        self.command(h, 'router', 'off')
        self.assertTrue(h.status()['features']['compress'])
        self.command(h, 'compress', 'off')
        self.assertEqual(h.hook('before_tool_call', tool_runtime_name='subagent_start',
                                tool_input={'task': 'Review'})['action'], 'continue')
        self.assertEqual(h.hook('after_tool_call', tool_runtime_name='bash',
                                tool_output=output)['action'], 'continue')
        result = h.request('tool.call', {'name': 'jev_decide', 'input': {
            'state': 'fixture', 'questions': {'ok': {'type': 'noul', 'instructions': 'Fixture?'}}}})
        self.assertEqual(json.loads(result['result']['content'])['answers']['ok']['noul'], 1)
        self.assertEqual(h.status()['by_op'], {'router': 1, 'compress': 1, 'decide': 1})

    def test_compress_default_off_and_saved_independent(self):
        h = self.host()
        output = 'routine output\n' * 600
        self.assertFalse(h.status()['features']['compress'])
        self.assertEqual(h.hook('after_tool_call', tool_runtime_name='bash',
                                tool_output=output)['action'], 'continue')
        self.assertEqual(h.status()['calls'], 0)
        self.command(h, 'guard', 'off', '--save')
        self.command(h, 'compress', 'on', '--save')
        self.assertEqual(h.config_sets, [('guard', 'false'), ('compress', 'true')])
        saved = dict(h.persisted)
        h.close()
        fresh = self.host(config=saved)
        self.assertFalse(fresh.status()['features']['guard'])
        self.assertTrue(fresh.status()['features']['compress'])
        fold = fresh.hook('after_tool_call', tool_runtime_name='bash', tool_output=output)
        from jev.compress import decode_output
        self.assertEqual(decode_output(fold['output']), output)
        self.assertEqual(fresh.status()['by_op'], {'compress': 1})

    def test_session_only_does_not_write_and_fresh_process_resets(self):
        h = self.host()
        self.command(h, 'guard', 'off')
        events = self.command(h, 'guard')
        self.assertEqual(next(e['rows'] for e in events if e['kind'] == 'table'),
                         [['guard', 'off', 'session override', 'on']])
        self.assertIn('guard=off (session)', json.dumps(self.command(h, 'status')))
        self.assertEqual(h.config_sets, [])
        self.assertEqual(list(self.base.rglob('*')), [])
        h.close()
        fresh = self.host()
        self.assertTrue(fresh.status()['features']['guard'])
        self.assertNotIn('(session)', json.dumps(self.command(fresh, 'status')))

    def test_save_clears_override_and_survives_host_boot(self):
        h = self.host()
        self.command(h, 'guard', 'on')
        events = self.command(h, 'guard', 'off', '--save')
        self.assertIn('host config.set', json.dumps(events))
        self.assertEqual(h.config_sets, [('guard', 'false')])
        rows = next(e['rows'] for e in self.command(h, 'guard') if e['kind'] == 'table')
        self.assertEqual(rows, [['guard', 'off', 'config', 'off']])
        self.assertNotIn('(session)', json.dumps(self.command(h, 'status')))
        saved = dict(h.persisted)
        h.close()
        fresh = self.host(config=saved)
        self.assertFalse(fresh.status()['features']['guard'])
        self.command(fresh, 'guard', 'on', '--save')
        self.assertEqual(fresh.config_sets, [('guard', 'true')])
        saved = dict(fresh.persisted)
        fresh.close()
        self.assertTrue(self.host(config=saved).status()['features']['guard'])

    def test_fallback_persistence_is_private_and_preserves_other_settings(self):
        h = self.host(reject_save=True)
        h.store.parent.mkdir(parents=True)
        h.store.write_text('# fixture\nrouter = false\nguard = true\n')
        self.command(h, 'guard', 'on')
        events = self.command(h, 'guard', 'off', '--save')
        self.assertIn('direct write', json.dumps(events))
        self.assertEqual(h.config_sets, [('guard', 'false')])
        self.assertEqual(h.store.read_text(), '# fixture\nrouter = false\nguard = false\n')
        self.assertEqual(h.store.stat().st_mode & 0o777, 0o600)
        self.assertFalse(h.store.with_suffix('.tmp').exists())
        self.assertEqual(next(e['rows'] for e in self.command(h, 'guard') if e['kind'] == 'table'),
                         [['guard', 'off', 'config', 'off']])
        # The runtime (not the extension) reloads persisted feature settings.
        saved = dict(line.split(' = ', 1) for line in h.store.read_text().splitlines()
                     if line and not line.startswith('#'))
        h.close()
        fresh = self.host(config=saved)
        self.assertFalse(fresh.status()['features']['guard'])
        self.assertFalse(fresh.status()['features']['router'])

    def test_triage_and_select_protocol(self):
        h = self.host()
        self.assertTrue(h.status()['features']['triage'])
        self.command(h, 'guard', 'off')
        p = {'kind': 'after_tool_call', 'tool_name': 'bash', 'session_id': 'synthetic',
             'tool_output': 'Command failed (exit 1):\nSyntaxError: invalid syntax'}
        result = h.request('hook.handle', p)['result']
        self.assertTrue(result['output'].startswith(p['tool_output']))
        calls = h.status()['calls']
        h.request('hook.handle', p)
        self.assertEqual(h.status()['calls'], calls)
        self.command(h, 'triage', 'off', '--save')
        self.assertIn(('triage', 'false'), h.config_sets)
        self.assertEqual(h.request('hook.handle', p)['result'], {'action': 'continue'})
        self.assertEqual(h.status()['calls'], calls)
        r = h.request('tool.call', {'name': 'jev_select', 'input': {
            'context': 'syntax error', 'decisions': [{'instruction': 'What to inspect?',
            'candidates': [{'id': 'source', 'description': 'reported source'},
                           {'id': 'tests', 'description': 'test suite'}]}]}})
        self.assertEqual(json.loads(r['result']['content'])['decisions'][0]['id'], 'source')

    def test_discovery_protocol(self):
        from test_discovery import catalog
        h = self.host()
        self.assertFalse(h.status()['features']['discovery'])
        p = {'kind': 'after_tool_call', 'tool_runtime_name': 'search_tools',
             'session_id': 'synthetic', 'tool_input': {'query': 'failed assertions'},
             'tool_output': json.dumps(catalog())}
        self.assertEqual(h.request('hook.handle', p)['result'], {'action': 'continue'})
        self.assertEqual(h.status()['calls'], 0)
        self.command(h, 'guard', 'off')
        self.command(h, 'discovery', 'on', '--save')
        self.assertIn(('discovery', 'true'), h.config_sets)
        result = h.request('hook.handle', p)['result']
        self.assertEqual(json.loads(result['output'])['jev_advisory']['recommended_id'], 'alpha')
        h.request('hook.handle', p)
        self.assertEqual(h.status()['calls'], 1)
        self.command(h, 'discovery', 'off')
        self.assertEqual(h.request('hook.handle', p)['result'], {'action': 'continue'})
        self.assertEqual(h.status()['calls'], 1)

    def test_diagnosis_protocol(self):
        from diagnosis_fixture import diagnosis_fixture
        data = diagnosis_fixture()
        h = self.host()
        def call(host):
            return json.loads(host.request('tool.call', {'name': 'jev_diagnose', 'input': data})['result']['content'])
        self.assertEqual(call(h)['hypotheses']['review'], ['h-local', 'unicode/é'])
        self.assertEqual(h.status()['calls'], 0)
        self.command(h, 'guard', 'off')
        self.command(h, 'diagnosis', 'on')
        self.assertNotIn(('diagnosis', 'true'), h.config_sets)
        out = call(h)
        self.assertEqual(out['hypotheses']['investigate'], ['h-local'])
        self.assertEqual(out['hypotheses']['review'], ['unicode/é'])
        self.assertEqual(out['optional_checks']['inspect'], ['optional'])
        self.assertEqual(out['required_check_ids'], ['mandatory'])
        self.assertFalse(h.status()['features']['guard'])
        self.assertEqual(h.status()['op_stats']['diagnose']['calls'], 1)
        self.assertEqual(h.status()['counters']['diagnose.questions'], 3)
        fresh = self.host()
        self.assertFalse(fresh.status()['features']['diagnosis'])
        self.command(h, 'diagnosis', 'on', '--save')
        self.assertIn(('diagnosis', 'true'), h.config_sets)
        saved = self.host(config=h.persisted)
        self.assertTrue(saved.status()['features']['diagnosis'])
        self.assertEqual(call(saved)['required_check_ids'], ['mandatory'])
        self.command(h, 'diagnosis', 'off')
        self.assertEqual(call(h)['optional_checks']['review'], ['optional'])
        self.assertEqual(h.status()['calls'], 1)
        self.command(h, 'on')
        self.assertTrue(h.status()['features']['diagnosis'])
        self.command(h, 'economy')
        self.assertFalse(h.status()['features']['diagnosis'])
        self.command(h, 'off')
        self.assertFalse(h.status()['features']['diagnosis'])
        inert = self.host(config={'api_key': ''})
        self.assertIn('jev_diagnose', [t['name'] for t in inert.init['result']['capabilities']['tools']])
        self.assertEqual(call(inert)['fallback_reason'], 'nokey')
        self.assertEqual(inert.status()['calls'], 0)

    def test_evidence_protocol(self):
        from test_evidence import data
        h = self.host()
        d = data(); d['candidates'] = d['candidates'][:2]
        def call():
            return json.loads(h.request('tool.call', {'name': 'jev_evidence', 'input': d})['result']['content'])
        self.assertEqual(call()['review_ids'], ['0'])
        self.assertEqual(h.status()['calls'], 0)
        self.command(h, 'evidence', 'on', '--save')
        self.command(h, 'guard', 'off')
        self.assertEqual(call()['inspect_first_ids'], ['0'])
        self.assertEqual(h.status()['op_stats']['evidence']['calls'], 1)
        self.assertEqual(h.status()['counters']['evidence.questions'], 1)
        self.assertIn(('evidence', 'true'), h.config_sets)
        self.command(h, 'evidence', 'off')
        self.assertEqual(call()['review_ids'], ['0'])
        self.assertEqual(h.status()['calls'], 1)
        d['candidates'] = d['candidates'][1:]
        self.assertEqual(call()['required_ids'], ['1'])
        self.assertEqual(h.status()['calls'], 1)
        inert = self.host(config={'api_key': ''})
        out = json.loads(inert.request('tool.call', {'name': 'jev_evidence', 'input': data()})['result']['content'])
        self.assertIn('/jev key', out['fallback_reason'])

    def test_verification_protocol(self):
        from test_verification import data
        h = self.host()
        d = data(); d['checks'] = d['checks'][:2]
        def call():
            return json.loads(h.request('tool.call', {'name': 'jev_verify', 'input': d})['result']['content'])
        self.assertEqual(call()['review_optional_ids'], ['candidate/0'])
        self.assertEqual(h.status()['calls'], 0)
        self.command(h, 'verification', 'on', '--save')
        self.command(h, 'guard', 'off')
        self.assertEqual(call()['recommended_optional_ids'], ['candidate/0'])
        self.assertEqual(h.status()['op_stats']['verification']['calls'], 1)
        self.assertIn(('verification', 'true'), h.config_sets)
        d['checks'] = d['checks'][:1]
        self.assertEqual(call()['required_ids'], ['mandatory'])
        self.assertEqual(h.status()['calls'], 1)
        d['checks'][0]['required'] = 1
        error = h.request('tool.call', {'name': 'jev_verify', 'input': d})['error']
        self.assertIn('invalid input', error['message'])
        inert = self.host(config={'api_key': ''})
        out = json.loads(inert.request('tool.call', {'name': 'jev_verify', 'input': data()})['result']['content'])
        self.assertEqual(out['required_ids'], ['mandatory'])
        self.assertIn('/jev key', out['fallback_reason'])

    def test_verification_typed_siblings_and_expansion_cap_protocol(self):
        from test_verification import data
        h = self.host()
        self.command(h, 'verification', 'on')
        d = data()
        def call():
            return json.loads(h.request('tool.call', {'name': 'jev_verify', 'input': d})['result']['content'])
        out = call()
        self.assertEqual(out['recommended_optional_ids'], ['candidate/0'])
        self.assertEqual(out['review_optional_ids'], ['candidate/1'])
        self.assertEqual(out['lower_priority_optional_ids'], ['candidate/2'])
        d['task'] = 'token=x ' * 500
        d['changes'] = ['token=x ' * 62] * 16
        out = call()
        self.assertEqual(out['required_ids'], ['mandatory'])
        self.assertEqual(out['review_optional_ids'], ['candidate/0', 'candidate/1', 'candidate/2'])
        self.assertEqual(out['fallback_reason'], 'redacted_state_too_large')
        self.assertEqual(h.status()['op_stats']['verification']['calls'], 1)

    def test_on_off_help_and_status_events(self):
        h = self.host()
        self.assertEqual([t['name'] for t in h.init['result']['capabilities']['tools']],
                         ['jev_decide', 'jev_status', 'jev_select', 'jev_verify', 'jev_evidence', 'jev_diagnose'])
        for args in [(), ('help',)]:
            text = json.dumps(self.command(h, *args))
            for phrase in ['/jev guard off', '--save', '/jev off', '/jev status']:
                self.assertIn(phrase, text)
        for command, enabled in [('off', False), ('on', True)]:
            events = self.command(h, command)
            self.assertIn('this session only', json.dumps(events))
            self.assertEqual(h.status()['features'], {'guard': enabled, 'router': enabled,
                                                      'compress': enabled, 'triage': enabled, 'discovery': enabled, 'verification': enabled, 'evidence': enabled, 'diagnosis': enabled, 'reports': enabled, 'context': enabled, 'tools': True})
            self.assertTrue(any(e['kind'] == 'table' for e in self.command(h, 'status')))
        self.command(h, 'off', '--save')
        self.assertEqual(h.config_sets, [('guard', 'false'), ('router', 'false'), ('compress', 'false'), ('triage', 'false'), ('discovery', 'false'), ('verification', 'false'), ('evidence', 'false'), ('diagnosis', 'false'), ('reports', 'false'), ('context', 'false')])
        self.assertNotIn('(session)', json.dumps(self.command(h, 'status')))


if __name__ == '__main__':
    unittest.main()
