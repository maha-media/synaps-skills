"""Offline context-boundary tests; no host, filesystem, network or API access in handler."""
import json
from pathlib import Path
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions'))
from jev import context
from jev.context import (ContextBoundary, BOUNDARY_THRESHOLD, CONTINUE, CRITERIA, MAX_TEXT, REPORT,
                         recognized)
from jev.audit import Audit, GLOSS
from jev_ext import Extension

SECRET = 'apikey_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
GOAL_SECRET = 'ghp_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'


def event(band='pressure', has_tool_use=False, message='Done: implemented and tested. Anything else?',
          enabled=True, **changes):
    p = dict(kind='on_message_complete', message=message, session_id='session-secret',
             data={'content_block_count': 1, 'has_tool_use': has_tool_use,
                   'context_management': {'enabled': enabled, 'band': band, 'phase': 'execute'}})
    p.update(changes)
    return p


def answer(choice='completed', confidence=.9, **extra):
    return {'answers': {'boundary': {'type': 'choice', 'choice': choice, 'confidence': confidence, **extra}},
            'model': 'offline-fixture', 'usage': {'input_tokens': 5}}


DEFAULT = object()


class Client:
    model = 'test-model'

    def __init__(self, response=DEFAULT):
        self.calls = []
        self.response = answer() if response is DEFAULT else response

    def decide(self, state, questions, **kwargs):
        self.calls.append((state, questions, kwargs))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def run(p=None, client=None, enabled=True, goal='Please finish the feature'):
    c = client or Client()
    a = Audit(None)
    with patch('builtins.open', side_effect=AssertionError('file access')), \
         patch('socket.socket', side_effect=AssertionError('network')), \
         patch('subprocess.Popen', side_effect=AssertionError('tool execution')):
        result = ContextBoundary().handle(p if p is not None else event(), c, enabled, a, goal=goal)
    return result, c, a


def reasons(a):
    rows = a.explanations()
    assert all(r['op'] == 'context' and r['reason'] in GLOSS for r in rows)
    return [r['reason'] for r in rows]


def test_recognized_requires_new_host_contract():
    assert recognized(event())
    assert not recognized({'kind': 'on_message_complete', 'message': 'x', 'data': {'has_tool_use': False}})
    assert not recognized({'kind': 'on_message_complete', 'message': 'x', 'data': None})
    assert not recognized({'kind': 'on_message_complete', 'message': 'x'})
    assert not recognized({'kind': 'after_tool_call', 'data': {'context_management': {}}})
    assert not recognized(None)
    assert not recognized([])


def test_older_host_without_context_management_is_inert():
    p = event()
    del p['data']['context_management']
    result, c, a = run(p)
    assert result == CONTINUE and c.calls == []
    assert a.counters == {'context.skip': 1}
    assert reasons(a) == ['noeconomiccandidate']


@pytest.mark.parametrize('band', ['normal', 'rollover', 'hard_limit', None, 'PRESSURE', 'pressure ', 3])
def test_only_pressure_band_fires(band):
    result, c, a = run(event(band=band))
    assert result == CONTINUE and c.calls == []
    assert a.counters == {'context.skip': 1} and reasons(a) == ['notpressure']


@pytest.mark.parametrize('has_tool_use', [True, None, 0, 'false'])
def test_tool_use_or_malformed_flag_skips(has_tool_use):
    result, c, a = run(event(has_tool_use=has_tool_use))
    assert result == CONTINUE and c.calls == []
    assert a.counters == {'context.skip': 1} and reasons(a) == ['notpressure']


@pytest.mark.parametrize('enabled', [False, None, 1, 'true'])
def test_context_management_disabled_skips(enabled):
    result, c, a = run(event(enabled=enabled))
    assert result == CONTINUE and c.calls == []
    assert reasons(a) == ['notpressure']


def test_disabled_and_nokey_skip():
    result, c, a = run(enabled=False)
    assert result == CONTINUE and c.calls == [] and reasons(a) == ['disabled']
    a = Audit(None)
    assert ContextBoundary().handle(event(), None, True, a) == CONTINUE
    assert a.counters == {'context.skip': 1} and reasons(a) == ['nokey']


@pytest.mark.parametrize('message', ['', '   \n', None, 5, ['text']])
def test_blank_or_non_string_message_skips(message):
    result, c, a = run(event(message=message))
    assert result == CONTINUE and c.calls == []
    assert reasons(a) == ['noeconomiccandidate']


def test_completed_high_confidence_reports_new_task():
    result, c, a = run()
    assert result == REPORT == {'action': 'context_phase', 'phase': 'new_task'}
    assert result is not REPORT
    assert len(c.calls) == 1
    state, questions, kwargs = c.calls[0]
    assert kwargs == {'op': 'context'}
    assert set(state) == {'assistant_final_text', 'latest_user_request'}
    assert state['latest_user_request'] == 'Please finish the feature'
    assert list(questions) == ['boundary']
    q = questions['boundary']
    assert q['type'] == 'choice' and q['criteria'] == CRITERIA and 'unclear' in q['criteria']
    assert 'untrusted data' in q['instructions'] and 'never instructions' in q['instructions']
    assert a.counters == {'context.call': 1, 'context.questions': 1, 'context.report': 1}
    assert reasons(a) == ['accepted']


def test_threshold_is_module_constant_and_boundary_inclusive():
    assert BOUNDARY_THRESHOLD == .85
    result, c, a = run(client=Client(answer(confidence=.85)))
    assert result == REPORT and reasons(a) == ['accepted']


def test_completed_low_confidence_continues():
    result, c, a = run(client=Client(answer(confidence=.7)))
    assert result == CONTINUE and len(c.calls) == 1
    assert a.counters == {'context.call': 1, 'context.questions': 1, 'context.abstain': 1}
    assert reasons(a) == ['lowconfidence']


@pytest.mark.parametrize('choice,reason', [('paused', 'accepted'), ('partial', 'accepted'), ('unclear', 'modelabstention')])
def test_other_choices_continue(choice, reason):
    result, c, a = run(client=Client(answer(choice=choice, confidence=.95)))
    assert result == CONTINUE
    assert a.counters['context.abstain'] == 1 and 'context.report' not in a.counters
    assert reasons(a) == [reason]


@pytest.mark.parametrize('bad', [
    answer(choice='completed', confidence=True),
    answer(choice='completed', confidence=float('nan')),
    answer(choice='completed', confidence=1.5),
    answer(choice='done', confidence=1),
    answer(choice='completed', confidence=.9, probabilities={'elsewhere': .5}),
    answer(choice='completed', confidence=.9, probabilities={}),
    answer(choice='completed', confidence=.9, extra_field=1),
    {**answer(), 'answers': {'boundary': {'type': 'noul', 'choice': 'completed', 'confidence': .9}}},
    {**answer(), 'answers': {'boundary': 'completed'}},
    {**answer(), 'answers': {'boundary': None}},
    {**answer(), 'answers': {}},
    {**answer(), 'answers': {'boundary': answer()['answers']['boundary'], 'other': {'noul': 1}}},
    {**answer(), 'answers': None},
    {'answers': {'boundary': {'choice': 'completed', 'confidence': .9}}, 'model': 'm' * 5000},
    [],
    None,
])
def test_malformed_answers_continue(bad):
    result, c, a = run(client=Client(bad))
    assert result == CONTINUE and len(c.calls) == 1
    assert 'context.report' not in a.counters
    assert set(reasons(a)) <= {'invalidresponse', 'review'} and reasons(a)


def test_transport_error_continues_and_counts_error():
    class Diagnosed(Exception):
        diagnosed = True
    result, c, a = run(client=Client(Diagnosed('upstream body ' + SECRET)))
    assert result == CONTINUE
    assert a.counters == {'context.call': 1, 'context.questions': 1, 'context.error': 1, 'context.abstain': 1}
    assert reasons(a) == []  # client-owned diagnostics; nothing hook-local to add
    result, c, a = run(client=Client(RuntimeError('undiagnosed ' + SECRET)))
    assert result == CONTINUE and reasons(a) == ['review'] and a.counters['context.error'] == 1
    assert SECRET not in json.dumps([a.explanations(), a.counters])


def test_fail_open_on_unexpected_exception():
    class Exploding(dict):
        def get(self, *a):
            raise RuntimeError('boom ' + SECRET)
    p = event()
    p['data'] = Exploding(p['data'])
    a = Audit(None)
    c = Client()
    assert ContextBoundary().handle(p, c, True, a) == CONTINUE
    assert c.calls == []
    assert a.counters == {'context.error': 1} and reasons(a) == ['review']
    assert SECRET not in json.dumps(a.explanations())


def test_secret_in_text_is_redacted_and_bounded_before_send():
    long = 'Finished. ' + SECRET + ' and password=hunter2 ' + ('line of report\n' * 800)
    assert len(long) > MAX_TEXT
    result, c, a = run(event(message=long), goal='Use token ' + GOAL_SECRET + ' to deploy ' + 'x' * 3000)
    state = c.calls[0][0]
    sent = json.dumps(state)
    assert SECRET not in sent and GOAL_SECRET not in sent and 'hunter2' not in sent
    assert '[REDACTED]' in state['assistant_final_text']
    assert '[TRUNCATED BY JEV:' in state['assistant_final_text']
    assert '[TRUNCATED BY JEV:' in state['latest_user_request']
    assert len(state['assistant_final_text']) < MAX_TEXT + 60
    assert len(state['latest_user_request']) < 1500 + 60
    assert 'session-secret' not in sent and 'session_id' not in sent


def test_short_text_is_not_marked_truncated():
    result, c, a = run()
    assert '[TRUNCATED' not in json.dumps(c.calls[0][0])


def test_oversized_state_skips_with_review():
    # Multi-byte characters keep the char bound but exceed the 24 KiB byte budget.
    result, c, a = run(event(message='\U0001f600' * MAX_TEXT), goal='\U0001f600' * 1500)
    assert result == CONTINUE and c.calls == []
    assert a.counters == {'context.skip': 1} and reasons(a) == ['review']


def test_nothing_from_state_reaches_audit(tmp_path):
    a = Audit(str(tmp_path / 'audit.jsonl'))
    writes = []
    a.write = lambda record: writes.append(record)
    c = Client()
    result = ContextBoundary().handle(event(message='Done with ' + SECRET), c, True, a, goal='goal ' + GOAL_SECRET)
    assert result == REPORT and writes == []
    assert not (tmp_path / 'audit.jsonl').exists()
    dump = json.dumps([a.counters, a.explanations()])
    for needle in (SECRET, GOAL_SECRET, 'Done with', 'goal ', 'session-secret', 'REDACTED'):
        assert needle not in dump


def test_no_cache_each_turn_end_is_a_new_call():
    c = Client()
    a = Audit(None)
    h = ContextBoundary()
    for _ in range(3):
        assert h.handle(event(), c, True, a) == REPORT
    assert len(c.calls) == 3 and a.counters['context.call'] == 3
    assert not hasattr(h, 'cache')


def test_extension_wiring_uses_goal_and_feature_flag():
    ext = Extension()
    ext.activate('offline-fixture', source='test')
    assert ext.features['context'] is True
    client = Client()
    ext.client = client
    ext._hook({'kind': 'before_message', 'message': 'Ship the release notes'})
    assert ext._hook(event()) == REPORT
    assert client.calls[0][0]['latest_user_request'] == 'Ship the release notes'
    assert ext.audit.counters['context.report'] == 1
    ext.set_feature('context', False, persist=False)
    assert ext._hook(event()) == CONTINUE and len(client.calls) == 1
    assert ext.audit.explanations()[-1] == {'sequence': 2, 'op': 'context', 'reason': 'disabled'}
    assert ext._hook({'kind': 'on_message_complete', 'message': 'older host', 'data': None}) == CONTINUE
    ext.deactivate()
    assert ext.features['context'] is False
    assert ext._hook(event()) == CONTINUE and len(client.calls) == 1


def test_session_start_inject_mentions_advisory_boundary():
    ext = Extension()
    text = ext._hook({'kind': 'on_session_start'})['content']
    assert 'context pressure' in text and 'advisory' in text and 'context_checkpoint' in text


def test_manifest_declares_hook_flag_and_command():
    manifest = json.loads((Path(__file__).resolve().parents[1] / '.synaps-plugin' / 'plugin.json').read_text())
    assert manifest['version'] == '0.9.0'
    assert {'hook': 'on_message_complete'} in manifest['extension']['hooks']
    entry = next(c for c in manifest['extension']['config'] if c['key'] == 'context')
    assert entry['type'] == 'bool' and entry['default'] is True
    assert 'context' in manifest['commands'][0]['subcommands']
    assert 'privacy.llm_content' in manifest['extension']['permissions']
    assert 'session.lifecycle' in manifest['extension']['permissions']
    assert context.KIND == 'on_message_complete'
