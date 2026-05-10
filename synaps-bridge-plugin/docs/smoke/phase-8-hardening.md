# Phase 8 — Production Hardening Smoke Playbook

**Branch:** `feat/scp-phase-8-hardening`
**Stacked on:** Phase 7 (#39)

This playbook assumes a locally-running SCP daemon with the following
`bridge.toml` snippet enabled:

```toml
[platform]
mode = "scp"

[web]
enabled   = true
http_port = 8080
bind      = "127.0.0.1"

[mcp]
enabled   = true

[mcp.rate_limit]
enabled              = true
per_token_capacity   = 60
per_token_refill     = 1
per_ip_capacity      = 120
per_ip_refill        = 2

[mcp.sse]
enabled = true

[mcp.dcr]
enabled             = true
registration_secret = "my-admin-secret"
token_ttl_ms        = 31536000000     # 365 days

[mcp]
surface_rpc_tools = true
```

Set `MCP_TOKEN` to a valid MCP bearer token obtained via `mcp_token_issue`
or via the DCR endpoint (Track 4).

---

## Track 1 — Rate Limiting

### Curl: normal request (within rate limit)

```bash
curl -s -X POST http://127.0.0.1:8080/mcp/v1 \
  -H "Content-Type: application/json" \
  -H "MCP-Token: $MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}' | jq .
```

**Expected:**
```json
{ "jsonrpc": "2.0", "id": 1, "result": {} }
```

### Curl: exhaust per-token bucket (fire > 60 requests rapidly)

```bash
for i in $(seq 1 65); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://127.0.0.1:8080/mcp/v1 \
    -H "Content-Type: application/json" \
    -H "MCP-Token: $MCP_TOKEN" \
    -d '{"jsonrpc":"2.0","id":'"$i"',"method":"ping","params":{}}'
done
```

**Expected:** first 60 → `200`, subsequent → `429`.

### Verify Retry-After header on 429

```bash
curl -si -X POST http://127.0.0.1:8080/mcp/v1 \
  -H "Content-Type: application/json" \
  -H "MCP-Token: $MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":99,"method":"ping","params":{}}' | grep -i retry-after
```

**Expected:** `Retry-After: 1` (or higher depending on refill rate).

### Troubleshooting: rate limit not triggering

- Check `[mcp.rate_limit] enabled = true` in `bridge.toml`.
- `per_token_capacity` defaults to 60 — reduce to 5 in dev for quick testing.
- Per-IP limit only fires when > 120 requests from the same IP in the window.

---

## Track 2 — Per-Tool Surfacing

### Curl: tools/list with surface_rpc_tools=true

```bash
curl -s -X POST http://127.0.0.1:8080/mcp/v1 \
  -H "Content-Type: application/json" \
  -H "MCP-Token: $MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq '.result.tools[].name'
```

**Expected:** `"synaps_chat"` plus any tools registered in the user's
`synaps rpc` workspace (e.g. `"web_fetch"`, `"web_search"`).

When the rpc subprocess does not yet expose `tools_list`, the router
returns `[]` (fault-tolerant probe) and the list contains only `synaps_chat`.

### Curl: call an rpc-surfaced tool

```bash
curl -s -X POST http://127.0.0.1:8080/mcp/v1 \
  -H "Content-Type: application/json" \
  -H "MCP-Token: $MCP_TOKEN" \
  -d '{
    "jsonrpc":"2.0","id":3,"method":"tools/call",
    "params":{ "name":"web_fetch","arguments":{"url":"https://example.com"} }
  }' | jq '.result'
```

**Expected:** `{ "content": [{ "type": "text", "text": "..." }], "isError": false }`

### Troubleshooting: only synaps_chat appears

- `surface_rpc_tools = false` is the default — set it to `true`.
- If the rpc subprocess doesn't implement `tools_list`, the probe returns `[]`
  silently (check bridge log for `SynapsRpcSessionRouter.listTools: probe failed`).

---

## Track 3 — MCP-over-SSE Streaming

### Curl: tools/call with Accept: text/event-stream

```bash
curl -sN -X POST http://127.0.0.1:8080/mcp/v1 \
  -H "Content-Type: application/json" \
  -H "MCP-Token: $MCP_TOKEN" \
  -H "Accept: text/event-stream" \
  -d '{
    "jsonrpc":"2.0","id":4,"method":"tools/call",
    "params":{ "name":"synaps_chat","arguments":{"prompt":"Hello agent"} }
  }'
```

**Expected output (SSE framing):**

```
retry: 1500

data: {"jsonrpc":"2.0","method":"synaps/result","params":{...}}

data: {"jsonrpc":"2.0","id":4,"result":{...}}

```

> **Note:** Chunk-by-chunk streaming from `synaps_chat` is a Phase 9 TODO.
> Phase 8 exercises the SSE framing path with a single-notification +
> single-result pattern. The transport is exercised end-to-end.

### Verify SSE headers

```bash
curl -si -X POST http://127.0.0.1:8080/mcp/v1 \
  -H "Content-Type: application/json" \
  -H "MCP-Token: $MCP_TOKEN" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"synaps_chat","arguments":{"prompt":"hi"}}}' \
  | head -10
```

**Expected headers:**
```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

### Troubleshooting: getting JSON instead of SSE

- `[mcp.sse] enabled = true` must be set in `bridge.toml`.
- The MCP client must send `Accept: text/event-stream`.

---

## Track 4 — OAuth2 Dynamic Client Registration (DCR)

### Curl: register a new client

```bash
curl -s -X POST http://127.0.0.1:8080/mcp/v1/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name":         "My MCP Client",
    "redirect_uris":       ["http://localhost"],
    "grant_types":         ["client_credentials"],
    "token_endpoint_auth_method": "none",
    "synaps_user_id":      "YOUR_SYNAPS_USER_ID",
    "registration_secret": "my-admin-secret"
  }' | jq .
```

**Expected:**
```json
{
  "client_id":                "abc1234567890def",
  "client_secret":            "<raw token — store immediately, not shown again>",
  "client_secret_expires_at": 9999999999,
  "token_endpoint_auth_method": "client_secret_post",
  "grant_types":              ["client_credentials"],
  "token_type":               "bearer"
}
```

Use `client_secret` as the `MCP-Token` header value for subsequent calls.

### Curl: wrong registration_secret → 401

```bash
curl -s -X POST http://127.0.0.1:8080/mcp/v1/register \
  -H "Content-Type: application/json" \
  -d '{"synaps_user_id":"u1","registration_secret":"WRONG"}' | jq .
```

**Expected:** `{ "error": "invalid_client" }` with HTTP 401.

### Curl: DCR disabled → 404

When `[mcp.dcr] enabled = false` or `registration_secret` is unset:

```bash
curl -si -X POST http://127.0.0.1:8080/mcp/v1/register \
  -H "Content-Type: application/json" \
  -d '{"synaps_user_id":"u1","registration_secret":"any"}' | head -5
```

**Expected:** `HTTP/1.1 404 Not Found`

### Troubleshooting: DCR

- Both `enabled = true` AND a non-empty `registration_secret` are required.
- The `registration_secret` is compared using `crypto.timingSafeEqual()` —
  timing attacks against the secret are not feasible.
- The issued `client_secret` is the raw token (returned ONCE). It is hashed
  before storage in `synaps_mcp_tokens`. Never log the raw value.

---

## Health check

```bash
curl -s http://127.0.0.1:8080/health | jq .
```

**Expected:** `{ "status": "ok", "mode": "scp", "ts": "..." }`
