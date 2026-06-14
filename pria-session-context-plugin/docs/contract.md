# Pria ⇄ Synaps In-VM Contract (Track B / B0)

**Status:** Frozen v1 (mirrors control-plane A0).
**Owner:** Pria agentic-VM Track B.
**Scope:** the *plugin-side* contract for (1) session-context delivery and
(2) the audit record schema emitted by the `pria-session-context` extension and
the `synaps_fsmon` sibling daemon.

This document is the authoritative Track B copy of the shared A0 contracts. It is
deliberately **environment-variable-free** for context delivery (see §1.2).

---

## 1. Session-context delivery

### 1.1 The record (spec §5.4)

```json
{
  "account_id": "acct_123",
  "account_slug": "acme-school",
  "instance_id": "inst_456",
  "instance_slug": "tutor-bot-7",
  "user_id": "user_789",
  "linux_username": "alice_acme",
  "linux_uid": 12001,
  "vm_id": "vm_abc",
  "session_id": "sess_def",
  "roles": ["agent_operator", "workspace_editor"],
  "policy_profile_id": "pol_001",
  "issued_at": "2026-06-14T00:00:00Z",
  "expires_at": "2026-06-14T01:00:00Z"
}
```

Optional, additive fields the plugin recognises (ignored if absent):

| Field | Type | Purpose |
|-------|------|---------|
| `ingest_url` | string (URL) | Pria audit ingest endpoint (B4). |
| `ingest_token` | string | Bearer token for the ingest endpoint (B4). |
| `credential_broker_url` | string (URL) | Credential broker `issue`/`revoke` base (B5). |
| `policy` | object | Inline tool-policy document (B3); see §3. |

> Secrets (`ingest_token`) MAY also arrive via plugin **config** (manifest
> `config[].secret_env` / user config) instead of the context file. The plugin
> prefers the context-file value, then config.

### 1.2 Delivery path — **file keyed by `session_id`, NOT env var**

**HARD STOP HS-2 (CONFIRMED).** SynapsCLI spawns every extension process with
`env_clear()` and forwards **only** `PATH, HOME, LANG, TERM, XDG_RUNTIME_DIR`
(evidence: `crates/agent-engine/src/extensions/runtime/process.rs:643-648`).
The `InitializeParams` passed to `initialize` carries only
`synaps_version, extension_protocol_version, plugin_id, plugin_root, config`
(evidence: `process.rs:34-40`) — **no session context**. A repo-wide grep for
`SYNAPS_SESSION_CONTEXT` / `SessionContext` returns **zero hits** in `src/` and
`crates/`. Therefore the spec §9.1 `SYNAPS_SESSION_CONTEXT` env var **cannot**
reach the extension without a SynapsCLI core change.

**Mitigation (plugin-only):** the control plane writes the context as a file
keyed by `session_id`. The extension learns `session_id` from the
`on_session_start` `HookEvent.session_id` field and reads the matching file.

**Resolution order** (first existing file wins):

1. `${XDG_RUNTIME_DIR}/synaps/sessions/<session_id>/context.json`
2. `${HOME}/.synaps-cli/sessions/<session_id>/context.json`
3. `${SYNAPS_BASE_DIR}/sessions/<session_id>/context.json`
   (only when `SYNAPS_BASE_DIR` is present — it is NOT in the forwarded
   allowlist, so treat as best-effort)

Both `XDG_RUNTIME_DIR` and `HOME` **are** in the forwarded allowlist, so paths 1
and 2 are always resolvable inside the extension process.

### 1.3 Lifecycle

- Read + cache on `on_session_start`.
- Re-stamp every emitted record (audit/policy/credential) with the cached IDs.
- Clear the cache on `on_session_end`.
- If no context file is found, the plugin operates in **degraded** mode: it still
  emits audit records (tagged `context: "missing"`) and **fails closed** on
  policy decisions for high-risk tools (deny), never silently allowing.

---

## 2. Audit record schema (spec §9.3)

All records share an envelope; `kind` selects the variant. Records are emitted to
every configured sink (local JSONL spool, Pria ingest, stdout) — see B4.

### 2.1 Envelope (common fields)

```json
{
  "schema_version": 1,
  "event_id": "evt_001",
  "kind": "tool.call.started",
  "source": "synaps-extension",
  "account_id": "acct_123",
  "instance_id": "inst_456",
  "user_id": "user_789",
  "vm_id": "vm_acct_123",
  "session_id": "sess_def",
  "linux_uid": 12001,
  "timestamp": "2026-06-14T00:00:00Z"
}
```

`source ∈ {"synaps-extension", "synaps-sidecar"}` — both already present in the
control-plane `EVENT_SOURCE` enum (`routes/models/agentControlCenter.js`). The
extension uses `synaps-extension`; the fsmon daemon uses `synaps-sidecar`.

### 2.2 Tool-call records (B3, from the extension)

```json
{
  "schema_version": 1,
  "event_id": "evt_001",
  "kind": "tool.call.started",
  "source": "synaps-extension",
  "account_id": "acct_123", "instance_id": "inst_456", "user_id": "user_789",
  "vm_id": "vm_acct_123", "session_id": "sess_def", "linux_uid": 12001,
  "tool_call_id": "tool_999",
  "tool_name": "bash",
  "cwd": "/srv/accounts/acme-school/instances/tutor-bot-7/workspace",
  "timestamp": "2026-06-14T00:00:00Z"
}
```

`kind ∈ {tool.call.started, tool.call.completed, tool.call.blocked,
tool.call.confirm_required, tool.call.modified}`.
Blocked/confirm/modified records add `decision` and `reason`.

Canonical→legacy mapping (control-plane A15 adapter performs this; documented here
for traceability):

| plugin `kind` | canonical `eventType` | legacy bucket |
|---------------|----------------------|---------------|
| `tool.call.started` | `tool.started` | `tool_call` |
| `tool.call.completed` | `tool.completed` | `tool_call` |
| `tool.call.blocked` | `tool.blocked` | `safety.policy_violation` |
| `tool.call.confirm_required` | `tool.confirm_required` | `safety` |
| `file.write.denied` | `safety.policy_violation` | `safety.policy_violation` |
| `credential.issued` | `credential.issued` | `credential` |
| `credential.denied` | `credential.denied` | `safety` |

### 2.3 File-write decision records (B7/B8, from `synaps_fsmon`)

```json
{
  "schema_version": 1,
  "event_id": "evt_002",
  "kind": "file.write.denied",
  "source": "synaps-sidecar",
  "account_id": "acct_123", "instance_id": "inst_456", "user_id": "user_789",
  "vm_id": "vm_acct_123", "session_id": "sess_def", "linux_uid": 12001,
  "path": "/srv/accounts/acme-school/instances/lab-grader-2/workspace/secret.env",
  "op": "open_write",
  "decision": "deny",
  "reason": "cross_instance_write",
  "timestamp": "2026-06-14T00:00:01Z"
}
```

`kind ∈ {file.write.allowed, file.write.denied}`;
`op ∈ {open_write, open_read, access}`;
`decision ∈ {allow, deny}`;
`reason ∈ {cross_instance_write, out_of_home, immutable_path, dlp_match,
policy_default_deny, monitor_degraded, allowed}`.

---

## 3. Tool-policy document (B3)

Centrally authored (spec §11.2a), delivered inline in `context.policy` or as a
separate file alongside the context (`policy.json`). Shape:

```json
{
  "version": 1,
  "default": "allow",
  "rules": [
    {"tool": "bash", "input_contains": "rm -rf /", "decision": "block",
     "reason": "destructive_root_delete"},
    {"tool": "bash", "input_contains": "curl", "decision": "confirm",
     "message": "Outbound network from shell requires confirmation"},
    {"tool": "subagent", "decision": "confirm",
     "message": "Spawning a subagent requires confirmation"},
    {"tool": "write", "path_outside_instance": true, "decision": "block",
     "reason": "cross_instance_write"},
    {"tool": "request_credential", "decision": "allow"}
  ]
}
```

Decision points are mapped onto the **existing** `before_tool_call` hook with
per-tool filters — see HS-1 mitigation. There are NO dedicated
`before_file_write` / `before_credential_request` / `before_subagent_spawn` hooks
(HookKind is a closed enum — `events.rs:21-40`).

---

## 4. Ingest endpoint (B4)

```
POST {ingest_url:-https://<pria>/agents/ingest/events}
Authorization: Bearer <ingest_token>
Content-Type: application/json

{ "events": [ <audit record>, ... ] }
```

`principal.source` is derived from the bearer token (control-plane side) and must
be one of `{synaps-extension, synaps-sidecar}`. Offline → spool-only, no crash.
