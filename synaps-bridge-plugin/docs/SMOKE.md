# synaps-bridge — Manual Smoke Playbook

**Version:** v0.1.0  
**Platform:** Linux + real Slack workspace  
**Estimated time:** 20–30 min for a complete run

This document is a step-by-step manual smoke test for a human operator with
access to a Slack workspace where the Synaps bot is already installed and
connected. Each step lists the **action**, the **expected log lines** (from
the daemon running in foreground with `log_level = "info"`), the **expected
Slack UI behaviour**, and a **failure-mode hint** if things go wrong.

---

## Pre-flight checklist

Before starting, verify all of the following. A `[ ]` next to any item means
it must be resolved before continuing.

```
[ ] Node.js ≥ 20 is on PATH
      node --version          # must print v20.x or higher

[ ] synaps binary is on PATH and the rpc subcommand exists
      synaps rpc --help       # must print usage without error

[ ] bridge.toml is in place
      ls ~/.synaps-cli/bridge/bridge.toml

[ ] bridge.toml contains a valid rpc.default_model value
      grep default_model ~/.synaps-cli/bridge/bridge.toml

[ ] Slack tokens are exported (or present in the env file)
      echo $SLACK_BOT_TOKEN   # must start with xoxb-
      echo $SLACK_APP_TOKEN   # must start with xapp-

[ ] Slack app has all required scopes:
      assistant:write  chat:write  app_mentions:read
      im:history  im:read  im:write
    and has been reinstalled to the workspace after the scopes were added.

[ ] Slack app has "Agents & AI Apps" feature enabled.

[ ] Slack app has Socket Mode enabled.

[ ] No other synaps-bridge instance is running
      pgrep -a -f synaps-bridge || echo "none running"
```

---

## Step 1 — Start the daemon in foreground

### Action

```bash
cd /path/to/synaps-bridge-plugin
node bin/synaps-bridge.js --log-level info
```

### Expected log lines

```
[<ts>] [info] synaps-bridge 0.1.0 starting
[<ts>] [info] config loaded from /home/<user>/.synaps-cli/bridge/bridge.toml
[<ts>] [info] slack adapter: connecting (Socket Mode)
[<ts>] [info] control socket listening at /home/<user>/.synaps-cli/bridge/control.sock
[<ts>] [info] synaps-bridge ready
```

The final `synaps-bridge ready` line confirms the daemon is up and the Slack
Socket Mode WebSocket is established.

### Expected Slack UI behaviour

No Slack activity yet.

### Failure-mode hints

- **"synaps not found"** — `synaps` binary is not on `PATH`; check `which synaps`.
- **"Failed to start daemon: missing token"** — `SLACK_BOT_TOKEN` or
  `SLACK_APP_TOKEN` not exported; run `export SLACK_BOT_TOKEN=xoxb-...` and
  retry.
- **"connect ECONNREFUSED"** — Socket Mode failed; verify the app-level token
  scope (`connections:write`) and that Socket Mode is enabled in the Slack app
  settings.

---

## Step 2 — AI-app mode: basic prompt

### Action

In Slack, open the **Synaps** app DM (click "Synaps" in the Apps section of
the sidebar, or search for it). Click the **new conversation** / pencil icon to
start a fresh AI-app thread. Type `hello` and press Enter.

### Expected log lines

```
[<ts>] [info] slack: assistant_thread_started channel=D... thread_ts=...
[<ts>] [info] session-router: spawning synaps rpc for key=slack:D<channel>:<thread_ts>
[<ts>] [info] synaps-rpc: ready session_id=<uuid> model=claude-sonnet-4-6
[<ts>] [info] slack: setStatus "is thinking…" channel=D... thread_ts=...
[<ts>] [info] streaming-proxy: stream started
[<ts>] [info] streaming-proxy: stream ended usage={...}
```

### Expected Slack UI behaviour

1. Typing indicator ("Synaps is thinking…") appears under your message via
   `assistant.threads.setStatus`.
2. A streaming reply begins — text appears character-by-character (debounced
   to ~80 chars / 250 ms chunks).
3. The reply completes; the typing indicator disappears.
4. Suggested follow-up prompts (buttons) appear below the reply.
5. The thread title in the sidebar is set (e.g. "hello").

### Failure-mode hints

- **No typing indicator** — `assistant:write` scope missing or AI-app feature
  not enabled; check the Slack app configuration.
- **No reply at all** — enable `--log-level debug`; look for `bot-gate: blocked`
  (self-message guard triggering incorrectly) or `synaps-rpc: error`.
- **Reply is static (no streaming)** — check that Bolt version is ≥ 4.5 and
  that `chat.startStream` is resolving (look for `streams: null` in debug logs).

---

## Step 3 — Tool call rendering

### Action

In the same AI-app thread from Step 2, send:

```
list my recent files
```

### Expected log lines

```
[<ts>] [info] streaming-proxy: tool_start tool=list_files
[<ts>] [info] streaming-proxy: flush (force, pre-tool)
[<ts>] [info] streaming-proxy: tool_complete tool=list_files
```

### Expected Slack UI behaviour

1. A `task_update` card appears **inside** the stream (not as a separate
   message) with status `in_progress` — it shows the tool name and a spinner.
2. When the tool result arrives, the card updates to `complete` with a brief
   result summary.
3. The assistant's text reply continues after the tool card (inline, same
   stream).

There should be **no** separate Block Kit bot messages in the thread; everything
is inside the single streaming reply.

### Failure-mode hints

- **Tool card appears as a separate message** — the thread is in legacy mode
  (not AI-app); `richStreamChunks` is `false`. Verify `assistant_view` is
  enabled in the Slack app.
- **Tool card never updates to `complete`** — the rpc child may have timed out
  waiting for a tool result; check `synaps rpc` stderr via `--log-level debug`.

---

## Step 4 — Subagent lifecycle rendering

### Action

In the same AI-app thread, send:

```
spawn a research subagent to summarize today's news
```

### Expected log lines

```
[<ts>] [info] subagent-tracker: subagent_start id=1 name=ResearchAgent
[<ts>] [info] subagent-tracker: subagent_update id=1 status=in_progress
[<ts>] [info] subagent-tracker: subagent_done id=1 duration=...s
```

### Expected Slack UI behaviour

1. A `task_update` card appears in the stream with the subagent name (e.g.
   "ResearchAgent") and status **pending**.
2. The card transitions to **in_progress** (spinner, task preview).
3. The card settles to **complete** with a result preview and duration badge.
4. The assistant's reply (summarising the subagent's output) continues below.

The entire lifecycle is visible in the Slack **timeline UI** (collapsible task
cards), not as separate bot messages.

### Failure-mode hints

- **Three separate bot messages instead of task cards** — legacy mode is active;
  see Step 3 failure hints.
- **Card stays at `pending` forever** — the subagent event stream stalled;
  look for `subagent_done` in the rpc child logs on stderr.

---

## Step 5 — Multi-thread isolation

### Action

1. Open a **second** AI-app thread with the Synaps bot (click the pencil icon
   again to start a new conversation — do not reply in the same thread).
2. In **Thread A** (Step 2), send: `What was my first message to you?`
3. In **Thread B** (the new thread), send: `What was my first message to you?`
4. While both are in-flight, run:

```bash
node scripts/control-cli.mjs threads
```

### Expected log lines (daemon)

Two distinct `session-router: spawning synaps rpc` lines with different thread
keys.

### Expected control-cli output

```
key                                      source  model               last-active
slack:D<chan>:<ts_A>                     slack   claude-sonnet-4-6   just now
slack:D<chan>:<ts_B>                     slack   claude-sonnet-4-6   just now
```

Two distinct rows — different thread keys, independent sessions.

### Expected Slack UI behaviour

- Thread A answers based on the conversation that started with "hello" in
  Step 2 ("Your first message was 'hello'").
- Thread B has no memory of Thread A — it says something like "This is the
  start of our conversation."

### Failure-mode hints

- **Only one row in `threads`** — both threads mapped to the same session key.
  Check that `thread_ts` values differ between the two conversations; the
  session key is `slack:<channel_id>:<thread_ts>`.
- **Thread B remembers Thread A's history** — cross-session contamination; file
  a bug with the session keys from the control socket output.

---

## Step 6 — Inline model switch

### Action

In Thread A, send:

```
set-model: claude-opus-4-7
What model are you using now?
```

(The `set-model:` directive must be on the **first line**.)

### Expected log lines

```
[<ts>] [info] slack-formatter: inline directive set-model=claude-opus-4-7
[<ts>] [info] synaps-rpc: set_model model=claude-opus-4-7
[<ts>] [info] synaps-rpc: response set_model ok=true
```

### Verify via control-cli

```bash
node scripts/control-cli.mjs threads
```

Thread A's `model` column should now show `claude-opus-4-7`.

### Expected Slack UI behaviour

- The `set-model:` line does not appear in the bot's reply (it is stripped).
- The bot's answer confirms the new model (e.g. "I'm using claude-opus-4-7").

### Failure-mode hints

- **Model column unchanged** — the directive line may have had extra whitespace
  or was not on the exact first line. Enable debug logging and look for
  `inline directive` log output.
- **`response set_model ok=false`** — the model ID is invalid; check the exact
  model string against the list of models supported by your `synaps rpc` build.

---

## Step 7 — Crash + restart resilience

### Action

1. Find the PID of the `synaps rpc` child for Thread A:

```bash
node scripts/control-cli.mjs threads --format=json | \
  python3 -c "import sys,json; [print(t['rpc_pid']) for t in json.load(sys.stdin)['threads'] if 'thread_A_ts' in t['key']]"
```

   Or search with `pgrep -a synaps` and identify the child.

2. Kill it:

```bash
kill -9 <rpc_pid>
```

3. Send a new message in Thread A: `Are you still there?`

### Expected log lines

```
[<ts>] [warn] session-router: rpc child exited code=137 key=slack:D<chan>:<ts_A>
[<ts>] [info] session-router: respawning with --continue <session_id>
[<ts>] [info] synaps-rpc: ready session_id=<same_uuid> model=claude-opus-4-7
```

### Expected Slack UI behaviour

- The reply arrives, possibly with a brief delay (child respawn + `ready` handshake).
- Some recent message history may be absent (only what was persisted to the
  session file is restored). This is acceptable at v0.
- The model is still `claude-opus-4-7` (persisted in the session file).

### Failure-mode hints

- **No respawn, no reply** — the session-router exceeded its one-retry limit
  and surfaced an error. Look for `session-router: giving up` in the logs; the
  session file may be corrupt. Delete `~/.synaps-cli/sessions/<session_id>.json`
  and the entry from `sessions.json`, then resend.
- **Reply but wrong model** — the session file did not persist the model change
  before the crash. At v0 this is a known limitation.

---

## Step 8 — Legacy fallback (app_mention)

### Action

1. In the Slack app settings, temporarily disable the **Agents & AI Apps**
   feature (toggle off `assistant_view`). You may need to wait 1–2 minutes for
   the change to propagate.
2. In a **public channel** (e.g. `#dev`), type:

```
@Synaps hello from legacy mode
```

### Expected log lines

```
[<ts>] [info] slack: app_mention channel=C... user=U...
[<ts>] [info] session-router: spawning synaps rpc for key=slack:C<channel>:<thread_ts>
[<ts>] [info] streaming-proxy: stream started (legacy: chat.update)
[<ts>] [info] streaming-proxy: stream ended
```

### Expected Slack UI behaviour

- The bot replies in a thread on that message (not in-channel).
- Streaming is simulated via repeated `chat.update` edits on the same message
  (`ts`). Text accumulates visibly.
- **No** typing indicator (legacy mode has no `assistant.threads.setStatus`
  equivalent).
- Subagent events (if any) appear as separate Block Kit messages in the thread,
  updated in-place.

### Failure-mode hints

- **Bot does not reply in channel** — verify `respond_to_mentions = true` in
  `bridge.toml` and that `app_mentions:read` scope is granted.
- **Still seeing AI-app behaviour** — the workspace-level change may not have
  propagated yet; wait and retry, or check with a different channel.

Re-enable Agents & AI Apps in the Slack app settings before continuing.

---

## Step 9 — Graceful shutdown + session persistence

### Action

In the daemon terminal, press **Ctrl+C** (SIGINT).

### Expected log lines

```
[<ts>] [info] Received SIGINT — shutting down
[<ts>] [info] bridge-daemon: stopping all adapters
[<ts>] [info] session-router: sending shutdown to 2 rpc children
[<ts>] [info] session-store: sessions.json written (2 sessions)
[<ts>] [info] bridge-daemon: stopped
```

### Verify session persistence

```bash
cat ~/.synaps-cli/bridge/sessions.json | python3 -m json.tool | grep session_id
```

Both Thread A and Thread B session IDs should be present.

### Expected Slack UI behaviour

No new messages or indicators — the daemon stops cleanly.

### Failure-mode hints

- **`sessions.json` missing or empty** — the session store may not have flushed
  before exit. Enable `--log-level debug` and look for `session-store:` lines.
- **rpc children linger** — check with `pgrep -a synaps`; a missing graceful
  shutdown path would leave orphans. File a bug with the shutdown log output.

---

## Post-smoke verification

After completing all steps, confirm the final state:

```bash
# No stray synaps-bridge or synaps rpc processes
pgrep -a -f 'synaps' || echo "clean"

# sessions.json has expected entries
python3 -c "
import json, pathlib
s = json.loads(pathlib.Path.home().joinpath('.synaps-cli/bridge/sessions.json').read_text())
print(f'{len(s)} sessions persisted')
for k, v in s.items():
    print(f'  {k}: session_id={v.get(\"session_id\", \"?\")[:8]}...')
"
```

All 9 smoke steps passing = **v0 release-ready**.
