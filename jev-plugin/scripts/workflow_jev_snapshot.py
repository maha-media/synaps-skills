"""Benchmark-only extension entrypoint, copied beside jev_ext in an isolated bundle.

Local observability, not attestation. Never serializes prompts, keys or exceptions.
"""
import json
import os
from pathlib import Path
import stat
import sys


def installed_base():
    here = Path(__file__).resolve()
    base = here.parents[3]
    plugin = base / "plugins" / "jev"
    if here.parent != plugin / "extensions":
        raise ValueError("wrapper installation")
    for directory in (base, base / "plugins", plugin, plugin / "extensions",
                      plugin / ".synaps-plugin"):
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError("wrapper installation")
    for file in (base / "config", plugin / ".synaps-plugin" / "plugin.json",
                 plugin / "extensions" / "jev_ext.py"):
        if file.is_symlink() or not file.is_file():
            raise ValueError("wrapper installation")
    return base


if "--help" in sys.argv[1:]:
    print("Benchmark-only wrapper; run only from an isolated adapter installation.")
    raise SystemExit(0)

# The host scrubs SYNAPS_BASE_DIR when spawning extensions. Recover only from
# this installed benchmark copy, never from HOME or production configuration.
os.environ["SYNAPS_BASE_DIR"] = str(installed_base())

import jev_ext


def snapshot(ext):
    data = json.dumps({"stats": ext.stats.snapshot(), "features": ext.features,
                       "compress_mode": ext.compress_cfg.mode},
                      ensure_ascii=False, allow_nan=False).encode()
    if len(data) > 8192:
        raise ValueError("snapshot limit")
    base = Path(os.environ["SYNAPS_BASE_DIR"])
    fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            info = os.stat("workflow-stats.json", dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("snapshot path")
        except FileNotFoundError:
            pass
        out = os.open("workflow-stats.tmp", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                      0o600, dir_fd=fd)
        with os.fdopen(out, "wb") as stream:
            stream.write(data)
        os.rename("workflow-stats.tmp", "workflow-stats.json", src_dir_fd=fd, dst_dir_fd=fd)
    finally:
        os.close(fd)


class ObservedExtension(jev_ext.Extension):
    def initialize(self, params):
        try:
            return super().initialize(params)
        finally:
            snapshot(self)

    def hook(self, params):
        try:
            return super().hook(params)
        finally:
            snapshot(self)

    def tool_call(self, params):
        try:
            return super().tool_call(params)
        finally:
            snapshot(self)


original_dispatch = jev_ext.dispatch


def dispatch(ext, request):
    try:
        return original_dispatch(ext, request)
    finally:
        snapshot(ext)


if __name__ == "__main__":
    jev_ext.Extension = ObservedExtension
    jev_ext.dispatch = dispatch
    jev_ext.main()
