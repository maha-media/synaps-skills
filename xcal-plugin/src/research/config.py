"""Centralized path/env config for xcal.

Container-clean: every external path is read from an env var with a sensible
default. Nothing else in this codebase should hardcode /home or any absolute
dev path. The container install overrides these vars; tests set them to
TempDirs.
"""
from __future__ import annotations
import os
import shutil
from pathlib import Path


def _expand(p: str) -> Path:
    return Path(os.path.expanduser(os.path.expandvars(p)))


def finlens_home() -> Path:
    return _expand(os.environ.get("FINLENS_HOME", "~/Jawz/workspace/finlens"))


def finlens_python() -> Path:
    """Path to the finlens venv python. Caller decides whether it must exist."""
    return finlens_home() / ".venv" / "bin" / "python"


def axel_bin() -> str:
    """Resolved axel binary path. Falls back to `axel` on PATH if the default
    doesn't exist. Returns a string (suitable for subprocess argv[0])."""
    explicit = os.environ.get("AXEL_BIN")
    if explicit:
        return os.path.expanduser(explicit)
    default = os.path.expanduser("~/Projects/axel/target/release/axel")
    if os.path.exists(default):
        return default
    on_path = shutil.which("axel")
    return on_path or default  # surface the missing path on use


def skills_dir() -> Path:
    return _expand(os.environ.get("XCAL_SKILLS_DIR", "~/.synaps/skills"))


# ── LLM config (phase 2.2) ──────────────────────────────────────────────────
def anthropic_api_key() -> str:
    """Provider API key from env. Empty string if unset — callers decide
    whether that's fatal. Never logged."""
    return os.environ.get("ANTHROPIC_API_KEY", "")


def dexter_model() -> str:
    """LLM model id. Default is a current Claude model; override via env."""
    return os.environ.get("XCAL_MODEL", "claude-sonnet-4-5")


def dexter_max_iters() -> int:
    try:
        return max(1, int(os.environ.get("XCAL_MAX_ITERS", "8")))
    except ValueError:
        return 8


# Default identity block prepended to `system` when authenticating via the
# Claude-subscription OAuth path. Anthropic's OAuth-beta requires the request
# to identify as Claude Code; the engine enforces this as the FIRST system
# block. Override only if you know what you're doing.
_DEFAULT_IDENTITY = (
    "You are Claude Code, Anthropic's official CLI for Claude."
)


def auth_json_path() -> Path:
    """Location of the Synaps-CLI auth.json shared credential."""
    return _expand(os.environ.get("XCAL_AUTH_JSON", "~/.synaps-cli/auth.json"))


def identity() -> str:
    """Identity text injected as system[0] in OAuth mode."""
    return os.environ.get("XCAL_IDENTITY", _DEFAULT_IDENTITY)


def anthropic_credential() -> tuple[str, str]:
    """Return ('api_key', key) | ('oauth', access_token).

    Precedence: ANTHROPIC_API_KEY env wins. Otherwise read auth.json and use
    the OAuth access token if its `expires` (ms epoch) is still in the future
    (with a 60-second safety margin). Raises RuntimeError otherwise — never
    embeds secrets in the message.
    """
    import json as _json
    import time as _time

    api = anthropic_api_key()
    if api:
        return ("api_key", api)

    p = auth_json_path()
    if not p.exists():
        raise RuntimeError(
            f"no LLM credential: ANTHROPIC_API_KEY unset and {p} missing"
        )
    try:
        data = _json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"no LLM credential: cannot read {p}: {e}") from e
    anth = (data or {}).get("anthropic") or {}
    if anth.get("type") != "oauth":
        raise RuntimeError(
            f"no LLM credential: {p} has no anthropic.type=='oauth' entry"
        )
    access = anth.get("access") or ""
    expires_ms = int(anth.get("expires") or 0)
    now_ms = int(_time.time() * 1000)
    if not access:
        raise RuntimeError(f"no LLM credential: {p} missing anthropic.access")
    if expires_ms and expires_ms - now_ms < 60_000:
        raise RuntimeError(
            "OAuth access token expired or near-expiry; refresh required "
            f"(auth.json: {p})"
        )
    return ("oauth", access)


def live_llm() -> bool:
    """Gate for tests/CI: only true when XCAL_LIVE_LLM=1 is set."""
    return os.environ.get("XCAL_LIVE_LLM", "") == "1"


# ── Reflection (phase 2.3) ──────────────────────────────────────────────────
def spool_dir() -> Path:
    """Where research_ticker drops session records for the reflection
    subprocess to pick up. Container-clean."""
    return _expand(os.environ.get(
        "XCAL_SPOOL_DIR", "~/.synaps/xcal/spool"))


def reflect_max_iters() -> int:
    """Hard cap on LLM turns inside a reflection subprocess."""
    try:
        return max(1, int(os.environ.get("XCAL_REFLECT_MAX_ITERS", "4")))
    except ValueError:
        return 4


def in_reflection() -> bool:
    """True if we are running inside the reflection subprocess. Set by the
    parent before spawning the child; checked everywhere to refuse recursion."""
    return os.environ.get("XCAL_IN_REFLECTION", "") == "1"


def reflect_enabled() -> bool:
    """Master switch — default ON. Set XCAL_REFLECT=0 to disable spawning."""
    return os.environ.get("XCAL_REFLECT", "1") != "0"
