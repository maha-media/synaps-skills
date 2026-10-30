"""Host facts for web-tools: one read of Pria's host profile, with per-OS defaults.

    host_get(key)            -> the profile value, else this OS's default (None if none)
    host_get(key, default)   -> the profile value, else `default` (pass None to see "unset")

Runs `pria-fleet host get KEY`, which prints the raw scalar and a newline
(arrays and tables as JSON text). Exit 0 is the value. Anything else means
"use the default": 9 unset, 2 unknown key or usage (also what an older
pria-fleet without `host` gives), a missing pria-fleet or a timeout. Exit 6 or
1 is a profile problem: treated as unset, with one warning on stderr.
This plugin never writes the profile and never asks setup questions.
Call sites don't branch on the OS: the per-OS defaults live here.

Keys used: gpu.kind (transcribe; unset = probe torch: CUDA, then MPS, then CPU).
"""
import subprocess
import sys

_OS_DEFAULT = object()
_cache = {}
_warned = []


def _os_default(key):
    """Per-OS defaults for the keys web-tools reads. None = no fixed default."""
    if key == "gpu.kind":
        return None            # probe at run time (transcribe.detect_device), on every OS
    return None


def _lookup(key):
    if key in _cache:
        return _cache[key]
    value = None
    try:
        r = subprocess.run(["pria-fleet", "host", "get", key], stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
                           timeout=5)
    except (OSError, subprocess.SubprocessError):
        r = None
    if r is not None:
        out = r.stdout.rstrip("\r\n")
        if r.returncode == 0 and out:
            value = out
        elif r.returncode in (1, 6) and not _warned:
            _warned.append(key)
            print(f"web-tools: warning: the host profile could not be read (pria-fleet host get {key}: "
                  f"exit {r.returncode}); using defaults.", file=sys.stderr)
    _cache[key] = value
    return value


def host_get(key, default=_OS_DEFAULT):
    value = _lookup(key)
    if value is not None:
        return value
    return _os_default(key) if default is _OS_DEFAULT else default
