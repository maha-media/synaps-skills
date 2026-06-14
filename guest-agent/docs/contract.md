# Pria Guest-Agent — Track B Contract (GA-B0)

**Status:** Frozen v1 (mirrors control-plane GA-A0).
**Owner:** Pria agentic-VM Track B.
**Scope:** the in-VM Rust guest-agent's frozen contracts: the HMAC canonical
string + header set, the per-VM bootstrap config, the Pria callback payloads,
and the `SYNAPS_SESSION_CONTEXT` file path/schema. These are the two artifacts
that let Track A (Node) and Track B (Rust) build in parallel against fakes.

This document is authoritative for the Rust crate and is byte-compatible with
`pria-ui-v22` GA-A0/GA-A1. **SynapsCLI is never modified** (see §5).

---

## 1. HMAC authentication (spec §5)

### 1.1 Canonical string (spec §5.2)

The HMAC-SHA256 signature is computed over the canonical string built by joining
these nine fields with a single `\n` (0x0A) separator, **no trailing newline**:

```text
METHOD\n
PATH\n
QUERY_STRING_CANONICAL\n
TIMESTAMP_MS\n
NONCE\n
ACCOUNT_ID\n
VM_ID\n
SESSION_ID_OR_EMPTY\n
BODY_SHA256_HEX
```

- `METHOD` — upper-case HTTP method (`GET`, `POST`, …).
- `PATH` — the request path, no query (e.g. `/guest/v1/health`).
- `QUERY_STRING_CANONICAL` — query params sorted by key, `k=v` joined by `&`,
  empty string when there is no query.
- `TIMESTAMP_MS` — milliseconds since epoch, decimal string.
- `NONCE` — the `X-Pria-Nonce` value (base64url random).
- `ACCOUNT_ID`, `VM_ID` — the bound identifiers.
- `SESSION_ID_OR_EMPTY` — the session id, or `""` when absent.
- `BODY_SHA256_HEX` — lower-case hex SHA-256 of the raw request body
  (SHA-256 of the empty string when there is no body).

The signature is lower-case hex of `HMAC_SHA256(secret, canonical_string)`.

### 1.2 Golden vector (shared with GA-A1)

```text
secret         = "local-dev-generated-secret"
METHOD         = "POST"
PATH           = "/guest/v1/sessions/start"
QUERY          = ""
TIMESTAMP_MS   = "1790000000000"
NONCE          = "nonce-abc-123"
ACCOUNT_ID     = "acct_local_123"
VM_ID          = "vm_local_456"
SESSION_ID     = "sess_abc"
BODY           = "{\"hello\":\"world\"}"
BODY_SHA256    = 93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588
SIGNATURE      = eba9ba5e3577be996992878db905837d3ee8186c11fe801578d87a730a38b61e
```

The Rust crate freezes the computed signature in `tests/hmac_tests.rs`; the Node
peer (`test/services/agenticVmHmac.test.js`) must produce the identical value.

### 1.3 Headers (spec §5.2)

```http
X-Pria-Account-Id:    acct_...
X-Pria-VM-Id:         vm_...
X-Pria-Session-Id:    sess_...        # optional
X-Pria-Timestamp-Ms:  1790000000000
X-Pria-Nonce:         base64url-random
X-Pria-Body-SHA256:   hex
X-Pria-Signature:     hex-hmac-sha256
X-Pria-Key-Id:        key_...         # optional but recommended for rotation
```

### 1.4 Replay protection (spec §5.3)

Reject when:
- timestamp skew exceeds `security.max_timestamp_skew_seconds` (default 300s),
- nonce already seen within `security.nonce_cache_seconds` (default 300s),
- `X-Pria-Body-SHA256` does not match the actual body hash,
- account/vm/session binding does not match the agent's configured identity,
- signature mismatch (timing-safe compare).

Mapped error codes (spec §15): `unauthorized_hmac_missing`,
`unauthorized_hmac_invalid`, `unauthorized_replay_detected`,
`forbidden_account_vm_mismatch`.

---

## 2. Bootstrap config (spec §5.5 / §14)

```yaml
mode: local-virsh
account_id: acct_123
vm_id: vm_456
replica_id: replica_0
listen:
  host: 0.0.0.0
  port: 47831
pria:
  base_url: http://host.libvirt.internal:3000
  hmac_key_id: key_123
  hmac_secret_file: /etc/pria/guest-agent.hmac
paths:
  efs_root: /efs/accounts/acct_123
  run_root: /run/pria
  policy_dir: /efs/accounts/acct_123/policy
  audit_spool_dir: /efs/accounts/acct_123/audit-spool
synaps:
  binary: /usr/local/bin/synaps
  plugin_dir: /opt/synaps/plugins
fsmon:
  socket: /run/pria/fsmon.sock
  forward_socket: /run/pria/fsmon-forward.sock
heartbeat:
  interval_seconds: 15
security:
  max_timestamp_skew_seconds: 300
  nonce_cache_seconds: 300
```

The HMAC secret is read from `pria.hmac_secret_file` (file mode 0600), never from
committed config (spec §16.3).

---

## 3. Session-context file (spec §8, frozen in A0/B0)

The guest agent writes the context **file** and (best-effort) sets
`SYNAPS_SESSION_CONTEXT` on the launched **synaps parent** process. Core ignores
the env var (HS-2/HS-7) — the `pria-session-context` plugin consumes the file.

**Canonical write path** (matches the plugin's resolution order #1):

```text
${XDG_RUNTIME_DIR}/synaps/sessions/<session_id>/context.json
```

When `XDG_RUNTIME_DIR` is unset, the agent falls back to
`${run_root}/sessions/<session_id>/context.json` (spec §6.4 `context_path`) and
mirrors to `${HOME}/.synaps-cli/sessions/<session_id>/context.json` so the plugin
resolves it (resolution order #2).

The written object satisfies
`pria-session-context-plugin/docs/session-context.schema.json` (required:
`account_id, instance_id, user_id, linux_username, linux_uid, vm_id, session_id,
roles, issued_at, expires_at`). It MUST NOT carry long-lived secrets (§16.3).

---

## 4. Pria callbacks (spec §7) — all HMAC signed

| Endpoint | Payload | Slice |
|----------|---------|-------|
| `POST /internal/agentic-vm/heartbeat` | §7.1 | GA-B4 |
| `POST /internal/agentic-vm/audit` | §7.2 audit families | GA-B4/GA-B8 |
| `POST /internal/agentic-vm/session-event` | §7.3 | GA-B4/GA-B6 |
| `POST /internal/agentic-vm/credential-request` | §7.4 | GA-B4 |

When Pria is unreachable, audit callbacks spool to
`paths.audit_spool_dir` (spec §9.4) and never crash the hot path.

---

## 5. HARD STOP register (confirmed against real SynapsCLI code)

This crate builds the documented mitigations; it NEVER edits SynapsCLI core.
See the implementation-plan §4 register (HS-1…HS-9, HS-IMG). Each is reconfirmed
in the final progress report with file/line evidence.

- **HS-2/HS-7** — `process.rs:643-648` `env_clear()` + 5-var allowlist; 0 hits
  for `SYNAPS_SESSION_CONTEXT`. → file delivery (§3).
- **HS-3** — `watcher/supervisor.rs` heartbeat hardcoded `{session,pid}`. →
  guest-agent emits the rich heartbeat (GA-B4).
- **HS-5** — `sidecar/spawn.rs` is a plugin-arg RPC, not a daemon supervisor. →
  fsmon is a sibling daemon supervised by the guest agent (GA-B7/B8).
- **HS-6** — `core/rpc_protocol.rs` `RpcEvent` carries no account/session tags.
  → guest agent tags at the boundary and relays via session-event (GA-B6).
