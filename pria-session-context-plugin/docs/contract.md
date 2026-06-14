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

---

## 5. Usage metering (HS-U*) — Track B1 pre-core assessment

**Status:** CONFIRMED against SynapsCLI read-only @ `crates/agent-engine` and
`crates/agent-core` (this checkout). This section is the authoritative HARD STOP
register that **gates Track C** (SynapsCLI core). Each finding is reproduced with
exact path/line evidence and the single required core change.

> Track B1 rule: do **not** edit SynapsCLI. The `on_usage` hook (spec §5) cannot
> be delivered to a plugin without core changes. The plugin manifest therefore
> stays `protocol_version: 1` and does **not** declare `on_usage` until Track C
> ships protocol v2. The no-core-change fallback is RPC `AgentEnd.usage` metered
> at the guest-agent boundary (HS-U6, §0.2 of the spec).

### 5.1 HARD STOP register (CONFIRMED)

| ID | Hard stop | Evidence (this checkout) | Verdict | Required SynapsCLI (Track C) change |
|----|-----------|--------------------------|---------|-------------------------------------|
| **HS-U1** | `HookKind` is a **closed enum** with 7 variants and no usage variant; plugins cannot subscribe to or receive token usage. | `crates/agent-engine/src/extensions/hooks/events.rs:25-40` (enum: `BeforeToolCall, AfterToolCall, BeforeMessage, OnMessageComplete, OnCompaction, OnSessionStart, OnSessionEnd`); `as_str` `:45-55`; `from_str` `:62-73`; `allowed_action_names` `:76-83`; `allows_result` `:91-100`; `required_permission` `:107-113`. Doc comment `:20-22` states "The set is intentionally closed; new kinds are added via a breaking version bump." | **CONFIRMED** | Add `HookKind::OnUsage` ("on_usage") and update **every** match arm: `as_str`/`from_str`, `allowed_action_names`→`["continue"]`, `allows_tool_filter`→false, `allows_result`→`Continue` only, `required_permission` (see HS-U5). Add `HookEvent::on_usage(...)` constructor carrying the §5.3 payload in `data`. |
| **HS-U2** | The authoritative token counts live in `runtime/api.rs` stream-parse state, whose context (`EventCtx`) has **no `hook_bus` handle** — so the hook cannot be emitted from where usage is actually known. | `crates/agent-engine/src/runtime/api.rs:193-205` (`struct EventCtx` carries only `tx`, `telemetry_level`, `request_start`, `cache_ttl`, two `AtomicBool` latches — no `hook_bus`); the single authoritative emission `api.rs:424-437` sends `SessionEvent::Usage` via `ctx.tx` only. The `hook_bus` **is** available one layer up in `runtime/stream.rs:43,221` (used for `on_message_complete`) but that scope has no token counts. A grep for `hook` in `api.rs` returns zero hits. | **CONFIRMED** | Plumb a `hook_bus` handle (or a usage→hook bridge channel) into the stream-parse context so the authoritative `message_delta` emission **also** fires `OnUsage`. Must reuse the `state.usage_emitted` single-emit latch (`api.rs:428`) so message_start (`api.rs:441-468`, capture-only) and the residual path (`api.rs:517-543`) do not double-emit. |
| **HS-U3** | Manifest validation **hard-rejects** any `protocol_version != 1`; a plugin declaring `on_usage` cannot also declare protocol v2 today. | `crates/agent-engine/src/extensions/manifest.rs:10` (`CURRENT_EXTENSION_PROTOCOL_VERSION = 1`); `validate()` `:113-118` returns `Err` for `protocol_version != CURRENT_EXTENSION_PROTOCOL_VERSION`. | **CONFIRMED** | Accept a supported **set** (`{1,2}`); bump `CURRENT_EXTENSION_PROTOCOL_VERSION = 2`. v1 manifests must still validate; v1 plugins must **never** be delivered `OnUsage` (the bus must not send unknown kinds to a plugin that did not subscribe). |
| **HS-U4** | `SessionEvent::Usage.model` is hard-coded `None` at the only authoritative emission site, so usage carries no model attribution. | `crates/agent-engine/src/runtime/api.rs:436` (`model: None`) — also the residual path `api.rs` (`emit_residual_usage`) emits `model: None`. The field exists on the type: `crates/agent-core/src/core/stream_types.rs` `SessionEvent::Usage{...model: Option<String>}` and mirror `TurnUsage.model: Option<String>` at `crates/agent-core/src/core/rpc_protocol.rs:98-100`. | **CONFIRMED** | Populate `model` from runtime/session config at the emission site when known; else `null`. Carry the same `model` into the `OnUsage` payload. Pria may backfill from session-start/RPC `Ready` when `null`. |
| **HS-U5** | A permission is needed to gate `OnUsage` subscription; no usage/metering permission exists. | `crates/agent-engine/src/extensions/permissions.rs:14-39` (`enum Permission`: `ToolsIntercept, ToolsOverride, LlmContent, SessionLifecycle, ToolsRegister, ProvidersRegister, MemoryRead, MemoryWrite, AudioInput, AudioOutput`). `required_permission` mapping `events.rs:107-113` has no usage arm. | **CONFIRMED** | Decide & wire a permission for `OnUsage`. Either reuse `Permission::LlmContent` (`privacy.llm_content` — usage is derived from LLM turns, and the Pria plugin already holds it) **or** add a dedicated `Permission::UsageMetering` (`usage.metering`). Recommendation: reuse `LlmContent` to avoid a permission-catalog change; document the choice. Map `OnUsage.required_permission()` accordingly. |
| **HS-U6** | RPC events carry **no** account/instance/user/session tags. | `crates/agent-core/src/core/rpc_protocol.rs:272-275` (`RpcEvent::AgentEnd { usage: TurnUsage }` — no identity fields); `TurnUsage` `:80-101`. Guest-side mitigation already shipped: `guest-agent/src/synaps/launcher.rs:95-117` (`tag_rpc_event`). | **CONFIRMED — MITIGATED (no core change)** | None. Keep `RpcEvent::AgentEnd { usage }` unchanged as the fallback/cross-check. The guest agent tags it with session identity at the boundary (AC-B1.3). |
| **HS-2 (carried)** | Extensions run under `env_clear()` + a 5-var allowlist; the spec §9.1 `SYNAPS_SESSION_CONTEXT` env var cannot reach the extension. | See §1.2 above (`process.rs:643-648`). | **CONFIRMED (prior)** | No core change. The usage path joins raw usage with the **file-delivered** session context (§1.2), exactly like audit tagging. |

### 5.2 Track C requirements (exact edits, derived from B1)

Track C **must not start** until HS-U1..U5 are confirmed (done, above). The exact
core edits Track C must land:

1. **`events.rs`** — add `HookKind::OnUsage`; extend `as_str`, `from_str`,
   `allowed_action_names` (→ `&["continue"]`), `allows_tool_filter` (→ `false`),
   `allows_result` (→ `Continue` only), `required_permission` (→ chosen
   permission, HS-U5). Add `HookEvent::on_usage(provider, model, session_id,
   message_id, turn_id, usage, source, occurred_at)` populating `data` with the
   spec §5.3 shape. Extend the `hook_kind_as_str_roundtrip` test array.
2. **`manifest.rs`** — `CURRENT_EXTENSION_PROTOCOL_VERSION = 2`; `validate()`
   accepts `{1,2}`; v1 still validates; v1 plugins are never subscribed to
   `on_usage`.
3. **`runtime/api.rs` + `runtime/stream.rs`/`runtime/mod.rs`** — plumb `hook_bus`
   into the stream-parse context; at the authoritative delta-arm emission
   (`api.rs:424-437`, guarded by `state.usage_emitted`) also `hook_bus.emit(OnUsage)`;
   populate `model` (HS-U4); never emit from `message_start` or twice from the
   residual path; hook failure follows existing extension failure semantics and
   never corrupts the stream.
4. **`permissions.rs`** — only if a dedicated `UsageMetering` permission is chosen
   (HS-U5); otherwise no change (reuse `LlmContent`).
5. **`rpc_protocol.rs`** — **no change**; `RpcEvent::AgentEnd { usage }`
   (`:272`) stays as the fallback/cross-check.

### 5.3 What B1 ships now (no core change)

- **Plugin (AC-B1.2):** `extensions/pria/usage.py` — pure raw-usage→Pria-payload
  transform, idempotency-key derivation, and session-context join. Wired into
  `app.handle_hook` **defensively** (handles an `on_usage` event if one ever
  arrives) but the manifest stays v1 and does **not** declare `on_usage`, so core
  never sends it until Track C lands. Emits **raw usage only** — no `credits`
  field (spec §5.5; Pria rating is authoritative).
- **Guest-agent (AC-B1.3):** `UsagePayload` + `PriaCallbackClient::usage()` +
  `tag_agent_end_usage()` at the RPC boundary → signed POST to
  `/internal/agentic-vm/usage`, spool on failure. This is the §0.2 fallback and
  remains even after `on_usage` ships (dedupe collapses overlap by idempotency
  key).
