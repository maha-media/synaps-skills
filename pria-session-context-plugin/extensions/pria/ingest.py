"""Pria ingest sink (B4).

POSTs batched audit records to the Pria control-plane ingest endpoint
(docs/contract.md §4) with a bearer token. Resolution of url/token:
  1. session-context (`ingest_url` / `ingest_token`)
  2. plugin config (`ingest_url` / `ingest_token`)

Offline-tolerant: failures are swallowed (records remain in the local JSONL
spool, which is the durable buffer). The network call never blocks the hook hot
path beyond a short timeout; the extension hook handler itself has a 5s budget
(process.rs:1844), so we keep timeouts well under that and never raise.

Uses only the Python stdlib (urllib) — no third-party deps, since the extension
runs under the minimal forwarded environment (process.rs:643-648).
"""
import json
import urllib.error
import urllib.request

DEFAULT_TIMEOUT = 2.0


class IngestSink:
    def __init__(self, ctx, config=None, timeout=DEFAULT_TIMEOUT, opener=None):
        self.ctx = ctx
        self.config = config or {}
        self.timeout = timeout
        self._opener = opener  # injectable for tests
        self._buffer = []
        self._last_error = None

    # ── config resolution (context first, then plugin config) ────────────────
    def url(self):
        return self.ctx.get("ingest_url") or self.config.get("ingest_url")

    def token(self):
        return self.ctx.get("ingest_token") or self.config.get("ingest_token")

    def configured(self) -> bool:
        return bool(self.url())

    # ── emission ─────────────────────────────────────────────────────────────
    def enqueue(self, record: dict):
        """Buffer + attempt a best-effort flush. Never raises."""
        self._buffer.append(record)
        # Flush immediately so denials reach the control plane promptly, but
        # tolerate offline by keeping the record buffered on failure.
        self.flush()

    def flush(self) -> bool:
        if not self._buffer:
            return True
        if not self.configured():
            # No endpoint configured -> spool-only mode; drop the network buffer
            # (the durable JSONL spool already holds the records).
            self._buffer.clear()
            return True
        payload = {"events": list(self._buffer)}
        try:
            self._post(payload)
            self._buffer.clear()
            self._last_error = None
            return True
        except (urllib.error.URLError, OSError, ValueError) as exc:
            self._last_error = str(exc)
            # Keep records buffered for a later flush; cap buffer to avoid growth.
            if len(self._buffer) > 1000:
                self._buffer = self._buffer[-1000:]
            return False

    def _post(self, payload: dict):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        req = urllib.request.Request(self.url(), data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        token = self.token()
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        opener = self._opener or urllib.request.urlopen
        resp = opener(req, timeout=self.timeout)
        # Drain/close if it's a real HTTP response.
        try:
            status = getattr(resp, "status", None) or resp.getcode()
        except Exception:  # noqa: BLE001
            status = 200
        if status is not None and not (200 <= int(status) < 300):
            raise ValueError(f"ingest returned status {status}")
        close = getattr(resp, "close", None)
        if callable(close):
            close()
