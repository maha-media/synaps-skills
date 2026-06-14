"""Session-context loader (B2).

Delivery is by FILE keyed by session_id (HS-2: env vars are stripped at extension
spawn — process.rs:643-648). The extension obtains session_id from the
on_session_start HookEvent and reads the matching context.json.

Resolution order (first existing wins):
  1. ${XDG_RUNTIME_DIR}/synaps/sessions/<id>/context.json
  2. ${HOME}/.synaps-cli/sessions/<id>/context.json
  3. ${SYNAPS_BASE_DIR}/sessions/<id>/context.json   (best-effort)
"""
import json
import os
from pathlib import Path

# Fields lifted from the context onto every audit record.
TAG_FIELDS = (
    "account_id",
    "instance_id",
    "user_id",
    "vm_id",
    "session_id",
    "linux_uid",
    "roles",
)


def candidate_paths(session_id: str):
    paths = []
    xdg = os.environ.get("XDG_RUNTIME_DIR")
    if xdg:
        paths.append(Path(xdg) / "synaps" / "sessions" / session_id / "context.json")
    home = os.environ.get("HOME")
    if home:
        paths.append(Path(home) / ".synaps-cli" / "sessions" / session_id / "context.json")
    base = os.environ.get("SYNAPS_BASE_DIR")
    if base:
        paths.append(Path(base) / "sessions" / session_id / "context.json")
    return paths


def load_context(session_id: str):
    """Return (context_dict, path_str) or (None, None) if no file found/parsed."""
    if not session_id:
        return None, None
    for path in candidate_paths(session_id):
        try:
            if path.is_file():
                with path.open("r", encoding="utf-8") as fh:
                    return json.load(fh), str(path)
        except (OSError, ValueError):
            continue
    return None, None


class SessionContext:
    """In-memory cache of the active session's context + derived audit tags."""

    def __init__(self):
        self.session_id = None
        self.raw = None
        self.path = None

    @property
    def resolved(self) -> bool:
        return self.raw is not None

    def load(self, session_id: str):
        self.session_id = session_id
        self.raw, self.path = load_context(session_id)
        return self.resolved

    def clear(self):
        self.session_id = None
        self.raw = None
        self.path = None

    def tags(self) -> dict:
        """The ID set stamped onto every emitted record."""
        out = {"context": "resolved" if self.resolved else "missing"}
        if self.session_id:
            out["session_id"] = self.session_id
        if self.raw:
            for field in TAG_FIELDS:
                if field in self.raw and self.raw[field] is not None:
                    out[field] = self.raw[field]
        return out

    def get(self, key, default=None):
        if not self.raw:
            return default
        return self.raw.get(key, default)
