# Phase 8 Spec Addendum

**Document:** PHASE_8_SPEC_ADDENDUM.md
**Supplements:** PLATFORM.SPEC.md (Phase 7)
**Phase:** 8 — Production Hardening
**Status:** Merged (stacked on Phase 7, PR #39)

---

## Overview

Phase 8 adds four independently-gated production hardening tracks to the
MCP wire-compat surface introduced in Phase 7. Every new behaviour is
**off by default** (additive feature flags) and requires explicit opt-in
via `bridge.toml`.

---

## New Endpoints

### `POST /mcp/v1/register` — OAuth2 Dynamic Client Registration (RFC 7591)

Allows MCP clients to self-register and obtain a bearer token without a
manual `mcp_token_issue` ControlSocket call.

**Precondition:** `[mcp.dcr] enabled = true` AND `registration_secret`
non-empty. When either condition is false, this endpoint responds `404`.

**Request body** (JSON):

| Field | Type | Required | Description |
|---|---|---|---|
| `client_name` | string | no | Human-readable client label (stored as token name). Defaults to `"dcr"`. |
| `redirect_uris` | array | no | Ignored in v0 (client_credentials flow only). |
| `grant_types` | array | no | Must include `"client_credentials"` if provided. |
| `token_endpoint_auth_method` | string | no | Informational; `"none"` recommended. |
| `synaps_user_id` | string | **yes** | The Synaps user to bind the issued token to. |
| `registration_secret` | string | **yes** | Pre-shared admin secret. Compared constant-time. |

**Success response** (201):

```json
{
  "client_id":                "abc1234567890def",
  "client_secret":            "<raw token — returned ONCE>",
  "client_secret_expires_at": 9999999999,
  "token_endpoint_auth_method": "client_secret_post",
  "grant_types": ["client_credentials"],
  "token_type": "bearer"
}
```

**Error responses:**

| HTTP | Body `error` | Cause |
|---|---|---|
| 400 | `invalid_request` | Malformed body or missing `synaps_user_id`. |
| 401 | `invalid_client` | Missing or incorrect `registration_secret`. |
| 404 | `not_found` | DCR disabled (no secret configured). |
| 405 | `method_not_allowed` | Non-POST method. |
| 500 | `server_error` | Token storage failure. |

---

## Updated Endpoint Behaviour: `POST /mcp/v1`

### Rate limiting (Track 1)

When `[mcp.rate_limit] enabled = true`, every request is checked against
two independent token-bucket dimensions **before** body parsing:

- **per-token** — keyed on `SHA-256(bearer_token)`.
- **per-IP** — keyed on `req.socket.remoteAddress` (IPv6-mapped IPv4 stripped).

Both dimensions must allow the request (AND semantics). When blocked:

- HTTP 429
- Header: `Retry-After: <ceiling(retryAfterMs / 1000)>` (seconds)
- Body: JSON-RPC error `-32029` (`"Too many requests"`) with data:
  ```json
  { "retry_after_ms": 1000, "scope": "token" | "ip" }
  ```

### SSE upgrade (Track 3)

When `[mcp.sse] enabled = true` AND the request carries
`Accept: text/event-stream` AND the method is `tools/call`:

- Response: `200 text/event-stream` (SSE framing)
- Stream emits one or more `data: <json-rpc-notification>\n\n` frames
- Final `data: <json-rpc-result>\n\n` frame closes the stream

**SSE event format** (each line):
```
data: {"jsonrpc":"2.0","method":"synaps/result","params":{...}}\n\n
data: {"jsonrpc":"2.0","id":<id>,"result":{...}}\n\n
```

> **Deviation:** chunk-by-chunk streaming from `synaps_chat` is a TODO for
> Phase 9. Phase 8 emits a single notification frame + final result frame.
> The SSE transport path is exercised end-to-end.

---

## New Config Keys

### `[mcp.rate_limit]`

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `false` | Enable per-token + per-IP rate limiting. |
| `per_token_capacity` | int | `60` | Token-bucket size for per-token dimension. |
| `per_token_refill` | int | `1` | Tokens refilled per second (per-token). |
| `per_ip_capacity` | int | `120` | Token-bucket size for per-IP dimension. |
| `per_ip_refill` | int | `2` | Tokens refilled per second (per-IP). |

Buckets are in-process only (not shared across daemon replicas). Use an
upstream load-balancer-level rate limiter for cluster deployments.

### `[mcp.sse]`

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `false` | Enable SSE upgrade for `tools/call` requests. |

### `[mcp.dcr]`

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `false` | Enable the `POST /mcp/v1/register` endpoint. |
| `registration_secret` | string | `""` | Pre-shared admin secret. Empty → endpoint disabled. |
| `token_ttl_ms` | int | `31536000000` | Issued token lifetime in ms (default 365 days). |

### `[mcp]`

| Key | Type | Default | Description |
|---|---|---|---|
| `surface_rpc_tools` | bool | `false` | Merge per-user rpc workspace tools into `tools/list`. |

---

## New Error Codes

| Code | Name | Description |
|---|---|---|
| `-32029` | `RATE_LIMITED` | Request blocked by token-bucket rate limiter. |

Existing codes from Phase 7 (unchanged):

| Code | Name |
|---|---|
| `-32700` | `PARSE_ERROR` |
| `-32600` | `INVALID_REQUEST` |
| `-32601` | `METHOD_NOT_FOUND` |
| `-32602` | `INVALID_PARAMS` |
| `-32603` | `INTERNAL_ERROR` |
| `-32001` | `AUTH_REQUIRED` |
| `-32002` | `TOOL_TIMEOUT` |
| `-32003` | `APPROVAL_REQUIRED` |

---

## New Modules

| Module | Description |
|---|---|
| `bridge/core/mcp/mcp-rate-limiter.js` | Pure token-bucket rate limiter (Wave A1). |
| `bridge/core/mcp/mcp-sse-transport.js` | SSE framing helper for MCP-over-SSE (Wave A3). |
| `bridge/core/mcp/mcp-dcr.js` | OAuth2 DCR handler (Wave A4). |
| `bridge/core/synaps-rpc-session-router.js` | Per-user rpc workspace tool router (Wave A2). |

---

## Security Notes

### DCR Pre-Shared Secret

The `registration_secret` protects the `/mcp/v1/register` endpoint.

- It must be stored securely (e.g. via Infisical cred broker, not in
  plain-text `bridge.toml` in production).
- Comparison is performed with `crypto.timingSafeEqual()` to prevent
  timing-oracle attacks.
- The `registration_secret` is never logged.
- The issued `client_secret` (raw token) is returned **once** in the
  201 response body. It is **hashed** (SHA-256) before being written to
  `synaps_mcp_tokens`. After the response is sent, the raw token cannot
  be recovered from the system.

### Rate Limiting Security Model

- Buckets are keyed on **tokenHash** (SHA-256 of raw bearer) to avoid
  storing raw tokens in memory.
- IPv6-mapped IPv4 addresses are normalised (`::ffff:1.2.3.4 → 1.2.3.4`)
  before keying.
- Rate limiting fires **before** body parsing so even oversized or
  malformed requests consume a token.
- Bucket state is in-process; it resets on daemon restart. A persistent
  distributed limiter (Redis) is out of scope for Phase 8.

### SSE Transport

- `res.on('close', …)` is hooked so the keepalive interval timer is
  cleared when the peer disconnects, preventing memory leaks.
- `heartbeat.unref()` is called to prevent the timer from keeping the
  Node.js event loop alive in test environments.
- Per-nginx best practice, `X-Accel-Buffering: no` is set to prevent
  proxy buffering of SSE frames.

---

## Per-Tool Surfacing (Track 2)

When `surface_rpc_tools = true`, `tools/list` merges the static
`synaps_chat` descriptor with tools reported by the user's `synaps rpc`
workspace via `SynapsRpcSessionRouter.listTools()`.

The probe is **fault-tolerant**: if the rpc subprocess does not implement
`tools_list` (or times out within `probeTimeoutMs`, default 5 s), the
router returns `[]` silently and only `synaps_chat` appears in the list.

Tool-list results are cached per user for `cacheTtlMs` (default 30 s) to
avoid re-probing the subprocess on every `tools/list` request.

`tools/call` routing:

1. `name === "synaps_chat"` → existing sessionRouter path (unchanged).
2. `surfaceRpcTools && rpcRouter` → `rpcRouter.callTool(...)`.
3. Neither → JSON-RPC `-32601` Method Not Found.

Per-tool ACLs and approval gates are not changed by Phase 8; the existing
`McpApprovalGate` logic applies uniformly to all surfaced tools.

---

## Backwards Compatibility

All Phase 8 behaviours are **additive opt-in**:

| Feature | Default | Phase 7 behaviour preserved when off? |
|---|---|---|
| Rate limiting | `false` | Yes — no `check()` call, requests always allowed. |
| SSE | `false` | Yes — normal JSON response for `tools/call`. |
| DCR | `false` | Yes — `/mcp/v1/register` returns 404. |
| Per-tool surfacing | `false` | Yes — `tools/list` returns only `synaps_chat`. |

The `McpServer.handle()` signature gained two new optional parameters
(`tokenHash`, `ip`, `accept`). Callers that don't supply them see the
same behaviour as Phase 7.

---

## Rate Limit Defaults Rationale

| Parameter | Value | Rationale |
|---|---|---|
| `per_token_capacity` | 60 | One request per second sustained; burst of 60. |
| `per_token_refill` | 1 | 1 token/s → ceiling throughput 3 600 requests/hour. |
| `per_ip_capacity` | 120 | Allows multiple users behind the same IP (shared office). |
| `per_ip_refill` | 2 | 2 tokens/s → ceiling 7 200 requests/hour per IP. |

These defaults are conservative and can be tuned upward for high-traffic
deployments via `bridge.toml`.
