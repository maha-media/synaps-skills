# synaps-workspace

> Ubuntu 22.04 desktop container — one per `SynapsUser`, accessed via KasmVNC.
> Part of the **Synaps Control Plane (SCP)** Phase 1.

---

## What this image is

Each active `SynapsUser` gets a dedicated container running a full Linux desktop
environment. The desktop is exposed over **KasmVNC** (HTTPS + WebSocket, port 6901)
so users can view and interact with the agent's screen directly in their browser.

The container is designed to be a **long-lived house**: it idles after booting the
desktop stack, and SCP spawns `synaps rpc` inside it on demand via `docker exec`
whenever a thread needs an agent process. When the user's session ends, the
container keeps running (idle) for up to 30 minutes before SCP's reaper stops it.

---

## What's inside

| Component        | Version / Source                          |
|------------------|-------------------------------------------|
| Base OS          | Ubuntu 22.04 LTS (jammy)                  |
| Xvfb             | Ubuntu 22.04 package (`xvfb`)             |
| Openbox WM       | Ubuntu 22.04 package (`openbox`)          |
| Chromium         | Ubuntu 22.04 package (`chromium-browser`) |
| KasmVNC          | **1.3.2** (pinned ARG; official `.deb` from [kasmtech/KasmVNC releases](https://github.com/kasmtech/KasmVNC/releases)) |
| xterm            | Ubuntu 22.04 package (`xterm`)            |
| synaps (Rust)    | Provided via `SYNAPS_BIN_URL` build arg (placeholder if unset — see below) |
| Runtime user     | `agent` (non-root, passwordless sudo)     |

---

## Build

### Prerequisites

```sh
docker buildx version   # >= 0.10
```

### Production image (tagged `0.1.0` + `latest`)

```sh
cd synaps-workspace/
docker buildx bake
```

### Dev image (tagged `:dev`, for local iteration)

```sh
docker buildx bake dev
```

### Override KasmVNC version

```sh
KASMVNC_VERSION=1.3.3 docker buildx bake dev
```

### Inject a prebuilt synaps Rust binary

The `SYNAPS_BIN_URL` build arg accepts a URL to a `.tar.gz` tarball containing a
`synaps` ELF binary (either at archive root or in a `bin/` subdirectory).

```sh
SYNAPS_BIN_URL=https://example.com/artifacts/synaps-linux-x64-0.5.0.tar.gz \
  docker buildx bake dev
```

If `SYNAPS_BIN_URL` is **not** set, a placeholder script is installed at
`/usr/local/bin/synaps` that prints `synaps binary not installed at build time`
and exits 1. This makes any accidental `docker exec … synaps rpc` fail loudly
rather than silently hanging.

---

## Run locally (manual smoke test)

```sh
docker run --rm -p 6901:6901 synaps/workspace:dev
```

Then open **`https://localhost:6901`** in your browser.

> **Note:** KasmVNC uses a self-signed certificate by default. Accept the
> browser warning. In production, SCP's reverse proxy terminates TLS with a
> valid cert (Phase 3+).

You should see an Openbox desktop running inside your browser.

To verify `synaps` is installed (when built with `SYNAPS_BIN_URL`):

```sh
docker exec <container_id> synaps --version
```

---

## How SCP uses this image

### Boot a workspace container

```sh
docker run -d \
  --name ws-<workspace_id> \
  -v efs-agent-home:/home/agent \
  --cpus 1 \
  --memory 2g \
  --pids-limit 256 \
  synaps/workspace:0.1.0
```

SCP's `workspace-manager.js` automates this via the `dockerode` library.

### Spawn the agent RPC process (on demand, per thread)

```sh
docker exec -d ws-<workspace_id> synaps rpc
```

The entrypoint keeps the container alive. `synaps rpc` is completely decoupled
from the desktop stack — it can be killed and re-spawned without affecting the
browser VNC session.

### Stop a workspace

```sh
docker stop ws-<workspace_id>
docker rm   ws-<workspace_id>
```

The reaper in SCP stops containers whose `last_heartbeat` is older than 30 minutes
(see `PLATFORM.SPEC.md §5`, heartbeat contract).

---

## Why no auth on KasmVNC

Phase 1 runs KasmVNC without HTTP Basic Auth (`-disableBasicAuth`). A random VNC
password is still generated at container start (stored in a tmpfile, never
exposed to callers) to satisfy KasmVNC's internal requirement.

**Production** runs KasmVNC behind SCP's authenticated reverse proxy
(Phase 3+). The proxy validates the user's session cookie before forwarding the
WebSocket to `container:6901`. No VNC credential is ever transmitted to the
browser.

This is a deliberate Phase 1 trade-off: the VNC port is not published to the
host except when SCP explicitly proxies it. Containers are in an isolated Docker
network; port 6901 is not reachable from outside the host.

---

## Image size budget

**Target: ≤ 800 MB** (compressed layer size on disk after `docker pull`).

The main contributors are:

| Layer                          | Approx. size |
|--------------------------------|-------------|
| ubuntu:22.04 base              | ~30 MB       |
| System packages (incl. Chromium) | ~350 MB    |
| KasmVNC .deb                   | ~80 MB       |
| synaps binary (optional)       | ~10–30 MB    |

**Measured image size:** TBD until first build (no network egress in CI wave).

Strategies to stay under budget:
- `--no-install-recommends` on all `apt-get install` calls.
- `rm -rf /var/lib/apt/lists/*` after each `RUN` that calls `apt-get`.
- Multi-stage build: the `kasmvnc` and `synaps_bin` stages keep temporary
  download artifacts out of the final layer.

---

## Open questions / TODOs

1. **Synaps Rust binary distribution** — The delivery mechanism for the
   `synaps` binary is not yet decided. The `SYNAPS_BIN_URL` build arg is a
   temporary workaround. Options under consideration: publish a GitHub Release
   asset, push to a private S3 bucket, or build the binary inside a separate
   multi-stage Docker stage from source.

2. **KasmVNC arm64** — `platforms = ["linux/amd64"]` only. The arm64 `.deb`
   asset naming and availability needs verification before enabling arm64 builds.

3. **KasmVNC `-disableBasicAuth` flag availability** — Verify the flag exists
   in KasmVNC 1.3.2. If not present, the entrypoint's password-file approach
   already handles the constraint gracefully.

4. **Resource limits** — `--cpus`, `--memory`, `--pids-limit` are set by the
   caller (SCP `workspace-manager.js`), not baked into the image. Defaults
   proposed in spec: 1 CPU, 2 GB RAM, 256 PIDs. Per-tenant overrides tracked
   in `institution.resource_quota` (Phase 2).

5. **Persistent home directory** — The `-v efs-agent-home:/home/agent` volume
   mount shown above assumes EFS is provisioned. Phase 1 can use a named Docker
   volume locally; EFS migration is Phase 2.
