"""Session accounting + JSONL audit trail.

Audit records never contain full file bodies — only what was sent to Jev
(previews) and what came back. Best-effort: a failed write never breaks a
hook.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path


def synaps_base_dir() -> Path:
    configured = os.environ.get("SYNAPS_BASE_DIR")
    return Path(configured) if configured else Path.home() / ".synaps-cli"


class Audit:
    def __init__(self, audit_file: str | None) -> None:
        self.path: Path | None = None
        if audit_file:
            p = Path(audit_file)
            self.path = p if p.is_absolute() else synaps_base_dir() / p
        self.counters: dict[str, int] = {}

    def bump(self, key: str) -> None:
        self.counters[key] = self.counters.get(key, 0) + 1

    def write(self, record: dict) -> None:
        if self.path is None:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            record.setdefault("ts", round(time.time(), 3))
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, separators=(",", ":")) + "\n")
            # Keep the audit log private: it contains command text.
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        except OSError:
            pass
