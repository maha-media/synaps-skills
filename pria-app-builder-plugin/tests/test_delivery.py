"""Inert snapshot payload and synthetic backend contracts; no installer/network."""
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from main import handle_request
from app_builder_tools import validate, ToolError
spec = importlib.util.spec_from_file_location('pack', ROOT/'scripts/pack.py')
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)

def prepared_package():
    return {'devDependencies': {'vite':'8.2.0','@vitejs/plugin-react':'6.0.5','parse5':'7.3.0'},
            'pria': {'requiredChecks': ['test']},
            'scripts': {'test': 'node --test', 'dev': 'vite --configLoader runner', 'build': 'vite build --configLoader runner'}}

def prepared_lock(package):
    return {'lockfileVersion': 3, 'packages': {'': package, **{
        'node_modules/'+name: {'version': version} for name, version in package['devDependencies'].items()}}}

class Delivery(unittest.TestCase):
    def test_marketplace_and_descriptor(self):
        market = json.loads((ROOT.parent/'.synaps-plugin/marketplace.json').read_text())
        manifest = json.loads((ROOT/'.synaps-plugin/plugin.json').read_text())
        entries = [x for x in market['plugins'] if x['name'] == manifest['name']]
        self.assertEqual(len(entries), 1)
        for key in ('version', 'description', 'author'):
            self.assertEqual(entries[0][key], manifest[key])
        self.assertEqual(entries[0]['source'], './pria-app-builder-plugin')
        self.assertEqual(json.loads((ROOT/'pack.json').read_text()), pack.descriptor())

    def test_inert_bake_copy_and_profile_commands(self):
        installer = (ROOT.parent/'guest-agent/packaging/install.sh').read_text()
        self.assertIn('pria-app-builder-plugin', installer)
        self.assertIn('cp -a "${src}" "${PLUGIN_DEST}/${dest_name}"', installer)
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp)/'plugin'
            shutil.copytree(ROOT, dest, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
            self.assertEqual(pack.descriptor(dest), pack.descriptor())
            subprocess.run([sys.executable, str(dest/'scripts/stdio_harness.py')], check=True, capture_output=True)
            app = Path(tmp)/'app'; app.mkdir()
            package = prepared_package()
            (app/'package.json').write_text(json.dumps(package))
            (app/'package-lock.json').write_text(json.dumps(prepared_lock(package)))
            command = [sys.executable, str(dest/'scripts/prepare-profile.py'), str(app)]
            subprocess.run(command, check=True, capture_output=True)
            self.assertEqual((app/'pria-adapters/vite-react.mjs').read_bytes(), (dest/'adapters/vite-react.mjs').read_bytes())
            self.assertIn("'./pria-adapters/vite-react.mjs'", (app/'vite.config.mjs').read_text())
            self.assertEqual((app/'pria-adapters/opaque-dev-runtime.js').read_bytes(), (dest/'adapters/opaque-dev-runtime.js').read_bytes())
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            (dest/'adapters/vite-react.mjs').write_text('// tampered')
            self.assertNotEqual(pack.descriptor(dest)['digest'], pack.descriptor()['digest'])

    def test_prepare_refuses_missing_checks_lock_drift_and_preserves_manifest(self):
        for mutation in ('checks', 'test', 'lock-root', 'lock-entry', 'lock-missing', 'lock-link', 'lock-version', 'scripts', 'config'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as tmp:
                app = Path(tmp)
                package = prepared_package()
                lock = prepared_lock(package)
                if mutation == 'checks': package.pop('pria')
                if mutation == 'test': package['scripts'].pop('test')
                if mutation == 'lock-root': lock['packages'][''] = {}
                if mutation == 'lock-entry': lock['packages']['node_modules/vite']['version'] = '8.1.0'
                if mutation == 'lock-missing': lock['packages'].pop('node_modules/parse5')
                if mutation == 'lock-link': lock['packages']['node_modules/vite']['link'] = True
                if mutation == 'lock-version': lock['lockfileVersion'] = 1
                if mutation == 'scripts': package['scripts']['build'] = 'my-custom-build'
                if mutation == 'config': (app/'vite.config.ts').write_text('// user config')
                original = json.dumps(package)
                (app/'package.json').write_text(original)
                (app/'package-lock.json').write_text(json.dumps(lock))
                result = subprocess.run([sys.executable, str(ROOT/'scripts/prepare-profile.py'), str(app)], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((app/'package.json').read_text(), original)
                self.assertFalse((app/'pria-adapters').exists())
                if mutation == 'scripts':
                    self.assertIn('package.json (proposed)', result.stdout)
                    self.assertIn('my-custom-build', result.stdout)

    def test_runbook_json_calls_with_synthetic_backend(self):
        import re
        calls = []
        class Backend:
            def call(self, subject, args):
                calls.append((subject, args))
                return {'ok': True, 'synthetic': True, 'receipt': {'applied': False}, 'sourceDigest': 'a'*64}
        for skill in (ROOT/'skills').glob('*/SKILL.md'):
            for block in re.findall(r'```json\n(.*?)\n```', skill.read_text(), re.S):
                call = json.loads(block)
                response, done = handle_request({'id':1,'method':'tool.call','params':{'name':call['tool'],'input':call['input']}}, {}, client_factory=lambda config: Backend())
                self.assertNotIn('error', response, response)
                self.assertFalse(done)
                self.assertIn('synthetic', str(response))
        self.assertEqual(len(calls), 6)

    def test_navigation_fail_closed(self):
        base = {'build':1,'workdir':'worktree','outputDir':'dist','builder': {'node':'v22.12.0','packageManager':'npm','lockfileSha256':'a'*64,'commands':[['npm','run','build']]}}
        for routes in ([], ['/nested'], ['/', '/../'], ['/', '/x?secret'], '/*'):
            with self.assertRaises(ToolError): validate('app_build_seal', {**base,'navigationPaths':routes})
