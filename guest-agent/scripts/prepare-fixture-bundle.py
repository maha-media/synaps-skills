#!/usr/bin/env python3
"""Offline disposable fixture only. Copies installed dependency closure, never installs.
Usage: prepare-fixture-bundle.py NODE_MODULES PACKAGE_LOCK DEST
DEST must not exist. Output DEST/node_modules is the trusted fixture config path.
Same-UID fixture proof is not production multiuser isolation certification.
"""
import hashlib, json, os, shutil, sys
from pathlib import Path
src, lock, dest = map(lambda s: Path(s).resolve(), sys.argv[1:])
if dest.exists():
    raise SystemExit('destination must be new')
dest.mkdir(mode=0o700)
modules = dest / 'node_modules'
modules.mkdir(mode=0o700)
count = total = 0
seen = set()
def digest(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        while b := f.read(65536): h.update(b)
    return h.hexdigest()
def copy_file(a, b):
    global count, total
    count += 1
    size = a.stat().st_size
    total += size
    if count > 30000 or size > 256*1024*1024 or total > 512*1024*1024:
        raise ValueError('fixture dependency copy bound')
    if not a.is_file(): raise ValueError('nonregular fixture dependency')
    b.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copyfile(a, b)
    b.chmod(0o500 if a.stat().st_mode & 0o111 else 0o400)
def resolve(name, origin):
    p = origin
    while True:
        candidate = p / 'node_modules' / name
        if (candidate / 'package.json').is_file(): return candidate.resolve()
        if p == p.parent: break
        p = p.parent
    candidate = src / name
    return candidate.resolve() if (candidate / 'package.json').is_file() else None
def package(name, source=None):
    source = source or resolve(name, src.parent)
    if source is None: raise ValueError('missing installed package: '+name)
    if name in seen:
        if seen_map[name] != source: raise ValueError('conflicting nested dependency: '+name)
        return
    seen.add(name); seen_map[name] = source
    manifest = json.loads((source/'package.json').read_text())
    target = modules / name
    target.mkdir(parents=True, mode=0o700)
    for base, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in ('node_modules', '.git'))
        for d in dirs:
            p = Path(base)/d
            if p.is_symlink(): raise ValueError('directory symlink in installed package')
            (target/p.relative_to(source)).mkdir(parents=True, exist_ok=True, mode=0o700)
        for file in sorted(files):
            p = Path(base)/file
            actual = p.resolve()
            if not actual.is_relative_to(src): raise ValueError('dependency outside supplied root')
            copy_file(actual, target/p.relative_to(source))
    dependencies = dict(manifest.get('dependencies', {}))
    optional = manifest.get('optionalDependencies', {})
    for dep in sorted(set(dependencies)|set(optional)):
        found = resolve(dep, source)
        if found: package(dep, found)
        elif dep not in optional: raise ValueError('missing dependency '+dep)
    bins = manifest.get('bin', {})
    if isinstance(bins, str): bins = {name.split('/')[-1]: bins}
    for binary, rel in bins.items():
        if '/' in binary or binary in ('.','..'): raise ValueError('unsafe binary')
        executable = (target/rel).resolve()
        if not executable.is_relative_to(target) or not executable.is_file(): raise ValueError('unsafe bin target')
        bindir = modules/'.bin'; bindir.mkdir(exist_ok=True, mode=0o700)
        (bindir/binary).symlink_to(os.path.relpath(executable, bindir))
seen_map = {}
try:
    for name in ['vite', '@vitejs/plugin-react', 'parse5', 'react', 'react-dom', 'react-router']:
        package(name)
    for directory in [modules, *modules.rglob('*')]:
        if directory.is_dir() and not directory.is_symlink(): directory.chmod(0o700)
    entries=[]
    for p in sorted(modules.rglob('*')):
        if p.is_symlink():
            link=os.readlink(p)
            entries.append(dict(path=p.relative_to(modules).as_posix(),size=len(link.encode()),sha256=hashlib.sha256(link.encode()).hexdigest(),mode=0o777,link=link))
        elif p.is_file():
            entries.append(dict(path=p.relative_to(modules).as_posix(),size=p.stat().st_size,sha256=digest(p),mode=p.stat().st_mode&0o777))
    entries.sort(key=lambda item:item["path"])
    manifest=dict(version=1,lockSha256=digest(lock),nodeSha256=digest(Path('/usr/bin/node').resolve()),npmSha256=digest(Path('/usr/bin/npm').resolve()),profile='react-spa-relative-v1',files=entries)
    (dest/'bundle.json').write_text(json.dumps(manifest,separators=(',',':')))
    (dest/'bundle.json').chmod(0o400)
    print(json.dumps(dict(dependencies=str(modules), files=count, bytes=total, lockSha256=manifest['lockSha256'])))
except Exception:
    # Keep failed disposable copy for diagnostics; never alter source deps.
    raise
