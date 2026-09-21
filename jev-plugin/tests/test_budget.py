"""Offline budgets, wire accounting and trusted-context boundaries."""
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions'))
from jev.client import DecisionClient, JevError, _Retryable, usage_tokens
from jev.policy import BudgetPolicy, PolicyDenied, validate
from jev import commands, tools
import jev_ext


def client(**settings):
    p = BudgetPolicy({'budget_enabled': True, **{'budget_' + k: v for k, v in settings.items()}})
    return DecisionClient('offline-fixture', policy=p), p


def response(tokens=10):
    return {'usage': {'input_tokens': tokens}, 'answers': {}}


def test_defaults_and_retry_accounting_without_policy():
    assert BudgetPolicy().settings == dict(enabled=False, calls=100, cost_usd=.02,
        latency_ms=30000, error_streak=3, cooldown_s=60)
    c = DecisionClient('offline-fixture')
    with patch.object(c, '_bounded_post', side_effect=[_Retryable('private', 0), response()]):
        c.decide('x', {})
    s = c.stats.snapshot()
    assert (s['calls'], s['wire_attempts'], s['retries']) == (1, 2, 1)
    assert s['input_tokens'] is s['cost_usd'] is None
    assert s['known_input_tokens'] == c.stats.input_tokens == 10
    assert s['unknown_usage_calls'] == s['unknown_usage_attempts'] == 1


def test_retry_call_cap_denies_before_wire_and_no_denial_error():
    c, p = client(calls=1)
    with patch.object(c, '_bounded_post', side_effect=_Retryable('private', 0)) as post:
        with pytest.raises(PolicyDenied, match='^budget_calls$'):
            c.decide('x', {})
        assert post.call_count == 1
        before = c.stats.snapshot()
        with pytest.raises(PolicyDenied, match='budget_calls'):
            c.decide('x', {})
    assert c.stats.snapshot() == before
    assert p.ledger().error_streak == 1
    assert p.snapshot()['aggregate']['denied'] == {'budget_calls': 2}


def test_estimated_cost_can_overshoot_one_inflight_then_stop():
    c, p = client(cost_usd=.000001)
    with patch.object(c, '_bounded_post', return_value=response(100)) as post:
        c.decide('x', {})
        assert p.snapshot()['aggregate']['known_cost_usd'] > .000001
        with pytest.raises(PolicyDenied, match='budget_cost'):
            c.decide('x', {})
        assert post.call_count == 1


@pytest.mark.parametrize('usage', [None, {}, [], {'input_tokens': True}, {'input_tokens': -1},
    {'input_tokens': 2**53+1}, {'input_tokens': '10'}, {'input_tokens': float('nan')}])
def test_unknown_usage_stops_optional_not_guard(usage):
    c, p = client()
    with patch.object(c, '_bounded_post', return_value={'usage': usage}) as post:
        c.decide('x', {})
        with pytest.raises(PolicyDenied, match='budget_unknown_usage'):
            c.decide('x', {})
        c.decide('x', {}, op='guard')
        assert post.call_count == 2
    assert c.stats.snapshot()['cost_usd'] is None
    assert c.stats.snapshot()['known_input_tokens'] == 0
    assert p.ledger().wire_attempts == 1
    assert usage_tokens(response(2**53)) == 2**53


def test_latency_deadline_and_full_retry_delay_counted():
    c, p = client(latency_ms=500)
    clock = [0.0]
    def post(body, remaining):
        assert remaining == pytest.approx(.5)
        clock[0] += .5
        return response()
    with patch('time.monotonic', side_effect=lambda: clock[0]), patch.object(c, '_bounded_post', side_effect=post):
        c.decide('x', {})
        with pytest.raises(PolicyDenied, match='budget_latency'):
            c.decide('x', {})
    assert p.ledger().latency_ms == 500
    c, p = client(enabled=False)
    clock[0] = 0
    def retry(body, remaining):
        clock[0] += .1
        if c.stats.wire_attempts == 1:
            raise _Retryable('private', .2)
        return response()
    with patch('time.monotonic', side_effect=lambda: clock[0]), patch('time.sleep', side_effect=lambda t: clock.__setitem__(0, clock[0]+t)), patch.object(c, '_bounded_post', side_effect=retry):
        c.decide('x', {})
    assert p.ledger().latency_ms == pytest.approx(400)
    assert c.stats.total_ms == 400


def test_circuit_cooldown_halfopen_and_unknown_is_independent_stop():
    p = BudgetPolicy({'budget_enabled': True, 'budget_error_streak': 2})
    l = p.ledger()
    with patch('time.monotonic', return_value=10):
        for _ in range(2):
            p.reserve(l, 0)
            p.observe(l, 10, True)
        with pytest.raises(PolicyDenied, match='circuit_open'):
            p.reserve(l, 0)
    with patch('time.monotonic', return_value=71):
        p.reserve(l, 0)
        with pytest.raises(PolicyDenied, match='circuit_open'):
            p.reserve(l, 0)
        p.observe(l, 10, False)
        assert l.error_streak == 0
        p.reserve(l, 0)
        p.observe(l, None, True)
        with pytest.raises(PolicyDenied, match='budget_unknown_usage'):
            p.reserve(l, 0)


def test_scopes_bounded_and_private():
    c, p = client(calls=1)
    with patch.object(c, '_bounded_post', return_value=response()):
        for session in ('private-one', 'private-two'):
            with p.scoped(session):
                c.decide('x', {})
                with pytest.raises(PolicyDenied):
                    c.decide('x', {})
        for i in range(200):
            with p.scoped(str(i)):
                p.ledger()
        assert len(p.ledgers) == 128
        with p.scoped('new-session'):
            c.decide('x', {})
        with p.scoped('another-new-session'):
            with pytest.raises(PolicyDenied):
                c.decide('x', {})
        for invalid in ('', ' ', 'x'*257, 'x\n', None, 42):
            with p.scoped(invalid):
                assert p.ledger() is p.ledgers['unscoped']
    assert 'private-one' not in str(p.snapshot())
    assert p.scope == 'unscoped'


def test_extension_scope_spoof_guard_failure_reactivation_and_reset():
    ext = jev_ext.Extension()
    ext.activate('offline-fixture', source='fixture')
    p = ext.policy
    p.settings.update(enabled=True, calls=1)
    data = {'state': {'session_id': 'spoof'}, 'session_id': 'spoof',
            'questions': {'q': {'type': 'noul', 'instructions': 'x'}}}
    with patch.object(ext.client, '_bounded_post', return_value=response()):
        ext.tool_call({'name': 'jev_decide', 'session_id': 'also-spoof', 'input': data})
        with pytest.raises(tools.ToolError, match='budget_calls'):
            ext.tool_call({'name': 'jev_decide', 'input': dict(data, session_id='new')})
    assert len(p.ledgers) == 2
    ext.activate('offline-fixture-new', source='fixture')
    assert ext.client.policy is p
    assert p.ledger().wire_attempts == 1
    with patch.object(ext.client, '_bounded_post', side_effect=JevError('transport failure')):
        result = ext.hook({'kind': 'before_tool_call', 'session_id': 'trusted',
                          'tool_runtime_name': 'bash', 'tool_input': {'command': 'rm important'}})
    assert result['action'] == 'confirm'
    assert ext.client.stats.snapshot()['by_op']['guard'] == 1
    assert p.scope == 'unscoped'
    assert p.ledger().wire_attempts == 1
    with patch.object(ext, '_hook', side_effect=RuntimeError):
        with pytest.raises(RuntimeError):
            ext.hook({'session_id': 'trusted'})
    assert p.scope == 'unscoped'
    events = []
    commands.handle({'args': ['budget', 'reset']}, ext, events.append, lambda *a: None)
    assert p.ledger().wire_attempts == 0
    assert ext.features['guard']
    assert ext.client.stats.calls == 1


def test_commands_validation_no_writes_no_key_status():
    ext = jev_ext.Extension()
    writes, events = [], []
    def run(*args):
        commands.handle({'args': ['budget', *args]}, ext, events.append, lambda *a: writes.append(a))
    for args in [('calls', 'NaN', '--save'), ('cost', 'inf', '--save'), ('calls', '1.2'),
                 ('on', 'extra', '--save'), ('reset', '--save'), ('on', '--save', '--save')]:
        run(*args)
        assert events[-2]['params']['event']['kind'] == 'error'
    assert writes == []
    run('on', '--save')
    assert writes == [('config.set', {'key': 'budget_enabled', 'value': 'true'})]
    run('calls', '4')
    assert ext.policy.settings['calls'] == 4
    assert not ext.features['guard']
    status = json.loads(ext.tool_call({'name': 'jev_status'})['content'])
    assert status['budget']['settings']['enabled']
    for name in ('calls', 'cost_usd', 'latency_ms', 'error_streak', 'cooldown_s'):
        for bad in (True, float('nan'), float('inf'), -1, 10**100):
            with pytest.raises(ValueError):
                validate(name, bad)


# Real framed command protocol, only HTTP stubbed; no installed configuration.
import unittest
import test_features_protocol as protocol


class BudgetProtocolTests(unittest.TestCase):
    setUp = protocol.FeatureProtocolTests.setUp
    host = protocol.FeatureProtocolTests.host
    command = protocol.FeatureProtocolTests.command

    def test_saved_settings_and_fallback_preserve_configuration(self):
        for fallback in (False, True):
            h = self.host(config={'api_key': ''}, reject_save=fallback)
            if fallback:
                h.store.parent.mkdir(parents=True, exist_ok=True)
                h.store.write_text('# keep\nguard = false\nunrelated = original\n')
            self.command(h, 'budget', 'on', '--save')
            self.command(h, 'budget', 'calls', '2', '--save')
            self.command(h, 'budget', 'cost', '.03', '--save')
            self.command(h, 'budget', 'latency', '1234', '--save')
            self.command(h, 'budget', 'errors', '2', '--save')
            self.command(h, 'budget', 'cooldown', '4', '--save')
            status = h.status()
            self.assertFalse(status['active'])
            self.assertTrue(status['budget']['settings']['enabled'])
            self.assertIn('budget', str(self.command(h, 'status')))
            before = list(h.config_sets)
            h.command('budget', 'calls', '2', 'extra', '--save')
            self.assertEqual(h.config_sets, before)
            saved = h.persisted
            if fallback:
                text = h.store.read_text()
                self.assertIn('# keep\nguard = false\nunrelated = original\n', text)
                self.assertEqual(h.store.stat().st_mode & 0o777, 0o600)
                saved = dict(line.split(' = ', 1) for line in text.splitlines() if ' = ' in line)
            fresh = self.host(config={'api_key': '', **saved})
            self.assertEqual(fresh.status()['budget']['settings'], status['budget']['settings'])

    def test_cache_guard_and_session_scope_live_commands(self):
        h = self.host()
        self.command(h, 'budget', 'calls', '1')
        self.command(h, 'budget', 'on')
        def route(session, task='Read docs'):
            return h.hook('before_tool_call', session_id=session, tool_runtime_name='subagent_start',
                          tool_input={'task': task})
        first = route('one')
        self.assertEqual(route('one'), first)  # local cache remains usable at cap
        self.assertEqual(route('one', 'Review tests'), {'action': 'continue'})
        route('two')
        for _ in range(2):
            h.hook('before_tool_call', session_id='one', tool_runtime_name='bash',
                   tool_input={'command': 'rm fixture'})
        status = h.status()
        self.assertEqual(status['by_op'], {'router': 2, 'guard': 2})
        self.assertEqual(status['budget']['aggregate']['wire_attempts'], 2)
        self.assertEqual(status['budget']['unscoped']['wire_attempts'], 0)
        self.assertNotIn('one', json.dumps(status['budget']))
        self.command(h, 'budget', 'off')
        self.command(h, 'budget', 'on')
        self.assertEqual(h.status()['budget']['aggregate']['wire_attempts'], 2)
        self.command(h, 'budget', 'reset')
        self.assertTrue(h.status()['features']['guard'])
        self.assertEqual(h.status()['budget']['aggregate']['wire_attempts'], 0)
        self.assertEqual(h.status()['calls'], 4)


def test_hook_key_pickup_scopes_new_client_and_user_tests_exempt():
    ext = jev_ext.Extension()
    ext.policy.settings.update(enabled=True, calls=1)
    with patch('jev_ext.keys.discover', return_value=('offline', 'fixture')):
        with patch.object(DecisionClient, '_bounded_post', return_value=response()):
            ext.hook({'kind': 'before_tool_call', 'session_id': 'trusted-pickup',
                      'tool_runtime_name': 'subagent_start', 'tool_input': {'task': 'Read docs'}})
    assert ext.client.policy is ext.policy
    assert ext.policy.snapshot()['aggregate']['wire_attempts'] == 1
    assert ext.policy.ledgers['unscoped'].wire_attempts == 0
    with patch.object(ext.client, '_bounded_post', return_value=response()):
        ext.client.decide('x', {})
        for op in ('probe', 'test', 'guard'):
            ext.client.decide('x', {}, op=op)
    assert ext.policy.ledgers['unscoped'].wire_attempts == 1
    assert ext.client.stats.calls == 5
