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
- MemoryGateway / axel wiring (Phase 2)
- Credential broker (Phase 4)
- Tetragon supervisor + reaper (Phase 5)
- Scheduler + hooks (Phase 6)
- MCP wire-compat (Phase 7)

Spec: see [`synaps-skills/docs/plans/PLATFORM.SPEC.md`](../../synaps-skills/docs/plans/PLATFORM.SPEC.md).
