#!/usr/bin/env python3
"""Prepare pinned assets without overwriting source; print required manifest diff."""
import argparse
import difflib
import json
from pathlib import Path
from pack import descriptor

root = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('app', type=Path)
a = p.parse_args().app.resolve(strict=True)
if json.loads((root / 'pack.json').read_text()) != descriptor(root):
    p.error('pack descriptor mismatch; refusing unpinned adapter copy')
package_path = a / 'package.json'
original = package_path.read_text()
package = json.loads(original)
lock_path = a / 'package-lock.json'
if not lock_path.is_file():
    p.error('npm lockfile required; prepare authorized dependency changes first')
lock = json.loads(lock_path.read_text())
versions = {'vite': '8.2.0', '@vitejs/plugin-react': '6.0.5', 'parse5': '7.3.0'}
for manifest in (package, lock.get('packages', {}).get('', {})):
    deps = {**manifest.get('dependencies', {}), **manifest.get('devDependencies', {})}
    if any(deps.get(name) != version for name, version in versions.items()):
        p.error('profile requires exact dependency versions in manifest and lock root')
if lock.get('lockfileVersion') not in (2, 3):
    p.error('npm lockfile v2/v3 required')
for name, version in versions.items():
    entry = lock['packages'].get('node_modules/' + name, {})
    if entry.get('version') != version or entry.get('link'):
        p.error('locked dependency version mismatch: ' + name)
scripts = package.get('scripts', {})
if package.get('pria', {}).get('requiredChecks') != ['test'] or not isinstance(scripts.get('test'), str) or not scripts['test'].strip():
    p.error('declare pria.requiredChecks:["test"] and a real non-watch test script; other check vectors unsupported (never omit checks)')
expected = {'dev': 'vite --configLoader runner', 'build': 'vite build --configLoader runner'}
if any(scripts.get(key) != value for key, value in expected.items()):
    proposed = json.loads(original)
    proposed.setdefault('scripts', {}).update(expected)
    print('Review and apply this explicit manifest change; package.json was NOT modified:')
    print(''.join(difflib.unified_diff(original.splitlines(True), (json.dumps(proposed, ensure_ascii=False, indent=2)+'\n').splitlines(True), fromfile='package.json', tofile='package.json (proposed)')))
    p.error('manifest script change requires explicit review; rerun after applying')
# Preserve adapter-internal relative imports. Every copied asset is descriptor-pinned.
assets = ('vite-react.mjs', 'opaque-dev-runtime.js')
outputs = {f'pria-adapters/{name}': root / 'adapters' / name for name in assets}
outputs['vite.config.mjs'] = root / 'profile/vite.config.mjs'
if any(a.glob('vite.config.*')) or (a / 'pria-adapters').exists() or (a / 'pria-adapters').is_symlink():
    p.error('existing profile/config: review and merge explicitly; refusing overwrite')
for name, src in outputs.items():
    target = a / name
    target.parent.mkdir(exist_ok=True)
    with target.open('xb') as output:
        output.write(src.read_bytes())
print('Created: ' + ', '.join(outputs))
print('Manifest unchanged. Review test implementation (no marker/no-op bypass), lock and source delta; commit prepared source through authorized workflow before seal. Trusted commands: npm test -- --run; npm run build -- --outDir /output. Source/deps read-only; output fresh and isolated.')
