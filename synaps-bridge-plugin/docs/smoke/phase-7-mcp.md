# Phase 7 MCP — Manual Smoke Playbook

**Applies to:** `feat/scp-phase-7-mcp` branch  
**Requires:** Bridge daemon in SCP mode, MongoDB running, `curl`, `node`, `mongosh` (for policy insertion)

---

## Prerequisites

1. **Bridge daemon** configured in SCP mode with MCP enabled:

   ```toml
   # /tmp/smoke-bridge.toml

   [platform]
   mode = "scp"

   [web]
   enabled   = true
   http_port = 18080
   bind      = "127.0.0.1"

   [mongodb]
   uri = "mongodb://localhost/priadb"

   [mcp]
   enabled            = true
   audit              = false
   chat_timeout_ms    = 120000
   max_body_bytes     = 262144
   policy_name        = "synaps-control-plane"
   ```

2. **MongoDB** running locally on default port (`mongod` or Atlas).
3. Optional: a running `synaps rpc` session for `tools/call` to return real output.

---

## Step 1 — Start the bridge

```bash
cd synaps-bridge-plugin
node bridge/bin/synaps-bridge.js --config /tmp/smoke-bridge.toml &
# Note the PID for later cleanup
BRIDGE_PID=$!
echo "Bridge PID: $BRIDGE_PID"
```

**Expected log:**
```
BridgeDaemon: started
[mcp] enabled
ScpHttpServer: listening on 0.0.0.0:18080
ControlSocket: listening on /home/<user>/.synaps-cli/bridge/control.sock
```

---

## Step 2 — Issue a token via the control socket

Use a Node.js one-liner to send `mcp_token_issue` over the UDS:

```bash
node -e '
  import("node:net").then(({ default: net }) => {
    const s = net.createConnection(
      process.env.HOME + "/.synaps-cli/bridge/control.sock"
    );
    s.on("connect", () => s.write(JSON.stringify({
      op:             "mcp_token_issue",
      synaps_user_id: "507f1f77bcf86cd799439011",
      institution_id: "507f1f77bcf86cd799439012",
      name:           "smoke-test"
    }) + "\n"));
    s.on("data", d => { console.log(d.toString()); s.end(); });
  });
' | tee /tmp/smoke-mcp-token.json
```

**Expected response:**
```json
{
  "ok":         true,
  "token":      "a3f8...64hex...b12c",
  "_id":        "6641abc123...",
  "name":       "smoke-test",
  "expires_at": null,
  "created_at": "2025-01-15T10:00:00.000Z"
}
```

> **Security:** The raw `token` value is returned exactly once. Save it now:
> ```bash
> MCP_TOKEN=$(jq -r '.token' /tmp/smoke-mcp-token.json)
> echo "Token: $MCP_TOKEN"
> ```

---

## Step 3 — Verify 401 without token

```bash
curl -i http://localhost:18080/mcp/v1 \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

**Expected:** `HTTP/1.1 401` with `AUTH_REQUIRED` error code (`-32001`) in the JSON-RPC envelope.

---

## Step 4 — `initialize` with MCP-Token header

```bash
curl -si http://localhost:18080/mcp/v1 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "MCP-Token: $MCP_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id":      1,
    "method":  "initialize",
    "params":  {
      "protocolVersion": "2024-11-05",
      "capabilities":    {},
      "clientInfo":      { "name": "smoke-client", "version": "0.0.1" }
    }
  }' | jq .
```

**Expected:** HTTP 200, response body:
```json
{
  "jsonrpc": "2.0",
  "id":      1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities":    { "tools": { "listChanged": false }, "logging": {} },
    "serverInfo":      { "name": "synaps-control-plane", "version": "0.1.0" },
    "instructions":    "Synaps Control Plane MCP gateway..."
  }
}
```

---

## Step 5 — Insert an institution policy row (enables tools/list)

Without a policy row in `mcpservers`, the approval gate denies all tools.
Insert a permissive policy via `mongosh`:

```bash
mongosh priadb --eval '
  db.mcpservers.insertOne({
    name:               "synaps-control-plane",
    institution:        ObjectId("507f1f77bcf86cd799439012"),
    status:             "active",
    tool_configuration: { enabled: false, allowed_tools: [] },
    require_approval:   { enabled: false, skip_approval_tools: [] }
  });
'
```

---

## Step 6 — `tools/list`

```bash
curl -si http://localhost:18080/mcp/v1 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "MCP-Token: $MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq .
```

**Expected:** HTTP 200, `result.tools` contains `synaps_chat`:
```json
{
  "jsonrpc": "2.0",
  "id":      2,
  "result": {
    "tools": [
      {
        "name":        "synaps_chat",
        "description": "Send a prompt to your Synaps agent workspace...",
        "inputSchema": { "type": "object", "properties": { "prompt": { ... } } }
      }
    ]
  }
}
```

---

## Step 7 — `tools/call` (optional — requires live synaps rpc session)

> This step requires an active Synaps workspace session for `synaps_user_id: "507f1f77bcf86cd799439011"`.
> Skip if no workspace is running.

```bash
curl -si http://localhost:18080/mcp/v1 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "MCP-Token: $MCP_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id":      3,
    "method":  "tools/call",
    "params":  {
      "name":      "synaps_chat",
      "arguments": { "prompt": "Hello, who are you?" }
    }
  }' | jq .
```

**Expected:** HTTP 200, `result.content[0].text` contains the agent's text reply within 120 s.

---

## Step 8 — Claude Desktop configuration

Add the following to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `~/.config/Claude/claude_desktop_config.json` (Linux):

```jsonc
{
  "mcpServers": {
    "synaps": {
      "transport": "http",
      "url":       "http://localhost:18080/mcp/v1",
      "headers": {
        "MCP-Token": "<your-raw-token-here>"
      }
    }
  }
}
```

Restart Claude Desktop.  In the tool picker (⚙ icon) you should see **synaps_chat** listed
under the `synaps` server.

---

## Step 9 — List tokens and revoke

```bash
# List all tokens for the test user
node -e '
  import("node:net").then(({ default: net }) => {
    const s = net.createConnection(
      process.env.HOME + "/.synaps-cli/bridge/control.sock"
    );
    s.on("connect", () => s.write(JSON.stringify({
      op:             "mcp_token_list",
      synaps_user_id: "507f1f77bcf86cd799439011"
    }) + "\n"));
    s.on("data", d => { console.log(d.toString()); s.end(); });
  });
'

# Revoke by _id (copy from list response or /tmp/smoke-mcp-token.json)
TOKEN_ID=$(jq -r '._id' /tmp/smoke-mcp-token.json)
node -e '
  import("node:net").then(({ default: net }) => {
    const s = net.createConnection(
      process.env.HOME + "/.synaps-cli/bridge/control.sock"
    );
    s.on("connect", () => s.write(JSON.stringify({
      op:       "mcp_token_revoke",
      token_id: "'"$TOKEN_ID"'"
    }) + "\n"));
    s.on("data", d => { console.log(d.toString()); s.end(); });
  });
'
```

**Expected revoke response:** `{"ok":true}`

---

## Step 10 — Confirm 401 after revoke

```bash
curl -si http://localhost:18080/mcp/v1 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "MCP-Token: $MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{}}' | head -5
```

**Expected:** `HTTP/1.1 401` — the revoked token is no longer accepted.

---

## Step 11 — Audit log (if enabled)

If `[mcp] audit = true` is set:

```bash
mongosh priadb --eval '
  db.synaps_mcp_audit.find().sort({ts:-1}).limit(5).pretty()
'
```

Each document shows `method`, `outcome`, `duration_ms`, `synaps_user_id`, `institution_id`.

---

## Step 12 — Cleanup

```bash
kill $BRIDGE_PID

# Drop smoke data from MongoDB
mongosh priadb --eval '
  db.synaps_mcp_tokens.deleteMany({ synaps_user_id: ObjectId("507f1f77bcf86cd799439011") });
  db.mcpservers.deleteMany({ institution: ObjectId("507f1f77bcf86cd799439012") });
'
```

---

## Pass / Fail Criteria

| Step | What to check | Pass | Fail |
|------|--------------|------|------|
| 1 | Bridge starts without errors | Log shows `[mcp] enabled` | Any startup exception |
| 2 | Token issue | `ok:true`, `token` is 64-char hex | `ok:false` or malformed token |
| 3 | 401 without token | HTTP 401, `AUTH_REQUIRED` code | Any other status |
| 4 | initialize | HTTP 200, `protocolVersion: "2024-11-05"` | Non-200 or wrong version |
| 5 | Policy insertion | `mongosh` returns `insertedId` | Write error |
| 6 | tools/list | `synaps_chat` present in `tools` array | Empty tools or 401 |
| 7 | tools/call | `isError: false`, text content | Error or timeout |
| 8 | Claude Desktop | `synaps_chat` appears in tool picker | Tool not listed |
| 9 | Revoke | `{"ok":true}` | `{"ok":false}` |
| 10 | 401 after revoke | HTTP 401 | Token still accepted |
| 11 | Audit log | Documents present with correct fields | Empty collection |
| 12 | Cleanup | No errors | Mongo errors |
