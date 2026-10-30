"""Tests for _lib/host.py, memory.py's SYNAPS_BASE_DIR and transcribe's device choice.

Run: python3 -m pytest -q web-tools-plugin/scripts/_lib/test_host.py
 or: cd web-tools-plugin/scripts && python3 -m unittest _lib.test_host
No network, no torch or whisper needed (a fake torch module is used).
"""
import importlib
import importlib.util
import io
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from _lib import host, memory  # noqa: E402


def load_transcribe():
    path = os.path.join(SCRIPTS, "transcribe", "transcribe.py")
    spec = importlib.util.spec_from_file_location("transcribe_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class HostGetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {"PATH": self.tmp})
        self.env.start()
        host._cache.clear()
        del host._warned[:]

    def tearDown(self):
        self.env.stop()
        host._cache.clear()
        del host._warned[:]

    def fake_fleet(self, out, rc):
        p = os.path.join(self.tmp, "pria-fleet")
        with open(p, "w") as f:
            f.write(f"#!/bin/sh\n[ \"$1 $2\" = 'host get' ] || exit 2\nprintf '%s\\n' '{out}'\nexit {rc}\n")
        os.chmod(p, 0o755)

    def test_missing_pria_fleet(self):
        self.assertIsNone(host.host_get("gpu.kind"))
        self.assertEqual(host.host_get("browser.cdp_port", "9222"), "9222")

    def test_value(self):
        self.fake_fleet("mps", 0)
        self.assertEqual(host.host_get("gpu.kind"), "mps")

    def test_unset_and_old_pria_fleet_are_quiet(self):
        for rc in (9, 2):
            host._cache.clear()
            self.fake_fleet("x", rc)
            err = io.StringIO()
            with mock.patch("sys.stderr", err):
                self.assertEqual(host.host_get("gpu.kind", "dflt"), "dflt")
            self.assertEqual(err.getvalue(), "")

    def test_profile_problem_warns_once(self):
        for rc in (6, 1):
            host._cache.clear()
            del host._warned[:]
            self.fake_fleet("x", rc)
            err = io.StringIO()
            with mock.patch("sys.stderr", err):
                self.assertIsNone(host.host_get("gpu.kind"))
                self.assertIsNone(host.host_get("scratch.dir"))
            self.assertEqual(err.getvalue().count("warning"), 1, err.getvalue())


class MemoryRootTests(unittest.TestCase):
    def tearDown(self):
        importlib.reload(memory)

    def test_synaps_base_dir(self):
        with mock.patch.dict(os.environ, {"SYNAPS_BASE_DIR": "/srv/synaps"}):
            os.environ.pop("WEB_MEMORY_ROOT", None)
            importlib.reload(memory)
            self.assertEqual(str(memory.ROOT), os.path.join("/srv/synaps", "memory", "web"))
        with mock.patch.dict(os.environ, {"SYNAPS_BASE_DIR": "/srv/synaps", "WEB_MEMORY_ROOT": "/srv/mem"}):
            importlib.reload(memory)
            self.assertEqual(str(memory.ROOT), "/srv/mem")

    def test_default_base(self):
        with mock.patch.dict(os.environ, {}):
            os.environ.pop("SYNAPS_BASE_DIR", None)
            os.environ.pop("WEB_MEMORY_ROOT", None)
            importlib.reload(memory)
            self.assertEqual(str(memory.ROOT), os.path.join(os.path.expanduser("~"), ".synaps-cli", "memory", "web"))


def fake_torch(cuda=False, mps=None):
    t = types.SimpleNamespace()
    t.cuda = types.SimpleNamespace(is_available=lambda: cuda, get_device_name=lambda i: "Fake GPU",
                                   get_device_properties=lambda i: types.SimpleNamespace(total_memory=8 << 30))
    t.backends = types.SimpleNamespace()
    if mps is not None:
        t.backends.mps = types.SimpleNamespace(is_available=lambda: mps)
    return t


class DeviceTests(unittest.TestCase):
    def setUp(self):
        self.tr = load_transcribe()
        self.kind = None
        self.tr.host_get = lambda key, *a: self.kind

    def detect(self, **kw):
        with mock.patch.dict(sys.modules, {"torch": fake_torch(**kw)}), mock.patch("sys.stderr", io.StringIO()):
            return self.tr.detect_device()

    def test_order(self):
        self.assertEqual(self.detect(cuda=True, mps=True)[0], "cuda")
        self.assertEqual(self.detect(cuda=False, mps=True), ("mps", 0))
        self.assertEqual(self.detect(cuda=False, mps=False), ("cpu", 0))
        self.assertEqual(self.detect(cuda=False), ("cpu", 0))         # old torch without backends.mps

    def test_gpu_kind_none_forces_cpu(self):
        self.kind = "none"
        self.assertEqual(self.detect(cuda=True, mps=True), ("cpu", 0))
        self.kind = "cuda"                                            # set but unusable: probe
        self.assertEqual(self.detect(cuda=False, mps=False), ("cpu", 0))

    def test_mps_model(self):
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(self.tr.auto_select_model("mps", 0), "small")
            self.assertEqual(self.tr.auto_select_model("cpu", 0), "base")


if __name__ == "__main__":
    unittest.main()
