"""Economy uses real commands/runtime; all key lookup and HTTP remain offline."""
import copy
from unittest.mock import patch

import pytest

import test_features_protocol as protocol
import unittest
from test_compress import RAW
from jev import commands, compress
from jev_ext import Extension


@pytest.mark.parametrize('guard', [True, False])
def test_economy_preserves_guard_and_mode_activation(guard):
    ext = Extension()
    ext.activate('offline', source='test')
    ext.set_feature('guard', guard, persist=False)
    events = []
    commands.handle({'args': ['economy']}, ext, events.append, lambda *a: None)
    assert ext.features == dict(guard=guard, router=True, triage=True, compress=True,
                               discovery=False, verification=False, evidence=False, reports=False, tools=True)
    assert ext.session_overrides['guard'] is guard
    assert ext.cfg == {}
    ext.activate('new-offline', source='test')
    assert ext.compress_cfg.mode == 'deterministic'
    assert ext.features['guard'] is guard
    commands.handle({'args': ['on']}, ext, events.append, lambda *a: None)
    assert all(ext.features.values()) and ext.compress_cfg.mode == 'deterministic'
    commands.handle({'args': ['off']}, ext, events.append, lambda *a: None)
    assert not ext.features['compress'] and ext.features['tools']


@pytest.mark.parametrize('config,active', [({}, False), ({'compress': True}, False),
    ({'compress_mode': 'deterministic'}, False),
    ({'compress': True, 'compress_mode': 'deterministic'}, True)])
def test_explicit_no_key_only(config, active):
    ext = Extension()
    with patch('jev_ext.keys.discover', return_value=(None, 'none')):
        ext.initialize({'config': config})
    assert ext.features['compress'] is active
    assert not ext.features['guard'] and ext.features['tools']


@pytest.mark.parametrize('args', [['economy', 'oops', '--save'],
    ['compress', 'mode', 'invalid', '--save'], ['compress', 'mode', 'jev', 'extra', '--save']])
def test_invalid_no_mutation_or_write(args):
    ext = Extension()
    before = copy.deepcopy((ext.cfg, ext.features, ext.session_overrides))
    events, writes = [], []
    commands.handle({'args': args}, ext, events.append, lambda *a: writes.append(a))
    assert (ext.cfg, ext.features, ext.session_overrides) == before
    assert ext.compress_cfg.mode == 'jev' and not writes
    assert any(e['params']['event']['kind'] == 'error' for e in events)


def test_all_caches_cleared_on_reactivation_and_deactivation():
    ext = Extension()
    for action in (lambda: ext.activate('offline', source='test'), ext.deactivate):
        for component in (ext.router, ext.triage, ext.reports, ext.discovery):
            component.cache['old session'] = 'old answer'
        action()
        assert all(not c.cache for c in (ext.router, ext.triage, ext.reports, ext.discovery))


class EconomyProtocolTests(unittest.TestCase):
    setUp = protocol.FeatureProtocolTests.setUp
    host = protocol.FeatureProtocolTests.host
    command = protocol.FeatureProtocolTests.command
    def test_economy_no_key_save_fresh_and_zero_calls(self):
        h = self.host(config={'api_key': ''})
        self.assertFalse(h.status()['features']['compress'])
        self.command(h, 'economy', '--save')
        self.assertNotIn('guard', dict(h.config_sets))
        self.assertEqual(dict(h.config_sets)['compress_mode'], 'deterministic')
        for host in (h, self.host(config=h.persisted)):
            result = host.hook('after_tool_call', tool_runtime_name='bash', tool_output=RAW)
            self.assertEqual(compress.decode_output(result['output']), RAW)
            status = host.status()
            self.assertFalse(status['active'])
            self.assertNotIn('compress.call', status['counters'])
            self.assertEqual(status['counters']['compress.local'], 1)
            self.assertTrue(status['features']['compress'])
            self.assertFalse(status['features']['guard'])
            events = self.command(host, 'status')
            self.assertIn('deterministic', str(events))
            self.command(host, 'off')
            self.assertEqual(host.hook('after_tool_call', tool_runtime_name='bash', tool_output=RAW),
                             {'action': 'continue'})

    def test_mode_save_fallback_and_explicit_no_key_enable(self):
        h = self.host(config={'api_key': ''}, reject_save=True)
        h.store.parent.mkdir(parents=True, exist_ok=True)
        h.store.write_text('# preserve\nunrelated = value\n')
        self.command(h, 'compress', 'mode', 'deterministic', '--save')
        self.assertEqual(h.store.stat().st_mode & 0o777, 0o600)
        self.assertIn('# preserve\nunrelated = value\n', h.store.read_text())
        self.command(h, 'compress', 'on', '--save')
        saved = dict(line.split(' = ', 1) for line in h.store.read_text().splitlines()
                     if ' = ' in line)
        fresh = self.host(config={'api_key': '', **saved})
        self.assertTrue(fresh.status()['features']['compress'])
        self.command(fresh, 'compress', 'mode', 'jev')
        self.assertFalse(fresh.status()['features']['compress'])

    def test_exact_session_caches_and_guard_not_cached(self):
        h = self.host()
        self.command(h, 'economy')
        def route(session):
            return h.hook('before_tool_call', session_id=session, tool_runtime_name='subagent_start',
                          tool_input={'task': 'Read docs'})
        def triage(session):
            return h.hook('after_tool_call', session_id=session, tool_runtime_name='bash',
                          tool_output='Command failed (exit 1):\nSyntaxError: invalid syntax')
        for call in (route, triage):
            self.assertEqual(call('s1'), call('s1'))
            call('s2')
        for _ in range(2):
            h.hook('before_tool_call', tool_runtime_name='bash', session_id='s1',
                   tool_input={'command': 'echo fixture'})
        status = h.status()
        self.assertEqual(status['by_op'], {'router': 2, 'triage': 2, 'guard': 2})
        self.assertEqual(status['counters']['router.cache'], 1)
        self.assertEqual(status['counters']['triage.cache'], 1)


    def test_economy_keyed_zero_calls_on_off_and_session_only(self):
        h = self.host()
        self.command(h, 'guard', 'off')
        self.command(h, 'economy')
        self.assertFalse(h.status()['features']['guard'])
        self.assertEqual(h.config_sets, [])
        folded = h.hook('after_tool_call', tool_runtime_name='bash', tool_output=RAW)
        self.assertEqual(compress.decode_output(folded['output']), RAW)
        self.assertEqual(h.status()['calls'], 0)
        self.command(h, 'on', '--save')
        self.assertTrue(all(h.status()['features'].values()))
        self.assertIn('deterministic', str(self.command(h, 'status')))
        self.command(h, 'off')
        self.assertFalse(h.status()['features']['compress'])
        fresh = self.host()
        self.assertFalse(fresh.status()['features']['compress'])
        self.assertIn('jev', str(self.command(fresh, 'status')))

    def test_economy_fallback_save_does_not_touch_saved_guard(self):
        h = self.host(config={'guard': False}, reject_save=True)
        h.store.parent.mkdir(parents=True, exist_ok=True)
        h.store.write_text('# keep\nguard = false\nunrelated = original\n')
        self.command(h, 'economy', '--save')
        text = h.store.read_text()
        self.assertIn('# keep\nguard = false\nunrelated = original\n', text)
        self.assertEqual(h.store.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('guard', dict(h.config_sets))
        saved = dict(line.split(' = ', 1) for line in text.splitlines() if ' = ' in line)
        fresh = self.host(config=saved)
        self.assertFalse(fresh.status()['features']['guard'])
        self.assertTrue(fresh.status()['features']['compress'])
        self.assertEqual(fresh.status()['calls'], 0)
