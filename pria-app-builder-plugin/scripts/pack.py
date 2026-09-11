#!/usr/bin/env python3
"""Deterministic inert payload descriptor. Never installs or imports application code."""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def descriptor(root=ROOT):
    files = []
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root)
        if any(x in ('__pycache__', 'tests', '.git') for x in rel.parts) or path.suffix == '.pyc' or str(rel) == 'pack.json':
            continue
        if path.is_symlink():
            raise ValueError('symlink in plugin payload')
        if path.is_file():
            files.append([rel.as_posix(), hashlib.sha256(path.read_bytes()).hexdigest()])
    digest = hashlib.sha256(json.dumps(files, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    manifest = json.loads((root / '.synaps-plugin/plugin.json').read_text())
    return {'name': manifest['name'], 'version': manifest['version'], 'profile': 'react-spa-relative-v1',
            'protocolVersion': 1, 'digestAlgorithm': 'sha256-path-content-tuples-v1', 'digest': digest,
            'toolchain': {'node': '>=22.12 <23 || >=24', 'vite': '8.2.0', '@vitejs/plugin-react': '6.0.5', 'parse5': '7.3.0'},
            'files': files}

if __name__ == '__main__':
    actual = descriptor()
    if sys.argv[1:] == ['--check']:
        if json.loads((ROOT/'pack.json').read_text()) != actual:
            raise SystemExit('pack descriptor mismatch')
        print('pack descriptor verified')
    elif sys.argv[1:]:
        raise SystemExit('usage: pack.py [--check]')
    else:
        print(json.dumps(actual, ensure_ascii=False, indent=2))
