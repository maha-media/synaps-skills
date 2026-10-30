"""Keep the jev test suite out of the REAL Allow-once store.

guard.handle() takes the Allow-once store from $HOME (allow_once.root(home)).
A test that drives an access block through the guard while $HOME is the real
home wrote a request into ~/.synaps-cli/memory/jev/access/requests: nine such
records once landed there (session "sess-log" and one with none).

Importing this module points the store for the real home (the passwd home and
$HOME as it was at import) at a per-run temp dir, removed at exit. A test that
passes its own temp home keeps the real formula, so test_allow_once and the
like are unchanged. The first import patches the whole process; every test
module that imports jev_ext or the guard imports this module too
(test_store_isolation.py checks that, and checks the redirect itself).
"""
from __future__ import annotations

import atexit
import os
import pwd
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "extensions"))

from jev import allow_once  # noqa: E402


def _real(path):
    try:
        return os.path.realpath(path) if path else None
    except (TypeError, ValueError):
        return None


REAL_HOMES = frozenset(h for h in (_real(pwd.getpwuid(os.getuid()).pw_dir), _real(os.environ.get("HOME")))
                       if h)
REAL_ROOTS = frozenset(os.path.join(h, ".synaps-cli", "memory", "jev", "access") for h in REAL_HOMES)

if not getattr(allow_once.root, "jev_test_home", False):
    RUN_DIR = tempfile.mkdtemp(prefix="jev-tests-store-")
    atexit.register(shutil.rmtree, RUN_DIR, True)
    # The store creates only its own dirs (os.mkdir, 0700); the parents exist in a real home.
    os.makedirs(os.path.join(RUN_DIR, "home", ".synaps-cli", "memory", "jev"), 0o700)
    _formula = allow_once.root

    def _root(home):
        if _real(home) in REAL_HOMES:
            return _formula(os.path.join(RUN_DIR, "home"))
        return _formula(home)

    _root.jev_test_home = True
    _root.run_dir = RUN_DIR
    allow_once.root = _root

RUN_DIR = allow_once.root.run_dir

# On a Pria host transport "auto" picks the relay, which dials the REAL
# ~/.local/state/pria-desktop/fleet.sock. Point the relay at a dir that does
# not exist, so auto stays direct and no test reaches the real socket or token.
from jev import relay  # noqa: E402

if relay.STATE_DIR is None:
    relay.STATE_DIR = os.path.join(RUN_DIR, "no-pria-desktop")

# The host profile: a fixed "nothing set" one, so no test runs the real
# pria-fleet or reads the real ~/.pria/host.toml. Tests that need values
# inject their own through HostProfile.use(...).
from jev import host_profile  # noqa: E402

if not getattr(host_profile.HostProfile, "jev_test_home", False):
    host_profile.HostProfile.install(host_profile.HostProfile({}))
    host_profile.HostProfile.jev_test_home = True

# jev.log (logs.default_path, set by jev_ext.main()) under a real home's
# .synaps-cli goes to the same per-run dir, so no test appends to the real log.
from jev import logs  # noqa: E402

if not getattr(logs.default_path, "jev_test_home", False):
    _log_formula = logs.default_path
    REAL_BASES = frozenset(os.path.join(h, ".synaps-cli") for h in REAL_HOMES)

    def _default_path():
        path = _log_formula()
        if any(_real(str(path)).startswith(base + os.sep) for base in REAL_BASES) or \
                any(str(path).startswith(base + os.sep) for base in REAL_BASES):
            return type(path)(RUN_DIR, "home", ".synaps-cli", "memory", "jev", "jev.log")
        return path

    _default_path.jev_test_home = True
    logs.default_path = _default_path
