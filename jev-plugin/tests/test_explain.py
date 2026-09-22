"""Offline bounded diagnostics; no raw payload, credential discovery or transport."""
import json
from pathlib import Path
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions'))
from jev.audit import Audit, GLOSS, OPS, classify_choice
from jev.client import DecisionClient, JevError
from jev.policy import BudgetPolicy, PolicyDenied
from jev import compress, discovery, evidence, reports, router, tools, triage, verify
from test_features_protocol import OfflineHost, BOOTSTRAP

SECRET = 'SECRET-payload-model-id-session-error'


def reasons(audit):
    rows = audit.explanations()
    assert SECRET not in json.dumps(rows)
    assert all(set(r) == {'sequence', 'op', 'reason'} and r['op'] in OPS and r['reason'] in GLOSS for r in rows)
    return [r['reason'] for r in rows]


def test_ring_clear_is_not_accounting_reset(tmp_path):
    audit = Audit(str(tmp_path / 'must-not-exist'))
    policy = BudgetPolicy()
    client = DecisionClient('synthetic', policy=policy, diagnostic=audit.explain)
    audit.bump('existing.counter')
    before = (dict(audit.counters), client.stats.snapshot(), policy.snapshot())
    for i in range(100):
        audit.explain('diagnose', 'review')
    for op, reason in [(SECRET, 'review'), ('diagnose', SECRET), ([], {}), ('diagnose', 'x' * 100000)]:
        audit.explain(op, reason)
    assert len(audit.explanations()) == 64
    assert audit.explanations()[0]['sequence'] == 37
    copy = audit.explanations(); copy[0]['reason'] = SECRET
    assert reasons(audit) == ['review'] * 64
    audit.clear_explanations()
    assert audit.explanations() == []
    assert before == (audit.counters, client.stats.snapshot(), policy.snapshot())
    audit.explain('diagnose', 'local')
    assert audit.explanations()[0]['sequence'] == 101
    assert not audit.path.exists()


@pytest.mark.parametrize('answer,expected', [
    ({'type': 'choice', 'choice': 'yes', 'confidence': .37, 'probabilities': {'yes': .37, 'unknown': .63}}, 'lowconfidence'),
    ({'choice': 'unknown', 'confidence': .9}, 'modelabstention'),
    ({'choice': SECRET, 'confidence': .9}, 'invalidresponse'),
    ({'choice': 'yes', 'confidence': True}, 'invalidresponse'),
    ({'choice': 'yes', 'confidence': .37, 'type': 'score'}, 'invalidresponse'),
    ({'choice': 'yes', 'confidence': .37, 'probabilities': {SECRET: .2}}, 'invalidresponse'),
    ({'choice': 'yes', 'confidence': .9, 'prose': SECRET}, 'invalidresponse'),
    (None, 'invalidresponse'),
])
def test_classification(answer, expected):
    assert classify_choice(answer, {'yes': '', 'unknown': ''}) == expected


@pytest.mark.parametrize('module', [verify, evidence])
@pytest.mark.parametrize('kind,expected', [('low', 'lowconfidence'), ('unknown', 'modelabstention'), ('invalid', 'invalidresponse')])
def test_existing_validator_diagnostics(module, kind, expected):
    choice = next(iter(module.CHOICES)) if kind != 'unknown' else 'unknown'
    answer = {'type': 'choice', 'choice': choice, 'confidence': .37 if kind == 'low' else .9}
    if kind == 'invalid': answer['type'] = SECRET
    assert classify_choice(answer, module.CHOICES, validator=lambda a: module._choice(a, threshold=0)) == expected
    if kind != 'unknown': assert module._choice(answer) is None


def client_for(audit, answer):
    client = DecisionClient('synthetic-not-a-real-key', diagnostic=audit.explain)
    client._bounded_post = lambda *_: {'answers': answer, 'usage': {'input_tokens': 1}}
    return client


@pytest.mark.parametrize('choice,confidence,expected', [('reviewer', .37, 'lowconfidence'), ('unknown', .9, 'modelabstention'), (SECRET, .9, 'invalidresponse')])
def test_router_lifecycle(choice, confidence, expected):
    a = Audit(None); r = router.Router()
    c = client_for(a, {'role': {'type': 'choice', 'choice': choice, 'confidence': confidence}})
    params = {'tool_name': 'subagent_start', 'session_id': SECRET,
              'tool_input': {'task': SECRET, 'write_policy': {'mode': 'read_only'}}}
    cfg = router.RouterConfig({})
    assert r.handle(params, c, cfg, a, lambda *_: None) == {'action': 'continue'}
    assert expected in reasons(a)
    r.handle(params, c, cfg, a, lambda *_: None)
    assert ('cache' in reasons(a)) == (expected != 'invalidresponse')
    r.handle(params, c, cfg, a, lambda *_: None, enabled=False)
    assert reasons(a)[-1] == 'disabled'
    r.handle(params, None, cfg, a, lambda *_: None)
    assert reasons(a)[-1] == 'nokey'
    params['tool_input']['role'] = 'reviewer'
    r.handle(params, c, cfg, a, lambda *_: None)
    assert reasons(a)[-1] == 'explicitfields'


def test_client_errors_and_budget_no_duplicate():
    a = Audit(None); c = client_for(a, {})
    def fail(*_): raise RuntimeError(SECRET)
    c._bounded_post = fail
    r = router.Router(); params = {'tool_name': 'subagent_start', 'tool_input': {'task': SECRET}}
    r.handle(params, c, router.RouterConfig({}), a, lambda *_: None)
    assert reasons(a) == ['transporterror']
    c._bounded_post = lambda *_: []
    r.handle(params, c, router.RouterConfig({}), a, lambda *_: None)
    assert reasons(a)[-1] == 'invalidresponse'
    c.policy = BudgetPolicy(); c.policy.configure({'budget_enabled': True, 'budget_calls': 1})
    c.policy.ledger().wire_attempts = 1
    with pytest.raises(PolicyDenied): c.decide({}, {}, op='select')
    assert reasons(a)[-1] == 'budget_calls'


def test_reports_partial_sibling_retains_advice():
    a = Audit(None)
    c = client_for(a, {'verification': {'choice': 'gap', 'confidence': .9},
                       'concern': {'choice': 'none_reported', 'confidence': .37}})
    params = {'tool_name': 'subagent_collect', 'session_id': SECRET, 'tool_input': {'handle_id': SECRET},
              'tool_output': json.dumps({'handle_id': SECRET, 'status': 'completed', 'output': SECRET, 'model': SECRET, 'terminal_cause': None, 'authorization': {}, 'collected': True})}
    # Fixture follows the same bounded collect schema as production.
    result = reports.Reports().handle(params, c, True, a)
    assert result['action'] == 'replace'
    assert reasons(a) == ['accepted', 'lowconfidence']


def test_select_triage_and_compression():
    a = Audit(None)
    c = client_for(a, {'0': {'choice': 'a', 'confidence': .37}})
    tools.call_select({'context': SECRET, 'decisions': [{'instruction': SECRET, 'candidates': [
        {'id': 'a', 'description': SECRET}, {'id': 'b', 'description': SECRET}]}]}, c, a)
    assert 'lowconfidence' in reasons(a)
    c = client_for(a, {'category': {'choice': 'unknown', 'confidence': .9}})
    triage.Triage().handle({'tool_name': 'bash', 'tool_output': 'Command failed (exit 1):\n'+SECRET}, c, True, a)
    assert reasons(a)[-1] == 'modelabstention'
    compress.handle({'tool_name': 'bash', 'tool_output': 'nothing'}, '', c, compress.CompressConfig({}), a, lambda *_: None)
    assert reasons(a)[-1] == 'noeconomiccandidate'


def test_real_framed_no_key_command(tmp_path):
    # Discovery is mocked in the child, not just the parent. No real keys/config.
    bootstrap = BOOTSTRAP.replace('jev_ext.main()', '''jev_ext.keys.discover = lambda: (None, "none")
original_initialize = jev_ext.Extension.initialize
def initialize(self, params):
    result = original_initialize(self, params)
    self.audit.explain("diagnose", "review")
    return result
jev_ext.Extension.initialize = initialize
jev_ext.main()''')
    with patch('test_features_protocol.BOOTSTRAP', bootstrap):
        h = OfflineHost(tmp_path, {'api_key': ''})
    try:
        _, events = h.command('explain')
        table = next(e for e in events if e['kind'] == 'table')
        assert table['rows'][0][1:3] == ['diagnose', 'review']
        _, events = h.command('explain', 'clear')
        assert next(e for e in events if e['kind'] == 'table')['rows'] == []
        result = h.request('tool.call', {'name': 'jev_status', 'input': {}})
        snap = json.loads(result['result']['content'])
        assert snap['calls'] == 0 and snap['explanations'] == []
        assert not snap['active']
        assert SECRET not in json.dumps(events)
    finally:
        h.close()

@pytest.mark.parametrize('choice,confidence,expected', [('compact', .37, 'lowconfidence'), ('keep', .9, 'modelabstention'), ('compact', True, 'invalidresponse')])
def test_compress_diagnostics_do_not_fold(choice, confidence, expected):
    a = Audit(None)
    c = client_for(a, {'format': {'type': 'choice', 'choice': choice, 'confidence': confidence}})
    output = ('synthetic repeated line\n' * 1000)
    result = compress.handle({'tool_name': 'bash', 'tool_output': output}, '', c, compress.CompressConfig({}), a, lambda *_: None)
    assert result == {'action': 'continue'}
    assert reasons(a) == [expected]


def test_discovery_and_explicit_decide():
    a = Audit(None); d = discovery.Discovery()
    c = client_for(a, {'recommendation': {'type': 'choice', 'choice': 'option_0', 'confidence': .37}})
    params = {'tool_name': 'search_skills', 'session_id': SECRET, 'tool_input': {'query': 'specific task'},
              'tool_output': json.dumps({'truncated': False, 'skills': [
                  {'id': SECRET+'a', 'name': 'one', 'description': 'first task'},
                  {'id': SECRET+'b', 'name': 'two', 'description': 'second task'}]})}
    assert d.handle(params, c, True, a) == {'action': 'continue'}
    assert reasons(a) == ['lowconfidence']
    d.handle(params, c, True, a)
    assert reasons(a)[-1] == 'cache'
    c = client_for(a, {'q': {'type': 'choice', 'choice': 'unknown', 'confidence': .9}})
    tools.call_decide({'state': SECRET, 'questions': {'q': {'type': 'choice', 'instructions': 'pick', 'criteria': {'unknown': 'none', 'a': 'first'}}}}, c, a)
    assert reasons(a)[-1] == 'modelabstention'


def test_status_secret_free_diagnostic_snapshot():
    a = Audit(None); c = client_for(a, {})
    a.explain('diagnose', SECRET)
    a.explain('diagnose', 'review')
    snap = json.loads(tools.call_status(c, a, {}, policy=BudgetPolicy(), compress_mode='deterministic')['content'])
    assert snap['explanations'] == a.explanations()
    assert SECRET not in json.dumps(snap)
    assert 'budget' in snap and snap['compress_mode'] == 'deterministic'
