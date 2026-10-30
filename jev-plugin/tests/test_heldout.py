"""Hermetic frozen-split protocol checks, never calibration evidence."""
import copy
import importlib.util
import json
from pathlib import Path
import socket
from types import SimpleNamespace
import pytest

spec = importlib.util.spec_from_file_location('heldout', Path(__file__).parents[1]/'scripts/evaluate_heldout.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def fail(*args, **kwargs):
        raise AssertionError('network forbidden')
    monkeypatch.setattr(socket, 'socket', fail)


def test_frozen_splits_and_offline(monkeypatch):
    cases = h.load_dataset()
    assert len(cases) == 24
    def fail(*args, **kwargs):
        raise AssertionError('key discovery/client construction forbidden')
    monkeypatch.setattr(h, 'os', SimpleNamespace(environ=type('NoEnv', (), {'get': fail})()))
    monkeypatch.setattr(h, 'BudgetClient', fail)
    a = h.evaluate(cases)
    assert a == h.evaluate(cases)
    assert a['measurement'] is None and a['complete']
    assert h.evaluate(cases, 'heldout')['complete']
    assert {c['input_sha256'] for c in cases if c['split']=='dev'}.isdisjoint(
        c['input_sha256'] for c in cases if c['split']=='heldout')
    assert all(r['structural_ok'] for r in a['cases'])


def test_tamper_before_key(monkeypatch, tmp_path):
    p = tmp_path/'tampered.json'
    p.write_bytes((h.ROOT/'jev-evaluation-v1.json').read_bytes()+b' ')
    with pytest.raises(ValueError):
        h.load_dataset(p)
    loader = h.load_dataset
    monkeypatch.setattr(h, 'load_dataset', lambda: loader(p))
    class NoEnv:
        def get(self, *args):
            pytest.fail('key discovery before validation')
    monkeypatch.setattr(h, 'os', SimpleNamespace(environ=NoEnv()))
    with pytest.raises(SystemExit) as exc:
        h.main(['--live'])
    assert exc.value.code == 2


def test_labels_required_and_source_stay_local():
    class Spy(h.StructuralClient):
        def decide(self, state, questions, *, op):
            text = json.dumps(state)
            assert 'LOCAL_SENTINEL' not in text
            assert 'expected' not in text
            assert 'example.invalid' not in text
            assert 'mandatory' not in text
            return super().decide(state, questions, op=op)
    for c in copy.deepcopy(h.load_dataset()):
        for group in ('candidates','checks'):
            for item in c['payload'].get(group, []):
                if item['required']:
                    item['summary' if group=='candidates' else 'description']='LOCAL_SENTINEL'
        assert h.observe(c, Spy())['structural_ok']


def test_metrics():
    m = h.metrics([(True,True),(False,True),(True,None),(False,False),(None,None)])
    assert (m['tp'],m['fp'],m['fn']) == (1,1,1)
    assert m['precision'] == m['recall'] == .5
    assert m['coverage'] == .6 and m['abstentions']==2 and m['unknown_labels']==1
    assert h.wilson(0,0) is None
    assert h.metrics([])['precision'] is None
    assert h.wilson(1,2) == m['precision_wilson95']
    assert all(0<=v<=1 for v in h.wilson(3,3))


@pytest.mark.parametrize('bad',[float('nan'),float('inf'),-.1,1.1,True,'0.9'])
def test_invalid_confidence_probability(bad):
    class Bad(h.StructuralClient):
        def decide(self, state, questions, *, op):
            out = super().decide(state, questions, op=op)
            for a in out['answers'].values():
                a['probabilities']={a['choice']:bad}
            return out
    for c in h.load_dataset()[:4]:
        obs=h.observe(c,Bad())
        assert all(r['choice'] is None for r in obs['raw'])


def test_error_abstention_sanitization_and_partial():
    class Broken(h.StructuralClient):
        def decide(self,*args,**kwargs):
            raise RuntimeError('SECRET')
    report=h.evaluate(h.load_dataset(),client=Broken(),max_calls=1)
    assert not report['complete'] and len(report['unexecuted_ids'])==11
    assert report['measurement']['evidence']['errors']==1
    assert report['measurement']['verification']['executed_cases']==0
    assert report['measurement']['evidence']['input_tokens'] is None
    assert 'SECRET' not in json.dumps(report)
    class Unknown(h.StructuralClient):
        def decide(self,state,questions,**kw):
            return dict(model='SECRET', answers={q:dict(type='choice',choice='unknown',confidence=.9) for q in questions})
    report=h.evaluate(h.load_dataset(),client=Unknown(),max_calls=4)
    assert all(not r['error'] for r in report['cases'])
    assert all(r['actual_model'] is None for r in report['cases'])
    assert 'SECRET' not in json.dumps(report)


def test_wire_budget_retry_and_usage(monkeypatch):
    from jev.client import _Retryable
    calls=[]
    def post(*a,**kw):
        calls.append(1)
        raise _Retryable('synthetic', 0)
    monkeypatch.setattr(h.DecisionClient,'_post',post)
    client=h.BudgetClient('fake-public-test-key',1)
    for _ in range(2):
        with pytest.raises(h.JevError):
            client.decide({}, {}, op='test')
    assert len(calls)==client.wires==1
    assert client.stats.retries==0 and client.timeout_s==3
    assert client.stats.snapshot()['input_tokens'] is None
    for n in (0,13,True):
        with pytest.raises(ValueError):
            h.BudgetClient('fake',n)


def test_output_exclusive(tmp_path,capsys):
    path=tmp_path/'summary.json'
    assert h.main(['--output',str(path)])==0
    assert json.loads(path.read_text())['measurement'] is None
    with pytest.raises(FileExistsError):
        h.main(['--output',str(path)])
    with pytest.raises(SystemExit):
        h.main(['--model','unknown'])


def test_raw_agreement_separate_from_gate():
    class Low(h.StructuralClient):
        def decide(self,state,questions,**kw):
            out=super().decide(state,questions,**kw)
            for a in out['answers'].values():
                a['confidence']=.5
            return out
    c=h.load_dataset()[0]
    o=h.observe(c,Low())
    s=h.summarize('evidence',[(c,o)])
    assert s['accepted_priorities']['coverage']==0
    assert s['raw_valid_count']==3
    assert s['confidence_bins_decision_agreement'][1]['count']==3
    assert s['brier'] is None


@pytest.mark.parametrize('field,value', [('confidence',float('nan')),('confidence',1.1),
    ('confidence',-.1),('confidence',True),('type','noul'),('choice','SECRET')])
def test_malformed_raw_not_agreement(field,value):
    class Invalid(h.StructuralClient):
        def decide(self,state,questions,**kw):
            out=super().decide(state,questions,**kw)
            for a in out['answers'].values():
                a[field]=value
            return out
    for c in h.load_dataset()[:4]:
        o=h.observe(c,Invalid())
        assert all(r['agreement'] is None for r in o['raw'])


def test_no_wire_for_disabled_or_nokey(monkeypatch):
    def forbidden(*args,**kwargs):
        pytest.fail('unexpected wire')
    monkeypatch.setattr(h.DecisionClient,'_post',forbidden)
    client=h.BudgetClient('fake-test-key',1)
    for c in h.load_dataset():
        assert h.observe(c,client,False)['calls']==0
        assert h.observe(c,None)['calls']==0
    assert client.wires==0


def test_known_usage_and_missing_answers():
    class Usage(h.StructuralClient):
        def decide(self,*args,**kw):
            return dict(answers={}, usage={'input_tokens':100},model=h.MODEL)
    c=h.load_dataset()[0]
    o=h.observe(c,Usage())
    assert o['input_tokens']==100 and o['actual_model']==h.MODEL
    s=h.summarize('evidence',[(c,o)])
    assert s['raw_valid_count']==0 and s['raw_unknown_count']==3
    assert s['cost_usd']==100*h.PRICE_PER_MTOK_INPUT/1e6
    assert s['accepted_priorities']['coverage']==0


def test_high_confidence_flag_set():
    class Flags(h.StructuralClient):
        def decide(self,state,questions,**kw):
            assert set(questions)=={'verification','concern'}
            return dict(answers={q:dict(type='choice',choice=c,confidence=.8)
                                 for q,c in [('verification','gap'),('concern','contradiction')]})
    c=next(c for c in h.load_dataset() if c['id']=='dev-reports-2')
    o=h.observe(c,Flags())
    assert {k for k,v in o['actual'].items() if v}=={'verification_gap','conflicting_claims'}
    s=h.summarize('reports',[(c,o)])
    assert s['accepted_priorities']['tp']==2
    assert s['accepted_priorities']['fp']==0
    assert s['confidence_bins_decision_agreement'][2]['count']==2


@pytest.mark.parametrize('corruption', ['field', 'extra', 'note', 'flag', 'advisory_extra', 'action_extra', 'mutate', 'type'])
def test_reports_corrupt_hook_rejected(monkeypatch, corruption):
    case = next(c for c in h.load_dataset() if c['id'] == 'dev-reports-2')
    def corrupt(self, p, *args):
        data = json.loads(p['tool_output'])
        data['jev_advisory'] = {'flags': ['verification_gap'], 'note': h.reports.NOTE}
        if corruption == 'type': data['collected'] = int(data['collected'])
        if corruption == 'field': data['authorization'] = 'corrupted'
        if corruption == 'extra': data['extra'] = True
        if corruption == 'note': data['jev_advisory']['note'] = 'authority'
        if corruption == 'flag': data['jev_advisory']['flags'] = ['approved']
        if corruption == 'advisory_extra': data['jev_advisory']['executed'] = True
        out = {'action': 'replace', 'output': json.dumps(data)}
        if corruption == 'action_extra': out['execute'] = True
        if corruption == 'mutate': p['tool_output'] = '{}'
        return out
    monkeypatch.setattr(h.reports.Reports, 'handle', corrupt)
    with pytest.raises(ValueError): h.observe(case, h.StructuralClient())


@pytest.mark.parametrize('field,value', [('required', True), ('kind', 'check'), ('id', 'wrong')])
def test_diagnosis_corrupt_metadata_rejected(monkeypatch, field, value):
    case = next(c for c in h.load_dataset() if c['feature'] == 'diagnosis')
    hook = h.diagnose.call_diagnose
    def corrupt(*args, **kwargs):
        result = hook(*args, **kwargs)
        data = json.loads(result['content'])
        data['references'][0][field] = value
        return {**result, 'content': json.dumps(data)}
    monkeypatch.setattr(h.diagnose, 'call_diagnose', corrupt)
    with pytest.raises(ValueError): h.observe(case, h.StructuralClient())


def test_verification_required_not_optional(monkeypatch):
    case = next(c for c in h.load_dataset() if c['feature'] == 'verification')
    hook = h.verify.call_verify
    def corrupt(*args, **kwargs):
        result = hook(*args, **kwargs)
        data = json.loads(result['content'])
        data['decisions'][0]['id'] = data['required_ids'][0]
        return {**result, 'content': json.dumps(data)}
    monkeypatch.setattr(h.verify, 'call_verify', corrupt)
    with pytest.raises(ValueError): h.observe(case, h.StructuralClient())


@pytest.mark.parametrize('feature', ['evidence', 'verification', 'reports', 'diagnosis_hypothesis', 'diagnosis_check'])
def test_threshold_drift_rejected_before_live(monkeypatch, feature):
    monkeypatch.setitem(h.THRESHOLDS, feature, .123)
    with pytest.raises(ValueError): h.load_dataset()
    monkeypatch.setattr(h, 'os', SimpleNamespace(environ=None))
    with pytest.raises(SystemExit) as exc: h.main(['--live'])
    assert exc.value.code == 2


@pytest.mark.parametrize('metadata', [{'extra': 'x' * 4097}, {'extra': float('nan')}, {'extra': '\ud800'}])
def test_response_metadata_bounds(metadata):
    class Metadata(h.StructuralClient):
        def decide(self, *args, **kwargs):
            return {**super().decide(*args, **kwargs), **metadata}
    for case in h.load_dataset():
        obs = h.observe(case, Metadata())
        assert all(row['choice'] is None for row in obs['raw'])


def test_invalid_labels_and_extra_keys_without_editing_frozen_data(monkeypatch):
    original = h.json.loads
    for corruption in ('label', 'key'):
        def loads(raw, **kwargs):
            data = original(raw, **kwargs)
            if 'cases' in data:
                if corruption == 'label':
                    key = next(iter(data['cases'][0]['expected']))
                    data['cases'][0]['expected'][key] = 'not-a-class'
                else:
                    data['cases'][0]['unexpected'] = True
            return data
        with monkeypatch.context() as m:
            m.setattr(h.json, 'loads', loads)
            with pytest.raises(ValueError): h.load_dataset()
