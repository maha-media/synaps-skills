"""Offline real-plugin wrapper and fake-host RPC tests. No provider calls."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import workflow_synaps as a
import workflow_compare as w

# Executed as the fake binary, using the real isolated wrapper/plugin over its
# own stdio protocol. Keys are dummy strings; no Jev decision is requested.
FAKE = r'''
import json, os, pathlib, subprocess, sys, time
base = pathlib.Path(os.environ['SYNAPS_BASE_DIR'])
ws = pathlib.Path.cwd()
behavior = BEHAVIOR
assert sys.argv[1:3] == ['rpc', '--model']
model = sys.argv[3]
assert sys.argv[4] == '--system'
assert os.environ['TOKIO_WORKER_THREADS'] == '1'
assert 'UNAPPROVED_SECRET' not in os.environ
plugin = base / 'plugins/jev'
cfg = {}
for line in (base / 'config').read_text().splitlines():
    key, value = line.split(' = ', 1)
    cfg[key.removeprefix('extension.jev.')] = {'true': True, 'false': False}.get(value, value)
assert cfg['events.auto_turn'] is False
assert cfg['guard'] is False and cfg['budget_enabled'] is False and cfg['audit_file'] == ''
assert not (plugin / 'config').exists()
# Match host spawn: base is scrubbed and secret-env config arrives at initialize.
child_env = {k:v for k,v in os.environ.items() if k not in ('SYNAPS_BASE_DIR', 'TYPESAFE_API_KEY')}
assert 'SYNAPS_BASE_DIR' not in child_env
if cfg['router']:
    assert os.environ['TYPESAFE_API_KEY'] == 'dummy-offline-key'
    cfg['api_key'] = 'dummy-offline-key'
p = subprocess.Popen([sys.executable, '-u', str(plugin / 'extensions/workflow_jev_snapshot.py')],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=child_env)
# Extension inbound also uses Content-Length framing.
def ext(method, params):
    body = json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params})
    p.stdin.write('Content-Length: '+str(len(body))+'\r\n\r\n'+body); p.stdin.flush()
    line = p.stdout.readline(); assert line.startswith('Content-Length: '), line
    n = int(line.split(':')[1]); assert p.stdout.readline() == '\n'
    return json.loads(p.stdout.read(n))
init = ext('initialize', {'config':cfg})
assert 'result' in init

def emit(x):
    print(json.dumps(x), flush=True)
def receive():
    return json.loads(sys.stdin.readline())
if behavior == 'timeout':
    print('{', end='', flush=True); time.sleep(10)
if behavior == 'malformed':
    print('SECRET bad json', flush=True); sys.exit(0)
if behavior == 'oversized':
    print('SECRET' + 'x' * (1024*1024+1), flush=True); sys.exit(0)
if behavior == 'error':
    emit({'type':'error','message':'SECRET'}); sys.exit(0)
emit({'type':'ready','protocol_version':2 if behavior == 'version' else 1,
      'model':'wrong' if behavior == 'model' else model})
cmd = receive(); assert cmd == {'type':'tools_list','id':'tools'}
names = ['jev_'+n for n in ('decide','select','status','verify','evidence','diagnose')]
if behavior == 'missing-tools': names.pop()
emit({'type':'response','id':'tools','command':'tools_list','ok':True,'tools':[{'name':n} for n in names]})
cmd = receive(); assert cmd['type'] == 'prompt' and cmd['id'] == 'task'
assert 'mode_config' not in cmd['message'] and 'result_template' not in cmd['message']
task = json.loads((ws / 'request.json').read_text())
assert json.dumps(task, sort_keys=True, separators=(',', ':'), ensure_ascii=False) in cmd['message']
# Deliberately leave solution untouched: adapter must not grade/solve the task.
ext('hook.handle', {'kind':'before_tool_call', 'tool':'read', 'input':{'path':'request.json'}})
if behavior == 'features':
    ext('initialize', {'config':{'compress':True, 'compress_mode':'deterministic'}})
emit({'type':'message_update','event':{'type':'thinking_delta','delta':'SECRET'}})
if behavior == 'unknown':
    snap = json.loads((base/'workflow-stats.json').read_text())
    snap['stats'].update(calls=1, wire_attempts=1, unknown_usage_calls=1, unknown_usage_attempts=1, input_tokens=None, cost_usd=None)
    snap['stats']['by_op'] = {'decide':1}
    snap['stats']['op_stats'] = {'decide':dict(calls=1, errors=0, known_input_tokens=0,
        total_ms=1, unknown_usage_calls=1, wire_attempts=1, unknown_usage_attempts=1,
        retries=0, mean_ms=1, known_cost_usd=0, input_tokens=None, cost_usd=None)}
    # Send shutdown first so wrapper's final snapshot precedes this synthetic
    # accounting mutation (only the nullable stats validation fixture).
    ext('shutdown', {}); p.wait()
    (base/'workflow-stats.json').write_text(json.dumps(snap))
else:
    ext('shutdown', {}); p.wait()
if behavior == 'missing-stats': (base/'workflow-stats.json').unlink()
if behavior == 'bad-stats':
    snap = json.loads((base/'workflow-stats.json').read_text()); snap['stats']['calls'] = True
    (base/'workflow-stats.json').write_text(json.dumps(snap))
usage = {'input_tokens':0 if behavior == 'zero' else 123, 'output_tokens':0 if behavior == 'zero' else 7, 'model':model}
if behavior == 'negative': usage['input_tokens'] = -1
emit({'type':'agent_end','usage':usage})
if behavior == 'duplicate': emit({'type':'agent_end','usage':usage})
emit({'type':'response','id':'wrong' if behavior == 'id' else 'task','command':'prompt',
      'ok':behavior != 'not-ok', 'cancelled': behavior == 'cancelled'})
assert receive() == {'type':'shutdown'}
sys.exit(7 if behavior == 'nonzero' else 0)
'''


def bundle(tmp_path, monkeypatch, mode='off', behavior='good'):
    root = tmp_path / 'bundle'; root.mkdir()
    for name in ('workspace', 'home', 'synaps'): (root/name).mkdir()
    task = w.TASKS[0]
    for name, text in w.starter(task).items(): (root/'workspace'/name).write_text(text)
    request = {'schema':1, 'task':task, 'mode_config':w.CONFIGS[mode],
               'result_template':w.template(task, mode, 'provider/test-model')}
    (root/'task.json').write_bytes(w.canonical(request))
    binary = tmp_path/'fake-synaps'
    binary.write_text('#!'+sys.executable+'\nBEHAVIOR='+repr(behavior)+'\n'+FAKE)
    binary.chmod(0o700)
    monkeypatch.setenv('HOME', str(root/'home'))
    monkeypatch.setenv('SYNAPS_BASE_DIR', str(root/'synaps'))
    monkeypatch.setenv('UNAPPROVED_SECRET', 'SECRET')
    monkeypatch.delenv('TYPESAFE_API_KEY', raising=False)
    for key in a.KEYS:
        monkeypatch.delenv(key, raising=False)
    if mode == 'selected': monkeypatch.setenv('TYPESAFE_API_KEY', 'dummy-offline-key')
    argv = ['--execute','--synaps-bin',str(binary),'--task',str(root/'task.json'),
            '--workspace',str(root/'workspace'),'--result',str(root/'result.json'),'--mode',mode,'--timeout','3']
    return root, argv


def test_default_no_actions(monkeypatch, capsys):
    monkeypatch.setattr(a.subprocess, 'Popen', lambda *x, **kw: pytest.fail('launch'))
    monkeypatch.setattr(a, 'prepare', lambda *x: pytest.fail('config'))
    assert a.main([]) == 0
    assert 'Not a sandbox' in capsys.readouterr().out


@pytest.mark.parametrize('mode', w.MODES)
def test_modes_real_wrapper(tmp_path, monkeypatch, mode):
    root, argv = bundle(tmp_path, monkeypatch, mode)
    assert a.main(argv) == 0
    result = json.loads((root/'result.json').read_text())
    assert result['model'] == 'provider/test-model'
    assert result['main_model'] == dict(input_tokens=123, output_tokens=7, cost_usd=None, requests=None, retries=None)
    assert result['jev'] == dict(input_tokens=0, output_tokens=0, cost_usd=0, requests=0, retries=0, wire_attempts=0)
    assert result['verification'] == {'claimed_passed':None}
    assert (root/'workspace/solution.json').read_text() == w.starter(w.TASKS[0])['solution.json']
    snap = json.loads((root/'synaps/workflow-stats.json').read_text())
    assert snap['features'] == {**{k:w.CONFIGS[mode][k] for k in w.FEATURES}, 'tools':True}
    assert (root/'synaps/workflow-stats.json').stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize('behavior', ['timeout','malformed','oversized','error','version','model','missing-tools',
    'features','missing-stats','bad-stats','negative','duplicate','id','not-ok','cancelled','nonzero'])
def test_failures(tmp_path, monkeypatch, capsys, behavior):
    root, argv = bundle(tmp_path, monkeypatch, behavior=behavior)
    argv[-1] = '1'
    assert a.main(argv) == 1
    assert not (root/'result.json').exists()
    captured = capsys.readouterr()
    assert captured.out == '' and captured.err == 'workflow_synaps: failed\n'


@pytest.mark.parametrize('behavior', ['zero','unknown'])
def test_unknown_not_zero(tmp_path, monkeypatch, behavior):
    root, argv = bundle(tmp_path, monkeypatch, behavior=behavior)
    assert a.main(argv) == 0
    r = json.loads((root/'result.json').read_text())
    if behavior == 'zero':
        assert r['main_model']['input_tokens'] is None and r['main_model']['output_tokens'] is None
    else:
        assert r['jev']['input_tokens'] is None and r['jev']['output_tokens'] is None and r['jev']['cost_usd'] is None


@pytest.mark.parametrize('mutation', ['mode','key','task','config','template','starter','extra','home','base','result','symlink','model','binary'])
def test_prelaunch_closed(tmp_path, monkeypatch, mutation):
    root, argv = bundle(tmp_path, monkeypatch, mode='selected')
    req = json.loads((root/'task.json').read_text())
    if mutation == 'mode': argv[argv.index('--mode')+1] = 'bogus'
    elif mutation == 'key': monkeypatch.delenv('TYPESAFE_API_KEY')
    elif mutation == 'task': req['task']['vectors'][0] = 'wrong'
    elif mutation == 'config': req['mode_config']['guard'] = True
    elif mutation == 'template': req['result_template']['jev']['requests'] = 0
    elif mutation == 'starter': (root/'workspace/solution.json').write_text('{"outputs": [1]}')
    elif mutation == 'extra': (root/'workspace/extra').touch()
    elif mutation in ('home','base'): (root/('synaps' if mutation == 'base' else 'home')/'config').touch()
    elif mutation == 'result': (root/'result.json').touch()
    elif mutation == 'symlink':
        (root/'workspace/request.json').unlink(); (root/'workspace/request.json').symlink_to(root/'task.json')
    elif mutation == 'model': req['result_template']['model'] = None
    elif mutation == 'binary': argv[argv.index('--synaps-bin')+1] = 'synaps'
    (root/'task.json').write_text(json.dumps(req))
    monkeypatch.setattr(a.subprocess, 'Popen', lambda *x, **kw: pytest.fail('launched invalid bundle'))
    assert a.main(argv) == 1


def test_wrapper_source_help_no_plugin_import(tmp_path):
    # Source location is deliberately not a valid installed layout.
    env = {'PATH': os.defpath, 'HOME': str(tmp_path)}
    proc = subprocess.run([sys.executable, '-I', str(SCRIPTS/'workflow_jev_snapshot.py'), '--help'],
                          env=env, capture_output=True, timeout=3)
    assert proc.returncode == 0
    assert b'Benchmark-only wrapper' in proc.stdout
    assert proc.stderr == b''
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize('missing', ['config', 'plugins/jev/.synaps-plugin', 'plugins/jev/extensions/jev_ext.py'])
def test_wrapper_invalid_installation(tmp_path, missing):
    base = tmp_path/'synaps'; base.mkdir()
    a.prepare(base, 'off')
    path = base/missing
    if path.is_dir():
        (path/'plugin.json').unlink(); path.rmdir()
    else:
        path.unlink()
    proc = subprocess.run([sys.executable, str(base/'plugins/jev/extensions/workflow_jev_snapshot.py')],
                          env={'PATH':os.defpath, 'HOME':str(tmp_path)},
                          input=b'', capture_output=True, timeout=3)
    assert proc.returncode != 0
    assert not (base/'workflow-stats.json').exists()
