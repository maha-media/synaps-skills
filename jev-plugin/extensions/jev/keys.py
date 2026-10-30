"""keys — where the API key comes from, and how to persist one.

Resolution (mirrors the runtime's own order for `secret_env` entries):
  1. SYNAPS_EXTENSION_JEV_API_KEY        env override
  2. TYPESAFE_API_KEY                    secret_env
  3. <base>/plugins/jev/config           plugin-owned store  (`api_key = …`)  ← /jev key writes here
  4. <base>/config                       legacy key          (`extension.jev.api_key = …`)

The runtime resolves these once at initialize and hands us `config.api_key`.
This module exists so an *inert* extension can pick a key up later without a
restart (after `/jev key …` or `scripts/setup.sh --key …`), and so the
setup script and the extension agree on one path.
"""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path

from .audit import synaps_base_dir

PLUGIN_ID = "jev"
KEY_RE = re.compile(r"^apikey_[A-Za-z0-9_]{20,}$")
GET_KEY_URL = "https://typesafe.ai"  # sign-in → API keys


def plugin_config_path() -> Path:
    return synaps_base_dir() / "plugins" / PLUGIN_ID / "config"


def legacy_config_path() -> Path:
    return synaps_base_dir() / "config"


def _read_kv(path: Path, key: str) -> str | None:
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            if k.strip() == key:
                return v.strip().strip('"').strip("'") or None
    except OSError:
        return None
    return None


def discover() -> tuple[str | None, str]:
    """Return (key, source_label)."""
    for env in ("SYNAPS_EXTENSION_JEV_API_KEY", "TYPESAFE_API_KEY"):
        v = os.environ.get(env, "").strip()
        if v:
            return v, f"env:{env}"
    v = _read_kv(plugin_config_path(), "api_key")
    if v:
        return v, f"file:{plugin_config_path()}"
    v = _read_kv(legacy_config_path(), f"extension.{PLUGIN_ID}.api_key")
    if v:
        return v, f"file:{legacy_config_path()} (extension.{PLUGIN_ID}.api_key)"
    return None, "none"


def looks_like_key(value: str) -> bool:
    return bool(KEY_RE.match(value.strip()))


def write_plugin_config(key: str, value: str) -> Path:
    """Direct-write fallback with the same semantics as the host's config.set:
    preserve comments and unrelated keys, replace or append `key = value`,
    mode 0600."""
    path = plugin_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    out, found = [], False
    for line in existing:
        s = line.strip()
        if not found and s and not s.startswith("#") and "=" in s and s.split("=", 1)[0].strip() == key:
            out.append(f"{key} = {value}")
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f"{key} = {value}")
    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(out) + "\n", encoding="utf-8")
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    os.replace(tmp, path)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    return path


def redact(key: str | None) -> str:
    if not key:
        return "(none)"
    return key[:10] + "…" + key[-4:] if len(key) > 18 else "(set)"
