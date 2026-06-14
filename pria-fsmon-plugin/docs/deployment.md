# B8 — fsmon ↔ guest-agent policy push + audit emit

This document freezes the contract between `synaps_fsmon` (Track B, B7) and the
Pria **guest agent** (Track A, A11) + **audit ingest** (Track A, A15). The
control-plane side is **stubbed** here (`scripts/guest_agent_stub.py`) so the
round-trip is demonstrable without the real guest agent / image (HS-IMG).

```
                 central policy (A11/A12, §11.2a)
                          │
            POST /guest/v1/policy/apply  (mTLS, A11)
                          │
                   ┌──────▼───────┐
                   │ guest agent  │  (in-VM, part of the VM image — HS-IMG)
                   │  - uid→sess  │
                   │  - ingest tok│
                   └───┬──────▲───┘
       control.sock    │      │  forward.sock (NDJSON audit envelopes)
   {"type":"policy_apply"}    │
                   ┌───▼──────┴───┐
                   │ synaps_fsmon │  (B7 sibling daemon, CAP_SYS_ADMIN)
                   │  L1 cache    │
                   │  fanotify    │
                   └──────────────┘
                          │ POST /agents/ingest/events (A15)
                          ▼  (performed by the guest agent, bearer token)
                    agent_event (synaps-sidecar adapter, D-2)
```

## 1. Policy push (guest agent → fsmon)

Local Unix socket `--control` (default `/run/synaps/fsmon/control.sock`),
newline-delimited JSON. The guest agent's `POST /guest/v1/policy/apply` handler
forwards the centrally-authored policy here.

Request:
```json
{
  "type": "policy_apply",
  "policy": {
    "default_decision": "allow",
    "immutable_prefixes": ["/srv/synaps/policy", "/srv/synaps/account.json"],
    "dlp_substrings": [".env", "id_rsa"],
    "high_risk_prefixes": ["/srv/synaps", "/etc"],
    "rules": [
      {"uid": null, "path_prefix": "/srv/accounts", "op": "open_write",
       "decision": "allow"}
    ],
    "principals": [
      {
        "uid": 12001,
        "account_id": "acct_123", "instance_id": "inst_456",
        "user_id": "user_789", "session_id": "sess_def", "vm_id": "vm_abc",
        "instance_roots": ["/srv/accounts/acme-school/instances/tutor-bot-7"],
        "home_root": "/home/alice_acme"
      }
    ]
  }
}
```

Response: `{"type":"ok","cache_len":0}` — **the L1 cache is cleared on every
apply** (hot refresh, no restart, no per-write network call).

Other control messages: `{"type":"ping"}`, `{"type":"stats"}`,
`{"type":"set_degraded","degraded":true}`.

> The `principals[]` table is how the guest agent supplies the `uid → {account,
> instance, user, session, vm, allowed roots}` mapping (spec §6.3). fsmon uses
> it both for the containment decision and to **tag** every audit record.

## 2. Audit emit (fsmon → guest agent → ingest)

fsmon writes every decision to its durable JSONL spool **and** streams it as an
NDJSON `AuditForwardEnvelope` to the guest agent's `--forward` socket:

```json
{"source":"synaps-sidecar","events":[ <file-write decision record> ]}
```

The decision record matches `docs/contract.md` §2.3 (`pria-session-context-plugin`):

```json
{
  "schema_version": 1, "event_id": "evt_…", "kind": "file.write.denied",
  "source": "synaps-sidecar",
  "account_id": "acct_123", "instance_id": "inst_456", "user_id": "user_789",
  "vm_id": "vm_abc", "session_id": "sess_def", "linux_uid": 12001,
  "path": "/srv/accounts/acme-school/instances/lab-grader-2/workspace/secret.env",
  "op": "open_write", "decision": "deny", "reason": "cross_instance_write",
  "timestamp": "2026-06-14T00:00:01Z"
}
```

The **guest agent** (holding the ingest bearer token + the uid→session map)
performs the authenticated POST to A15:

```
POST {ingest_url}/agents/ingest/events
Authorization: Bearer <ingest_token>
{ "events": [ <record>, … ] }
```

A15's `synaps-sidecar` adapter maps `kind:"file.write.denied"` →
`appendAgentEvent({eventType:"safety.policy_violation", source:"synaps-sidecar",
metadata:{accountId, vmId, linuxUid, path, op, decision, reason, toolCallId}})`
(per D-2: IDs ride in `metadata`).

> **Why fsmon does not POST to ingest directly.** Keeping the daemon
> dependency-light and CAP-scoped means no embedded TLS HTTP stack and no ingest
> secret on the fanotify host. The guest agent already terminates mTLS, holds the
> token, and owns the uid→session map (A11), so it is the correct egress point.
> This stays entirely within the no-core-change boundary.

## 3. systemd unit (illustrative — assembled in the VM image, HS-IMG)

```ini
[Unit]
Description=Pria in-VM file-write monitor (synaps_fsmon)
After=network.target srv-synaps.mount

[Service]
User=synaps_fsmon
AmbientCapabilities=CAP_SYS_ADMIN
ExecStart=/usr/local/bin/synaps_fsmon run \
  --mount /srv \
  --spool /srv/synaps/audit-spool/fsmon.jsonl \
  --control /run/synaps/fsmon/control.sock \
  --forward /run/synaps/guest-agent/audit.sock \
  --policy /srv/synaps/policy/fsmon.json
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

The guest agent (not SynapsCLI) owns `Restart=always` supervision (HS-5).
