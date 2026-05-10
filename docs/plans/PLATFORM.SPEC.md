# Synaps Control Plane (SCP) — Platform Specification

**Version:** 0.1.0
**Date:** 2026-05-10
**Status:** ✅ **Approved 2026-05-10** — Phase 1 cleared to start
**Predecessors:**
- `synaps-bridge.SPEC.md` (v0.1.0, Slack-only bridge — shipped, 511/511 tests)
- `/tmp/synaps-design/BRIEF.md` + 8 research reports (A–H, ~131 KB)

---

## 0. Scope & non-scope

### What this spec covers
A **production-grade multi-tenant agent platform** that promotes the existing `synaps-bridge-plugin` from a Slack-only bridge to a full **control plane** governing:

1. Per-user containerized Ubuntu agent workspaces (Docker-in-Docker on a single ECS host).
2. Multiple inbound channels (Slack ✅, web dashboard, Discord, Telegram, Teams).
3. Live remote desktop view of each agent's GUI, in any browser.
4. Cross-channel **identity reconciliation** — Slack `U123` and dashboard `jane@x` resolve to one `SynapsUser`.
5. Persistent agent memory (axel-memory-manager) wired into every session.
6. Out-of-container **credential brokering** (Infisical) — agent never sees raw secrets.
7. eBPF **supervisor / kill-switch** (Tetragon) for runaway-agent containment.
8. **Heartbeat / liveness** protocol for every long-lived component.
9. **Cron / scheduled / proactive** agent runs (agenda-js on MongoDB).
10. **Hook lifecycle** (pre-tool / post-tool / pre-stream / post-stream / on-error).
11. MCP wire-compatible tool surface (so SCP-hosted tools work in any MCP client).

### Explicit non-goals
- Building our own LLM or our own agent runtime — Synaps Rust core stays as is.
- Replacing axel-memory-manager — it is THE memory layer, no Mem0/Letta/Zep.
- Replacing pria-ui-v22's MongoDB — `priadb` on `localhost` is the system of record.
- Per-user Fargate tasks — we use **one big ECS host** with Docker-in-Docker.
- Windows / macOS host support — Linux-only; v0 ships systemd unit.
- Re-implementing OAuth — pria-ui-v22 already owns `oauthProvider` collection.

---

## 1. Problem

The shipped Slack bridge proves the streaming-RPC pattern works, but **eight platform capabilities are still missing** before SCP can host real agents for real customers:

| # | Gap | Symptom today |
|---|---|---|
| 1 | Container orchestration | Bridge spawns `synaps rpc` on the host. No isolation, one bad agent crashes everyone. |
| 2 | Remote desktop | No way for a user to *see* what their agent is doing graphically. |
| 3 | Identity layer | Every channel is its own siloed user. Slack ≠ web ≠ Discord. |
| 4 | Web dashboard | Slack only. No first-party UI. |
| 5 | Credential broker | Secrets live as `process.env` in the bridge. Agent sees raw tokens. |
| 6 | Supervisor / kill-switch | No external watchdog. Runaway loops eat CPU until human intervenes. |
| 7 | Memory gateway | axel-memory-manager exists as a plugin but isn't bound per-user/per-channel. |
| 8 | Heartbeat / liveness | Daemon is fire-and-forget. No `/health`. No reaper for dead workspaces. |
| 9 | Cron / proactive | Agent only acts on inbound message. Can't wake itself on schedule. |
| 10 | Hook lifecycle | No standard pre/post-tool, pre/post-stream, on-error injection points. |
| 11 | MCP wire-compat | Synaps extensions speak Synaps-RPC, not MCP. External MCP clients can't reach them. |

Each gap is closed by exactly one phase below.

---

## 2. Solution overview

```
                                ┌─────────────────────────────────────────┐
                                │          Synaps Control Plane           │
                                │             (Node.js daemon)            │
   Slack ──┐                    │                                         │
   Discord─┤  ChannelAdapters → │  IdentityRouter → SessionRouter         │
   Web   ──┤                    │       │                  │              │
   API   ──┤                    │       ▼                  ▼              │
   Cron  ──┘                    │  pria MongoDB        WorkspaceManager   │
                                │  (priadb)               │               │
                                │  • SynapsUser           │ Docker socket │
                                │  • channel_identity     │ /var/run/...  │
                                │  • workspace            ▼               │
                                │  • scheduled_task   ┌──────────────────┐│
                                │                     │ Workspace pool   ││
                                │  MemoryGateway ←──→ │ (DinD nested)    ││
                                │  CredBroker(Infisical)                 │
                                │  Supervisor(Tetragon eBPF)             │
                                │  Scheduler(agenda-js)                  │
                                │  HookBus                               │
                                └─────────────────────────────────────────┘
                                                         │
                                              ┌──────────┼──────────┐
                                              ▼          ▼          ▼
                                          ┌────────┐ ┌────────┐ ┌────────┐
                                          │WS-001  │ │WS-002  │ │WS-NNN  │ Ubuntu containers
                                          │ Xvfb   │ │ Xvfb   │ │ Xvfb   │   (one per
                                          │Openbox │ │Openbox │ │Openbox │    SynapsUser)
                                          │KasmVNC │ │KasmVNC │ │KasmVNC │
                                          │synaps  │ │synaps  │ │synaps  │
                                          │  rpc   │ │  rpc   │ │  rpc   │
                                          │/home/  │ │/home/  │ │/home/  │
                                          │ agent  │ │ agent  │ │ agent  │ (EFS / volume)
                                          └────────┘ └────────┘ └────────┘
```

### Key shape decisions (locked)

1. **One big ECS host, Docker-in-Docker.** Not per-user Fargate. Cost & cold-start win; isolation comes from container boundaries + Tetragon, not VM boundaries.
2. **MongoDB only.** pg-boss → agenda-js. Shared `priadb` at `mongodb://localhost/priadb`. Reuse `institution`, `user`, `userInstitution`, `oauthProvider`, `mcpserver` collections — they already exist.
3. **axel-memory-manager is canonical memory.** MemoryGateway is a thin per-tenant namespace router on top of a single `.r8` brain per `SynapsUser`.
4. **KasmVNC** for desktop. Built-in HTTPS+WS, adaptive WebP/WebRTC, multi-user — beats Xvfb+x11vnc+noVNC stack.
5. **Tetragon** for supervisor. eBPF in-kernel SIGKILL is sub-millisecond; no userspace race.
6. **Infisical** (OSS, self-hosted) for cred broker. Result-proxy pattern: agent calls `cred.use("github.token")` → broker injects, runs HTTP, returns response. Agent never sees the token.
7. **Next.js + Vercel AI SDK `useChat`** for the web dashboard. SSE numbered data-stream protocol. Same streaming chunk types we already emit (`markdown_text`, `task_update`, `plan_update`, `suggested_response`).
8. **Convergence mode = none** for implementation. Single-agent execution, speed > bias-control. (Spec phase uses spec-driven-development; build phase doesn't.)

---

## 3. Architecture

### 3.1 Component map

| Component | Lang | Process | Responsibility |
|---|---|---|---|
| **SynapsCLI core** | Rust | per-thread `synaps rpc` child | LLM loop, tool dispatch, streaming chunks. **No changes needed.** |
| **SCP daemon** | Node 20 | one host process | Channel adapters, identity, routing, workspace mgmt, scheduling. Evolves from existing `synaps-bridge-plugin`. |
| **Workspace container** | — | one per `SynapsUser` | Ubuntu 22.04 + Xvfb + Openbox + KasmVNC + `synaps rpc`. |
| **Web dashboard** | Next.js 14 | `pria-ui-v22` host | `/synaps/chat` route, `useChat` SSE, OAuth via existing pria login. |
| **MemoryGateway** | Node | inline in SCP | Routes `memory.*` RPC events → axel sidecar with per-user namespace. |
| **CredBroker** | Node + Infisical | sidecar service | Holds tokens; agent calls broker, broker calls upstream. |
| **Supervisor** | Tetragon | systemd unit on host | eBPF policies; SIGKILL on policy violation. |
| **Scheduler** | agenda-js | inline in SCP | Cron + one-shot jobs in MongoDB; emits `proactive` events. |
| **HookBus** | Node | inline in SCP | Pub-sub for `pre_tool`, `post_tool`, `pre_stream`, `post_stream`, `on_error`. |

### 3.2 Data model (MongoDB additions)

Reuse from pria-ui-v22 (DO NOT duplicate):
- `users` — base user
- `institutions` — tenant
- `user_institutions` — membership / role
- `oauthproviders` — OAuth tokens (Slack, GitHub, Google)
- `mcpservers` — MCP server registry + approval workflow
- `sessions` — pria's session collection (we will NOT mix Synaps sessions in here)
- `memories` — pria's memory store (separate from axel; we don't touch this)

New collections SCP will add:

```js
// synaps_user — Synaps-side identity that aggregates channel_identities
{
  _id: ObjectId,
  pria_user_id: ObjectId,        // FK → users._id (1:1)
  institution_id: ObjectId,       // FK → institutions._id (denormalized for queries)
  display_name: String,
  workspace_id: ObjectId,         // FK → synaps_workspace (1:1)
  memory_namespace: String,       // axel .r8 namespace key, e.g. "u_<id>"
  default_channel: String,        // 'slack' | 'web' | 'discord' | ...
  created_at, updated_at,
}

// synaps_channel_identity — one row per (channel, external_id)
{
  _id: ObjectId,
  synaps_user_id: ObjectId,       // FK → synaps_user
  channel: String,                // 'slack' | 'web' | 'discord' | 'telegram' | 'teams'
  external_id: String,            // e.g. Slack 'U08XXX' or web 'jane@x.com'
  external_team_id: String,       // e.g. Slack 'T08Q47N2NUT'
  display_name: String,
  linked_at: Date,
  link_method: String,            // 'oauth' | 'magic_code' | 'admin'
}
// unique index: { channel: 1, external_id: 1, external_team_id: 1 }

// synaps_workspace — one Ubuntu container per SynapsUser
{
  _id: ObjectId,
  synaps_user_id: ObjectId,
  container_id: String,           // Docker ID once running
  state: String,                  // 'provisioning' | 'running' | 'stopped' | 'failed' | 'reaped'
  image: String,                  // 'synaps/workspace:0.1.0'
  volume_path: String,            // '/efs/agents/<user_id>'
  vnc_url: String,                // public KasmVNC URL behind auth
  rpc_socket: String,             // unix socket path inside DinD network
  last_heartbeat: Date,
  resource_limits: { cpu, mem, pids },
  created_at, updated_at,
}

// synaps_thread — bridge's existing session map, now persisted
{
  _id: ObjectId,
  synaps_user_id: ObjectId,
  workspace_id: ObjectId,
  channel: String,
  thread_key: String,             // e.g. Slack 'C08X.1234.5678'
  rpc_pid: Number,                // synaps rpc process id (inside container)
  state: String,                  // 'active' | 'idle' | 'closed'
  last_activity: Date,
  created_at, updated_at,
}

// synaps_scheduled_task — agenda-js will use its own collection by default;
// this is a higher-level user-visible record
{
  _id: ObjectId,
  synaps_user_id: ObjectId,
  agenda_job_id: ObjectId,        // FK → agendajobs._id (agenda native)
  name: String,                   // 'Monday GitHub PR digest'
  cron: String,                   // '0 9 * * MON'
  channel: String,                // where to deliver result
  prompt: String,                 // what to ask the agent
  enabled: Boolean,
  last_run, next_run, created_at,
}

// synaps_hook — registered hooks, per-user or per-tenant
{
  _id: ObjectId,
  scope: { type: 'user'|'institution'|'global', id: ObjectId? },
  event: String,                  // 'pre_tool' | 'post_tool' | 'pre_stream' | 'post_stream' | 'on_error'
  matcher: { tool?: String, channel?: String, ... },
  action: { type: 'webhook'|'inline_js'|'block', config: Mixed },
  enabled: Boolean,
  created_at,
}
```

### 3.3 Identity routing

```
inbound message
  → channel adapter normalizes to {channel, external_id, external_team_id, text, thread_key}
  → IdentityRouter.resolve()
       1. lookup synaps_channel_identity by (channel, external_id, external_team_id)
       2. if hit → return synaps_user
       3. if miss → create synaps_channel_identity in 'unlinked' state, return synthetic user
                    AND emit a "link prompt" back to the channel
                    ("Reply with /synaps link <code> on the web dashboard to link accounts")
  → SessionRouter.routeFor(synaps_user, thread_key)
       1. ensureWorkspace(synaps_user)  — boot container if not running
       2. ensureThread(synaps_user, thread_key) — spawn synaps rpc inside container
       3. attach StreamingProxy
```

### 3.4 Workspace container

`Dockerfile` (sketch):

```dockerfile
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y \
    xvfb openbox xterm firefox \
    curl ca-certificates sudo unzip \
    fonts-dejavu-core libnss3
# KasmVNC binary release (no compile)
RUN curl -fsSL https://github.com/kasmtech/KasmVNC/releases/.../kasmvncserver_*.deb -o /tmp/kasm.deb \
 && dpkg -i /tmp/kasm.deb && rm /tmp/kasm.deb
# Synaps Rust binary, multi-arch
COPY --from=synaps/cli:0.1 /usr/local/bin/synaps /usr/local/bin/synaps
RUN useradd -m -s /bin/bash agent && echo 'agent ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers
USER agent
WORKDIR /home/agent
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

`entrypoint.sh`:
1. start `Xvfb :1 -screen 0 1280x800x24`
2. start `openbox-session` against `:1`
3. start `kasmvncserver -display :1 -websocketPort 6901 -auth /run/secrets/kasm_user`
4. exec `tail -f /dev/null` (the actual `synaps rpc` is spawned **on demand** by SCP via `docker exec`, one per thread — workspace is the *house*, threads are *rooms*)

### 3.5 Streaming chunks (unchanged)

```
markdown_text   — assistant text, supports incremental
task_update     — subagent / nested task lifecycle  (id, parent_id, state, label)
plan_update     — high-level plan / TODO timeline
suggested_response — chip suggestions for next user message
```

These already work end-to-end on Slack via `chat.startStream` / `appendStream` / `stopStream`. Web dashboard reuses the **same chunks**, transported as Vercel AI SDK numbered data-stream frames.

### 3.6 Hook lifecycle

The Rust core emits 5 lifecycle events as RPC events; SCP's `HookBus` routes them:

```
pre_tool       { tool, args }              → may rewrite args, may block
post_tool      { tool, result, ms }        → audit / forward
pre_stream     { thread_key, first_chunk } → may inject system message
post_stream    { thread_key, summary }     → may persist to memory, may notify
on_error       { error, context }          → may retry, may escalate
```

Hooks are stored in `synaps_hook`. v0 supports `webhook` action only; `inline_js` is a Phase 7 stretch.

---

## 4. Phased roadmap

| Phase | Theme | Closes gaps | Outcome |
|---|---|---|---|
| **1 — Workspace container** | DinD + KasmVNC | 1, 2 | Each `SynapsUser` has a running container; user can view desktop in browser. |
| **2 — Memory gateway** | axel wired in | 7 | Every thread's RPC has memory pre-loaded for the user; consolidation runs on `post_stream`. |
| **3 — Web + Identity** | Next.js dashboard, IdentityRouter | 3, 4 | One Synaps account spans Slack + web. `/synaps link` flow works. |
| **4 — Credentials** | Infisical broker, result-proxy | 5 | Agent uses `cred.use("github.token")`; never sees the value. |
| **5 — Supervisor & Heartbeats** | Tetragon, `/health`, reaper | 6, 8 | Runaway agent SIGKILL'd in <1ms; dead workspaces reaped. |
| **6 — Scheduler & Hooks** | agenda-js, HookBus | 9, 10 | "Every Monday 9am" works; pre/post-tool hooks fire. |
| **7 — MCP wire-compat** | adapter | 11 | External MCP clients can list & call SCP-hosted tools. |

Each phase ships its own PR, its own tests, its own smoke playbook. **No phase merges without 100% test pass + smoke checklist signed off.**

---

## 5. Phase 1 — Workspace container (detailed)

### 5.1 Deliverables
- `synaps-workspace/Dockerfile`, `entrypoint.sh`, `docker-bake.hcl`
- `bridge/core/workspace-manager.{js,test.js}` — boots/stops/exec containers via `dockerode`
- New RPC bridge mode: `synaps rpc` is launched via `docker exec <container> synaps rpc` instead of host spawn
- KasmVNC proxy route in SCP daemon: `GET /vnc/:workspace_id` → reverse-proxy to `container:6901` after auth check
- MongoDB writes: `synaps_workspace` rows, lifecycle transitions
- Smoke test: provision workspace, open browser to VNC URL, see Openbox desktop

### 5.2 Open questions for Phase 1
- **Image size budget?** Target ≤ 800 MB. Firefox alone is ~250 MB; consider Chromium or no browser baseline.
- **EFS vs. local volume for `/home/agent`?** EFS for persistence across host replacement; local for speed. Recommend EFS with local cache layer in v1.
- **Resource limits per workspace?** Propose: 1 CPU, 2 GB RAM, 256 PIDs default. Per-tenant override via `institution.resource_quota`.
- **Concurrency cap on the host?** ECS instance type → max workspaces. e.g. `c6i.4xlarge` (16 vCPU / 32 GB) → ~16 concurrent active workspaces, ~50 idle.

### 5.3 Acceptance criteria
1. `WorkspaceManager.ensure(synaps_user_id)` returns a running container in <8s on warm host, <30s cold.
2. KasmVNC URL renders Openbox desktop in Chrome/Firefox with mouse + keyboard working.
3. `synaps rpc` spawned via `docker exec` produces identical line-JSON to host-spawn (regression suite reused).
4. Killing the SCP daemon does NOT kill running workspaces; restarting reattaches.
5. Reaper unit test: workspace with `last_heartbeat > 30 min` is stopped on the next sweep.

---

## 6. Phase 2 — Memory gateway

### 6.1 Design
axel-memory-manager runs as a **single sidecar** on the SCP host (not per-container). It exposes:
```
search(namespace, query, k)
store(namespace, text, metadata)
consolidate(namespace, since)
```
`MemoryGateway` in SCP wraps these calls and **prepends the namespace** = `synaps_user.memory_namespace` (e.g. `u_507f1f77`).

Each thread's `synaps rpc`:
- on session start, SCP injects a `pre_stream` system block with `recent_memory_summary`
- on `post_stream`, SCP forwards the final assistant text + tool calls to `MemoryGateway.store(...)`
- nightly cron triggers `consolidate(namespace)` per active user

### 6.2 Acceptance
- Two threads from the same `SynapsUser` share recall ("you told me yesterday X").
- Two threads from different users do NOT cross-contaminate (namespace test).
- Disabling `memory.enabled = false` in `bridge.toml` short-circuits the gateway with no errors.

---

## 7. Phase 3 — Web dashboard + Identity

### 7.1 Web
- Route lives in pria-ui-v22 under `/synaps/*`
- `app/synaps/chat/page.tsx` — `useChat({ api: '/api/synaps/stream' })`
- `app/api/synaps/stream/route.ts` — proxies to SCP control socket; translates SCP chunks → Vercel AI SDK numbered frames:
  ```
  0:"text"          ← markdown_text
  2:[{...}]         ← task_update / plan_update (data parts)
  8:[{...}]         ← suggested_response (annotations)
  d:{...}           ← done frame, finishReason
  ```
- Auth: pria existing session cookie. SCP trusts `x-pria-user-id` header from same-host proxy.

### 7.2 Identity reconciliation
- New page `/synaps/link` shows a 6-char code valid for 5 min
- User types `/synaps link ABC123` in Slack; bridge calls SCP → SCP looks up code → links Slack `external_id` to existing `SynapsUser`
- Same flow for Discord etc.

### 7.3 Acceptance
- Same user can chat from Slack and web; both threads see the same memory.
- Streaming chunks render identically (text, task tree, suggestion chips).
- Logout in pria invalidates web SCP session.

---

## 8. Phase 4 — Credentials (Infisical)

### 8.1 Pattern
Agent never holds a token. Instead, tools call `cred_broker.use(key, request)`:
```
agent → cred_broker.use("github.token", { method: "GET", url: "https://api.github.com/user" })
cred_broker → fetch with Authorization: Bearer <token from Infisical>
cred_broker → return { status, headers, body } to agent
```
This is the **result-proxy pattern**. The token never crosses the agent boundary.

### 8.2 Infisical layout
- One Infisical project per `institution`
- One folder per `synaps_user`
- Secrets keyed by canonical name: `github.token`, `slack.bot.token`, etc.

### 8.3 Acceptance
- `agent.run("git push")` succeeds without `GITHUB_TOKEN` in container env.
- Container env audit: zero secrets present (`env | grep -i token` returns empty).
- Infisical audit log shows token use with `synaps_user_id` attribution.

---

## 9. Phase 5 — Supervisor & heartbeats

### 9.1 Tetragon policies (v0)
- `block_egress_to_metadata_service` — no `169.254.169.254`
- `block_unprivileged_kernel_modules`
- `kill_on_fork_bomb` — > N forks/sec
- `kill_on_cpu_runaway` — > 90% CPU sustained 60s

### 9.2 Heartbeats
Every long-lived component emits to MongoDB `synaps_heartbeat`:
```
{ component: 'workspace'|'rpc'|'scp', id, ts, healthy: bool, details }
```
Reaper sweeps every 60s:
- workspace stale > 30 min → stop container, mark `state='reaped'`
- rpc stale > 5 min → kill rpc, keep workspace
- scp stale > 30s → systemd restart (handled by `Restart=always`)

### 9.3 Acceptance
- Forced fork-bomb in workspace → SIGKILL within 100 ms; SCP records `reaped_by='tetragon'`.
- `/health` on SCP returns 200 with component table; 503 if any critical component stale.

---

## 10. Phase 6 — Scheduler & Hooks

### 10.1 agenda-js
- Mongo collection `agendajobs` (agenda default)
- SCP exposes:
  - `POST /api/scheduled` create
  - `DELETE /api/scheduled/:id`
  - `GET /api/scheduled?user=...`
- On fire, agenda emits a synthetic inbound event into the channel adapter for the user's `default_channel`.

### 10.2 HookBus
- Hooks stored in `synaps_hook`
- `HookBus.emit(event, payload)` → matches → fires actions in parallel with 5s timeout
- v0: `webhook` action only (HTTP POST with HMAC signature)

### 10.3 Acceptance
- `cron: "0 9 * * MON"` job fires Monday 9am, posts to user's default channel.
- pre_tool webhook receives JSON with tool name + args; returning `{ block: true }` aborts the call.

---

## 11. Phase 7 — MCP wire-compat

### 11.1 Plan
- New SCP HTTP endpoint: `/mcp/v1/*` implementing MCP HTTP transport
- Inside, translate to existing Synaps RPC tool surface
- pria's `mcpserver` collection lists them; existing approval workflow gates access

### 11.2 Acceptance
- Claude Desktop with `mcp.json` pointing to `https://scp.example.com/mcp/v1` lists Synaps tools.
- Tool call round-trips through the live workspace.

---

## 12. Cross-cutting concerns

### 12.1 Configuration
`~/.synaps-cli/bridge/bridge.toml` grows:

```toml
[platform]
mode = "scp"  # was "bridge" — same daemon, more capabilities

[mongodb]
uri = "mongodb://localhost/priadb"

[workspace]
image = "synaps/workspace:0.1.0"
docker_socket = "/var/run/docker.sock"
volume_root = "/efs/agents"
default_cpu = 1.0
default_mem_mb = 2048
default_pids = 256
idle_reap_minutes = 30

[memory]
enabled = true
axel_socket = "/run/synaps/axel.sock"

[creds]
broker = "infisical"
infisical_url = "https://infisical.internal"
infisical_token_file = "/run/secrets/infisical_token"

[supervisor]
tetragon_policy_dir = "/etc/tetragon/synaps"

[scheduler]
enabled = true

[web]
trust_proxy_header = "x-pria-user-id"
allowed_origin = "https://pria.example.com"
```

### 12.2 Secrets
- `~/.config/synaps/scp.env` (mode 0600) — only `MONGODB_URI`, `INFISICAL_TOKEN`, `KASM_ADMIN_PASSWORD`
- All other secrets resolved at runtime via Infisical
- Single chokepoint module: `bridge/core/secrets.js`

### 12.3 Testing strategy
- Unit: vitest, `pool: 'vmThreads'` (existing config)
- Integration: dockerode against a local Docker; gated by `INTEGRATION=1`
- E2E: existing `tests/bridge-e2e/` harness extended with workspace boot
- Smoke: per-phase markdown checklist in `docs/smoke/phase-N.md`

### 12.4 Observability
- `pino` JSON logs to stdout (systemd journal in prod)
- Per-tenant metrics: `synaps_workspace_active_total{institution_id="..."}`
- OpenTelemetry trace spans across `IdentityRouter → SessionRouter → WorkspaceManager → SynapsRpc`

### 12.5 Migration from current bridge
- Phase 0 (already done): bridge daemon stable on Slack
- Phase 1 add-on: introduce `WorkspaceManager` behind `[platform] mode = "scp"` flag; old `mode = "bridge"` keeps host-spawn behavior — **zero breaking change for the live Slack deployment**
- Phases 2–7 default off, opt-in per-institution

---

## 13. Risks & gotchas

| Risk | Mitigation |
|---|---|
| DinD privileged container = host-escape risk | Tetragon policies + non-root inner user + read-only host bind mounts |
| ECS host single point of failure | v0 single AZ, single host. v1: warm standby + EFS for state. Documented as known limitation. |
| KasmVNC over public URL = attack surface | Behind same-origin proxy in pria-ui-v22, requires authenticated session cookie |
| axel `.r8` brain lock contention with many users | Per-user namespace, but single file. If contention shows up, shard by `synaps_user_id` hash. |
| Infisical outage = agent can't act | CredBroker caches last-known-good token for 5 min; surfaces "creds unavailable" tool error after that. |
| pria-ui-v22 schema drift | Treat pria collections as read-mostly; add new collections rather than mutating existing ones. Coordinate breaking changes via pria team. |
| Slack rate limits with many tenants | Existing per-thread queue stays; add per-team token-bucket layer in `bridge/sources/slack`. |
| MongoDB hot collections (`agendajobs`, `synaps_heartbeat`) | TTL indexes; capped collection for heartbeat. |

---

## 14. Decisions locked (2026-05-10)

All eight open questions resolved by project owner:

| # | Question | Decision |
|---|---|---|
| 1 | ECS instance type for v0 | ✅ `c6i.4xlarge` (16 vCPU / 32 GB, ~16 active workspaces) |
| 2 | Storage for `/home/agent` | ✅ **EFS** — persistence across host replacement, accept ~50 ms tail |
| 3 | Browser baseline in workspace image | ✅ **Chromium** (lighter than Firefox) |
| 4 | Web dashboard route placement | ✅ Mount inside pria-ui-v22 — **as a new root-level page like `Pria.js`** (top-level route at `/synaps`, parallel to existing root pages — NOT nested inside another page). Same SSO cookie. |
| 5 | `idle_reap_minutes` default | ✅ 30 min |
| 6 | Linking code shape | ✅ 6-char alphanumeric, 5 min TTL, 5 attempts |
| 7 | Tetragon policy review cadence | ✅ Quarterly + on-incident |
| 8 | axel `.r8` tenancy strategy | ✅ Namespace-in-one-file v0; shard if contention shows up |

### Phase 3 clarification (decision 4)

The web chat UI is a **new top-level page in pria-ui-v22**, peer to whatever existing root pages exist (e.g. `Pria.js`-style). Concretely:

- File: `pria-ui-v22/pages/Synaps.js` (or framework-equivalent root component)
- Route: `/synaps` (and `/synaps/*` for sub-routes like `/synaps/chat`, `/synaps/link`, `/synaps/scheduled`)
- Auth: pria's existing session cookie — no separate login
- Streaming: `useChat({ api: '/api/synaps/stream' })` proxies to SCP control socket
- API routes: `pages/api/synaps/*` — `stream`, `link`, `scheduled`, `workspace/vnc`

This keeps a single deploy unit (pria-ui-v22) and a single auth surface.

---

## 15. Success criteria for the whole platform

When all 7 phases ship, this is true end-to-end:

> Jane signs into pria-ui-v22 with Google. She visits `/synaps/chat`, types "hi". A workspace boots in 8 seconds. The agent replies. She clicks "Open Desktop" — Openbox renders in her browser. She types `/synaps link ABC123` in Slack from her phone — Slack and web are now the same Synaps user. She tells the agent in Slack "remind me to review PRs every Monday at 9". On Monday at 9, her web dashboard chat receives a streamed report listing GitHub PRs — the agent used `cred_broker.use("github.token", ...)` and never saw the raw token. She closes her laptop. The container reaps after 30 minutes. Next time she chats, axel-memory-manager recalls the PR routine. Throughout, Tetragon would have killed the agent in <1ms if it tried to read AWS metadata. SCP `/health` is 200 the whole time. None of this required modifying SynapsCLI core — only additive work in the bridge daemon and pria-ui-v22 routes.

If that scenario passes its smoke playbook, SCP v0.1.0 is done.

---

## 16. Approval

✅ **Approved 2026-05-10** by project owner (jr).

All eight open questions answered (see §14). Phase 1 worktree may begin.
