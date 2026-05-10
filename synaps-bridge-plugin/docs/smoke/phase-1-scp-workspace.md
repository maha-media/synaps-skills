# Phase 1 — SCP Workspace: Manual Smoke Playbook

> **Scope:** End-to-end local verification of the Synaps Control Plane Phase 1
> workspace container feature on a developer's machine. No AWS, no production
> deploy, no Kubernetes.
>
> **Spec reference:** `synaps-skills/docs/plans/PLATFORM.SPEC.md` § 5.3

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Build the workspace image](#2-build-the-workspace-image)
3. [Run the workspace container manually (without bridge)](#3-run-the-workspace-container-manually-without-bridge)
4. [Configure SCP mode in bridge.toml](#4-configure-scp-mode-in-bridgetoml)
5. [Start the bridge daemon in SCP mode](#5-start-the-bridge-daemon-in-scp-mode)
6. [Verify /health](#6-verify-health)
7. [Trigger workspace boot via Slack DM](#7-trigger-workspace-boot-via-slack-dm)
8. [Open the desktop in browser](#8-open-the-desktop-in-browser)
9. [Send a tool-using prompt](#9-send-a-tool-using-prompt)
10. [Reaper test](#10-reaper-test)
11. [Cleanup](#11-cleanup)
12. [Acceptance grid (mirrors spec § 5.3)](#12-acceptance-grid-mirrors-spec--53)
13. [Known gaps / Phase-1 limits](#13-known-gaps--phase-1-limits)

---

## 1. Prerequisites

### 1.1 Docker daemon

Phase 1 requires Docker (or compatible runtime exposing the standard socket).

```bash
docker info
```

Expected: Docker server info block — engine version, storage driver, etc.
If you see `Cannot connect to the Docker daemon`, start the service:

```bash
# Linux (systemd)
sudo systemctl start docker

# macOS — ensure Docker Desktop is running
open -a Docker
```

### 1.2 MongoDB

The bridge needs MongoDB ≥ 6.0. For local smoke testing the quickest option
is a throw-away container:

```bash
docker run -d --name mongo-smoke -p 27017:27017 mongo:7
```

Or, if you already have a local `mongod`:

```bash
mongosh --eval "db.adminCommand({ ping: 1 })"
# { ok: 1 }
```

### 1.3 Node ≥ 20

```bash
node --version
# v20.x.x or newer
```

If you use a version manager:

```bash
nvm use 20      # nvm
fnm use 20      # fnm
```

### 1.4 Synaps Rust binary

Phase 1 ships a **placeholder** `synaps` script inside the workspace image
(the upstream Rust release pipeline is not yet wired). For local testing the
image build falls back gracefully: `SYNAPS_BIN_URL` is a Docker build-arg that
overrides where the binary is fetched from. You may:

- Leave the arg unset → placeholder `synaps` shell script is used (sufficient
  for smoke testing through Step 8; Step 9 requires a real binary).
- Set `SYNAPS_BIN_URL` to a presigned S3 URL or local HTTP server serving the
  real binary if you want to smoke Step 9 end-to-end.

```bash
# Expose a local file as a build-arg (optional):
export SYNAPS_BIN_URL="http://host.docker.internal:8888/synaps"
python3 -m http.server 8888 --directory /path/to/rust/release &
```

---

## 2. Build the workspace image

```bash
cd synaps-workspace
docker buildx bake dev
```

> **Note:** The `dev` target in `docker-bake.hcl` builds
> `synaps/workspace:dev` from `Dockerfile`. The first build pulls the Ubuntu
> 22.04 base layer and installs Chromium + KasmVNC — allow 3–5 minutes on a
> cold cache.

Confirm the image is present:

```bash
docker images synaps/workspace
```

Expected output:

```
REPOSITORY        TAG     IMAGE ID       CREATED         SIZE
synaps/workspace  dev     <sha>          X minutes ago   <700 MB
```

The image **must be ≤ 800 MB** (spec § 5.1). If it exceeds this, check for
stray apt caches — the Dockerfile should run `apt-get clean && rm -rf
/var/lib/apt/lists/*`.

---

## 3. Run the workspace container manually (without bridge)

Start a standalone container to confirm KasmVNC boots independently:

```bash
docker run --rm -d \
  -p 6901:6901 \
  --name ws-smoke \
  synaps/workspace:dev
```

Wait ~10 seconds for KasmVNC to initialize, then open the VNC web UI:

```
https://localhost:6901
```

> **Self-signed certificate:** Accept the browser security warning — KasmVNC
> generates a self-signed TLS cert at startup.

**Expected:** KasmVNC login screen appears. Enter the configured password
(default: `vncpassword` or whatever `VNC_PW` was set to in the image).
After login, the Openbox desktop renders (black background, right-click
for menu).

Verify the agent home directory:

```bash
docker exec ws-smoke ls /home/agent
# may be empty — that's fine; volume is not mounted in this standalone run
```

Tear down the standalone container before moving on:

```bash
docker rm -f ws-smoke
```

---

## 4. Configure SCP mode in `bridge.toml`

The bridge reads `~/.synaps-cli/bridge/bridge.toml` by default (override with
`--config <path>`). Create or edit it:

```bash
mkdir -p ~/.synaps-cli/bridge
cat > ~/.synaps-cli/bridge/bridge.toml << 'EOF'
[platform]
mode = "scp"

[mongodb]
uri = "mongodb://localhost/priadb_dev"

[workspace]
image              = "synaps/workspace:dev"
docker_socket      = "/var/run/docker.sock"
volume_root        = "/tmp/scp-smoke/agents"
idle_reap_minutes  = 30

[web]
enabled   = true
bind      = "127.0.0.1"
http_port = 8723

[bridge]
log_level = "debug"

[sources.slack]
enabled          = true
bot_token_env    = "SLACK_BOT_TOKEN"
app_token_env    = "SLACK_APP_TOKEN"
respond_to_dms   = true
EOF
```

Create the volume root directory:

```bash
mkdir -p /tmp/scp-smoke/agents
```

---

## 5. Start the bridge daemon in SCP mode

Export your Slack tokens (skip if you only want to test HTTP routes without
Slack connectivity):

```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
```

Set the default user ID (a 24-hex ObjectId used as the fallback Synaps user
when no real identity mapping is present in Phase 1):

```bash
export SCP_DEFAULT_USER_ID=000000000000000000000001
```

Start the daemon:

```bash
node bin/synaps-bridge.js
```

Or, to run in the background and tail logs:

```bash
node bin/synaps-bridge.js &
tail -f ~/.synaps-cli/bridge/daemon.log
```

**Expected log lines (in order):**

```
[config] mode=scp
[db] connected to mongodb mongodb://localhost/priadb_dev
[WorkspaceManager] initialized image=synaps/workspace:dev volumeRoot=/tmp/scp-smoke/agents
[ScpHttpServer] listening on 127.0.0.1:8723 (mode=scp)
[Slack] connected to workspace <workspace name>
```

If you see `MongoServerSelectionError`, confirm MongoDB is running (Step 1.2).

---

## 6. Verify `/health`

```bash
curl -s http://127.0.0.1:8723/health | jq .
```

Expected response:

```json
{
  "status": "ok",
  "mode": "scp",
  "ts": "2025-05-10T12:34:56.789Z"
}
```

If you get `Connection refused`, check that `[web] enabled = true` is set and
the daemon is running on the expected port.

---

## 7. Trigger workspace boot via Slack DM

Open Slack and send a direct message to your Synaps bot:

```
Hello, synaps
```

Watch the daemon log:

```bash
tail -f ~/.synaps-cli/bridge/daemon.log
```

**Expected log sequence:**

```
[WorkspaceManager] ensure: user=000000000000000000000001 — no live workspace found, provisioning
[WorkspaceManager] docker.createContainer: name=synaps-ws-<id> image=synaps/workspace:dev
[WorkspaceManager] ensure: workspace <id> running (container=<container_id>)
```

Verify the container is running:

```bash
docker ps --filter 'name=synaps-ws-'
```

Expected:

```
CONTAINER ID   IMAGE                   COMMAND   CREATED        STATUS        PORTS                    NAMES
<id>           synaps/workspace:dev    ...       1 minute ago   Up 1 minute   6901/tcp                 synaps-ws-<workspace_id>
```

---

## 8. Open the desktop in browser

### 8.1 Find the workspace ID

```bash
mongosh priadb_dev --eval "db.synaps_workspaces.findOne()" --quiet
```

Copy the `_id` hex string from the output (e.g. `6641a1b2c3d4e5f607080910`).

### 8.2 Verify with curl first

```bash
WS_ID=<paste workspace _id here>
curl -v \
  -H "x-synaps-user-id: 000000000000000000000001" \
  http://127.0.0.1:8723/vnc/${WS_ID}/
```

Expected: HTTP 200 or redirect from KasmVNC upstream (or 502 if the container
IP is unreachable from the host — see note below).

> **Host networking note:** By default the bridge proxies to the container's
> Docker-bridge IP (e.g. `172.17.0.x`). On Linux this is reachable from the
> host. On macOS/Windows with Docker Desktop the internal network is not
> directly reachable; use `docker exec ws-smoke ...` for RPC testing and
> connect to VNC via `https://localhost:6901` using the standalone method
> (Step 3) as a workaround until Phase 3 port-forward mode is implemented.

### 8.3 Open in browser

Browsers block custom request headers set via the URL bar. Two workarounds:

**Option A — ModHeader extension (Chrome/Edge/Firefox):**

1. Install [ModHeader](https://modheader.com/) or
   [SimpleModifyHeaders](https://addons.mozilla.org/en-US/firefox/addon/simple-modify-header/).
2. Add header: `x-synaps-user-id: 000000000000000000000001`.
3. Navigate to `http://127.0.0.1:8723/vnc/${WS_ID}/`.

**Option B — tiny local reverse proxy (no extension required):**

```bash
# Requires Node ≥ 18 (built-in fetch + http modules)
node - << 'EOF'
import http from 'node:http';
const WS_ID = process.env.WS_ID || '<your-workspace-id>';
const UPSTREAM = `http://127.0.0.1:8723`;
const PORT = 9901;
http.createServer((req, res) => {
  const opts = {
    hostname: '127.0.0.1', port: 8723,
    path: req.url, method: req.method,
    headers: { ...req.headers, 'x-synaps-user-id': '000000000000000000000001' },
  };
  const proxy = http.request(opts, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
  proxy.on('error', (e) => { res.writeHead(502); res.end(e.message); });
  req.pipe(proxy);
}).listen(PORT, '127.0.0.1', () => console.log(`Proxy on http://127.0.0.1:${PORT}/vnc/${WS_ID}/`));
EOF
```

Then open `http://127.0.0.1:9901/vnc/${WS_ID}/` in your browser.

**Expected:** KasmVNC desktop for the container Slack just booted.

---

## 9. Send a tool-using prompt

In the Slack DM to your bot:

```
open chromium and go to example.com
```

**Expected:**

- In daemon log: `synaps rpc` (or docker exec equivalent) invoked with the
  prompt.
- A `task_update` stream chunk appears in the Slack thread.
- In VNC browser (Step 8): Chromium opens and navigates to `example.com`.

> **Note:** This step requires a real `synaps` Rust binary in the image
> (Step 1.4). With the placeholder binary you will see the prompt echoed
> but no actual tool execution.

---

## 10. Reaper test

The idle workspace reaper is **Phase 5** and is not implemented in Phase 1.
The following describes the intended future behavior for documentation purposes.

### Phase 5 (future) procedure:

1. Set `idle_reap_minutes = 0.05` (3 seconds) in `bridge.toml` and restart.
2. Wait 30 seconds without sending any messages.
3. **Expected (Phase 5):** daemon log shows:
   ```
   [WorkspaceReaper] workspace <id> idle — reaping
   [WorkspaceManager] reap: workspace <id> reaped
   ```
4. `docker ps --filter 'name=synaps-ws-'` shows no containers.
5. `mongosh priadb_dev --eval "db.synaps_workspaces.findOne()"` shows
   `state: 'reaped'`.

**⚠️ Phase 1 status:** The `WorkspaceManager.reap()` method exists and is
tested, but no periodic reaper sweep is scheduled. This is a known gap —
see [§ 13](#13-known-gaps--phase-1-limits).

---

## 11. Cleanup

Stop the bridge daemon:

```bash
# If running in foreground: Ctrl-C
# If backgrounded:
node bin/synaps-bridge.js stop
# or:
kill $(pgrep -f synaps-bridge)
```

Remove all smoke workspace containers:

```bash
docker rm -f $(docker ps -aq --filter 'name=synaps-ws-')
```

Clean up MongoDB test data:

```bash
mongosh priadb_dev --eval "db.synaps_workspaces.deleteMany({})"
```

Remove the throw-away MongoDB container (if you started one in Step 1.2):

```bash
docker rm -f mongo-smoke
```

Remove volume root data:

```bash
rm -rf /tmp/scp-smoke
```

---

## 12. Acceptance grid (mirrors spec § 5.3)

| # | Criterion | How to verify | Pass? |
|---|-----------|---------------|-------|
| 1 | `WorkspaceManager.ensure()` completes in < 8 s (warm) or < 30 s (cold boot) | Compare timestamps in `daemon.log` between "ensure called" and "workspace running" | ☐ |
| 2 | KasmVNC URL renders Openbox desktop | Step 8: `/vnc/<id>/` returns KasmVNC page; VNC session shows Openbox | ☐ |
| 3 | `synaps rpc` via `docker exec` produces identical line-JSON to local binary | Unit tests (`npm test`) + Step 9: response streamed to Slack | ☐ |
| 4 | Killing daemon does NOT kill workspaces; restart reattaches to existing container | `kill $(pgrep -f synaps-bridge)` → `docker ps` still shows container → restart bridge → send another DM → no new container created | ☐ |
| 5 | Reaper deletes stale workspace container and sets `state = 'reaped'` in Mongo | Step 10 | ☐ *(Phase 5)* |

### How to record results

After running each step, update the table above (or a copy of it in your team
wiki) with the actual timing from daemon.log and a ✓ or ✗ in the Pass column.

---

## 13. Known gaps / Phase-1 limits

### Reaper not implemented (Phase 5)

`WorkspaceManager.reap()` exists and is unit-tested, but no background sweep
timer is wired. Stale containers will remain running until manually stopped or
until the Phase 5 reaper sweep is landed.

**Workaround:** Periodically run `docker rm -f $(docker ps -aq --filter
'name=synaps-ws-')` during development.

### Auth on `/vnc/*` is header-trust only (Phase 3 will add pria session)

Phase 1 checks `x-synaps-user-id` header against the workspace's owner field.
This is only safe when the VNC proxy is behind a trusted same-host proxy
(i.e., the bridge itself). Do **not** expose port 8723 directly to the
internet in Phase 1.

Phase 3 will replace this with pria session-cookie verification.

### Synaps Rust binary is a build-arg placeholder (no upstream image yet)

The `synaps-workspace/Dockerfile` accepts `SYNAPS_BIN_URL` as an ARG. When the
arg is absent the build falls back to a placeholder shell script named `synaps`
that echoes its arguments as JSON. No real AI inference happens with the
placeholder.

The upstream binary release pipeline (GitHub Actions → S3 presigned URL) is
not yet wired. This means Step 9 (tool-using prompt) is only fully verifiable
once the binary pipeline is in place.

### Single-user mode only (Phase 3)

Phase 1 uses `SCP_DEFAULT_USER_ID` as a fixed fallback. Multi-user identity
reconciliation (mapping Slack `user_id` → Synaps `ObjectId`) is Phase 3.

### macOS/Windows VNC proxy connectivity

On macOS/Windows with Docker Desktop, the container's internal Docker-bridge
IP is not directly reachable from the host. The `/vnc/*` proxy will return
502. Use the standalone VNC method (Step 3) for VNC verification on these
platforms until Phase 3 introduces explicit port-forwarding.
