"""Raw-usage → Pria usage-ingest transform (AC-B2.1, live under protocol v2).

This module is the plugin-side half of the agentic credits / usage-metering
path (spec §5/§6). Now that SynapsCLI core (Track C) ships the `on_usage` hook
and bumps the extension protocol to v2, the plugin manifest declares
`on_usage` and core delivers raw LLM token usage to `app._on_usage`, which calls
into this module:

  * It emits **raw usage only** — token/cache counts, provider, model. It MUST
    NOT compute or include Pria `credits`; Pria's rating engine is the sole
    authority (spec §5.5). `assert_raw_only` enforces this on every batch.
  * Identity (account/instance/user/vm/session) comes from the file-delivered
    session context (HS-2: extensions run under `env_clear()`, so there is no
    `SYNAPS_SESSION_CONTEXT` env var — the context arrives as a file keyed by
    `session_id`; see contract §1.2).
  * The forward target is the **guest-agent local signing proxy**, which holds
    the Pria HMAC key and re-stamps trusted identity before POSTing to
    `/internal/agentic-vm/usage` (AC-B2.2, resolves open Q10 → guest-agent
    signs). The transport shape is identical to a direct POST.

Responsibilities (all pure / side-effect-free except `forward`):
  * `usage_from_hook(event)`   — normalise an `on_usage` HookEvent → raw usage.
  * `derive_idempotency_key(...)` — stable dedupe key when the runtime gives none.
    Mirrors the guest-agent fallback hashing byte-for-byte so the two ingest
    paths derive convergent `usage_hash` values (spec §6.4).
  * `build_usage_batch(ctx, ...)` — join raw usage with file-delivered session
    context (account/instance/user/vm/session) into the spec §6.2 request body.
  * `UsageForwarder` — best-effort POST via the existing `IngestSink` transport
    pattern (spool-tolerant, never raises on the hot path).
"""
import hashlib
import json
from datetime import datetime, timezone

# Canonical event type for LLM token usage (spec §6.2 `events[].type`).
EVENT_TYPE_LLM_TOKENS = "llm.tokens"

# Source tag identifying this emission path (spec §6.1 / model `source`).
SOURCE_ON_USAGE = "synaps-hook-on-usage"

# Raw token fields we recognise inside the hook's `usage` object. Order is
# significant for the idempotency hash so the key is stable across runs.
USAGE_TOKEN_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cache_creation_5m",
    "cache_creation_1h",
)

# Session-context fields lifted into the ingest envelope (top-level attribution).
_CONTEXT_ENVELOPE_FIELDS = (
    "account_id",
    "instance_id",
    "user_id",
    "vm_id",
    "replica_id",
    "session_id",
    "ephemeral_task_id",
)


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalise_usage(raw: dict) -> dict:
    """Project an arbitrary usage dict onto the recognised token fields.

    Missing numeric fields default to 0 for the always-present pair
    (input/output/cache_read/cache_creation) and to ``None`` for the optional
    cache-TTL split (mirrors `SessionEvent::Usage` / `TurnUsage` where the
    5m/1h breakdown is `Option<u64>`). Non-int values are coerced/skipped.
    """
    raw = raw or {}
    out = {}
    for field in USAGE_TOKEN_FIELDS:
        val = raw.get(field)
        if val is None:
            # 5m/1h are genuinely optional; the four core counts default to 0.
            out[field] = None if field in ("cache_creation_5m", "cache_creation_1h") else 0
            continue
        try:
            out[field] = int(val)
        except (TypeError, ValueError):
            out[field] = None if field in ("cache_creation_5m", "cache_creation_1h") else 0
    return out


def usage_from_hook(event: dict) -> dict:
    """Extract the raw-usage record from an `on_usage` HookEvent payload.

    The hook payload (spec §5.3) carries its fields under `data`. We tolerate
    a flattened shape too (fields directly on the event) for forward-compat.
    Returns a dict with: provider, model, session_id, message_id, turn_id,
    usage (normalised), occurred_at, source_event. Never raises.
    """
    event = event or {}
    data = event.get("data")
    if not isinstance(data, dict):
        data = event
    src = data.get("source") if isinstance(data.get("source"), dict) else {}
    return {
        "provider": data.get("provider"),
        "model": data.get("model"),
        "session_id": data.get("session_id") or event.get("session_id"),
        "message_id": data.get("message_id"),
        "turn_id": data.get("turn_id"),
        "usage": normalise_usage(data.get("usage") or {}),
        "occurred_at": data.get("occurred_at") or _utcnow_iso(),
        "source_event": src.get("event"),
    }


def usage_hash(usage: dict) -> str:
    """Stable short hash of the normalised token counts (idempotency input)."""
    canonical = json.dumps(
        {f: usage.get(f) for f in USAGE_TOKEN_FIELDS},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def derive_idempotency_key(session_id, message_id, turn_id, event_type, usage):
    """Derive a stable idempotency key (spec §6.4).

    Preferred dedupe identity is `session_id + (message_id|turn_id) + type +
    usage_hash`. This must match the guest-agent fallback derivation so the two
    ingest paths collapse onto the same key for the same billable turn.
    """
    correlator = message_id or turn_id or "noid"
    return "synaps:{sid}:{cor}:{etype}:{uh}".format(
        sid=session_id or "nosession",
        cor=correlator,
        etype=event_type,
        uh=usage_hash(usage),
    )


def build_usage_event(record: dict, event_type: str = EVENT_TYPE_LLM_TOKENS) -> dict:
    """Build a single spec §6.2 `events[]` entry from a `usage_from_hook` record.

    Emits raw usage ONLY — there is deliberately no `credits` field.
    """
    usage = record.get("usage") or {}
    idem = derive_idempotency_key(
        record.get("session_id"),
        record.get("message_id"),
        record.get("turn_id"),
        event_type,
        usage,
    )
    metadata = {}
    if record.get("message_id") is not None:
        metadata["message_id"] = record["message_id"]
    if record.get("turn_id") is not None:
        metadata["turn_id"] = record["turn_id"]
    if record.get("source_event") is not None:
        metadata["source_event"] = record["source_event"]
    return {
        "idempotency_key": idem,
        "type": event_type,
        "provider": record.get("provider"),
        "model": record.get("model"),
        "occurred_at": record.get("occurred_at") or _utcnow_iso(),
        "usage": usage,
        "metadata": metadata,
    }


def build_usage_batch(ctx, records, source: str = SOURCE_ON_USAGE) -> dict:
    """Join raw-usage records with the file-delivered session context (HS-2).

    `ctx` is the plugin `SessionContext` (account/instance/user/vm/session come
    from the context FILE, never env — see contract §1.2). `records` is a list
    of `usage_from_hook` dicts. Returns the spec §6.2 request body.
    """
    envelope = {}
    raw_ctx = getattr(ctx, "raw", None) or {}
    for field in _CONTEXT_ENVELOPE_FIELDS:
        envelope[field] = raw_ctx.get(field)
    # session_id may also be known directly on the ctx even if absent from raw.
    if not envelope.get("session_id") and getattr(ctx, "session_id", None):
        envelope["session_id"] = ctx.session_id
    envelope["source"] = source
    envelope["events"] = [build_usage_event(r) for r in records]
    return envelope


def assert_raw_only(batch: dict) -> None:
    """Guard: ingest payloads must never carry Pria credits (spec §5.5)."""
    for ev in batch.get("events", []):
        if "credits" in ev or "credit_cost" in ev:
            raise ValueError("usage event must not contain credits (raw-only, spec §5.5)")


class UsageForwarder:
    """Best-effort usage forwarder reusing the IngestSink transport pattern.

    Resolves a dedicated `usage_url`/`usage_token` first, then falls back to the
    audit `ingest_url`/`ingest_token`. Spool-tolerant: failures never raise on
    the hook hot path. This is the plugin-direct path; in production (AC-B2.x)
    the guest agent signs/proxies to `/internal/agentic-vm/usage`, but the
    transport shape (envelope == request body) is identical.

    Unlike the audit `IngestSink` (which wraps records as ``{"events": [...]}``),
    the usage envelope IS the spec §6.2 request body — account/instance/user
    attribution lives at the top level — so we POST it verbatim.
    """

    DEFAULT_TIMEOUT = 2.0

    def __init__(self, ctx, config=None, opener=None, timeout=DEFAULT_TIMEOUT):
        self.ctx = ctx
        self.config = config or {}
        self._opener = opener  # injectable for tests
        self.timeout = timeout
        self._buffer = []
        self._last_error = None

    def url(self):
        return (
            self._lookup("usage_url")
            or self._lookup("ingest_url")
        )

    def token(self):
        return (
            self._lookup("usage_token")
            or self._lookup("ingest_token")
        )

    def _lookup(self, key):
        ctx_get = getattr(self.ctx, "get", None)
        if callable(ctx_get):
            val = self.ctx.get(key)
            if val:
                return val
        return self.config.get(key)

    def configured(self) -> bool:
        return bool(self.url())

    def forward(self, batch: dict) -> bool:
        """Validate raw-only, then best-effort POST the §6.2 envelope.

        Never raises. On failure the envelope is buffered for a later flush
        (the durable spool lives elsewhere; this is the in-proc retry buffer).
        """
        assert_raw_only(batch)
        self._buffer.append(batch)
        return self.flush()

    def flush(self) -> bool:
        if not self._buffer:
            return True
        if not self.configured():
            # No endpoint -> spool-only mode (durable spool is the buffer).
            self._buffer.clear()
            return True
        pending = list(self._buffer)
        ok = True
        for envelope in pending:
            try:
                self._post(envelope)
                self._buffer.remove(envelope)
                self._last_error = None
            except Exception as exc:  # noqa: BLE001
                self._last_error = str(exc)
                ok = False
        if len(self._buffer) > 1000:
            self._buffer = self._buffer[-1000:]
        return ok

    def _post(self, envelope: dict):
        import urllib.request

        body = json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        req = urllib.request.Request(self.url(), data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        token = self.token()
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        opener = self._opener or urllib.request.urlopen
        resp = opener(req, timeout=self.timeout)
        try:
            status = getattr(resp, "status", None) or resp.getcode()
        except Exception:  # noqa: BLE001
            status = 200
        if status is not None and not (200 <= int(status) < 300):
            raise ValueError(f"usage ingest returned status {status}")
        close = getattr(resp, "close", None)
        if callable(close):
            close()

