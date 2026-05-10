# Phase 9 Spec Addendum

**Document:** PHASE_9_SPEC_ADDENDUM.md
**Supplements:** PHASE_8_SPEC_ADDENDUM.md (Phase 8 hardening)
**Phase:** 9 — MCP Concurrency, Streaming, OAuth 2.1, and ACL
**Status:** In progress (feat/scp-phase-9-polish)

---

## Overview

Phase 9 extends the MCP surface introduced in Phase 7 and hardened in
Phase 8 with four independently-gated capability tracks. All new
behaviours are **off by default** (additive feature flags) and require
explicit opt-in via `bridge.toml`. No Phase 8 client breaks.

| Track | Title | Config gate |
|---|---|---|
| 1 | Per-session prompt serialisation | internal — no flag |
| 2 | SSE per-delta token streaming | `[mcp.sse] stream_deltas` |
| 3 | OAuth 2.1 Authorization Code flow with PKCE | `[mcp.oauth] enabled` |
| 4 | Per-tool ACL resolver | `[mcp.acl] enabled` |
| 5 | rpc-probe tool surfacing (C3 subagent) | `[mcp] surface_rpc_tools` |
| 6 | `/metrics` Prometheus endpoint (C3 subagent) | `[metrics] enabled` |

Tracks 5 and 6 are specified in the C3 subagent's addendum sections
(see HTML fences below).

---

## Track 1 — Per-session Prompt Serialisation

### Problem

Phase 8 smoke item #19 revealed that issuing N concurrent `tools/call
synaps_chat` requests on the **same MCP token** produced 1 success and
N−1 `INTERNAL_ERROR` responses. Root cause: `SynapsRpc.prompt()` enforces
a single in-flight prompt per session, but `McpToolRegistry._invokeChat`
dispatched concurrent callers straight through without queuing.

Real-world MCP clients (Claude Code, browser extensions) issue sequential
chat turns, so the failure was never seen in production. It does appear in
automated smoke harnesses and any multi-threaded client that fires parallel
tool-calls on the same session.

### Design

Add a **per-session serial promise queue** inside `McpToolRegistry`:

```
_sessionLocks: Map<sessionKey, Promise<void>>
```

In `_invokeChat`:

```js
const key  = _sessionKey(synaps_user_id);                     // opaque hash
const prev = this._sessionLocks.get(key) ?? Promise.resolve();
const next = prev.then(() => this._runOnce(callArgs, synaps_user_id));
this._sessionLocks.set(key, next.finally(() => {
  if (this._sessionLocks.get(key) === next)
    this._sessionLocks.delete(key);
}));
return next;
```

Properties of this design:

- **Serial within session**: concurrent callers on the same token execute
  one at a time in arrival order.
- **Parallel across sessions**: two different tokens make progress
  simultaneously (Map keyed by user, not globally).
- **Memory-safe**: the `finally` guard removes the key when the last
  queued call completes, so idle sessions cost zero Map entries.
- **No timeout cascade**: each queued promise sees only its own call's
  timeout, not cumulative wait time. The per-call `chat_timeout_ms` guard
  (Phase 7) remains in effect.
- **No new dependency**: pure JS, no external scheduler library.

### Wire-Format Impact

None. The queue is an internal implementation detail. From the client's
perspective:

- All N concurrent calls receive successful responses (in request-arrival
  order, not wall-clock order, since HTTP responses are independent).
- Request `id` values are echoed correctly on each response.
- No new JSON-RPC error codes introduced.

### Acceptance Criteria

Verified by `/tmp/smoke/concurrent-v2-test.mjs`:

- 5 concurrent `tools/call synaps_chat` on Token A → all 5 `isError:false`.
- 10 sequential calls post-burst → all succeed (no session-lock leak).
- 2×Token-A + 2×Token-C concurrent → wall time < 2× single-call latency
  (confirms the queue serialises within a session, not globally).

### Rollback

No config flag. Revert the `_sessionLocks` commit in
`bridge/core/mcp/mcp-tool-registry.js`.

---

## Track 2 — SSE Per-Delta Token Streaming

### Problem

Phase 8 SSE (Track 3) emits a single `synaps/result` notification frame
followed by the final `result` frame — the model's full reply is
buffered server-side before the client sees any text. This adds latency
and prevents progressive rendering in streaming-capable clients.

### Design

When `[mcp.sse] stream_deltas = true` AND the request carries
`Accept: text/event-stream` AND the method is `tools/call`:

1. `McpToolRegistry._invokeChat` subscribes to `text_delta` events emitted
   by the `SynapsRpc` session EventEmitter.
2. Each `text_delta` event is forwarded to the SSE transport as a
   `synaps/delta` notification frame **immediately** — before the agent
   completes.
3. When the agent fires `agent_end`, the final `result` frame is emitted
   and the SSE stream is closed.

#### New SSE frame: `synaps/delta`

```
data: {"jsonrpc":"2.0","method":"synaps/delta","params":{"id":<req_id>,"text":"...chunk..."}}\n\n
```

| Field | Type | Description |
|---|---|---|
| `params.id` | number\|string | The `id` from the originating JSON-RPC request. Allows clients to correlate deltas when multiplexing. |
| `params.text` | string | The incremental text chunk emitted by the model. Not normalised (may be a single token, a word, or a sentence fragment). |

#### Full stream sequence (stream_deltas=true)

```
data: {"jsonrpc":"2.0","method":"synaps/delta","params":{"id":1,"text":"The "}}\n\n
data: {"jsonrpc":"2.0","method":"synaps/delta","params":{"id":1,"text":"Linux "}}\n\n
data: {"jsonrpc":"2.0","method":"synaps/delta","params":{"id":1,"text":"kernel..."}}\n\n
... (≥1 more delta frames)
data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"The Linux kernel..."}],"isError":false}}\n\n
```

**Invariant**: the concatenation of all `params.text` strings across
`synaps/delta` frames equals `result.content[0].text` in the final frame.

#### Stream sequence (stream_deltas=false, Phase 8 baseline)

```
data: {"jsonrpc":"2.0","method":"synaps/result","params":{...}}\n\n
data: {"jsonrpc":"2.0","id":1,"result":{...}}\n\n
```

### Configuration

#### `[mcp.sse]` (extended)

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `false` | Enable SSE upgrade for `tools/call` (Phase 8). |
| `stream_deltas` | bool | `false` | When true, emit `synaps/delta` frames as tokens arrive. Requires `enabled = true`. |

### Backward Compatibility

- Clients sending `Accept: application/json` are unaffected regardless of
  `stream_deltas` — they receive the existing plain JSON response.
- Clients sending `Accept: text/event-stream` with `stream_deltas = false`
  receive the existing 2-frame Phase 8 shape; the `synaps/delta` method
  never appears.
- `stream_deltas = true` is additive: existing SSE consumers that ignore
  unknown `method` values are unaffected. A conforming consumer must
  handle `synaps/delta` frames.

### Abort Semantics

When the client closes the SSE connection mid-stream:

1. Node's `res.on('close', …)` fires (already hooked by the Phase 8 SSE
   transport).
2. The `SynapsRpc` session is **not** terminated — the agent continues
   running to completion server-side. This preserves conversational
   continuity for reconnecting clients and avoids partial writes to the
   memory store.
3. Subsequent `tools/call` on the same token queues behind the running
   call (Track 1 serialiser). When the in-flight call finishes, the queue
   drains normally.

If the client reconnects within `chat_timeout_ms` and issues a new
`tools/call`, it gets a new response for the new prompt; the prior
in-progress call's delta frames are not replayed.

### Acceptance Criteria

Verified by `/tmp/smoke/sse-deltas-test.mjs`:

- **A** — `stream_deltas=false`: exactly 2 frames, no `synaps/delta`.
- **B** — `stream_deltas=true`: ≥2 `synaps/delta` frames; concat == final text.
- **C** — `Accept: application/json`: plain JSON, shape unchanged.
- **D** — abort after 3 deltas; follow-up `tools/list` succeeds within 5 s;
  `/health` reports `status: ok`.

### Rollback

```toml
[mcp.sse]
stream_deltas = false
```

No data migration required. Flip without restart possible only if the
server supports config-reload; otherwise restart the daemon.

---

<!-- begin: rpc-probe -->

## Track 5 — rpcFactory probe + strict mode

### Overview

In SCP mode (`platform.mode = "scp"`) the daemon selects between two
`rpcFactory` variants:

- **DockerExecSynapsRpc** — spawns commands inside the managed workspace
  container (default when `[rpc] host_mode = false`).
- **SynapsRpc** — spawns commands directly on the host (fallback / dev mode,
  or when `[rpc] host_mode = true`).

Prior to Phase 9 the Docker factory was chosen unconditionally if
`host_mode = false`, which caused silent runtime failures when the
`synaps` binary was absent or the SynapsCLI Docker image was stale.

Phase 9 C3 adds a **one-shot synchronous probe** to `defaultSessionRouterFactory`.
The probe verifies that the `synaps` CLI can enumerate tools before the
daemon begins accepting requests.

### Probe Mechanics

When `useDockerWorkspace = true`, the factory calls:

```js
execFileSync(config.rpc.binary || 'synaps', ['tools_list', '--json'], {
  timeout:  5000,
  encoding: 'utf8',
});
```

The result is JSON-parsed. If the result is a non-empty array the probe
succeeds. On success, `DockerExecSynapsRpc` is used as the `rpcFactory`.

On failure (binary not found, non-zero exit, timeout, non-array JSON):

- **Non-strict mode** (`[rpc] strict = false`, default):
  A `warn`-level log is emitted and the factory falls back to the host
  `SynapsRpc` for the lifetime of this daemon run. The daemon continues to
  start. The log message reads:
  ```
  [rpc] tools_list probe failed: <reason> — falling back to host_mode for this run
  (set rpc.strict = true to make this fatal)
  ```

- **Strict mode** (`[rpc] strict = true`):
  `defaultSessionRouterFactory` throws immediately. The daemon start fails
  and the process exits with an error. The error message reads:
  ```
  [rpc] tools_list probe failed: <reason> — refusing to start (rpc.strict = true)
  ```

### Configuration

#### `[rpc]` (extended)

| Key | Type | Default | Description |
|---|---|---|---|
| `binary` | string | `"synaps"` | Path to the Synaps CLI binary. |
| `host_mode` | bool | `false` | Skip Docker orchestration; use host SynapsRpc directly. |
| `strict` | bool | `false` | If true, a failed probe aborts daemon startup. |

Example `bridge.toml` for production (strict probe required):

```toml
[rpc]
binary    = "/usr/local/bin/synaps"
host_mode = false
strict    = true
```

Example for development without the SynapsCLI Docker image:

```toml
[rpc]
host_mode = true
strict    = false
```

### Dependency Injection

`defaultSessionRouterFactory` accepts an `execFileImpl` option (4th arg)
for test injection:

```js
defaultSessionRouterFactory(config, logger, scpDeps, { execFileImpl: myExecFn });
```

The `BridgeDaemon` constructor accepts `execFileImpl` and threads it
through to the session router factory at start time. Default:
`execFileSync` from `node:child_process`.

### Smoke Procedure (once SynapsCLI v0.1.7 ships)

```sh
# Verify probe succeeds with installed CLI
synaps tools_list --json | jq 'length'
# → integer ≥ 0

# Start daemon in strict mode
echo '[rpc]\nstrict = true' >> ~/.synaps-cli/bridge/bridge.toml
synaps bridge start
# → [rpc] tools_list probe ok: N tool(s)

# Simulate probe failure (rename binary)
sudo mv /usr/local/bin/synaps /tmp/synaps.bak
synaps bridge start
# → Error: [rpc] tools_list probe failed: ... refusing to start (rpc.strict = true)

sudo mv /tmp/synaps.bak /usr/local/bin/synaps
```

<!-- end: rpc-probe -->

---

## Track 3 — OAuth 2.1 Authorization Code Flow with PKCE

### Problem

Phase 8 introduced Dynamic Client Registration (RFC 7591) for
machine-to-machine token issuance. Human-in-the-loop MCP clients (e.g.
browser-based agents, VS Code extensions) need a user-facing consent flow
that:

- Does not require a pre-shared `registration_secret`.
- Supports PKCE (RFC 7636) to prevent authorization code interception.
- Integrates with the existing Synaps session/auth stack.
- Conforms to OAuth 2.1 draft (which mandates PKCE for all public clients).

### Endpoints

#### `GET /.well-known/oauth-authorization-server`

Returns the OAuth 2.0 Authorization Server Metadata document (RFC 8414).

**Response** (200 `application/json`):

```json
{
  "issuer":                        "https://<host>",
  "authorization_endpoint":        "https://<host>/mcp/v1/authorize",
  "token_endpoint":                "https://<host>/mcp/v1/token",
  "response_types_supported":      ["code"],
  "grant_types_supported":         ["authorization_code"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"]
}
```

No secrets required. Always enabled when `[mcp.oauth] enabled = true`.

#### `GET /.well-known/oauth-protected-resource`

Returns the OAuth 2.0 Protected Resource Metadata (RFC 9728 draft).

**Response** (200 `application/json`):

```json
{
  "resource":               "https://<host>/mcp/v1",
  "authorization_servers":  ["https://<host>"],
  "bearer_methods_supported": ["header"]
}
```

#### `GET /mcp/v1/authorize`

Begins the authorization flow.

**Query parameters:**

| Parameter | Required | Description |
|---|---|---|
| `response_type` | yes | Must be `code`. |
| `client_id` | yes | Opaque string identifying the requesting client. |
| `redirect_uri` | yes | Must match the redirect URI allow-list (see Security). |
| `code_challenge` | yes | Base64url(SHA-256(code_verifier)). |
| `code_challenge_method` | yes | Must be `S256`. |
| `state` | recommended | Opaque string; echoed in redirect. |
| `scope` | no | Ignored in v0 (all scopes granted). |

**Unauthenticated request (no Synaps session cookie and no
`X-Synaps-Test-Auth` header):**

Responds `302` to `/agents/login?next=<url-encoded authorize URL>`.

**Authenticated request:**

Responds `200 text/html` with the consent page. The page:

- Displays `client_id` and the requested redirect domain.
- Embeds a `csrf_token` hidden form field (single-use, stored server-side).
- Embeds the `code_challenge`, `code_challenge_method`, `state`,
  `client_id`, and `redirect_uri` as hidden form fields.
- Contains a CSP header: `default-src 'self'; script-src 'none'`.

**Test-auth header (development only):**

When `[mcp.oauth] allow_test_auth = true` (default `false`), the header
`X-Synaps-Test-Auth: <synaps_user_id>` bypasses session lookup and acts
as if the given user is authenticated. This header is rejected in
production (config gate).

#### `POST /mcp/v1/authorize`

Submits the consent decision.

**Form body** (`application/x-www-form-urlencoded`):

| Field | Required | Description |
|---|---|---|
| `csrf_token` | yes | Single-use token from the consent page. |
| `consent` | yes | `allow` or `deny`. |
| `client_id` | yes | Echoed from the authorize request. |
| `redirect_uri` | yes | Echoed from the authorize request. |
| `state` | no | Echoed from the authorize request. |

**`consent=allow` response:**

`302` to `<redirect_uri>?code=<32-byte hex>&state=<state>`.

The authorization code is stored in `synaps_oauth_codes` with:

- `code_hash` — SHA-256 of the raw code (raw code never stored).
- `code_challenge` + `code_challenge_method` — for PKCE verification.
- `client_id`, `redirect_uri`.
- `synaps_user_id` — the authenticated user.
- `expires_at` — `Date.now() + code_ttl_ms` (default 10 minutes).
- `used` — `false`; set to `true` on first `POST /mcp/v1/token` exchange.

**`consent=deny` response:**

`302` to `<redirect_uri>?error=access_denied&state=<state>`.

**Error responses** (consent page not shown):

| HTTP | Condition |
|---|---|
| 400 | Missing required parameters; `redirect_uri` not in allow-list. |
| 403 | CSRF token invalid or expired. |
| 403 | Not authenticated (no session, test-auth disabled). |

#### `POST /mcp/v1/token`

Exchanges an authorization code for an MCP bearer token.

**Request body** (`application/x-www-form-urlencoded`):

| Field | Required | Description |
|---|---|---|
| `grant_type` | yes | Must be `authorization_code`. |
| `code` | yes | The raw authorization code from the redirect. |
| `code_verifier` | yes | The PKCE verifier (32-byte random, base64url). |
| `client_id` | yes | Must match the code's stored `client_id`. |
| `redirect_uri` | yes | Must match the code's stored `redirect_uri`. |

**Success response** (200 `application/json`):

```json
{
  "access_token": "<raw MCP bearer token>",
  "token_type":   "bearer",
  "expires_in":   31536000
}
```

The `access_token` is an MCP bearer token issued via `McpTokenRepo` with
the user's `synaps_user_id` bound. It is usable in `MCP-Token: <token>`
headers immediately. The raw token is returned once; it is stored as
`SHA-256(token)` in `synaps_mcp_tokens`.

**Error responses:**

| HTTP | `error` | Cause |
|---|---|---|
| 400 | `invalid_request` | Missing required fields; wrong `grant_type`. |
| 400 | `invalid_grant` | Code not found, already used, expired, wrong `client_id`/`redirect_uri`, or PKCE `code_verifier` does not match `code_challenge`. |
| 400 | `invalid_client` | `client_id` mismatch (when client auth is required). |

### Mongoose Model: `synaps_oauth_codes`

```js
{
  code_hash:             { type: String, required: true, unique: true },
  code_challenge:        { type: String, required: true },
  code_challenge_method: { type: String, required: true, default: 'S256' },
  client_id:             { type: String, required: true },
  redirect_uri:          { type: String, required: true },
  synaps_user_id:        { type: String, required: true },
  institution_id:        { type: String, required: true },
  expires_at:            { type: Date,   required: true },
  used:                  { type: Boolean, default: false },
  created_at:            { type: Date,   default: Date.now },
}
```

TTL index: `{ expires_at: 1 }` with `expireAfterSeconds: 0` (MongoDB
auto-delete after expiry).

### PKCE Algorithm

```
code_verifier  = base64url(randomBytes(32))          // 43 chars
code_challenge = base64url(SHA-256(code_verifier))   // 43 chars, S256
```

Verification at token endpoint:

```js
const expected = base64url(createHash('sha256').update(code_verifier).digest());
assert(expected === stored.code_challenge);
```

Comparison is performed with `crypto.timingSafeEqual` to prevent
timing-oracle attacks.

### Consent UX

The consent page is a minimal server-rendered HTML form with no client-side
JavaScript. Key UX requirements:

- The requesting `client_id` is displayed prominently.
- The domain component of `redirect_uri` is displayed (not the full URI).
- Buttons: "Allow" (`consent=allow`) and "Deny" (`consent=deny`).
- Session cookies use `SameSite=Lax; Secure` (where HTTPS available).

### CSRF Protection

Each consent page render creates a single-use `csrf_token`:

- 16-byte random hex string stored in the server-side session.
- Validated on `POST /mcp/v1/authorize`; immediately deleted on first use.
- Expired if not consumed within `csrf_ttl_ms` (default 15 minutes).

### CSP + XSS

- `Content-Security-Policy: default-src 'self'; script-src 'none'`
  is set on all OAuth HTML responses.
- No inline scripts; no external resources.
- All form values are HTML-entity-escaped before rendering.

### Security Considerations

#### Open Redirect Prevention

`redirect_uri` is validated against a server-side allow-list:

```toml
[mcp.oauth]
redirect_uri_allow_list = [
  "http://localhost:*",
  "https://app.example.com/callback",
]
```

Glob patterns support `*` for port and path components but not scheme
or host wildcards (e.g. `https://*.example.com` is rejected). Any
`redirect_uri` not matching the list results in a `400` error; the
redirect is **never** followed.

#### Code Binding

The authorization code is bound to `client_id`, `redirect_uri`, and
`synaps_user_id` at creation time. A stolen code cannot be exchanged
by a different client or redirected to a different URI.

#### Replay Prevention

The `used` field is set to `true` on the **first** successful token
exchange. A second exchange with the same code returns `400 invalid_grant`.

#### Token Storage

The issued MCP bearer token is stored as `SHA-256(token)` in
`synaps_mcp_tokens`. The raw token is returned once in the HTTP response.
Subsequent requests use `SHA-256` for auth checks (consistent with Phase 7
auth chain).

### Configuration

#### `[mcp.oauth]`

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `false` | Enable OAuth 2.1 endpoints. |
| `code_ttl_ms` | int | `600000` | Authorization code lifetime in ms (10 min). |
| `csrf_ttl_ms` | int | `900000` | CSRF token lifetime in ms (15 min). |
| `redirect_uri_allow_list` | string[] | `[]` | Allowed redirect URI patterns. Required when enabled. |
| `allow_test_auth` | bool | `false` | Allow `X-Synaps-Test-Auth` bypass (dev only). |
| `issuer` | string | `""` | OAuth issuer URL. Defaults to `https://<host>`. |

### Rollback

```toml
[mcp.oauth]
enabled = false
```

No data migration required. Existing MCP bearer tokens (issued via DCR or
`mcp_token_issue`) continue to work.

---

## Track 4 — Per-Tool ACL Resolver

### Problem

Phase 8 provides per-user token management and an approval gate, but no
fine-grained deny/allow rules per tool. A user with a valid MCP token can
call any tool the server exposes. Enterprise deployments need:

- Per-user, per-tool deny lists (e.g. block `web_fetch` for read-only users).
- Wildcard rules (deny all tools for a user, then selectively allow).
- Time-bounded rules (TTL expiry for temporary access grants).
- Audit evidence that ACL decisions were applied.

### Model: `synaps_mcp_tool_acls`

```js
{
  user_id:    { type: String, required: true },
  tool_name:  { type: String, required: true },   // literal name OR "*"
  action:     { type: String, enum: ['allow','deny'], required: true },
  reason:     { type: String, default: '' },
  expires_at: { type: Date,   default: null },     // null = no expiry
  created_at: { type: Date,   default: Date.now },
}
```

Compound index: `{ user_id: 1, tool_name: 1 }` (unique per user+tool).

TTL index on `expires_at` for automatic MongoDB cleanup of expired rows
(same pattern as `synaps_oauth_codes`).

### Resolver Semantics

The ACL resolver applies **most-restrictive / deny-wins** semantics.
Evaluation order:

1. Collect all non-expired ACL rows for `(user_id, tool_name)` and
   `(user_id, '*')`.
2. Expire check: rows where `expires_at != null && expires_at <= Date.now()`
   are treated as absent (ignored in evaluation even if MongoDB TTL
   has not yet deleted them).
3. Apply the following precedence (highest wins):

| Condition | Result |
|---|---|
| No rows at all (after expire filter) | **allow** (fall-through) |
| Any `deny` row present (exact or wildcard) | **deny** |
| Only `allow` rows present | **allow** |

Concretely:

- `wildcard deny + exact allow` → **deny** (wildcard deny wins).
- `exact deny + wildcard allow` → **deny** (exact deny wins).
- `wildcard allow` only → **allow**.
- `exact allow` only → **allow**.
- Empty → **allow**.

This is the most conservative interpretation: a single `deny` row
anywhere in the user's ACL set (including wildcards) blocks the tool.
Operators must explicitly remove or expire deny rows to re-grant access.

### ACL Cache

To avoid a MongoDB round-trip on every `tools/call`, ACL rows are cached
per `(user_id, tool_name)` in an in-process `Map` with a configurable
TTL.

```toml
[mcp.acl]
cache_ttl_ms = 5000   # default 5 s
```

Cache entries are invalidated eagerly on `mcp_acl_set` / `mcp_acl_delete`
operations if the ControlSocket op is handled by the same process. In
multi-replica deployments, cache staleness is bounded by `cache_ttl_ms`.

### Error Response: Tool Denied

When the ACL resolver denies a call, `McpServer` returns:

```json
{
  "jsonrpc": "2.0",
  "id":      <id>,
  "error": {
    "code":    -32601,
    "message": "Method not found",
    "data": {
      "message": "Tool denied by ACL",
      "tool":    "<tool_name>"
    }
  }
}
```

HTTP status: `200` (JSON-RPC spec: all RPC errors are 200).

Code `-32601` is reused (Method Not Found) so that clients cannot
distinguish ACL denial from a missing tool — this prevents enumeration
of which tools exist.

### ControlSocket Operations

Three new ControlSocket JSON-RPC methods are added:

#### `mcp_acl_list`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "mcp_acl_list",
  "params": { "userId": "<synaps_user_id>" }
}
```

**Response `result`**: array of ACL row objects (same shape as the model,
`_id` included for reference).

#### `mcp_acl_set`

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "mcp_acl_set",
  "params": {
    "userId":    "<synaps_user_id>",
    "toolName":  "<tool name or *>",
    "action":    "allow" | "deny",
    "reason":    "<optional human-readable string>",
    "expiresAt": <epoch ms | null>
  }
}
```

Upserts the row (by `{ user_id, tool_name }`).

**Response `result`**: `{ ok: true }`.

#### `mcp_acl_delete`

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "mcp_acl_delete",
  "params": {
    "userId":   "<synaps_user_id>",
    "toolName": "<tool name or *>"
  }
}
```

Deletes the matching row (no-op if absent).

**Response `result`**: `{ ok: true, deleted: 0 | 1 }`.

### Audit Log Integration

The existing `synaps_mcp_audit` collection gains one new field:

```js
acl_outcome: {
  type: String,
  enum: ['allow', 'deny', 'expired', null],
  default: null,
}
```

| Value | Meaning |
|---|---|
| `null` | ACL check not performed (feature disabled). |
| `"allow"` | ACL resolver returned allow (rows present, action=allow). |
| `"deny"` | ACL resolver returned deny (request blocked). |
| `"expired"` | All matching rows were expired; treated as allow. |

This field is written to every audit record regardless of whether the call
succeeded or failed for other reasons (timeout, tool error, etc.).

### Configuration

#### `[mcp.acl]`

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `false` | Enable the ACL resolver. |
| `cache_ttl_ms` | int | `5000` | In-process ACL cache TTL in ms. |

### Rollback

```toml
[mcp.acl]
enabled = false
```

No data migration. Existing `synaps_mcp_tool_acls` rows are ignored when
disabled. The `acl_outcome` field is `null` in all new audit records.

---

<!-- begin: metrics-endpoint -->

## Track 6 — /metrics endpoint contract

### Overview

Phase 9 C3 adds a Prometheus-compatible `/metrics` endpoint to the
`ScpHttpServer`. When `[metrics] enabled = true`, the endpoint exposes
counter, histogram, and gauge metrics collected by `MetricsRegistry`
in the **Prometheus text exposition format** (version 0.0.4).

The endpoint is **off by default** and restricted to localhost (or the
configured `[metrics] bind` address) to prevent accidental public exposure.

### Configuration

#### `[metrics]`

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `false` | Expose the `/metrics` endpoint. |
| `path` | string | `"/metrics"` | HTTP path for the endpoint. |
| `bind` | string | `"127.0.0.1"` | Allow only connections from this IP (plus `127.0.0.1`, `::1`, `::ffff:127.0.0.1`). |

### Endpoint Contract

#### `GET /metrics` (or `metricsConfig.path`)

| Condition | HTTP Status | Body |
|---|---|---|
| `metrics.enabled = false` OR `metricsRegistry = null` | `404` | `{"error":"not_found"}` |
| Request from a non-localhost, non-bind address | `403` | `{"error":"forbidden"}` |
| Success | `200` | Prometheus text (see below) |

**Success response headers:**

```
Content-Type: text/plain; version=0.0.4; charset=utf-8
Content-Length: <bytes>
```

**Bind guard logic:**

```
LOCALHOST_ADDRS = { '127.0.0.1', '::1', '::ffff:127.0.0.1' }
allow = req.socket.remoteAddress ∈ LOCALHOST_ADDRS
      OR req.socket.remoteAddress == metricsConfig.bind
if !allow → 403
```

The guard fires before `render()` is called — no registry work is
done for rejected requests.

### Metric Names and Labels

All metrics emitted by the Synaps bridge daemon follow the
`synaps_` prefix convention. Labels are optional; cardinality must be
bounded by a fixed number of label value combinations.

#### Daemon-level gauges (registered by `BridgeDaemon`)

| Metric | Type | Label keys | Description |
|---|---|---|---|
| `synaps_mongoose_connection_state` | gauge | — | `1` when Mongoose `readyState === 1` (connected); `0` otherwise. Updated every 5 seconds. |
| `synaps_bridge_heartbeat_age_seconds` | gauge | — | Seconds since the last bridge heartbeat was recorded (`supervisor.bridgeHeartbeatAt`). `0` when no supervisor is configured. Updated every 5 seconds. |

The 5-second poll interval is started after the Mongoose connection is
established and `MetricsRegistry` is initialised. The interval handle is
`unref()`d so it does not prevent process exit. The handle is cleared
by `BridgeDaemon.stop()`.

#### MCP-level metrics (registered by McpServer / McpToolRegistry)

Phase 9 Wave A/B components register additional metrics via the
`MetricsRegistry` instance that is injected into them at daemon start.
Refer to the Wave A/B spec addenda for exact metric names.

### Cardinality Limits

To prevent cardinality explosions, label values MUST be drawn from a
**finite, bounded set**:

- Tool names (`synaps_chat`, `synaps_tools_list`, etc.) are acceptable
  label values — the set is bounded by the binary's tool list.
- User IDs, request IDs, session IDs, and any unbounded strings MUST NOT
  be used as label values.
- Maximum label combinations per metric: **50**.

Violating these limits will not cause errors at the registry level, but
will cause memory growth proportional to the number of unique label
combinations seen.

### Sample Prometheus scrape_config

```yaml
scrape_configs:
  - job_name: 'synaps-bridge'
    static_configs:
      - targets: ['127.0.0.1:18080']
    metrics_path: '/metrics'
    scheme: 'http'
    scrape_interval: 15s
    scrape_timeout: 5s
```

### Rollback

```toml
[metrics]
enabled = false
```

No data migration required. The `/metrics` route returns 404 when disabled;
no `MetricsRegistry` is instantiated and no poll interval is started.

<!-- end: metrics-endpoint -->

---

## Config Defaults Summary

All new config keys introduced in Phase 9:

| Section | Key | Type | Default | Track |
|---|---|---|---|---|
| `[mcp.sse]` | `stream_deltas` | bool | `false` | 2 |
| `[mcp.oauth]` | `enabled` | bool | `false` | 3 |
| `[mcp.oauth]` | `code_ttl_ms` | int | `600000` | 3 |
| `[mcp.oauth]` | `csrf_ttl_ms` | int | `900000` | 3 |
| `[mcp.oauth]` | `redirect_uri_allow_list` | string[] | `[]` | 3 |
| `[mcp.oauth]` | `allow_test_auth` | bool | `false` | 3 |
| `[mcp.oauth]` | `issuer` | string | `""` | 3 |
| `[mcp.acl]` | `enabled` | bool | `false` | 4 |
| `[mcp.acl]` | `cache_ttl_ms` | int | `5000` | 4 |

Track 1 (serialisation) has no config key — it is always active.

Tracks 5 and 6 config keys are documented by the C3 subagent.

---

## Wire-Format Compatibility Table

| Client type | Phase 8 setting | Phase 9 setting | Breaks? |
|---|---|---|---|
| `Accept: application/json` | any SSE config | `stream_deltas=true` | **No** — SSE not activated for this client. |
| `Accept: text/event-stream` | `stream_deltas=false` | `stream_deltas=false` | **No** — identical 2-frame shape. |
| `Accept: text/event-stream` | `stream_deltas=false` | `stream_deltas=true` | **Additive** — `synaps/delta` frames appear before the existing frames. Clients that ignore unknown `method` values are unaffected. |
| MCP-Token bearer (Phase 7 / DCR-issued) | `[mcp.oauth] disabled` | `[mcp.oauth] enabled` | **No** — existing tokens bypass the OAuth flow. |
| N concurrent `tools/call` same token | Phase 8 → N−1 errors | Phase 9 → all succeed | **Improvement** — previously failing calls now succeed. |
| `tools/call` (any tool) | no ACL | `[mcp.acl] enabled=false` | **No** — ACL gated by flag. |
| `tools/call` denied tool | N/A | `[mcp.acl] enabled=true` | **Intentional change** — `-32601` returned. Clients that handle Method Not Found correctly already handle this. |

---

## Rollback Procedure

All tracks are independently rollback-able via a single `bridge.toml` edit
and daemon restart. No data migration is required for any track.

| Track | Rollback action |
|---|---|
| 1 — Serialisation | Revert `bridge/core/mcp/mcp-tool-registry.js` commit. |
| 2 — SSE delta streaming | Set `[mcp.sse] stream_deltas = false`. |
| 3 — OAuth 2.1 | Set `[mcp.oauth] enabled = false`. |
| 4 — ACL | Set `[mcp.acl] enabled = false`. |
| 5 — rpc-probe | Set `[mcp] surface_rpc_tools = false` (Phase 8 key). |
| 6 — metrics | Set `[metrics] enabled = false`. |

---

## Open Ports

Phase 9 introduces no new network ports.

The existing `[mcp] port` (default `:18080`, Phase 1) serves all new
endpoints:

| Path | Method | Track |
|---|---|---|
| `/mcp/v1` | POST | 1, 2 (modified) |
| `/mcp/v1/authorize` | GET, POST | 3 |
| `/mcp/v1/token` | POST | 3 |
| `/.well-known/oauth-authorization-server` | GET | 3 |
| `/.well-known/oauth-protected-resource` | GET | 3 |
| `/metrics` | GET | 6 (C3 subagent) |

The ControlSocket (Unix domain socket, not a TCP port) gains three new
JSON-RPC methods: `mcp_acl_list`, `mcp_acl_set`, `mcp_acl_delete`.

---

## New Modules

| Module | Track | Description |
|---|---|---|
| `bridge/core/mcp/mcp-oauth.js` | 3 | OAuth 2.1 authorize + token endpoint handlers, PKCE verification, consent CSRF. |
| `bridge/core/mcp/mcp-oauth-codes.js` | 3 | Mongoose model + repo for `synaps_oauth_codes`. |
| `bridge/core/mcp/mcp-acl.js` | 4 | ACL resolver with deny-wins semantics + in-process cache. |
| `bridge/core/mcp/mcp-acl-repo.js` | 4 | Mongoose model + CRUD operations for `synaps_mcp_tool_acls`. |

Track 1 (serialisation) is a modification to the existing
`bridge/core/mcp/mcp-tool-registry.js` — no new module file.

Track 2 (SSE deltas) is a modification to the existing
`bridge/core/mcp/mcp-sse-transport.js` — no new module file.

Tracks 5 and 6 modules are listed by the C3 subagent.

---

## New Error Codes

Phase 9 introduces no new JSON-RPC error codes. The ACL denial reuses
`-32601` (`METHOD_NOT_FOUND`) intentionally (see Track 4 — Error
Response). The OAuth token endpoint uses standard OAuth 2.0 error strings
(not JSON-RPC codes) in its `application/json` responses.

---

## Backwards Compatibility

All Phase 9 behaviours are **additive opt-in** except Track 1 (serialisation),
which fixes a bug. The Track 1 fix is always active but is transparent to
correctly-behaving clients: N concurrent calls that previously received
N−1 errors now succeed.

| Feature | Default | Phase 8 behaviour preserved when off? |
|---|---|---|
| SSE delta streaming | `false` | Yes — 2-frame shape unchanged. |
| OAuth 2.1 flow | `false` | Yes — `/mcp/v1/authorize` and `/mcp/v1/token` are 404. |
| ACL resolver | `false` | Yes — all tools callable by any valid token. |
| Prompt serialisation | always on | Better than Phase 8 — was a bug. |
