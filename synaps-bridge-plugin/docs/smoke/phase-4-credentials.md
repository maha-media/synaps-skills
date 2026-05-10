# Phase 4 — Credential Broker (Infisical): Manual Smoke Playbook

> **Scope:** End-to-end local verification of the Synaps Bridge Phase 4
> result-proxy credential broker backed by Infisical.
>
> **Spec reference:** `synaps-skills/docs/plans/PLATFORM.SPEC.md` §8

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Step 1 — Set up Infisical project, folder, and secret](#2-step-1--set-up-infisical-project-folder-and-secret)
3. [Step 2 — Configure `bridge.toml`](#3-step-2--configure-bridgetoml)
4. [Step 3 — Restart bridge daemon + verify startup log](#4-step-3--restart-bridge-daemon--verify-startup-log)
5. [Step 4 — Send `cred_broker_use` op via control socket](#5-step-4--send-cred_broker_use-op-via-control-socket)
6. [Step 5 — Verify response shape + Infisical audit log](#6-step-5--verify-response-shape--infisical-audit-log)
7. [Step 6 — Disconnect Infisical (simulate outage)](#7-step-6--disconnect-infisical-simulate-outage)
8. [Step 7 — Verify cached value served within 5 min](#8-step-7--verify-cached-value-served-within-5-min)
9. [Step 8 — Wait > 10 min → verify `creds_unavailable`](#9-step-8--wait--10-min--verify-creds_unavailable)
10. [Step 9 — Token-leak audit](#10-step-9--token-leak-audit)
11. [Rollback](#11-rollback)

---

## 1. Prerequisites

### 1.1 Infisical instance running (self-hosted)

The smoke test targets a self-hosted Infisical instance.  You can start a
local one using the official Docker Compose bundle:

```bash
# Clone Infisical and start with Docker Compose
git clone https://github.com/Infisical/infisical
cd infisical
docker compose -f docker-compose.prod.yml up -d

# Default URL: http://localhost:8080
# Create an admin account via the web UI.
```

Alternatively, [Infisical Cloud](https://app.infisical.com) works identically
for this smoke test — substitute the cloud URL where you see
`https://infisical.internal`.

Confirm it is accessible:

```bash
curl -s https://infisical.internal/api/status
# Expected: HTTP 200 (may return {} or a version JSON)
```

### 1.2 Node ≥ 20

```bash
node --version
# v20.x.x or newer
```

### 1.3 Synaps bridge built

```bash
cd synaps-bridge-plugin
ls bridge/core/cred-broker.js bridge/core/cred-broker/infisical-client.js
# Both files must exist (Wave A output)
```

### 1.4 `infisical` CLI on PATH (optional, for CLI-driven setup)

```bash
infisical --version
# If not installed: https://infisical.com/docs/cli/overview
```

---

## 2. Step 1 — Set up Infisical project, folder, and secret

### Via Infisical web UI

1. **Create a project** named `synaps-smoke` (or any name).
   - Note the **Project ID** — this is your `institution_id`.
   - Example: `6636c1f2e4b0c3a1d7890001`

2. **Navigate to Secrets → Development environment** (or any environment).

3. **Create the folder path** `/users/u_smoke_test_01`:
   - In the Secrets view, click "Add folder", name it `users`.
   - Inside `users`, create a subfolder `u_smoke_test_01`.

4. **Add a secret** named `github.token` inside `/users/u_smoke_test_01`:
   - Value: `ghp_SmokeTestFakeToken12345` (or your real GitHub PAT)

### Via Infisical CLI

```bash
# Authenticate
infisical login --method=universal-auth \
  --client-id=<your-client-id> \
  --client-secret=<your-client-secret>

# Set the secret (replace PROJECT_ID with your project ID)
infisical secrets set github.token="ghp_SmokeTestFakeToken12345" \
  --projectId=6636c1f2e4b0c3a1d7890001 \
  --path=/users/u_smoke_test_01 \
  --env=dev
```

### Create a service token

In Infisical:
1. **Settings → Service Tokens → New Token**
2. Scope: the project + `/users/*` folder (read access is sufficient)
3. **Copy the token** — you will never see it again.
4. Write it to a file the bridge can read:

```bash
echo 'st.abc123...your-infisical-service-token' \
  > ~/.synaps-cli/bridge/infisical-token
chmod 600 ~/.synaps-cli/bridge/infisical-token
```

> **Security:** This file should be owned by the bridge daemon user with
> `mode 0600`.  Do NOT commit it or put it in the TOML file directly.

---

## 3. Step 2 — Configure `bridge.toml`

Create or edit `~/.synaps-cli/bridge/bridge.toml`:

```bash
mkdir -p ~/.synaps-cli/bridge
```

Add the `[creds]` section:

```toml
[creds]
broker                = "infisical"
infisical_url         = "https://infisical.internal"
infisical_token_file  = "~/.synaps-cli/bridge/infisical-token"
cache_ttl_secs        = 300
audit_attribute_user  = true
```

> **Note:** `~` in `infisical_token_file` is expanded by the bridge config
> loader.  If you prefer an absolute path, use
> `/home/<user>/.synaps-cli/bridge/infisical-token`.

> **Default OFF:** If you omit the `[creds]` section entirely, the bridge
> uses `NoopCredBroker` and the `cred_broker_use` op returns
> `{ ok:false, code:'creds_disabled' }`.  Existing Slack / SCP behaviour is
> completely unaffected.

---

## 4. Step 3 — Restart bridge daemon + verify startup log

```bash
# Stop any running daemon.
systemctl --user stop synaps-bridge || true

# Start (or run in foreground for smoke testing):
node bin/synaps-bridge.js 2>&1 | tee /tmp/bridge-smoke.log
```

Wait for the startup log lines.  Expected lines:

```
BridgeDaemon: cred broker initialized (enabled=true, broker=infisical)
ControlSocket: listening on /home/<user>/.synaps-cli/bridge/control.sock
BridgeDaemon: started
```

**Checkpoint:**

| Expected log line | Pass? |
|---|---|
| `cred broker initialized (enabled=true, broker=infisical)` | ☐ |
| `ControlSocket: listening on …control.sock` | ☐ |
| No `ERROR` or `warn` on startup | ☐ |

If you see `enabled=false` or `broker=noop`, the `[creds]` section was not
saved correctly — re-check Step 2.

---

## 5. Step 4 — Send `cred_broker_use` op via control socket

Open a second terminal and use `nc` (netcat) to send the op:

```bash
# Using netcat with Unix domain socket support
echo '{"op":"cred_broker_use","synaps_user_id":"u_smoke_test_01","institution_id":"6636c1f2e4b0c3a1d7890001","key":"github.token","request":{"method":"GET","url":"https://api.github.com/user"}}' \
  | nc -U ~/.synaps-cli/bridge/control.sock
```

Or using the bridge's own scripts if available:

```bash
node scripts/bridge-ctl.js cred_broker_use \
  --synaps_user_id u_smoke_test_01 \
  --institution_id 6636c1f2e4b0c3a1d7890001 \
  --key github.token \
  --method GET \
  --url https://api.github.com/user
```

You can also pipe a JSON file for more complex requests (e.g. POST with body):

```bash
cat <<'EOF' | nc -U ~/.synaps-cli/bridge/control.sock
{"op":"cred_broker_use","synaps_user_id":"u_smoke_test_01","institution_id":"6636c1f2e4b0c3a1d7890001","key":"github.token","request":{"method":"POST","url":"https://httpbin.org/post","headers":{"Content-Type":"application/json"},"body":"{\"hello\":\"world\"}"}}
EOF
```

---

## 6. Step 5 — Verify response shape + Infisical audit log

### Expected success response

```json
{
  "ok": true,
  "status": 200,
  "headers": { "content-type": "application/json; charset=utf-8", "...": "..." },
  "body": "{\"login\":\"your-github-bot-user\", ...}",
  "cached": false,
  "fetched_at": 1718000000000
}
```

Key checks:

| Field | Expected | Pass? |
|---|---|---|
| `ok` | `true` | ☐ |
| `status` | HTTP status from upstream (e.g. 200) | ☐ |
| `body` | Valid JSON from GitHub API | ☐ |
| `cached` | `false` on first call | ☐ |
| No `token`, `authorization`, `secret` top-level keys | absent | ☐ |
| Token string NOT present outside `body` field | absent | ☐ |

### Verify Infisical audit log shows `synaps_user_id` attribution

In the Infisical web UI:
1. **Audit Logs** (Settings → Audit Logs or Project → Activity)
2. Look for a `SECRET_READ` event for the secret path
   `/users/u_smoke_test_01` with secretName `github.token`.
3. The event's `User-Agent` header should contain `synaps-cred-broker/u_smoke_test_01`
   (set by the bridge when `audit_attribute_user = true`).

```bash
# Or check bridge logs for the Infisical request line:
grep "InfisicalClient.*getSecret" /tmp/bridge-smoke.log | tail -5
# Expected: debug log with baseUrl, institutionId, synapsUserId, key — NO token value.
```

**Checkpoint:**

| Check | Pass? |
|---|---|
| Response `ok:true` | ☐ |
| GitHub API response body is valid JSON | ☐ |
| Infisical audit log shows the secret read | ☐ |
| `synaps-cred-broker/<userId>` in User-Agent | ☐ |

---

## 7. Step 6 — Disconnect Infisical (simulate outage)

Simulate an Infisical outage by blocking outbound traffic to Infisical or
stopping its container.

```bash
# Option A — iptables block (Linux)
sudo iptables -I OUTPUT -d <infisical-host-ip> -j REJECT

# Option B — stop the Docker Compose stack
cd infisical && docker compose stop

# Option C — edit /etc/hosts to misdirect (simplest for local smoke)
echo '127.0.0.1 infisical.internal' | sudo tee -a /etc/hosts
```

**Verify Infisical is unreachable:**

```bash
curl -s --max-time 3 https://infisical.internal/api/status
# Expected: connection refused / timeout
```

---

## 8. Step 7 — Verify cached value served within 5 min

**Immediately after blocking Infisical** (within `cache_ttl_secs = 300`
seconds), send the same op again:

```bash
echo '{"op":"cred_broker_use","synaps_user_id":"u_smoke_test_01","institution_id":"6636c1f2e4b0c3a1d7890001","key":"github.token","request":{"method":"GET","url":"https://api.github.com/user"}}' \
  | nc -U ~/.synaps-cli/bridge/control.sock
```

Expected response:

```json
{
  "ok": true,
  "status": 200,
  "cached": true,
  "fetched_at": <same timestamp as Step 4>
}
```

Also check the bridge log for the graceful-degradation warning if past TTL
but within the 2× TTL window:

```bash
tail -20 /tmp/bridge-smoke.log | grep -i "stale\|unavailable\|warn"
# Expected (if past TTL): "CredBroker: Infisical unavailable, using stale cached token"
```

**Checkpoint:**

| Check | Pass? |
|---|---|
| Response `ok:true` with Infisical down | ☐ |
| `cached: true` in response | ☐ |
| GitHub API still responds correctly (cached token works) | ☐ |
| No token string in warn log | ☐ |

---

## 9. Step 8 — Wait > 10 min → verify `creds_unavailable`

Wait until the cache TTL has been exceeded **twice** (> `cache_ttl_secs × 2`
seconds = 10 minutes with default `cache_ttl_secs = 300`).

```bash
# Check current time so you know when 10 min has elapsed
date
# Then wait...
sleep 610  # 10 min 10 sec
```

Send the op again:

```bash
echo '{"op":"cred_broker_use","synaps_user_id":"u_smoke_test_01","institution_id":"6636c1f2e4b0c3a1d7890001","key":"github.token","request":{"method":"GET","url":"https://api.github.com/user"}}' \
  | nc -U ~/.synaps-cli/bridge/control.sock
```

Expected response (exact code depends on whether the expired entry still
exists in the cache and which Infisical error type is returned):

```json
{
  "ok": false,
  "code": "broker_upstream",
  "error": "infisical upstream error: …"
}
```

Or, if the broker wrapped it:

```json
{
  "ok": false,
  "code": "creds_unavailable",
  "error": "failed to obtain credential for key \"github.token\": …"
}
```

**Checkpoint:**

| Check | Pass? |
|---|---|
| Response `ok: false` | ☐ |
| `code` is `broker_upstream` or `creds_unavailable` | ☐ |
| No token in error message | ☐ |

---

## 10. Step 9 — Token-leak audit

This is the most critical acceptance check for Phase 4.

```bash
# Check daemon logs for any token strings.
# Replace 'ghp_SmokeTestFakeToken12345' with your actual token prefix.
journalctl -u synaps-bridge --since "1 hour ago" \
  | grep -iE "ghp_|st\.[a-z0-9]{40}|bearer [a-zA-Z0-9._-]{20,}" \
  | head -20

# Or if running in foreground / log file:
grep -iE "ghp_|bearer [a-zA-Z0-9._-]{20,}" /tmp/bridge-smoke.log | head -20
```

**Expected result: zero matching lines.**

If any lines appear, a token has leaked into the logs — this is a critical
security defect.  Stop the daemon immediately and audit `bridge/core/cred-broker.js`
and `bridge/core/cred-broker/infisical-client.js` for any `logger.*` calls
that might include token-bearing values.

```bash
# Automated token-leak grep in source (should return nothing):
grep -rn "Bearer\|secretValue\|infisical_token" \
  bridge/core/cred-broker.js bridge/core/cred-broker/infisical-client.js \
  | grep -i "log\|warn\|error\|info\|debug"
# Expected: no output
```

**Checkpoint:**

| Check | Pass? |
|---|---|
| `journalctl` grep returns zero lines | ☐ |
| Source audit grep returns zero lines | ☐ |
| Token never appears in `result` fields outside `body` | ☐ |

---

## 11. Rollback

### Disable credential broker

Set `enabled = false` (or remove the `[creds]` section) in `bridge.toml`
and restart the daemon:

```toml
[creds]
enabled = false
```

The broker switches to `NoopCredBroker`.  All existing Slack / SCP sessions
continue unaffected.  Any `cred_broker_use` ops will return
`{ ok:false, code:'creds_disabled' }`.

### Re-enable Infisical

1. Restore Infisical connectivity (reverse the iptables rule / Docker Compose
   restart / etc.).
2. Verify with `curl https://infisical.internal/api/status`.
3. Restart the bridge daemon.
4. Send the `cred_broker_use` op again — should return `ok:true` with
   `cached:false`.

### Rotate the service token

1. In Infisical, revoke the old token and create a new one.
2. Write the new token to `~/.synaps-cli/bridge/infisical-token`:
   ```bash
   echo 'st.new-token-value' > ~/.synaps-cli/bridge/infisical-token
   chmod 600 ~/.synaps-cli/bridge/infisical-token
   ```
3. Send SIGHUP to the bridge process (the `InfisicalClient` will reload the
   token on the next request):
   ```bash
   systemctl --user kill -s HUP synaps-bridge
   ```
4. Verify the next `cred_broker_use` op succeeds.
