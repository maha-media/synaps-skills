# synaps-bridge-plugin — shared subagent brief

> Read this file first. Every subagent building Tasks 4–10 reads this same
> brief so the contracts are pinned and parallel work integrates cleanly.

## 0. Cardinal rules

1. **No source-specific imports anywhere under `bridge/core/**`.** Slack
   types/strings/Bolt imports must stay inside `bridge/sources/slack/**`.
2. **All files are ESM** (`import` / `export`, not `require`). `package.json`
   already has `"type": "module"`.
3. **No top-level `await`** in library files. Tests may use it.
4. **Vitest** is the test runner. Test files end in `.test.js` and live next
   to the source they cover.
5. **Pure constructors.** No I/O, no spawning, no socket opens in
   constructors. Side effects live behind `start()` / `connect()` /
   `getOrCreateSession()` etc.
6. **Logger by injection.** Modules accept an optional `logger` (default
   `console`). Never call `console.*` directly inside library code.
7. **No secret in any log line.** If you log a token, the test must redact
   it.
8. **Spec is authoritative.** When in doubt, re-read
   `/home/jr/Projects/Maha-Media/synaps-bridge.SPEC.md` and
   `/home/jr/Projects/Maha-Media/.worktrees/SynapsCLI-synaps-rpc-mode/docs/rpc-protocol.md`.

## 1. Wire protocol cheatsheet (`synaps rpc`)

### Commands (parent → child stdin, line-JSON)

```ts
{ id: string, type: "prompt",       message: string, attachments?: { path: string, name?: string, mime?: string }[] }
{ id: string, type: "follow_up",    message: string }
{ id: string, type: "compact" }
{ id: string, type: "new_session" }
{ id: string, type: "get_messages" }
{ id: string, type: "set_model",            model: string }
{ id: string, type: "get_available_models" }
{ id: string, type: "abort" }
{ id: string, type: "get_session_stats" }
{ id: string, type: "get_state" }
{           type: "shutdown" }   // no id, no response, child saves+exits 0
```

### Events (child → parent stdout, line-JSON)

```ts
{ type: "ready",         session_id: string, model: string, protocol_version: 1 }
{ type: "message_update", event: MessageUpdate }
{ type: "subagent_start",  subagent_id, agent_name, task_preview }
{ type: "subagent_update", subagent_id, agent_name, status }
{ type: "subagent_done",   subagent_id, agent_name, result_preview, duration_secs }
{ type: "agent_end",       usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, model } }
{ type: "response", id, command, /* flattened body fields, e.g. ok, model, messages, ... */ }
{ type: "error",    id?: string, message: string }
```

`MessageUpdate` is one of:
```ts
{ type: "text_delta",           delta: string }
{ type: "thinking_delta",       delta: string }
{ type: "toolcall_start",       tool_id: string, tool_name: string }
{ type: "toolcall_input_delta", tool_id: string, delta: string }
{ type: "toolcall_input",       tool_id: string, input: any }
{ type: "toolcall_result",      tool_id: string, result: any }
```

### Framing rules

- Line-delimited JSON, UTF-8, `\n` (0x0A) terminator.
- Inbound max frame size: **1 MiB**.
- Stdout is reserved for protocol frames only — `tracing::*` goes to stderr.
- `stdin EOF` on child = save session and exit 0 (graceful).

### Concurrency model

Commands run sequentially. While a `prompt`/`follow_up` is in flight, the
ONLY safe commands are `abort`, `get_state`, `get_session_stats`. Any
other command will receive an error response.

### CLI flags

```
synaps rpc [--continue <SESSION_ID>] [--system <PROMPT_OR_FILE>]
           [--model <MODEL_ID>] [--profile <PROFILE>]
```

## 2. Capability flag set (Task 5 abstractions)

Every concrete adapter declares a capability map. Core code branches on
flags, never on source identity.

```ts
interface AdapterCapabilities {
  streaming:        boolean;  // chat.startStream / appendStream / stopStream
  richStreamChunks: boolean;  // markdown_text + task_update + plan_update + blocks
  buttons:          boolean;  // Block Kit / inline keyboards
  files:            boolean;  // file uploads
  reactions:        boolean;
  threading:        boolean;  // thread_ts / reply_to_message
  auxBlocks:        boolean;  // out-of-band aux messages (legacy fallback)
  aiAppMode:        boolean;  // assistant_thread_started / setStatus / etc
}
```

## 3. Directory layout

```
synaps-bridge-plugin/
├── package.json                 (already scaffolded — type: module, vitest)
├── vitest.config.js             (already scaffolded)
├── .gitignore                   (already scaffolded)
├── bridge/
│   ├── core/
│   │   ├── synaps-rpc.js                    (Task 4)
│   │   ├── session-router.js                (Task 6)
│   │   ├── session-store.js                 (Task 6)
│   │   ├── streaming-proxy.js               (Task 7)
│   │   ├── tool-progress.js                 (Task 7)
│   │   ├── subagent-tracker.js              (Task 7)
│   │   ├── done-check.js                    (Task 8)
│   │   ├── helpers.js                       (Task 8)
│   │   └── abstractions/
│   │       ├── adapter.js                   (Task 5)
│   │       ├── bot-gate.js                  (Task 5)
│   │       ├── formatter.js                 (Task 5)
│   │       ├── stream-handle.js             (Task 5)
│   │       ├── tool-progress-renderer.js    (Task 5)
│   │       └── subagent-renderer.js         (Task 5)
│   └── sources/
│       └── slack/
│           ├── slack-bot-gate.js               (Task 9)
│           ├── slack-formatter.js              (Task 9)
│           ├── slack-stream-handle.js          (Task 9)
│           ├── slack-tool-progress-renderer.js (Task 9)
│           ├── slack-subagent-renderer.js      (Task 9)
│           └── index.js                        (Task 10 — Bolt wiring)
├── bin/
│   └── synaps-bridge.js          (Task 11, later)
└── docs/
```

Each `*.js` has a sibling `*.test.js`.

## 4. Streaming debounce parameters

- Flush text deltas at **80 chars** OR **250 ms**.
- **Force-flush** before any non-text event (toolcall, subagent, agent_end).
- Subagent events render as `task_update` chunks when capability
  `richStreamChunks: true`, else as out-of-band `auxBlocks`, else inline text.

## 5. Session storage

- Path: `~/.synaps-cli/bridge/sessions.json`
- Atomic-write JSON (write to `.tmp`, fsync, rename).
- Survives daemon restart.
- Idle reaper: closes child after **24h** of no activity. Next access
  spawns child with `synaps rpc --continue <session_id>`.

## 6. File-upload paths

- Downloads: `~/.synaps-cli/bridge/files/<conversation>/<thread>/<filename>`
- Inject path into prompt as `attachments: [{path, name, mime}]`.

## 7. Error handling contract

- `SynapsRpc` child crash → emit `'exit'` event with code, reject all
  pending command promises with `Error('rpc child exited: code=N')`.
- Frame > 1 MiB inbound to child → child emits `error` with `id: null`,
  stays alive. Client surfaces as `'error'` event, not a promise rejection.
- Child writes malformed JSON → client logs warning, drops line.
- Pending command without matching `response` after 60 s → reject with
  `Error('rpc timeout: command=<type> id=<id>')`.

## 8. Env vars

- `SLACK_BOT_TOKEN` — `xoxb-...` bot token
- `SLACK_APP_TOKEN` — `xapp-...` socket-mode app token
- Read from `process.env` exactly once, in a single chokepoint helper:
  `bridge/sources/slack/auth.js` (Task 10). Other modules accept the value
  by injection.

## 9. Test conventions

- One `*.test.js` per module.
- Mock the synaps-rpc child with a fake stream pair (no real subprocess in
  unit tests).
- No live network. No real Slack workspace.
- Snapshot tests are forbidden — assert on shape with explicit fields.
- Prefer `vi.useFakeTimers()` for the streaming-proxy debounce tests.

## 10. References

- Spec: `/home/jr/Projects/Maha-Media/synaps-bridge.SPEC.md`
- Plan: `/home/jr/Projects/Maha-Media/synaps-bridge.PLAN.md`
- RPC docs: `/home/jr/Projects/Maha-Media/.worktrees/SynapsCLI-synaps-rpc-mode/docs/rpc-protocol.md`
- pria reference: `/tmp/pria-recon/pria-agent/host/slack-bridge/` (may need re-clone)
