"""Audit sink (B2: local JSONL spool + stdout; B4 adds the Pria ingest POST).

Every record passes through `AuditSink.emit(kind, fields)` which:
  - stamps schema_version, event_id, timestamp, source,
  - merges the active session-context tags (account/instance/user/... IDs),
  - writes to the local JSONL spool and stdout JSONL,
  - (B4) enqueues for the Pria ingest endpoint.

Records must never block the hook hot path beyond the 5s extension hook timeout
(process.rs:1844) — spool/stdout writes are local and fast; network egress (B4)
is best-effort and offline-tolerant.
"""
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1
SOURCE = "synaps-extension"


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def synaps_base_dir() -> Path:
    configured = os.environ.get("SYNAPS_BASE_DIR")
    if configured:
        return Path(configured)
    return Path.home() / ".synaps-cli"


class AuditSink:
    def __init__(self, ctx, config=None, stdout=None):
        self.ctx = ctx
        self.config = config or {}
        self._stdout = stdout if stdout is not None else sys.stdout
        self._ingest = None  # set by B4

    def spool_path(self) -> Path:
        rel = str(self.config.get("audit_spool_file")
                  or "audit-spool/pria-session-context.jsonl")
        p = Path(rel)
        if p.is_absolute():
            return p
        return synaps_base_dir() / p

    def build(self, kind: str, fields: dict) -> dict:
        record = {
            "schema_version": SCHEMA_VERSION,
            "event_id": "evt_" + uuid.uuid4().hex[:16],
            "kind": kind,
            "source": SOURCE,
            "timestamp": _now(),
        }
        # Session-context tags (account/instance/user/vm/session/uid/roles).
        record.update(self.ctx.tags())
        # Caller-specific fields override nothing critical but add detail.
        for k, v in fields.items():
            if v is not None:
                record[k] = v
        return record

    def emit(self, kind: str, fields: dict = None) -> dict:
        record = self.build(kind, fields or {})
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        self._write_spool(line)
        self._write_logstream(line)
        if self._ingest is not None:
            try:
                self._ingest.enqueue(record)
            except Exception:  # noqa: BLE001 — audit egress is best-effort
                pass
        return record

    def _write_spool(self, line: str):
        try:
            path = self.spool_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except OSError:
            pass  # spool failure must not crash the hook

    def _write_logstream(self, line: str):
        # NOTE: stdout is the JSON-RPC pipe to the runtime, so supervisor-capturable
        # JSONL goes to STDERR (the runtime forwards extension stderr to its logs:
        # process.rs spawn_reader). Prefixed for grep-ability.
        # stderr, not stdout: stdout is the JSON-RPC pipe to the runtime.
        if os.environ.get("PRIA_AUDIT_QUIET"):
            return
        try:
            sys.stderr.write("PRIA_AUDIT " + line + "\n")
            sys.stderr.flush()
        except OSError:
            pass

    def attach_ingest(self, ingest):
        self._ingest = ingest

    def flush(self):
        if self._ingest is not None:
            try:
                self._ingest.flush()
            except Exception:  # noqa: BLE001
                pass
