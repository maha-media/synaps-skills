"""Sequential offline adapter fixtures: synthetic metrics are not LLM measurements."""
import importlib.util
import json
import os
from pathlib import Path
import sys

import pytest

SPEC = importlib.util.spec_from_file_location("workflow_compare", Path(__file__).parents[1] / "scripts/workflow_compare.py")
w = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(w)

ADAPTER = r'''
import argparse, hashlib, json, os, pathlib, time
p = argparse.ArgumentParser()
for name in ('task', 'workspace', 'result', 'mode'):
    p.add_argument('--' + name)
p.add_argument('--behavior', default='good')
a = p.parse_args()
t = json.loads(pathlib.Path(a.task).read_text())
ws = pathlib.Path(a.workspace)
assert json.loads((ws / 'solution.json').read_text()) == {'outputs': []}
assert json.loads((ws / 'request.json').read_text()) == t['task']
def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
assert digest({p.name: p.read_text() for p in ws.iterdir()}) == t['result_template']['input_sha']
assert digest(t['task']) == t['result_template']['task_sha']
c = t['mode_config']
assert not c['guard'] and not c['diagnosis']
assert c['router'] == c['triage'] == (a.mode == 'selected')
assert c['compress'] == (a.mode == 'deterministic')
assert set(os.environ) <= {'PATH', 'LANG', 'HOME', 'SYNAPS_BASE_DIR', 'LC_CTYPE', 'PUBLIC_TEST_TOKEN'}
assert os.environ['HOME'] != os.environ['SYNAPS_BASE_DIR']
assert not list(pathlib.Path(os.environ['HOME']).iterdir())
pathlib.Path(os.environ['HOME'], 'marker').write_text('fresh')
print('SECRET_DO_NOT_CAPTURE')
if a.behavior == 'timeout': time.sleep(5)
if a.behavior == 'nonzero': raise SystemExit(4)
v = t['task']['vectors']
id = t['task']['task_id']
if id == 'parser': outputs = [s.strip() for s in v]
elif id == 'account-cache': outputs = v
else:
    outputs = []
    for state, events in v:
        for event in events:
            if event == 'Tab': state = (state + 1) % 3
            elif event == 'ShiftTab': state = (state - 1) % 3
            elif event == 'Escape': state = 0
        outputs.append(state)
r = t['result_template']
for group in ('main_model', 'jev'):
    for key in r[group]: r[group][key] = 1
r['verification']['claimed_passed'] = True
if a.behavior == 'wrong': outputs = []
if a.behavior == 'null': r['jev']['cost_usd'] = None
if a.behavior == 'model': r['model'] = 'wrong-model'
if a.behavior == 'digest': r['input_sha'] = 'wrong'
if a.behavior == 'negative': r['jev']['retries'] = -1
if a.behavior == 'extra': r['secret'] = 'SECRET_DO_NOT_CAPTURE'
(ws / 'solution.json').write_text(json.dumps({'outputs': outputs}))
result = pathlib.Path(a.result)
if a.behavior == 'missing': raise SystemExit(0)
if a.behavior == 'symlink':
    result.symlink_to(ws / 'solution.json')
else: result.write_text(json.dumps(r))
if a.behavior == 'solution-link':
    (ws / 'solution.json').unlink()
    (ws / 'solution.json').symlink_to(result)
if a.behavior == 'malformed': result.write_text('{broken')
if a.behavior == 'oversize': result.write_text(' ' * 8193)
'''


@pytest.fixture
def runner(tmp_path):
    path = tmp_path / 'offline_adapter.py'
    path.write_text(ADAPTER)
    return path


def options(runner, behavior='good', extra=()):
    return w.arguments(['--execute', '--runner', sys.executable, '--runner-arg=-I',
                        '--runner-arg', str(runner), '--runner-arg=--behavior',
                        '--runner-arg', behavior, '--model', 'synthetic-fixture', *extra])


def test_default_never_launches_or_discovers(monkeypatch):
    def forbidden(*a, **kw):
        raise AssertionError('execution or environment discovery')
    monkeypatch.setattr(w.subprocess, 'Popen', forbidden)
    monkeypatch.setattr(w.tempfile, 'TemporaryDirectory', forbidden)
    args = w.arguments([])
    from types import SimpleNamespace
    monkeypatch.setattr(w, 'os', SimpleNamespace(environ=None))
    report = w.build_report(args)
    assert len(report['runs']) == 9
    assert all(r['wall_seconds'] is None and r['total_cost_usd'] is None for r in report['runs'])
    assert not report['comparison']['comparable']
    assert all(s['quality']['unknown'] == 3 for s in report['summary'].values())
    assert 'expected' not in json.dumps(report)


def test_nine_fresh_runs_and_totals(runner, monkeypatch):
    monkeypatch.setenv('UNFORWARDED_SECRET', 'SECRET_DO_NOT_CAPTURE')
    report = w.build_report(options(runner))
    assert len(report['runs']) == 9
    assert all(r['status'] == 'completed' and r['grader'] == 'passed' for r in report['runs'])
    for task in w.TASKS:
        rows = [r for r in report['runs'] if r['task_id'] == task['task_id']]
        assert len({r['input_sha'] for r in rows}) == 1
        assert len({r['task_sha'] for r in rows}) == 1
    assert report['comparison']['comparable']
    assert report['comparison']['cost_delta_vs_off_usd'] == {'selected': 0, 'deterministic': 0}
    assert report['summary']['off']['total_cost_usd'] == 6
    assert report['summary']['off']['usage_totals']['jev']['retries'] == 3
    assert 'SECRET_DO_NOT_CAPTURE' not in json.dumps(report)
    report['runs'][0]['input_sha'] = 'different-reset'
    assert not w.summarize(report['runs'])[1]['comparable']


@pytest.mark.parametrize('behavior,status,grader', [
    ('wrong', 'completed', 'failed'), ('null', 'completed', 'passed'),
    ('model', 'invalid_result', 'passed'), ('digest', 'invalid_result', 'passed'),
    ('negative', 'invalid_result', 'passed'), ('extra', 'invalid_result', 'passed'),
    ('missing', 'invalid_result', 'passed'), ('malformed', 'invalid_result', 'passed'),
    ('oversize', 'invalid_result', 'passed'), ('symlink', 'invalid_result', 'passed'),
    ('solution-link', 'completed', 'failed'), ('nonzero', 'nonzero', 'failed'),
    ('timeout', 'timeout', 'failed'),
])
def test_failure_retained(runner, behavior, status, grader):
    args = options(runner, behavior, ['--timeout', '1'])
    row = w.run_one(args, w.TASKS[0], 'off', 1)
    assert row['status'] == status
    assert row['grader'] == grader
    assert row['wall_seconds'] >= 0
    if status != 'completed':
        assert all(v is None for v in row['usage']['main_model'].values())
    rows = [dict(row, mode=mode) for mode in w.MODES]
    summary, comparison = w.summarize(rows)
    assert not comparison['comparable']
    assert summary['off']['quality'][grader] == 1


@pytest.mark.parametrize('text', ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', '[' * 1100])
def test_strict_json(tmp_path, text):
    (tmp_path / 'result.json').write_text(text)
    with pytest.raises((ValueError, RecursionError)):
        w.read_json(tmp_path, 'result.json')


@pytest.mark.parametrize('value', [True, -1, 1.5, 10**10, float('inf'), float('nan')])
def test_invalid_counts(value):
    result = w.template(w.TASKS[0], 'off', None)
    expected = w.template(w.TASKS[0], 'off', None)
    result['jev']['requests'] = value
    with pytest.raises(ValueError):
        w.validate(result, expected)


@pytest.mark.parametrize('argv', [['--runner', '/bin/false'], ['--execute'], ['--execute', '--runner', 'python'],
    ['--repeats', '2'], ['--repeats', '4'], ['--timeout', '0'], ['--timeout', '121'], ['--model', 'bad\nmodel']])
def test_cli_bounds(argv):
    with pytest.raises(SystemExit): w.arguments(argv)


def test_repeat_bound_and_forwarding(runner, monkeypatch):
    monkeypatch.setenv('PUBLIC_TEST_TOKEN', 'public-fixture-value')
    report = w.build_report(options(runner, extra=['--repeats', '3', '--pass-env', 'PUBLIC_TEST_TOKEN']))
    assert len(report['runs']) == 27
    assert all(r['status'] == 'completed' for r in report['runs'])
    assert 'public-fixture-value' not in json.dumps(report)
    for name in ['HOME', 'SYNAPS_BASE_DIR', 'BAD=VALUE', 'X' * 65]:
        with pytest.raises(SystemExit): options(runner, extra=['--pass-env', name])


def test_parent_symlink_and_fifo(tmp_path):
    (tmp_path / 'workspace').symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(OSError): w.read_json(tmp_path, 'workspace/solution.json')
    os.mkfifo(tmp_path / 'result.json')
    with pytest.raises(ValueError): w.read_json(tmp_path, 'result.json')


def test_output_explicit_and_exclusive(tmp_path, capsys):
    path = tmp_path / 'report.json'
    assert w.main(['--output', str(path)]) == 0
    assert json.loads(path.read_text())['executed'] is False
    assert capsys.readouterr().out == ''
    with pytest.raises(FileExistsError): w.main(['--output', str(path)])
