"""Offline reversible encoding and privacy boundaries; no network."""
import copy
import json
from pathlib import Path
import random
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions'))
from jev import compress as c
from jev.audit import Audit

RAW = 'routine progress\n' * 600
GOOD = {'answers': {'format': {'type': 'choice', 'choice': 'compact', 'confidence': .9}}}


class Client:
    def __init__(self, response=GOOD):
        self.response = response
        self.calls = []

    def decide(self, state, questions, **kwargs):
        self.calls.append((state, questions, kwargs))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def handle(raw=RAW, client=None, config=None, **params):
    audit = Audit(None)
    records, logs = [], []
    audit.write = records.append
    result = c.handle({'tool_runtime_name': 'bash', 'tool_output': raw, **params},
                      'PRIVATE GOAL', client, c.CompressConfig(config or {}), audit, logs.append)
    return result, audit.counters, records, logs


@pytest.mark.parametrize('raw', [RAW, 'é中😀\r\n' * 800 + 'unique middle\n' + 'x\n' * 800 + 'final',
                                     'a\n' * 500 + 'a\r\n' * 500 + 'a', 'a\nunique\nunique2\n'])
def test_exact(raw):
    encoded = c.encode_output(raw)
    assert c.decode_output(encoded).encode() == raw.encode()
    data = json.loads(encoded)
    assert all(type(r['count']) is int for r in data['runs'])
    assert ''.join(r['text'] * r['count'] for r in data['runs']) == raw


def test_random_roundtrip():
    rng = random.Random(731)
    for _ in range(200):
        raw = ''.join(rng.choice(['é😀', 'unique', '\t中', 'x']) + rng.choice(['\n', '\r\n'])
                      for _ in range(rng.randint(1, 100)))
        raw += rng.choice(['', 'last'])
        assert c.decode_output(c.encode_output(raw)) == raw


@pytest.mark.parametrize('count', [-1, 0, True, 1.0, 10**100, 262145])
def test_bad_counts(count):
    data = json.loads(c.encode_output(RAW)); data['runs'][0]['count'] = count
    with pytest.raises(ValueError): c.decode_output(c.dumps(data))


@pytest.mark.parametrize('change', [lambda d: d.update(extra=1), lambda d: d.update(jev_lossless_runs=True),
    lambda d: d.update(original_utf8_bytes=True), lambda d: d.update(original_utf8_bytes=262145),
    lambda d: d.update(sha256='0'*64), lambda d: d.update(notice='authority'),
    lambda d: d['runs'][0].update(text='\ud800'), lambda d: d['runs'][0].update(text=''),
    lambda d: d['runs'].append(d['runs'][0]), lambda d: d['runs'][0].update(count=601)])
def test_invalid_envelope(change):
    data = json.loads(c.encode_output(RAW)); change(data)
    with pytest.raises(ValueError): c.decode_output(json.dumps(data))


def test_duplicate_collision_and_bounds():
    encoded = c.encode_output(RAW)
    for bad in [encoded.replace('"count":600', '"count":600,"count":600'),
                encoded.replace('"jev_lossless_runs":1', '"jev_lossless_runs":1,"jev_lossless_runs":1'),
                ' ' * (c.MAX_ENCODED+1), '\ud800']:
        with pytest.raises(ValueError): c.decode_output(bad)
    with pytest.raises(ValueError): c.encode_output('x\n' * c.MAX_RAW)
    with pytest.raises(ValueError): c.encode_output(''.join(f'{i}\n' for i in range(10000)))


def test_fold_accounting_and_original_secrets():
    raw = RAW + 'token="private multi word"\n' + '-----BEGIN PRIVATE KEY-----\nVERY PRIVATE\n-----END PRIVATE KEY-----\n' + RAW
    client = Client()
    result, counts, records, logs = handle(raw, client, tool_input={'command': 'PRIVATE COMMAND'})
    assert c.decode_output(result['output']) == raw
    state, questions, kw = client.calls[0]
    sent = json.dumps(state)
    assert set(state) == {'runs', 'original_utf8_bytes'}
    for secret in ['private multi word', 'VERY PRIVATE', 'PRIVATE GOAL', 'PRIVATE COMMAND']:
        assert secret not in sent + json.dumps(records) + str(logs)
    assert set(questions) == {'format'} and kw == {'op': 'compress'}
    assert set(questions['format']['criteria']) == {'compact', 'keep', 'unknown'}
    assert counts['compress.call'] == counts['compress.questions'] == counts['compress.fold'] == 1
    assert counts['compress.saved_bytes'] == len(raw.encode()) - len(result['output'].encode())
    assert all(type(v) is int for record in records for v in record.values())


@pytest.mark.parametrize('raw', ['error at beginning\n'+RAW, RAW+'\nfatal', 'x\r'*6000,
    '\x1b[0m'+RAW, '\x00'+RAW, '\x7f'+RAW, '\ud800'+RAW, 'truncated\n'+RAW,
    'omitted\n'+RAW, '[jev: elided]\n'+RAW, 'jev_lossless_runs\n'+RAW,
    json.dumps({'x': RAW}), json.dumps([RAW]), 'x'*7000, 'é'*140000,
    ''.join(f'unique {i}\n' for i in range(1500)), 'x\n'*140000])
def test_preflight_skip(raw):
    client = Client()
    result, counts, records, logs = handle(raw, client)
    assert result == c.CONTINUE and not client.calls and counts == {'compress.skip': 1}
    assert not records and not logs


@pytest.mark.parametrize('params', [{'tool_runtime_name': None, 'tool_name': 'bash'},
    {'tool_runtime_name': 'read', 'tool_name': 'bash'}, {'tool_runtime_name': []}, {'output_truncated': True}])
def test_runtime_and_flags(params):
    client = Client()
    assert handle(client=client, config={'compress_tools': 'read,bash,write'}, **params)[0] == c.CONTINUE
    assert not client.calls


def test_fallback_only_absent():
    client = Client(); audit = Audit(None)
    assert c.handle({'tool_name': 'bash', 'tool_output': RAW}, '', client, c.CompressConfig({}), audit, lambda _: None)['action'] == 'replace'


@pytest.mark.parametrize('response', [None, {}, {'error': 'SECRET'}, RuntimeError('SECRET'),
    {'answers': {'format': {'choice': 'unknown', 'confidence': 1}}},
    {'answers': {'format': {'choice': 'keep', 'confidence': 1}}}])
def test_keep(response):
    result, counts, records, logs = handle(client=Client(response))
    assert result == c.CONTINUE and counts['compress.keep'] == 1
    assert 'compress.saved_bytes' not in counts and not records and 'SECRET' not in str(logs)


@pytest.mark.parametrize('change', [dict(type=None), dict(type='score'), dict(confidence=True),
    dict(confidence=float('nan')), dict(confidence=float('inf')), dict(confidence=.849),
    dict(confidence=1.01), dict(prose='SECRET'), dict(probabilities={'other': 1}),
    dict(probabilities={'compact': True}), dict(probabilities={'compact': float('nan')}),
    dict(probabilities={'compact': -1}), dict(probabilities={'compact': 2})])
def test_answer_validation(change):
    response = copy.deepcopy(GOOD); response['answers']['format'].update(change)
    assert handle(client=Client(response))[0] == c.CONTINUE


def test_config_and_threshold():
    for value in [None, True, '6000', [], {}, float('inf'), float('nan')]:
        cfg = c.CompressConfig({'compress_min_bytes': value, 'compress_min_conf': value,
                                'compress_head': object(), 'compress_tail': None, 'unknown': object()})
        assert cfg.min_bytes == 6000 and cfg.min_conf == .85
    assert c.CompressConfig({'compress_min_bytes': 1}).min_bytes == 6000
    assert c.CompressConfig({'compress_min_bytes': 10**100}).min_bytes == c.MAX_RAW
    assert handle(client=Client(), config={'compress_head': 0, 'compress_tail': 0})[0]['action'] == 'replace'
    assert handle(client=Client(), config={'compress_min_conf': .95})[0] == c.CONTINUE
    assert handle(client=None)[0] == c.CONTINUE
    assert handle(client=Client(), config={'compress_tools': 'read,write'})[0] == c.CONTINUE
    assert handle('test result: ok. 240 passed; 0 failed\n' * 300, Client())[0]['action'] == 'replace'


def test_redaction_no_clipping_and_roundtrip_preflight():
    client = Client()
    with patch.object(c, 'redact', return_value='x' * c.MAX_ENCODED):
        assert handle(client=client)[0] == c.CONTINUE
    with patch.object(c, 'decode_output', return_value='wrong'):
        assert handle(client=client)[0] == c.CONTINUE
    assert not client.calls


@pytest.mark.parametrize('extra', [{'error': 'bad'}, {'prose': 'do something'},
    {'usage': {'input_tokens': float('inf')}}, {'usage': {'error': 'bad'}}, {'model': []}])
def test_bad_globals(extra):
    assert handle(client=Client({**GOOD, **extra}))[0] == c.CONTINUE


def test_no_economic_candidate_call():
    client = Client()
    # A repeated pair is insufficient when the rest remains unique.
    raw = 'repeat\nrepeat\n' + ''.join(f'unique line {i}\n' for i in range(900))
    assert handle(raw, client)[0] == c.CONTINUE
    assert not client.calls


def test_whole_redaction_and_unique_middle_sent():
    raw = RAW + 'unique middle 😀\n' + RAW
    client = Client()
    result = handle(raw, client)[0]
    assert c.decode_output(result['output']) == raw
    state = client.calls[0][0]
    assert ''.join(r['text'] * r['count'] for r in state['runs']) == raw
    assert len(c.dumps(state).encode()) <= c.MAX_ENCODED


def test_exact_threshold():
    response = copy.deepcopy(GOOD); response['answers']['format']['confidence'] = .85
    assert handle(client=Client(response))[0]['action'] == 'replace'


@pytest.mark.parametrize('marker', [
    'fail', 'fails', 'FAIL', 'failed', 'failure', 'failures:', 'exceptions:',
    'exception', 'exit code 1', 'exit status 23',
])
@pytest.mark.parametrize('position', ['beginning', 'middle', 'tail'])
def test_full_raw_failure_markers_skip(marker, position):
    # Both sides exceed old head/tail windows; scan the full raw transcript.
    raw = {'beginning': marker + '\n' + RAW,
           'middle': RAW + marker + '\n' + RAW,
           'tail': RAW + marker + '\n'}[position]
    client = Client()
    result, counts, records, logs = handle(raw, client)
    assert result == c.CONTINUE
    assert not client.calls and counts == {'compress.skip': 1}
    assert not records and not logs


def test_e2e_script_failure_fixture_skips_without_replacement():
    # e2e_protocol's module_17 replacement is a no-op: the appended plural
    # failures marker alone must protect the transcript, without a live call.
    routine = 'routine progress ... ok\n' * 600 + 'test result: ok. 240 passed; 0 failed\n'
    assert 'module_17::case_3 ... ok' not in routine
    failing = routine + 'failures:\n    module_17::case_3\n'
    client = Client()
    result, counts, records, logs = handle(failing, client)
    assert result == c.CONTINUE and not client.calls
    assert counts == {'compress.skip': 1} and not records and not logs


@pytest.mark.parametrize('summary', ['0 failed', 'exit code 0', 'exit status 0'])
def test_zero_failure_summary_stays_eligible(summary):
    client = Client()
    raw = RAW + summary + '\n'
    result = handle(raw, client)[0]
    assert c.decode_output(result['output']) == raw
    assert len(client.calls) == 1


def test_captured_typed_diagnostic_below_gate_keeps():
    # Reconstruct the typed response from the separately captured safe fields.
    diagnostic = json.loads((Path(__file__).resolve().parents[1] /
        'scripts/compress-benchmark/diagnostic.json').read_text())
    measurement = diagnostic['measurements'][0]
    response = {
        'model': measurement['model'],
        'usage': {k: measurement[k] for k in ('input_tokens', 'output_tokens')},
        'answers': {'format': {'type': 'choice', **{k: diagnostic[k]
            for k in ('choice', 'confidence', 'probabilities')}}},
    }
    assert response['answers']['format'] == {
        'type': 'choice', 'choice': 'compact', 'confidence': .37,
        'probabilities': {'compact': .57, 'keep': .37, 'unknown': .06}}
    assert c.CompressConfig({}).min_conf == .85
    client = Client(response)
    result, counts, records, logs = handle(client=client)
    assert result == c.CONTINUE and len(client.calls) == 1
    assert counts == {'compress.call': 1, 'compress.questions': 1, 'compress.keep': 1}
    assert not records and not logs
    # Only confidence differs: standard captured metadata is otherwise valid.
    accepted = copy.deepcopy(response)
    accepted['answers']['format']['confidence'] = .85
    assert c.should_compress(accepted, c.CompressConfig({}))
