# synaps-bridge-plugin

**synaps-bridge** is a long-running daemon that connects external chat
platforms to the Synaps AI engine. **Slack is the primary target at v0.** The
daemon maintains one `synaps rpc` child process per active Slack thread, giving
each conversation a fully isolated Synaps session with its own message history,
model selection, and memory namespace. Text streams back to Slack in real time
via the Bolt SDK's Agents & AI Apps surface (`chat.startStream` /
`appendStream` / `stopStream`); tool calls and subagent events are rendered as
native `task_update` chunks inside the same stream — no extra Bot messages, no
polling.

---

## Architecture

```
                ┌──────────────── Slack workspace ────────────────────┐
                │  Bolt + Socket Mode                                  │
                │  • assistant_thread_started / context_changed        │
                │  • assistant.threads.{setStatus,setSuggestedPrompts, │
                │                       setTitle}                      │
                │  • chat.startStream / appendStream / stopStream      │
                │    chunk types: markdown_text · task_update ·        │
                │                 plan_update · blocks                 │
                │  fallback: app_mention / message.im (legacy)         │
                └──────────────────────┬──────────────────────────────┘
                                       │ Socket Mode WebSocket
                           ┌───────────▼──────────┐
                           │   Slack adapter       │
                           │ bridge/sources/slack  │
                           │ aiAppMode = true      │
                           │ richStreamChunks = true│
                           └───────────┬──────────┘
                                       │ AdapterInstance interface
              ┌──────── bridge/core ───▼──────────────────────────────┐
              │  session-router   (source, conv, thread) → SynapsRpc  │
              │  session-store    ~/.synaps-cli/bridge/sessions.json   │
              │  streaming-proxy  debounce 80 chars / 250 ms          │
              │  subagent-tracker pending → in_progress → complete     │
              │  tool-progress    toolcall_start → result collation    │
              │  control-socket   JSONL unix socket                    │
              └────────────────────┬──────────────────────────────────┘
                                   │ JSONL stdio (one child per thread)
          ┌────────────┬───────────┼──────────────┬─────────────────┐
          ▼            ▼           ▼              ▼                 ▼
    synaps rpc   synaps rpc  synaps rpc     synaps rpc        synaps rpc
  (DM thread 1) (DM thread 2)(ai-app T1)   (#ops T1)         (idle → reaped)
```

**Process model.** The bridge is a single Node.js daemon (systemd user unit on
production Linux). Each active Slack thread gets its own `synaps rpc` child
process. Children own their Synaps session, model, and history. On idle reap
(24 h) the child is cleanly shut down; the next message spawns a new child with
`synaps rpc --continue <session_id>`.

**Surface modes.** The Slack adapter has two modes:

| Mode | Trigger | Streaming primitives | Subagent rendering |
|---|---|---|---|
| **AI-app** (primary) | `assistant_thread_started` | `chat.startStream` + typed chunks | `task_update` chunks (in-stream, timeline UI) |
| **Legacy** (fallback) | `app_mention` / `message.im` | `chat.postMessage` + `chat.update` edits | Separate Block Kit messages (`auxBlocks`) |

---

## Status

- **Version:** v0.1.0
- **Platform:** Linux only (systemd user unit; macOS launchd deferred)
- **Sources:** Slack only at v0; Discord/IRC/webhook architecture is prepared but unimplemented
- **Subagent surface:** `task_update` chunks (Slack AI-app mode primary); `auxBlocks` Block Kit fallback (legacy mode)
- **AI-app surface:** primary; `app_mention` / `message.im` legacy fallback always active

---

## Requirements

| Requirement | Notes |
|---|---|
| Node.js ≥ 20 | ESM-only package |
| `synaps rpc` subcommand | From the `feat/synaps-rpc-mode` branch of SynapsCLI on `PATH` |
| `@slack/bolt` ≥ 4.5 | Installed automatically via `npm install`; provides `app.assistant()` + `streamer` helper |
| Linux + systemd | For production; dev foreground run works on any Linux |
| Slack bot + app tokens | `SLACK_BOT_TOKEN` (`xoxb-…`), `SLACK_APP_TOKEN` (`xapp-…`) |

---

## Repo layout

```
synaps-bridge-plugin/
├── .synaps-plugin/
│   └── plugin.json              # Synaps plugin manifest + /bridge slash command
├── bridge/
│   ├── core/
│   │   ├── abstractions/        # Source-agnostic interfaces (BotGate, Formatter,
│   │   │   │                    #   StreamHandle, ToolProgressRenderer, SubagentRenderer)
│   │   │   └── *.js + *.test.js
│   │   ├── synaps-rpc.js        # JSONL child-process client (EventEmitter)
│   │   ├── session-router.js    # (source, conv, thread) → SynapsRpc map + idle reaper
│   │   ├── session-store.js     # Atomic-write sessions.json persistence
│   │   ├── streaming-proxy.js   # Debounced flush, chunk-type dispatch
│   │   ├── subagent-tracker.js  # Per-subagent state machine → renderer calls
│   │   ├── tool-progress.js     # Toolcall collation → renderer calls
│   │   ├── done-check.js        # LLM-based completion detection
│   │   ├── helpers.js           # Pure text utilities (no source-specific code)
│   │   └── *.test.js
│   ├── sources/
│   │   └── slack/
│   │       ├── index.js                     # Bolt app wiring (events, actions, files)
│   │       ├── auth.js                      # Token env-var chokepoint
│   │       ├── file-store.js                # File download → ~/.synaps-cli/bridge/files/
│   │       ├── slack-bot-gate.js            # Extends abstractions/BotGate
│   │       ├── slack-formatter.js           # Markdown ↔ mrkdwn, inline-directive parser
│   │       ├── slack-stream-handle.js       # chat.startStream / appendStream / stopStream
│   │       ├── slack-tool-progress-renderer.js  # task_update (AI-app) / context block (legacy)
│   │       ├── slack-subagent-renderer.js   # task_update (AI-app) / auxBlock (legacy)
│   │       ├── slack-capabilities.js        # Capability map factory
│   │       └── *.test.js
│   ├── config.js                # bridge.toml loader + env resolution
│   ├── control-socket.js        # Unix-domain JSONL control socket
│   ├── index.js                 # BridgeDaemon class (start / stop)
│   └── *.test.js
├── bin/
│   └── synaps-bridge.js         # Daemon entrypoint (CLI flags, logger, signal handlers)
├── config/
│   └── bridge.toml.example      # Canonical config template
├── scripts/
│   ├── install-systemd.sh       # Idempotent user-unit installer
│   ├── uninstall-systemd.sh     # Reverse of the above
│   ├── control-cli.mjs          # CLI wrapper over the control socket
│   ├── control-cli-lib.mjs      # Shared helpers for control-cli
│   └── bridge-cli.sh            # Shell glue used by the /bridge Synaps slash command
├── systemd/
│   └── synaps-bridge.service    # Systemd user unit template (tokens substituted by installer)
├── tests/
│   └── bridge-e2e/              # Cross-component e2e (fake Bolt + fake synaps rpc)
│       ├── 01-prompt-streams-text.test.mjs
│       ├── 02-tool-progress-routes.test.mjs
│       ├── 03-subagent-lifecycle.test.mjs
│       ├── 04-control-socket-threads.test.mjs
│       ├── 05-multi-thread-isolation.test.mjs
│       ├── 06-rpc-crash-restart.test.mjs
│       ├── fake-bolt-client.mjs
│       ├── fake-synaps-rpc.mjs
│       └── helpers.mjs
├── docs/
│   ├── SMOKE.md                 # Manual smoke playbook (10 steps)
│   └── smoke-checklist.json     # Machine-readable mirror of SMOKE.md
├── package.json
└── vitest.config.js
```

---

## Install & run (dev)

```bash
# 1. Install Node dependencies
npm install

# 2. Copy the example config and edit it
mkdir -p ~/.synaps-cli/bridge
cp config/bridge.toml.example ~/.synaps-cli/bridge/bridge.toml
$EDITOR ~/.synaps-cli/bridge/bridge.toml   # set default_model, etc.

# 3. Export Slack tokens (or add to ~/.config/synaps/slack-bridge.env)
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...

# 4. Start in the foreground
node bin/synaps-bridge.js
# You should see: [<timestamp>] [info] synaps-bridge ready
```

Alternatively, store tokens in `~/.config/synaps/slack-bridge.env`:

```ini
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

The systemd unit (and the installer) reads this file automatically as an
`EnvironmentFile`.

---

## Install & run (production — systemd)

```bash
# Installs the rendered unit, optionally enables and starts it
bash scripts/install-systemd.sh --enable --start --linger

# Check status
systemctl --user status synaps-bridge

# Follow logs
journalctl --user -u synaps-bridge -f

# Restart after config change
systemctl --user restart synaps-bridge
```

The `--linger` flag runs `loginctl enable-linger $USER` so the bridge stays
alive after you log out.

To uninstall: `bash scripts/uninstall-systemd.sh`

---

## Configuration reference

The canonical template is [`config/bridge.toml.example`](config/bridge.toml.example).
Copy it to `~/.synaps-cli/bridge/bridge.toml` before starting the daemon.

| Key | Type | Default | Description |
|---|---|---|---|
| `bridge.log_level` | string | `"info"` | Log verbosity: `debug` \| `info` \| `warn` \| `error` |
| `bridge.session_idle_timeout_secs` | integer | `86400` | Seconds of inactivity before a thread session is reaped and the rpc child shut down. Next message resumes via `--continue`. |
| `bridge.session_dir` | string | `"~/.synaps-cli/bridge"` | Directory for `sessions.json`, `control.sock`, and downloaded files. Tilde expansion supported. |
| `rpc.binary` | string | `"synaps"` | Path or name of the `synaps` binary. Resolved via `PATH` if not absolute. |
| `rpc.default_model` | string | `"claude-sonnet-4-6"` | Model ID passed to `synaps rpc --model` for new sessions. |
| `rpc.default_profile` | string | `""` | Named profile passed to `synaps rpc --profile`. Empty = no profile. |
| `sources.slack.enabled` | boolean | `true` | Set to `false` to disable the Slack adapter. |
| `sources.slack.bot_token_env` | string | `"SLACK_BOT_TOKEN"` | Name of the env var that holds the bot token. The value is **never** logged. |
| `sources.slack.app_token_env` | string | `"SLACK_APP_TOKEN"` | Name of the env var that holds the app-level token (Socket Mode). |
| `sources.slack.respond_to_dms` | boolean | `true` | Respond to direct messages (legacy mode). |
| `sources.slack.respond_to_mentions` | boolean | `true` | Respond to `@synaps` mentions in channels (legacy mode). |
| `sources.slack.thread_replies` | boolean | `true` | Participate in threads the bot is already part of. |

---

## Slack app setup

Create a new Slack app at <https://api.slack.com/apps>.

### Required OAuth bot scopes

| Scope | Purpose |
|---|---|
| `assistant:write` | AI-app surface (`chat.startStream`, `chat.appendStream`, `chat.stopStream`, `assistant.threads.*`) |
| `chat:write` | Send and update messages (legacy surface) |
| `app_mentions:read` | Receive `@synaps` mentions in channels |
| `im:history` | Read DM message history |
| `im:read` | Receive DM events |
| `im:write` | Send DMs |

### Required features

- **Agents & AI Apps** (`assistant_view`) — enables AI-app mode. Under
  "App Home" → enable the "Messages Tab" and check "Allow users to send
  Slash commands and messages from the messages tab". Under "Agents & AI
  Apps" → toggle on.
- **Socket Mode** — required for `SLACK_APP_TOKEN` (`xapp-…`). Enable
  under "Socket Mode" in your app settings. Generate an app-level token
  with the `connections:write` scope.
- **Event subscriptions** — subscribed automatically via Socket Mode;
  no public URL required.

---

## Inline directives

A user can switch the active thread's model by prepending a directive on the
**first line** of any message:

```
set-model: claude-opus-4-7
Summarize the notes from today's meeting.
```

The directive line is stripped before the message is forwarded to the rpc
child. The new model is confirmed via `/bridge model <thread>` (see below).
The change persists for all subsequent turns in that thread until overridden
again.

---

## Slash commands (via Synaps plugin)

The `synaps-bridge-plugin` ships as a Synaps plugin. Once installed
(`synaps plugin install`), the `/bridge` command is available in the Synaps
TUI. It talks to the running daemon via the control socket.

| Command | Description |
|---|---|
| `/bridge threads` | List all active bridge sessions with source, thread key, model, and last-active time |
| `/bridge model <key> <model>` | Change the model for an active session identified by `<key>` (as shown in `threads`) |
| `/bridge reap <key>` | Forcibly reap a session — shuts down the rpc child and removes the session from the active map |
| `/bridge status` | Show daemon uptime, adapter health, active session count |

---

## Control socket

The daemon exposes a JSONL unix-domain socket at
`~/.synaps-cli/bridge/control.sock` (configurable via `bridge.session_dir`).

### Protocol

Each request and response is a single line of JSON (`\n`-terminated, UTF-8).

**Request shape:**
```jsonc
{ "op": "threads" }
{ "op": "status" }
{ "op": "model",  "params": { "key": "<thread-key>", "model": "<model-id>" } }
{ "op": "reap",   "params": { "key": "<thread-key>" } }
```

**Response shape (success):**
```jsonc
{ "ok": true, "threads": [ ... ] }          // threads
{ "ok": true, "uptime": 3600, ... }         // status
{ "ok": true }                              // model / reap
```

**Response shape (error):**
```jsonc
{ "ok": false, "error": "session not found" }
```

### CLI wrapper

[`scripts/control-cli.mjs`](scripts/control-cli.mjs) is a thin CLI over the
socket:

```bash
# List active threads (table format)
node scripts/control-cli.mjs threads

# Same as JSON
node scripts/control-cli.mjs threads --format=json

# Change model for a thread
node scripts/control-cli.mjs model slack:C12345:1234567890.123456 claude-opus-4-7

# Reap a thread
node scripts/control-cli.mjs reap slack:C12345:1234567890.123456

# Daemon status
node scripts/control-cli.mjs status

# Use a non-default socket path
node scripts/control-cli.mjs threads --socket=/tmp/my-bridge.sock
```

---

## Tests

```bash
npm test          # vitest run — all 510 tests across 34 files
npm run test:watch   # vitest watch mode
npm run test:coverage  # coverage report (v8)
```

**Test layout:**

| Path | Tests | Coverage |
|---|---|---|
| `bridge/core/**/*.test.js` | Unit tests for all core modules | High |
| `bridge/sources/slack/**/*.test.js` | Slack adapter units (mocked Bolt) | High |
| `bridge/*.test.js` | Config, control socket, daemon |  |
| `scripts/*.test.mjs` | Install script, control-cli library |  |
| `tests/bridge-e2e/*.test.mjs` | Cross-component e2e — fake Bolt + fake `synaps rpc` subprocess; no real Slack | 6 scenarios |

The e2e harness (`tests/bridge-e2e/`) uses `fake-synaps-rpc.mjs` — a
Node.js child that speaks the JSONL RPC wire protocol — and
`fake-bolt-client.mjs` — a minimal Bolt API surface stub — so the full
bridge stack runs in CI without a live Slack workspace or a compiled Synaps
binary.

---

## Streaming behavior

1. **Text debounce.** `streaming-proxy.js` accumulates `text_delta` events and
   flushes when either 80 characters are buffered **or** 250 ms have elapsed —
   whichever comes first. This throttles `chat.appendStream` calls while keeping
   perceived latency low.

2. **Force-flush.** Any non-text event (tool call start, subagent event,
   `agent_end`) triggers an immediate flush of any buffered text before the
   event is processed.

3. **Capability-tier dispatch** — the streaming proxy routes output based on
   the thread's adapter capability flags:

   | Flag | Subagent / tool rendering |
   |---|---|
   | `richStreamChunks: true` (AI-app) | `task_update` chunks inside the active stream — appears as a timeline card in Slack |
   | `auxBlocks: true` (legacy) | Separate `chat.postMessage` Block Kit blocks updated in-place via `chat.update` |
   | Neither | Inline text lines appended to the main stream |

4. **`task_update` for both tool calls and subagents.** Tool calls emit a
   `task_update` chunk with `status: "in_progress"` when the tool is invoked
   and `status: "complete"` when the result arrives. Subagents (`subagent_start`
   → `subagent_update` → `subagent_done`) follow the same lifecycle. Both appear
   in the Slack timeline UI as collapsible task cards — no separate bot
   messages.

---

## Limitations (not in v0)

The following are **explicitly out of scope** for v0. They appear here so the
"not a bug" line is clear.

- **Multi-workspace.** A single operator's workspace only.
- **Credential-proxy plugin.** Separate spec; not included here.
- **Discord / IRC / webhook adapters.** The architecture supports them
  (implementing the adapter interface); the adapters themselves are unimplemented.
- **Watcher-managed bridge supervision.** The bridge is a peer process, not
  supervised by the Synaps watcher.
- **Per-thread auto-compaction.** Manual `/compact` via the rpc child is
  possible; automated threshold-based compaction is deferred.
- **Context estimator / token-budget UI.** No real-time token usage card
  at v0.
- **Memory indexing.** Sessions share the default Synaps memory namespace;
  no per-thread memory partitioning.
- **macOS / launchd.** The systemd unit and install script are Linux-only.
  The daemon itself will run on macOS for development, but no launchd plist
  is provided.
- **Non-Slack sources.** See above.
- **`assistant_thread_context_changed` action.** Event is received and
  logged but not acted upon at v0.

---

## Troubleshooting

### The bot replies to its own messages (loop)

The `SlackBotGate` blocks messages whose `actor` matches the bot's own user ID.
If loops still occur, check that `SLACK_BOT_TOKEN` belongs to the expected bot
user and that the `bot_id` is resolving correctly. Enable `log_level = "debug"`
to see gate decisions:

```
[debug] bot-gate: blocked self-message from bot_id=B12345
```

### 401 / `not_authed` errors from Slack

All Bolt operations are failing. Verify:

1. `SLACK_BOT_TOKEN` is set and starts with `xoxb-`.
2. `SLACK_APP_TOKEN` is set and starts with `xapp-`.
3. Socket Mode is enabled on your Slack app and the app-level token has the
   `connections:write` scope.
4. Required OAuth scopes (`assistant:write`, `chat:write`, `app_mentions:read`,
   `im:history`, `im:read`, `im:write`) are all added **and the bot has been
   reinstalled** to the workspace after adding them.

### `EACCES` / permission denied on the control socket

The control socket at `~/.synaps-cli/bridge/control.sock` is only accessible
to the user who started the daemon. If you run `control-cli.mjs` as a different
user (e.g. via `sudo`), you'll get `EACCES`. Always run control-cli as the
**same user** that owns the running `synaps-bridge` process.

```bash
# Find which user owns the daemon
ps aux | grep synaps-bridge

# Run as that user
su -l <user> -c 'node scripts/control-cli.mjs threads'
```

---

## License

MIT — see `package.json`.

---

## Phase 1 — Workspace container (SCP mode)

Phase 1 of the Synaps Control Plane is included in this branch but **off
by default**. Existing Slack bridge behavior is unchanged. To opt in:

1. Build the workspace image: `cd synaps-workspace && docker buildx bake dev`
2. Set `[platform] mode = "scp"` in `bridge.toml`
3. Run MongoDB locally and configure `[mongodb] uri`
4. Optionally enable the SCP HTTP server (`[web] enabled = true`)

Full smoke playbook: `docs/smoke/phase-1-scp-workspace.md`

What Phase 1 ships:
- `synaps-workspace/` — Ubuntu 22.04 + Chromium + KasmVNC + (placeholder) synaps Rust binary
- `bridge/core/db/` — Mongoose schema + repo for `synaps_workspace`
- `bridge/core/workspace-manager.js` — dockerode wrapper (boot/stop/exec)
- `bridge/core/synaps-rpc-docker.js` — RPC over `docker exec`
- `bridge/core/scp-http-server.js` + `vnc-proxy.js` — minimal HTTP surface, VNC reverse-proxy
- `[platform]`, `[workspace]`, `[web]`, `[mongodb]` config sections

What Phase 1 does NOT ship (planned for later phases):
- Identity reconciliation across channels (Phase 3)
- pria-cookie auth on `/vnc/*` (Phase 3)
- Credential broker (Phase 4)
- Tetragon supervisor + reaper (Phase 5)
- Scheduler + hooks (Phase 6)
- MCP wire-compat (Phase 7)

Spec: see [`synaps-skills/docs/plans/PLATFORM.SPEC.md`](../../synaps-skills/docs/plans/PLATFORM.SPEC.md).

---

## Phase 2 — Memory gateway

Per-user persistent memory backed by [`axel-memory-manager`](https://github.com/synaps-ai/axel-memory-manager).
**Disabled by default** — set `[memory] enabled = true` to opt in.

### How it works

```
Slack message arrives
  │
  ├─ Pre-stream: MemoryGateway.recall(userId, query)
  │     → axel search  →  top-K results prepended as [memory_recall]…[/memory_recall]
  │
  └─ Post-stream: MemoryGateway.store(userId, assistantText)
        → axel remember  →  response stored in user's .r8 brain file
```

One `.r8` brain file per `SynapsUser` at `<brain_dir>/u_<synapsUserId>.r8`.
Namespace isolation is strict — two Slack users never share a brain file.

### Quick start

Add to `~/.synaps-cli/bridge/bridge.toml`:

```toml
[memory]
enabled          = true        # opt-in
transport        = "cli"       # only "cli" is implemented in v0
cli_path         = "axel"      # binary on PATH
brain_dir        = "~/.local/share/synaps/memory"
recall_k         = 8           # top-K search results
recall_min_score = 0.0         # filter weak matches (0–1)
recall_max_chars = 2000        # cap on injected text size
```

### Config keys

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Opt-in gate — set to `true` to activate |
| `transport` | `"cli"` | Transport mode: `"cli"` (axel per-call) or `"socket"` (future) |
| `cli_path` | `"axel"` | Path or name of the `axel` binary |
| `brain_dir` | `"~/.local/share/synaps/memory"` | Directory holding per-user `.r8` brain files |
| `recall_k` | `8` | Number of top search results to retrieve (1–50) |
| `recall_min_score` | `0.0` | Minimum cosine similarity threshold (0.0–1.0) |
| `recall_max_chars` | `2000` | Maximum characters injected into prompt (100–50 000) |
| `axel_socket` | `"/run/synaps/axel.sock"` | Forward-looking socket path (unused in v0) |
| `consolidation_cron` | `"0 3 * * *"` | Nightly consolidation schedule (not wired yet) |

### What Phase 2 ships

- `bridge/core/memory-gateway.js` — `MemoryGateway` + `NoopMemoryGateway`
- `bridge/core/memory/axel-cli-client.js` — `AxelCliClient` (CLI transport)
- `[memory]` config section in `bridge/config.js`
- Pre/post-stream hooks in `bridge/sources/slack/index.js`

### Operator playbook

See `docs/smoke/phase-2-memory.md` for the full smoke test procedure including:
axel binary sanity, config validation, recall-on-second-thread verification,
namespace isolation verification, and disabled-mode confirmation.

---

## Phase 3 — Web dashboard + Identity

**Status:** Web dashboard + Identity — landed (PR #N pending).

Per-user identity reconciliation across Slack + web, backed by MongoDB.
A 6-char link-code flow lets users merge their Slack and pria web identities.
Web chat streams from SCP via SSE using the AI SDK numbered data-stream protocol.
**Disabled by default** — set `[identity] enabled = true` to opt in.

**Quick links:**
- Brief: [`/tmp/synaps-design/PHASE_3_BRIEF.md`](/tmp/synaps-design/PHASE_3_BRIEF.md)
- Smoke playbook: [`docs/smoke/phase-3-web-identity.md`](docs/smoke/phase-3-web-identity.md)
- IdentityRouter: [`bridge/core/identity-router.js`](bridge/core/identity-router.js)
- ControlSocket: [`bridge/control-socket.js`](bridge/control-socket.js)
- Release notes: [`docs/plans/2026-05-10-phase-3-summary.md`](docs/plans/2026-05-10-phase-3-summary.md)

### New config: `[identity]`

```toml
[identity]
enabled             = false        # opt-in — set true to activate
link_code_ttl_secs  = 300          # 6-char code TTL (60–3600 s)
default_institution_id = ""        # optional 24-hex ObjectId fallback
```

When `enabled = false`, a `NoOpIdentityRouter` is wired in — memory namespace
falls back to `u_<external_id>` (Phase 2 behaviour preserved).

### New ControlSocket ops (Phase 3)

| Op | Request fields | Response |
|----|---------------|---------|
| `link_code_issue` | `pria_user_id`, `ttl_secs?` | `{ ok, code, expires_at }` |
| `link_code_redeem` | `code`, `channel`, `external_id`, `external_team_id?` | `{ ok, synaps_user_id, was_relinked }` or `{ ok:false, error }` |
| `identity_resolve_web` | `pria_user_id`, `institution_id?`, `display_name?` | `{ ok, synaps_user_id, is_new, memory_namespace }` |
| `chat_stream_start` | `synaps_user_id`, `channel?`, `thread_key?`, `text`, `model?` | Stream of `{ kind:'chunk'… }` lines, terminated by `{ kind:'done' }` or `{ kind:'error' }` |

### New MongoDB collections

| Collection | Key fields | Index |
|-----------|-----------|-------|
| `synaps_users` | `pria_user_id`, `memory_namespace` | `{ pria_user_id: 1 }` UNIQUE |
| `synaps_channel_identities` | `channel`, `external_id`, `external_team_id`, `synaps_user_id` | `{ channel, external_id, external_team_id }` UNIQUE |
| `synaps_link_codes` | `code`, `pria_user_id`, `synaps_user_id`, `expires_at` | `{ code: 1 }` UNIQUE + TTL on `expires_at` |

### AI SDK data-stream frame mapping

| Chunk type | Frame prefix | Format |
|-----------|-------------|--------|
| `markdown_text` | `0:` | `0:"<text>"\n` |
| `task_update` | `2:` | `2:[{"type":"task_update",...}]\n` |
| `plan_update` | `2:` | `2:[{"type":"plan_update",...}]\n` |
| `suggested_response` | `8:` | `8:[{"type":"suggested_response",...}]\n` |
| `agent_end` | `e:` + `d:` | step-finish frame + done frame |
| `error` | `3:` | `3:"<message>"\n` |
| Unknown | `2:` | defensive pass-through |

### What Phase 3 ships

- `bridge/core/identity-router.js` — `IdentityRouter` + `NoOpIdentityRouter`
- `bridge/core/web-stream-bridge.js` — AI SDK frame translator (pure functions)
- `bridge/core/db/models/synaps-user.js` — Mongoose schema + factory
- `bridge/core/db/models/synaps-channel-identity.js` — Mongoose schema + factory
- `bridge/core/db/models/synaps-link-code.js` — Mongoose schema + factory
- `bridge/core/db/repositories/{user,channel-identity,link-code}-repo.js`
- `[identity]` config section in `bridge/config.js`
- `link_code_issue`, `link_code_redeem`, `identity_resolve_web`, `chat_stream_start` ops in `bridge/control-socket.js`
- `defaultIdentityRouterFactory` in `bridge/index.js`
- pria-ui-v22 `feat/synaps-web-dashboard` branch: Express SSE route + React chat + link-code UI

### Acceptance tests

| File | Tests |
|------|-------|
| `tests/scp-phase-3/00-identity-router-mongo.test.mjs` | 10 |
| `tests/scp-phase-3/01-control-socket-link-flow.test.mjs` | 6 |
| `tests/scp-phase-3/02-control-socket-chat-stream.test.mjs` | 5 |
| `tests/scp-phase-3/03-web-stream-bridge-integration.test.mjs` | 12 |
| `tests/scp-phase-3/04-bridge-daemon-config-toggle.test.mjs` | 7 |
| **Total new** | **40** |

### Operator playbook

See `docs/smoke/phase-3-web-identity.md` for the full 14-step smoke test
procedure including: MongoDB setup, web chat verification, link-code flow,
cross-channel memory recall, and rollback instructions.

### Known limitations (Phase 3 v0)

1. **Memory namespace migration:** Phase 2 used `u_<slackUserId>`; Phase 3 uses
   `u_<synapsUserId>`. Existing brain files are not auto-migrated. Manual rename
   procedure documented in the smoke playbook.
2. **Orphaned synthetic users:** Pre-link Slack-only `SynapsUser` docs remain
   in the DB after linking. A Phase 5 cleanup job will reap them.
3. **Web task-tree styling:** `task_update` data arrives in SSE frames but the
   React UI renders it as raw JSON only. Full styling deferred to Phase 5.

---

## Phase 4 — Credentials

**Status:** Credentials broker — landed (Wave A + Wave B + Wave C).

Result-proxy credential broker backed by [Infisical](https://infisical.com).
The broker fetches a secret token server-side and signs outbound API requests
on behalf of the agent — **the token never crosses the agent boundary.**
The agent receives only the HTTP response; it cannot extract, log, or forward
the credential.

**Disabled by default** — the Slack bridge is unaffected. Set
`[creds] enabled = true` to opt in.

**Quick links:**
- Smoke playbook: [`docs/smoke/phase-4-credentials.md`](docs/smoke/phase-4-credentials.md)
- CredBroker: [`bridge/core/cred-broker.js`](bridge/core/cred-broker.js)
- InfisicalClient: [`bridge/core/cred-broker/infisical-client.js`](bridge/core/cred-broker/infisical-client.js)
- ControlSocket op: `cred_broker_use` in [`bridge/control-socket.js`](bridge/control-socket.js)

### How CredBroker works (result-proxy pattern)

```
Agent / SCP consumer
       │
       │  { op:"cred_broker_use", synaps_user_id, institution_id, key, request }
       ▼
  ControlSocket (UDS)
       │
       ▼
  CredBroker.use()
       │
       ├─ 1. Validate request shape
       │
       ├─ 2. Resolve token (cache → Infisical → graceful-degradation stale cache)
       │       └─ InfisicalClient.getSecret({ institutionId, synapsUserId, key })
       │              GET <infisical_url>/api/v3/secrets/raw?workspaceId=…&secretPath=…&secretName=…
       │
       ├─ 3. Inject Authorization: Bearer <token>  (strips any caller-supplied header)
       │
       ├─ 4. Forward request to upstream API  (real fetch, server-side)
       │
       └─ 5. Return { status, headers, body, cached, fetchedAt }
               Token is NOT present anywhere in this object
```

### New config: `[creds]`

```toml
[creds]
enabled               = false          # opt-in — set true to activate
broker                = "infisical"    # only "infisical" is implemented in v0
infisical_url         = "https://infisical.example.com"
infisical_token_file  = "~/.config/synaps/infisical-token"
cache_ttl_secs        = 300            # last-known-good cache window (seconds)
audit_attribute_user  = true           # include synapsUserId in User-Agent for audit trail
```

| Key | Default | Description |
|---|---|---|
| `enabled` | `false` | Opt-in gate — set `true` to activate |
| `broker` | `"infisical"` | Backend: `"infisical"` or `"noop"` |
| `infisical_url` | `""` | Infisical API base URL |
| `infisical_token_file` | `""` | Path to file containing the Infisical service token (mode `0600`) |
| `cache_ttl_secs` | `300` | Last-known-good token cache TTL; graceful degradation serves stale within 2× TTL on Infisical outage |
| `audit_attribute_user` | `true` | Adds `User-Agent: synaps-cred-broker/<synapsUserId>` to Infisical requests for per-user audit attribution |

### New ControlSocket op (Phase 4)

| Op | Request fields | Response (success) | Response (error) |
|---|---|---|---|
| `cred_broker_use` | `synaps_user_id`, `institution_id`, `key`, `request.{method,url,headers?,body?}` | `{ ok:true, status, headers, body, cached, fetched_at }` | `{ ok:false, code, error }` |

**Error codes:**

| Code | Cause |
|---|---|
| `creds_disabled` | `[creds] enabled = false` or broker not injected |
| `invalid_request` | Missing or malformed required fields |
| `creds_unavailable` | Token could not be fetched and no usable cache |
| `secret_not_found` | Infisical returned 404 for the requested key |
| `broker_auth_failed` | Infisical rejected the service token (401/403) |
| `broker_upstream` | Infisical returned 5xx or had a network failure |

### Default-off posture

When `enabled = false` (the default), a `NoopCredBroker` is wired in transparently:

- Every `use()` call throws `CredBrokerDisabledError` (code `creds_disabled`).
- The Slack bridge, session router, memory gateway, and identity router are completely unaffected.
- No Infisical client is instantiated; no network calls are made.
- The control socket returns `{ ok: false, code: "creds_disabled" }` for any
  `cred_broker_use` op.

### Infisical secret path convention

Secrets are stored at:

```
/<projectId>/
  /users/<synapsUserId>/
    <key>          ← e.g. "github.token"
```

`institutionId` maps 1:1 to the Infisical `workspaceId` (project ID).
`synapsUserId` maps to the folder `/users/<synapsUserId>`.
`key` is the secret name within that folder.

### What Phase 4 ships

- `bridge/core/cred-broker.js` — `CredBroker` + `NoopCredBroker` + error classes
- `bridge/core/cred-broker/infisical-client.js` — `InfisicalClient` (HTTP wrapper)
- `defaultCredBrokerFactory` in `bridge/index.js`
- `cred_broker_use` op in `bridge/control-socket.js`
- `[creds]` config section in `bridge/config.js`

### Acceptance tests

| File | Tests |
|------|-------|
| `tests/scp-phase-4/00-cred-broker-result-proxy.test.mjs` | 7 |
| `tests/scp-phase-4/01-cred-broker-cache-and-fallback.test.mjs` | 8 |
| `tests/scp-phase-4/02-cred-broker-control-socket.test.mjs` | 16 |
| `tests/scp-phase-4/03-cred-broker-disabled-noop.test.mjs` | 6 |
| **Total new** | **37** |

### Operator playbook

See [`docs/smoke/phase-4-credentials.md`](docs/smoke/phase-4-credentials.md)
for the full 9-step smoke verification procedure including: Infisical project
setup, token file configuration, daemon startup log verification, UDS
round-trip confirmation, audit log inspection, cache behaviour under Infisical
outage, graceful-degradation window testing, `creds_unavailable` boundary
check, and a token-leak audit against daemon logs.

---

## Phase 5 — Supervisor, heartbeats & Tetragon policies

### What Phase 5 adds

Phase 5 introduces two complementary layers of runtime safety:

1. **Heartbeat infrastructure (JS layer)** — a `HeartbeatEmitter` records
   periodic liveness pulses for every critical subsystem (bridge daemon,
   workspaces, RPC sessions) into MongoDB.  A `Reaper` sweeps stale records and
   terminates the corresponding subjects (stops workspace containers, kills RPC
   sessions).  The `/health` endpoint on `ScpHttpServer` now returns a full
   component table with graduated status codes.

2. **Tetragon eBPF security policies (kernel layer)** — four
   `TracingPolicy` YAMLs enforce invariants that application code cannot
   enforce: blocking outbound connections to the cloud metadata endpoint,
   preventing kernel module loading inside containers, and killing fork-bomb
   attacks at the scheduler level.

### `[supervisor]` config block

```toml
[supervisor]
# Master switch — heartbeats only fire when this is true.
# When false (the default), no HeartbeatEmitter or Reaper is created and
# /health falls back to the Phase-1 shape { status, mode, ts }.
enabled               = false

# How often (ms) the bridge daemon writes its own heartbeat to MongoDB.
heartbeat_interval_ms = 10000    # 10 s

# How often (ms) the Reaper sweeps for stale records.
reaper_interval_ms    = 60000    # 60 s

# Staleness thresholds — records older than this are considered dead.
workspace_stale_ms    = 1800000  # 30 min → stopWorkspace() called
rpc_stale_ms          = 300000   # 5 min  → rpcKiller() called
scp_stale_ms          = 30000    # 30 s   → warn only; systemd Restart=always handles recovery

# Age threshold for the bridge's OWN heartbeat above which /health returns
# HTTP 503 + status:'down'.  Other components use the same threshold for
# the 'degraded' verdict.
bridge_critical_ms    = 60000    # 60 s
```

Full schema reference (all keys + types + defaults):

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `false` | Master opt-in switch |
| `heartbeat_interval_ms` | int | `10000` | Bridge heartbeat cadence (ms) |
| `reaper_interval_ms` | int | `60000` | Reaper sweep cadence (ms) |
| `workspace_stale_ms` | int | `1800000` | Workspace staleness threshold (ms) |
| `rpc_stale_ms` | int | `300000` | RPC session staleness threshold (ms) |
| `scp_stale_ms` | int | `30000` | SCP process staleness threshold (ms; info-only) |
| `bridge_critical_ms` | int | `60000` | Bridge critical-stale threshold for /health 503 (ms) |

### Default-off posture

When `enabled = false` (the default):

- No `HeartbeatEmitter` or `Reaper` is instantiated; no MongoDB heartbeat
  collection is accessed.
- `BridgeDaemon.supervisor` is `null`.
- `/health` returns the Phase-1 shape `{ status: 'ok', mode, ts }` with no
  `components` key (backward-compatible).
- No timers are scheduled.

To activate:

```toml
[supervisor]
enabled = true
```

### `/health` component table semantics

When `heartbeatRepo` is present (supervisor enabled), `/health` returns:

```json
{
  "status":     "ok",
  "mode":       "scp",
  "ts":         "2026-05-10T12:00:00.000Z",
  "components": [
    { "component": "bridge",    "id": "main",     "healthy": true, "ts": "...", "ageMs": 500 },
    { "component": "workspace", "id": "ws_alice", "healthy": true, "ts": "...", "ageMs": 2000 },
    { "component": "rpc",       "id": "sess_xyz", "healthy": true, "ts": "...", "ageMs": 1000 }
  ]
}
```

**HTTP status rules:**

| HTTP | `status` | Condition |
|---|---|---|
| 200 | `"ok"` | Bridge heartbeat present, healthy, `ageMs` < `bridge_critical_ms`; all others also fresh |
| 200 | `"degraded"` | Bridge fresh & healthy; at least one non-bridge component stale or unhealthy |
| 503 | `"down"` | No bridge heartbeat, OR bridge `ageMs` > `bridge_critical_ms`, OR bridge `healthy = false` |

### Reaper thresholds

| Component | Default threshold | Action on stale |
|---|---|---|
| `workspace` | 30 min | `workspaceManager.stopWorkspace(id)` + `markReaped(id)` + heartbeat row deleted |
| `rpc` | 5 min | `rpcKiller(sessionId)` + heartbeat row deleted |
| `scp` | 30 s | Warn log only — systemd `Restart=always` handles process restart |

Reap actions are **best-effort**: if `stopWorkspace` or `rpcKiller` throws, the
error is captured in the sweep summary and the sweep continues to the next
target. The heartbeat row for a failed reap is NOT deleted (so the next sweep
retries).

### Tetragon policies

Four `TracingPolicy` YAMLs are included under `config/tetragon/`:

| File | Purpose | Action |
|---|---|---|
| `block-egress-metadata.yaml` | Block TCP connect to 169.254.169.254 | `Override -EPERM` |
| `block-kernel-modules.yaml` | Deny `finit_module`/`init_module` in non-init namespaces | `Override -EPERM` |
| `kill-fork-bomb.yaml` | Kill any PID spawning > 200 tasks/second | `Sigkill` |
| `kill-cpu-runaway.yaml` | **Documented stub** — CPU% enforcement (see file header) | N/A (inert) |

> **Note on `kill-cpu-runaway.yaml`**: Tetragon v1.2 does not expose a stable
> "CPU percentage over time" selector in the YAML DSL without a custom BPF
> helper.  The file ships as an inert stub with a detailed explanation of the
> limitation and the recommended alternatives (cgroups v2 `cpu.max` at
> container-create time, or the JS-side Reaper polling `/proc` stats).  See
> the file header for full details.

Apply the policies:

```bash
tetra tracingpolicy add config/tetragon/block-egress-metadata.yaml
tetra tracingpolicy add config/tetragon/block-kernel-modules.yaml
tetra tracingpolicy add config/tetragon/kill-fork-bomb.yaml
```

### What Phase 5 ships

| File | Description |
|---|---|
| `bridge/core/db/models/synaps-heartbeat.js` | Mongoose model factory (`makeHeartbeatModel`) |
| `bridge/core/db/repositories/heartbeat-repo.js` | `HeartbeatRepo` class (record/findStale/findAll/remove) |
| `bridge/core/heartbeat-emitter.js` | `HeartbeatEmitter` periodic timer class |
| `bridge/core/reaper.js` | `Reaper` sweep + targeted termination class |
| `bridge/core/scp-http-server.js` | Extended with component-table `/health` |
| `bridge/index.js` | `defaultHeartbeatFactory` + `BridgeDaemon.supervisor` wiring |
| `config/tetragon/*.yaml` | 4 Tetragon TracingPolicy YAMLs |

### Acceptance tests

| File | Tests |
|------|-------|
| `tests/scp-phase-5/00-heartbeat-emitter-mongo.test.mjs` | 5 |
| `tests/scp-phase-5/01-reaper-end-to-end.test.mjs` | 6 |
| `tests/scp-phase-5/02-health-component-table.test.mjs` | 5 |
| `tests/scp-phase-5/03-supervisor-disabled.test.mjs` | 4 |
| **Total new** | **20** |

### Operator playbook

See [`docs/smoke/phase-5-supervisor.md`](docs/smoke/phase-5-supervisor.md)
for the full 10-step manual verification procedure including: Tetragon
installation, policy application, fork-bomb kill test, cloud metadata egress
block test, `/health` component table verification (including the
freeze-and-recover cycle), Reaper smoke with direct MongoDB injection, and
full audit-trail review via `tetra getevents`.

## Phase 6 — Scheduler, Hooks & Watcher Integration

### What Phase 6 adds

Phase 6 introduces three new subsystems that work together to give Synaps
autonomous scheduling, extensible lifecycle hooks, and deep integration with
the SynapsCLI in-container watcher process.

---

#### 1. Agenda-js Scheduler

Cron-based scheduled tasks stored in `synaps_scheduled_task`.  On fire, agenda
reads the task row and calls an injected `dispatcher` callback that injects a
synthetic inbound event into the user's default channel.

```
Monday 9am: "Post the weekly GitHub PR digest to #dev"
```

The scheduler is **default-off** (`[scheduler] enabled = false`).  When disabled,
all operations return `code: "scheduler_disabled"`.  The dispatcher is injected
by BridgeDaemon — the scheduler itself has no Slack or channel imports.

#### 2. HookBus — Lifecycle Webhooks

`synaps_hook` rows route the five RPC lifecycle events:
`pre_tool` / `post_tool` / `pre_stream` / `post_stream` / `on_error`
to `webhook` actions with HMAC-SHA256 signing and a 5-second timeout.

- Hooks matched by scope (user > institution > global), then by `matcher.tool` / `matcher.channel`
- Fired in parallel via `Promise.allSettled`
- `block: true` in a `pre_tool` response aborts the tool call (caller decision)
- **Secrets never appear in logs or `hook_list` responses** — `action.config.secret` is always `<redacted>` on the wire

The HookBus is **default-off** (`[hooks] enabled = false`).

#### 3. Watcher Integration

Two narrow interfaces bridge the JS host-level supervisor (Phase 5) with the
Rust in-container SynapsCLI watcher:

**In: `heartbeat_emit` ControlSocket op**  
The SynapsCLI watcher pushes workspace heartbeats from inside the container:
```json
{ "op": "heartbeat_emit", "component": "workspace", "id": "<workspace-id>", "synaps_user_id": "...", "healthy": true }
```
- For `component === 'workspace'`: ownership checked against WorkspaceRepo (defense-in-depth)
- For `component === 'rpc'` / `'agent'`: trusted from the local UDS (same-host only)
- When supervisor is disabled: returns `{ "ok": true, "supervisor": "noop" }` silently

**Out: `InboxNotifier`**  
When the Phase-5 Reaper stops a stale workspace, it writes a Rust-`Event`-shaped
JSON file to `~/.synaps-cli/inbox/`:
```
reaper-<workspace-id>-20260510-123456.json
```
The SynapsCLI event bus picks this up automatically.  Payload exactly matches
the Rust `Event` / `EventSource` / `EventContent` struct serialization.

---

### New ControlSocket ops (Phase 6)

| Op | Input | Output |
|----|-------|--------|
| `heartbeat_emit` | `{ component, id, healthy?, details?, synaps_user_id }` | `{ ok:true, ts }` or `{ ok:true, supervisor:'noop' }` |
| `scheduled_task_create` | `{ synaps_user_id, institution_id, name, cron, channel, prompt }` | `{ ok:true, id, agenda_job_id, next_run }` |
| `scheduled_task_list` | `{ synaps_user_id }` | `{ ok:true, tasks:[...] }` |
| `scheduled_task_remove` | `{ id, synaps_user_id }` | `{ ok:true }` |
| `hook_create` | `{ scope, event, matcher, action, enabled? }` | `{ ok:true, id }` |
| `hook_list` | _(no required fields)_ | `{ ok:true, hooks:[...] }` (**secret redacted**) |
| `hook_remove` | `{ id }` | `{ ok:true }` |

### Error codes (Phase 6)

| Code | Meaning |
|------|---------|
| `invalid_request` | Missing or wrong-typed required field |
| `not_found` | Entity ID not found |
| `unauthorized` | Ownership mismatch (e.g. wrong `synaps_user_id` for a workspace) |
| `scheduler_disabled` | `[scheduler] enabled = false` or NoopScheduler |
| `hooks_disabled` | `[hooks] enabled = false` or NoopHookBus |
| `supervisor_disabled` | `heartbeatRepo` absent (supervisor off) |
| `internal_error` | Unexpected server-side error |

### Configuration (bridge.toml)

```toml
[scheduler]
enabled             = false  # default OFF
process_every_secs  = 30
max_concurrency     = 5

[hooks]
enabled      = false         # default OFF
timeout_ms   = 5000
max_parallel = 16

[inbox]
enabled      = false         # default OFF — writes watcher Event files
dir_template = ""            # resolved per-workspace by WorkspaceManager
```

### Layer boundary (§9.x)

| Layer | Scope | Owns |
|-------|-------|------|
| `synaps watcher` (Rust, in-container) | Per-agent process reaping | `~/.synaps-cli/inbox/` event drops |
| Phase-5 `Reaper` (JS, host-level) | Workspace container reaping | `WorkspaceManager.stopWorkspace()` |

**Never overlap:** the watcher does not stop containers; the Reaper does not
signal in-container processes directly.

### What Phase 6 ships

| File | Description |
|------|-------------|
| `bridge/core/db/models/synaps-scheduled-task.js` | Mongoose model factory |
| `bridge/core/db/repositories/scheduled-task-repo.js` | `ScheduledTaskRepo` |
| `bridge/core/db/models/synaps-hook.js` | Mongoose model factory |
| `bridge/core/db/repositories/hook-repo.js` | `HookRepo` |
| `bridge/core/hook-bus.js` | `HookBus` + `NoopHookBus` |
| `bridge/core/inbox-notifier.js` | `InboxNotifier` + `NoopInboxNotifier` |
| `bridge/core/scheduler.js` | `Scheduler` + `NoopScheduler` |
| `bridge/core/reaper.js` | Extended with `inboxNotifier` + `inboxDirFor` |
| `bridge/control-socket.js` | 7 new ops (Phase 6) |
| `bridge/index.js` | Phase 6 factory wiring |
| `bridge/config.js` | `[scheduler]`, `[hooks]`, `[inbox]` sections |

### Acceptance tests

| File | Tests |
|------|-------|
| `tests/scp-phase-6/00-scheduler-end-to-end.test.mjs` | 8 |
| `tests/scp-phase-6/01-hook-bus-webhook.test.mjs` | 9 |
| `tests/scp-phase-6/02-inbox-notifier-fs.test.mjs` | 7 |
| `tests/scp-phase-6/03-heartbeat-emit-control-socket.test.mjs` | 8 |
| `tests/scp-phase-6/04-phase-6-disabled.test.mjs` | 12 |
| **Total new** | **44** |

### Operator playbook

See [`docs/smoke/phase-6-scheduler.md`](docs/smoke/phase-6-scheduler.md) for
the complete manual verification procedure including: create/list/remove
scheduled tasks, hook CRUD with secret-redaction verification, heartbeat_emit
with ownership checks, and InboxNotifier event-file validation.


---

## Phase 7 — MCP Wire-Compat (`/mcp/v1`)

### What Phase 7 adds

Phase 7 makes the SCP bridge act as a **remote MCP server**. Any MCP-aware client
(Claude Desktop, Cursor, Continue.dev, custom agents) can connect to
`http://scp.example.com/mcp/v1` with a per-user bearer token and:

1. **`initialize`** an MCP session (protocol handshake, capability exchange).
2. **`tools/list`** — discover the Synaps tools available to that user's institution,
   filtered through the existing pria `mcpservers` approval policy.
3. **`tools/call`** — invoke a tool against the user's live workspace via the existing
   `SessionRouter` / `SynapsRpc` chain.

Version 0 exposes one meta-tool: **`synaps_chat`**, which forwards the prompt to the
user's `synaps rpc` session and returns the final assistant text. Per-tool surfacing of
the full RPC tool registry is a Phase 7+ stretch goal.

Token management (issue, list, revoke) is available via three new ControlSocket ops so
pria-ui-v22 admin tooling can manage tokens without direct DB access.

### Configuration

```toml
[mcp]
enabled            = false           # Off by default — set true to enable
audit              = false           # Write audit docs to synaps_mcp_audit
chat_timeout_ms    = 120000          # tools/call wait limit (ms)
max_body_bytes     = 262144          # 256 KiB request body cap
policy_name        = "synaps-control-plane"  # mcpservers row name
```

> **Default is off.** All Phase 5/6 behaviour is preserved when `enabled = false`.
> No MCP code is loaded or instantiated in disabled mode.

### New ControlSocket ops (Phase 7)

| Op | Request | Response |
|----|---------|----------|
| `mcp_token_issue` | `{ synaps_user_id, institution_id, name, expires_at? }` | `{ ok, token (64-hex, once), _id, name, expires_at, created_at }` |
| `mcp_token_list` | `{ synaps_user_id?, institution_id? }` | `{ ok, tokens: [{_id, name, last_used_at, expires_at, revoked_at, created_at}] }` |
| `mcp_token_revoke` | `{ token_id }` | `{ ok: true\|false }` |

When `[mcp] enabled = false`, all three ops return `{ ok: false, error: 'mcp_disabled' }`.

### `/mcp/v1` HTTP endpoint

- **Method:** `POST` only (`GET` → 405 with `Allow: POST`).
- **Auth:** `MCP-Token: <raw-64-hex-token>` header required for all methods except
  `initialize` and `notifications/initialized`.
- **Protocol:** JSON-RPC 2.0. Errors are returned with HTTP 200 (code in envelope),
  except auth (401), parse (400), and size (413) failures.
- **Disabled:** When `[mcp] enabled = false`, `POST /mcp/v1` → 404.

### Operator playbook

See [`docs/smoke/phase-7-mcp.md`](docs/smoke/phase-7-mcp.md) for the complete
manual verification procedure including: token issue, initialize, tools/list,
tools/call, Claude Desktop config, revoke + 401 confirmation, and cleanup.

### Spec addendum

See [`docs/plans/PHASE_7_SPEC_ADDENDUM.md`](docs/plans/PHASE_7_SPEC_ADDENDUM.md)
for the full locked-in design: wire protocol tables, authentication model, tool
registry, approval gating, audit, configuration, ControlSocket op table,
ScpHttpServer integration, acceptance criteria, out-of-scope items, and risks.

### What Phase 7 ships

| File | Description |
|------|-------------|
| `bridge/core/mcp/mcp-server.js` | JSON-RPC 2.0 dispatcher |
| `bridge/core/mcp/mcp-token-resolver.js` | `McpTokenResolver` + `generateRawToken` + `hashToken` |
| `bridge/core/mcp/mcp-tool-registry.js` | `McpToolRegistry` + `synaps_chat` tool |
| `bridge/core/mcp/mcp-approval-gate.js` | `McpApprovalGate` (reads pria `mcpservers`) |
| `bridge/core/mcp/mcp-tool-descriptors.js` | `SYNAPS_CHAT_TOOL_DESCRIPTOR` constant |
| `bridge/core/db/models/synaps-mcp-token.js` | Mongoose model factory |
| `bridge/core/db/models/synaps-mcp-audit.js` | Audit model factory |
| `bridge/core/db/repositories/mcp-token-repo.js` | `McpTokenRepo` |
| `bridge/core/db/repositories/mcp-audit-repo.js` | `McpAuditRepo` |
| `bridge/core/db/repositories/mcp-server-repo.js` | Read-only adapter for pria `mcpservers` |
| `bridge/control-socket.js` | 3 new ops (Wave C1) |
| `bridge/index.js` | MCP factory wiring, `mcpTokenRepo` → ControlSocket |
| `bridge/core/scp-http-server.js` | `/mcp/v1` route |
| `bridge/config.js` | `[mcp]` section schema + defaults |

### Acceptance tests

| File | Tests |
|------|-------|
| `tests/scp-phase-7/00-mcp-initialize-handshake.test.mjs` | 8 |
| `tests/scp-phase-7/01-mcp-token-resolver-mongo.test.mjs` | 10 |
| `tests/scp-phase-7/02-mcp-approval-gate-filtering.test.mjs` | 11 |
| `tests/scp-phase-7/03-mcp-control-socket-tokens.test.mjs` | 10 |
| `tests/scp-phase-7/04-mcp-disabled.test.mjs` | 12 |
| **Total new (C2)** | **51** |
| **ControlSocket MCP token unit tests (C1)** | **20** |
| **Phase 7 total** | **71** |

---

## Phase 8 — Production Hardening

**Status:** Production hardening — merged (PR #40, stacked on #39).

Four independently-gated production hardening tracks layered on top of the MCP
surface shipped in Phase 7. Every new behaviour is **off by default** and requires
explicit opt-in via `bridge.toml`. All 19 Phase 7 smoke items carried forward;
18/19 full PASS; 1 partial (#19 — concurrent same-token serialisation) targeted by Phase 9.

| Track | Feature | Config gate |
|---|---|---|
| 1 | Per-token + per-IP token-bucket rate limiting | `[mcp.rate_limit] enabled` |
| 2 | Per-user rpc workspace tool surfacing | `[mcp] surface_rpc_tools` |
| 3 | SSE upgrade for `tools/call` | `[mcp.sse] enabled` |
| 4 | OAuth2 Dynamic Client Registration (RFC 7591) | `[mcp.dcr] enabled` + `registration_secret` |

**Quick links:**
- Spec addendum: [`docs/plans/PHASE_8_SPEC_ADDENDUM.md`](docs/plans/PHASE_8_SPEC_ADDENDUM.md)
- Live smoke report: [`docs/smoke/phase-8-live-smoke-report.md`](docs/smoke/phase-8-live-smoke-report.md)

### New config sections (Phase 8)

```toml
[mcp.rate_limit]
enabled             = false
per_token_capacity  = 60
per_token_refill    = 1
per_ip_capacity     = 120
per_ip_refill       = 2

[mcp.sse]
enabled             = false

[mcp.dcr]
enabled             = false
registration_secret = ""
token_ttl_ms        = 31536000000
```

### New modules (Phase 8)

| Module | Description |
|---|---|
| `bridge/core/mcp/mcp-rate-limiter.js` | Pure token-bucket rate limiter |
| `bridge/core/mcp/mcp-sse-transport.js` | SSE framing helper |
| `bridge/core/mcp/mcp-dcr.js` | OAuth2 DCR handler |
| `bridge/core/synaps-rpc-session-router.js` | Per-user rpc workspace tool router |


---

## Phase 9 — MCP Concurrency, Streaming, OAuth 2.1, and ACL

**Status:** In progress (`feat/scp-phase-9-polish`).

Phase 9 builds on the MCP surface hardened in Phase 8, adding four capability
tracks: a bug-fix for per-session concurrent serialisation (Track 1), SSE
per-delta token streaming so clients see model output token-by-token (Track 2),
a full OAuth 2.1 Authorization Code flow with PKCE for user-facing MCP clients
such as browser extensions and VS Code plugins (Track 3), and a per-tool ACL
resolver with deny-wins semantics, ControlSocket management ops, and audit
integration (Track 4). Tracks 5 and 6 (rpc-probe tool surfacing and a
Prometheus `/metrics` endpoint) are authored by the C3 subagent and are
gated by the same Phase 8 config keys.

All Phase 8 client behaviour is preserved. No wire-format break when Phase 9
features are off (which is the default for all new flags).

**Quick links:**
- Full spec: [`docs/plans/PHASE_9_SPEC_ADDENDUM.md`](docs/plans/PHASE_9_SPEC_ADDENDUM.md)
- Smoke report skeleton: [`docs/smoke/phase-9-live-smoke-report.md`](docs/smoke/phase-9-live-smoke-report.md)
- Smoke playbook: `/tmp/smoke/phase-9-playbook.sh`

### New config keys (Phase 9)

```toml
[mcp.sse]
stream_deltas       = false   # Track 2: emit synaps/delta frames per token

[mcp.oauth]
enabled             = false   # Track 3: OAuth 2.1 Authorization Code + PKCE
code_ttl_ms         = 600000
csrf_ttl_ms         = 900000
redirect_uri_allow_list = []
allow_test_auth     = false   # dev only — never true in production
issuer              = ""

[mcp.acl]
enabled             = false   # Track 4: per-tool ACL resolver
cache_ttl_ms        = 5000
```

### New ControlSocket ops (Phase 9)

| Method | Track | Description |
|---|---|---|
| `mcp_acl_list` | 4 | List all ACL rows for a user. |
| `mcp_acl_set` | 4 | Upsert an ACL row (allow/deny, optional TTL). |
| `mcp_acl_delete` | 4 | Delete a specific ACL row. |

### New MongoDB collections (Phase 9)

| Collection | Track | Description |
|---|---|---|
| `synaps_oauth_codes` | 3 | Short-lived authorization codes (auto-TTL). |
| `synaps_mcp_tool_acls` | 4 | Per-user per-tool ACL rules. |

### New modules (Phase 9)

| Module | Track | Description |
|---|---|---|
| `bridge/core/mcp/mcp-oauth.js` | 3 | OAuth 2.1 authorize + token endpoint handlers. |
| `bridge/core/mcp/mcp-oauth-codes.js` | 3 | Mongoose model + repo for `synaps_oauth_codes`. |
| `bridge/core/mcp/mcp-acl.js` | 4 | ACL resolver with deny-wins semantics + cache. |
| `bridge/core/mcp/mcp-acl-repo.js` | 4 | Mongoose model + CRUD for `synaps_mcp_tool_acls`. |

