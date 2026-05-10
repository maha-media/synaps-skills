# Phase 7 Spec Addendum — MCP Wire-Compat (`/mcp/v1`)

**Branch:** `feat/scp-phase-7-mcp`  
**Stacked on:** Phase 6 Scheduler (`feat/scp-phase-6-scheduler`)  
**Spec reference:** `docs/plans/PLATFORM.SPEC.md` §11 (three bullets; all detail herein)

---

## §11.0 Goals & Non-Goals

### Goals

- Expose SCP as a **remote MCP server** so that MCP-aware clients (Claude Desktop,
  Cursor, Continue.dev, custom agents) can connect to `/mcp/v1` with a per-user bearer
  token and:
  1. `initialize` an MCP session.
  2. `tools/list` — discover the user's gated tool surface.
  3. `tools/call` — invoke a tool against the user's live workspace.
- v0 exposes **one meta-tool**: `synaps_chat`, which forwards the prompt to the user's
  `synaps rpc` session and returns the final assistant text.
- Manage tokens via `ControlSocket` ops so pria-ui-v22 admin UI can issue/list/revoke
  without direct DB access.

### Non-Goals (Phase 7)

- SSE streaming tool output — v0 is request/response only.
- Per-tool exposure of the full `SynapsRpc` tool registry.
- `resources/*`, `prompts/*` MCP methods.
- OAuth2 dynamic client registration.
- Per-tool rate limiting.
- MCP aggregation (one `/mcp/v1` endpoint surfacing many user-installed MCP servers).

---

## §11.1 Wire Protocol

**Endpoint:** `POST /mcp/v1`  
**Transport:** JSON-RPC 2.0 over HTTP (Streamable HTTP transport, no SSE for v0)  
**Auth header:** `MCP-Token: <raw-64-hex-token>`  
**Content-Type:** `application/json`  
**Protocol version (pinned):** `2024-11-05`

### Supported Methods

| Method | Auth required | Purpose |
|---|---|---|
| `initialize` | No | Handshake; echo back server caps and protocol version |
| `notifications/initialized` | No | Client ack after init; 202 no-body |
| `ping` | Yes | Keep-alive; returns `{}` result |
| `tools/list` | Yes | List tools filtered through institution approval policy |
| `tools/call` | Yes | Invoke a tool |

### Unsupported Methods

All other methods (`resources/*`, `prompts/*`, etc.) return JSON-RPC error code `-32601`
(Method Not Found).

### HTTP Status Codes

| Condition | HTTP status | Notes |
|---|---|---|
| Notification (`notifications/*` or no `id`) | 202 | No response body |
| Success | 200 | JSON-RPC envelope in body |
| JSON-RPC error (invalid params, tool error…) | 200 | Error encoded in envelope |
| Missing / invalid token | 401 | `error.code: -32001` (AUTH_REQUIRED) |
| Malformed JSON body | 400 | `error.code: -32700` (PARSE_ERROR) |
| Body exceeds `max_body_bytes` | 413 | `error.code: -32600` |
| Method = GET | 405 | `Allow: POST` header |
| MCP disabled | 404 | `{ error: 'not_found' }` |

### JSON-RPC Error Codes

| Code | Constant | Meaning |
|---|---|---|
| `-32700` | `PARSE_ERROR` | Body is not valid JSON or is empty |
| `-32600` | `INVALID_REQUEST` | `jsonrpc` ≠ `"2.0"` or `method` missing |
| `-32601` | `METHOD_NOT_FOUND` | Unsupported method |
| `-32602` | `INVALID_PARAMS` | Tool arg validation failed |
| `-32603` | `INTERNAL_ERROR` | Unexpected dispatcher error |
| `-32001` | `AUTH_REQUIRED` | Token missing, expired, or revoked |
| `-32002` | `TOOL_TIMEOUT` | `synaps_chat` call exceeded `chat_timeout_ms` |
| `-32003` | `APPROVAL_REQUIRED` | Tool blocked by institution approval gate |

### `initialize` Wire Shape

**Request:**
```json
{
  "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities":    {},
    "clientInfo":      { "name": "claude-desktop", "version": "0.7.x" }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities":    { "tools": { "listChanged": false }, "logging": {} },
    "serverInfo":      { "name": "synaps-control-plane", "version": "0.1.0" },
    "instructions":    "Synaps Control Plane MCP gateway. ..."
  }
}
```

Note: `initialize` does not require auth. Clients that miss or skip init and go directly
to `tools/list` will be challenged by the auth middleware.

### `tools/call` Response Shape

```json
{
  "jsonrpc": "2.0", "id": 3,
  "result": {
    "content": [{ "type": "text", "text": "<assistant response>" }],
    "isError": false
  }
}
```

On tool error: `"isError": true`, `content` contains the error description.

---

## §11.2 Authentication

### Token Model (`synaps_mcp_tokens` collection)

```js
{
  _id:            ObjectId,
  token_hash:     String,       // SHA-256 hex of the raw 32-byte token
  synaps_user_id: ObjectId,     // FK → synaps_user
  institution_id: ObjectId,     // FK → institution
  name:           String,       // human label, e.g. 'claude-desktop-laptop'
  scopes:         [String],     // v0 always ['*']
  last_used_at:   Date | null,
  created_at:     Date,
  expires_at:     Date | null,  // null = never expires
  revoked_at:     Date | null,
}
```

**Indexes:**
- `{ token_hash: 1 }` — unique, partial filter `{ revoked_at: null }` (allows same hash after revoke)
- `{ synaps_user_id: 1 }`
- `{ institution_id: 1 }`

### Token Generation

```
rawToken = crypto.randomBytes(32).toString('hex')   // 64 lowercase hex chars
hash     = sha256(rawToken)                         // stored; raw never stored
```

### Resolution Flow

1. Read `MCP-Token` header → `rawToken`.
2. `hash = sha256(rawToken)`.
3. Look up `token_hash = hash, revoked_at = null, (expires_at = null OR > now)`.
4. On hit: best-effort `touch(last_used_at = now)` — never fail the request on touch error.
5. Return `{ synaps_user_id, institution_id, token_id }`.

**Security invariants:**
- Raw token is NEVER logged (only the first 8 chars of the hash for debugging).
- Raw token is returned exactly once at issue time — caller must save it.
- `mcp_token_list` never returns `token_hash` or the raw token.

---

## §11.3 Tool Registry

### v0 Tool: `synaps_chat`

```json
{
  "name": "synaps_chat",
  "description": "Send a prompt to your Synaps agent workspace and receive the response.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "prompt":  { "type": "string", "description": "The user prompt." },
      "context": { "type": "string", "description": "Optional extra context to prepend." }
    },
    "required": ["prompt"]
  }
}
```

`McpToolRegistry.callTool` resolves a `SessionRouter.getOrCreate({ synaps_user_id })`, calls
`rpc.sendUserPrompt(prompt)`, awaits the `agent_end` / `response` event, and wraps the text in
the MCP `content` array. Timeout is `chat_timeout_ms` (default 120 s).

### Expansion Path (Phase 7+)

Future: enumerate user-installed MCP servers from `~/.synaps-cli/mcp.json` inside the workspace
container and surface each tool as a top-level tool in `tools/list`. The meta-tool pattern
(single `synaps_chat`) is a v0 simplification.

---

## §11.4 Approval Gating

**Source:** pria-ui-v22's `mcpservers` collection (read-only from bridge).  
**Component:** `McpApprovalGate` (`bridge/core/mcp/mcp-approval-gate.js`).

### Policy Row Shape

```js
{
  name:               String,    // must match `policy_name` config (default 'synaps-control-plane')
  institution:        ObjectId,  // FK → institution
  status:             'active' | 'inactive',
  tool_configuration: {
    enabled:       Boolean,      // true = whitelist mode; false = allow all
    allowed_tools: [String],     // non-empty = whitelist; empty = all allowed
  },
  require_approval: {
    enabled:             Boolean,  // true = gate is on
    skip_approval_tools: [String], // tools that bypass the gate
  },
}
```

### Decision Matrix (AND semantics)

A tool is exposed in `tools/list` (and callable) only if it passes **both** checks:

| `tool_configuration.enabled` | `allowed_tools` | Whitelist result |
|---|---|---|
| `false` | any | ✅ pass |
| `true` | `[]` | ✅ pass (empty = open) |
| `true` | `['synaps_chat']` | ✅ only `synaps_chat` passes |

| `require_approval.enabled` | `skip_approval_tools` | Approval result |
|---|---|---|
| `false` | any | ✅ pass |
| `true` | tool in list | ✅ pass |
| `true` | tool NOT in list | ❌ denied (`-32003`) |

**No active policy row** for institution → deny-all.  
**`status !== 'active'`** → deny-all.

---

## §11.5 Audit

Gated by `[mcp] audit = true`. When enabled, each handled request writes one document to
`synaps_mcp_audit`:

```js
{
  _id:            ObjectId,
  ts:             Date,
  synaps_user_id: ObjectId | null,
  institution_id: ObjectId | null,
  method:         String,           // 'tools/list', 'tools/call', etc.
  tool_name:      String | null,
  outcome:        'ok' | 'denied' | 'error' | 'rate_limited',
  duration_ms:    Number,
  error_code:     Number | null,
  client_info:    { name: String, version: String } | null,
}
```

Index: `{ ts: -1 }` (TTL 30 days recommended — not enforced by bridge, set via MongoDB TTL index).  
Audit failures are swallowed — they must never block the request path.

---

## §11.6 Configuration

```toml
[mcp]
enabled            = false           # Off by default — enables on true
audit              = false           # Write to synaps_mcp_audit
chat_timeout_ms    = 120000          # tools/call wait limit (1000–600000)
max_body_bytes     = 262144          # 256 KiB request body cap (1024–4194304)
policy_name        = "synaps-control-plane"  # mcpservers row name to look up
```

**Defaults:** All fields have safe defaults. `enabled = false` means the MCP code path is
never loaded (deferred `import()` in `BridgeDaemon.start()`), preserving Phase 5/6 behaviour.

---

## §11.7 ControlSocket Ops

Three new ops added in Phase 7 Wave C1:

| Op | Request fields | Response | Notes |
|---|---|---|---|
| `mcp_token_issue` | `synaps_user_id`, `institution_id`, `name`, `expires_at?` (ISO string) | `{ ok, token, _id, name, expires_at, created_at }` | Raw token returned once. |
| `mcp_token_list` | `synaps_user_id?`, `institution_id?` | `{ ok, tokens: [{_id, name, last_used_at, expires_at, revoked_at, created_at}] }` | `token_hash` never returned. |
| `mcp_token_revoke` | `token_id` | `{ ok: true\|false }` | `ok:false` when id not found. |

**Disabled guard:** When `mcp.enabled = false`, `mcpTokenRepo` is not injected into
`ControlSocket`. All three ops return `{ ok: false, error: 'mcp_disabled' }`.

**Error codes used:**

| Op | Condition | Response |
|---|---|---|
| `mcp_token_issue` | Missing `synaps_user_id`, `institution_id`, or `name` | `{ ok:false, error:'missing_fields' }` |
| `mcp_token_revoke` | Missing `token_id` | `{ ok:false, error:'missing_fields' }` |
| `mcp_token_revoke` | `token_id` not found | `{ ok:false }` |

---

## §11.8 ScpHttpServer Integration

`ScpHttpServer` accepts an optional `mcpServer` constructor argument (default `null`).

**Route:** `POST /mcp/v1`

When `mcpServer === null`:
- `POST /mcp/v1` → `404 { error: 'not_found' }`.
- `GET /mcp/v1` → `405 { Allow: 'POST' }` (method check precedes mcpServer guard).

When `mcpServer` is set:
1. Body size checked against `maxBodyBytes` (configurable, default 256 KiB).
2. Body parsed as JSON; `BAD_JSON` → 400; `BODY_TOO_LARGE` → 413.
3. `mcp-token` header extracted (lowercase; `null` if absent).
4. `mcpServer.handle({ token, body })` called.
5. When response `body === null` (notifications): `202` + no body.
6. Otherwise: `_sendJson(res, out.statusCode, out.body)`.

**No session state** is kept between requests — every HTTP POST is independently authenticated.

---

## §11.9 Acceptance Criteria

A Phase 7 PR is mergeable when all of the following hold:

- [ ] All Phase 5/6 tests still pass per-file (no regressions).
- [ ] `bridge/control-socket.test.js` — 20 new MCP token tests pass.
- [ ] `tests/scp-phase-7/00-mcp-initialize-handshake.test.mjs` — 8 tests pass.
- [ ] `tests/scp-phase-7/01-mcp-token-resolver-mongo.test.mjs` — 10 tests pass.
- [ ] `tests/scp-phase-7/02-mcp-approval-gate-filtering.test.mjs` — 11 tests pass.
- [ ] `tests/scp-phase-7/03-mcp-control-socket-tokens.test.mjs` — 10 tests pass.
- [ ] `tests/scp-phase-7/04-mcp-disabled.test.mjs` — 12 tests pass.
- [ ] When `[mcp] enabled = false`, `/mcp/v1` → 404 and all 3 ControlSocket ops return `mcp_disabled`.
- [ ] Smoke playbook (`docs/smoke/phase-7-mcp.md`) executed successfully.
- [ ] `initialize` curl returns `protocolVersion: "2024-11-05"`.
- [ ] `tools/list` returns `synaps_chat` under a permissive institution policy.
- [ ] Token revoke → subsequent `/mcp/v1` returns 401.

---

## §11.10 Out of Scope / Future

- **Streaming via SSE.** v0 is blocking request/response. Full streaming requires SSE transport
  and SCP RPC layer changes.
- **Per-tool surfacing.** v0 exposes only `synaps_chat`. Phase 7+ stretch: enumerate
  `~/.synaps-cli/mcp.json` inside the user's workspace and surface each tool.
- **`resources/*` and `prompts/*` MCP methods.** Return `-32601` today.
- **OAuth2 dynamic client registration.** v0 uses static `MCP-Token` headers.
- **Per-tool rate limiting.** Deferred; add when abuse patterns emerge.
- **Inline `inline_js` hook action.** Deferred from Phase 6.
- **MCP aggregation** — one `/mcp/v1` endpoint surfacing tools from many user-installed MCP servers.
- **pria-ui-v22 admin UI for token management.** Phase 7 issues tokens via ControlSocket ops;
  the web UI flow is a separate pria PR.

---

## §11.11 Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Protocol version drift** | `2024-11-05` is pinned. We echo back our version in `initialize`; compliant clients fall back. Document the pin. |
| 2 | **`tools/call` timeout** | Default 120 s. Operator-tunable via `chat_timeout_ms`. Long-term: SSE streaming. |
| 3 | **Token leakage in logs** | All `mcp/**` code reviewed — raw token never logged; hash prefix (8 chars) used in debug messages. |
| 4 | **`mcpservers` schema drift** | pria-ui-v22 owns the schema. `McpServerRepo` uses raw MongoDB driver (`db.collection()`) to avoid schema coupling; documents the read-only contract. |
| 5 | **Denial gone unnoticed** | Empty `tools/list` looks like "no tools". `instructions` field in `initialize` response points admins to pria console. Audit log (when enabled) captures denied outcomes. |
