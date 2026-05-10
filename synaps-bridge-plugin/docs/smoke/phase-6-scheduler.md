# Phase 6 Scheduler — Manual Smoke Playbook

**Applies to:** `feat/scp-phase-6-scheduler` branch  
**Requires:** Running bridge daemon (SCP mode, MongoDB connected), `socat` or `nc` for UDS interaction

---

## Prerequisites

1. Bridge daemon running in SCP mode:
   ```bash
   cd synaps-bridge-plugin
   node bin/bridge.js
   ```
2. MongoDB running (Atlas, local, or `mongod` on default port)
3. `config/bridge.toml` with `[scheduler]` and `[hooks]` sections enabled:
   ```toml
   [scheduler]
   enabled = true
   process_every_secs = 30
   max_concurrency = 5

   [hooks]
   enabled = true
   timeout_ms = 5000

   [inbox]
   enabled = true
   dir_template = "/home/<user>/.synaps-cli/inbox/"
   ```

---

## Smoke Test 1 — Scheduler: Create / List / Remove

### Step 1: Create a scheduled task

Send `scheduled_task_create` via the control socket:

```bash
echo '{"op":"scheduled_task_create","synaps_user_id":"<SYNAPS_USER_ID>","institution_id":"<INST_ID>","name":"Monday PR Digest","cron":"0 9 * * MON","channel":"#dev","prompt":"Post the weekly GitHub PR digest"}' \
  | socat - UNIX-CONNECT:~/.synaps-cli/bridge/control.sock
```

**Expected response:**
```json
{"ok":true,"id":"<task-id>","agenda_job_id":"<agenda-id>","next_run":"<ISO8601>"}
```

### Step 2: List scheduled tasks

```bash
echo '{"op":"scheduled_task_list","synaps_user_id":"<SYNAPS_USER_ID>"}' \
  | socat - UNIX-CONNECT:~/.synaps-cli/bridge/control.sock
```

**Expected response:**
```json
{"ok":true,"tasks":[{"_id":"<task-id>","name":"Monday PR Digest","cron":"0 9 * * MON",...}]}
```

### Step 3: Remove the task

```bash
echo '{"op":"scheduled_task_remove","id":"<task-id>","synaps_user_id":"<SYNAPS_USER_ID>"}' \
  | socat - UNIX-CONNECT:~/.synaps-cli/bridge/control.sock
```

**Expected response:**
```json
{"ok":true}
```

---

## Smoke Test 2 — HookBus: Create / List / Remove

### Step 1: Create a webhook hook

```bash
echo '{"op":"hook_create","scope":{"type":"user","id":"<SYNAPS_USER_ID>"},"event":"pre_tool","matcher":{"tool":"bash"},"action":{"type":"webhook","config":{"url":"https://your-webhook.example.com/hook","secret":"your-hmac-secret"}},"enabled":true}' \
  | socat - UNIX-CONNECT:~/.synaps-cli/bridge/control.sock
```

**Expected response:**
```json
{"ok":true,"id":"<hook-id>"}
```

### Step 2: List hooks (verify secret is redacted)

```bash
echo '{"op":"hook_list"}' \
  | socat - UNIX-CONNECT:~/.synaps-cli/bridge/control.sock
```

**Expected response (note `<redacted>` for secret):**
```json
{
  "ok": true,
  "hooks": [{
    "_id": "<hook-id>",
    "action": {
      "config": {
        "url": "https://your-webhook.example.com/hook",
        "secret": "<redacted>"
      }
    }
  }]
}
```

> ⚠️ **Security check:** The raw secret must NEVER appear in the `hook_list` response.

### Step 3: Remove the hook

```bash
echo '{"op":"hook_remove","id":"<hook-id>"}' \
  | socat - UNIX-CONNECT:~/.synaps-cli/bridge/control.sock
```

**Expected response:**
```json
{"ok":true}
```

---

## Smoke Test 3 — Watcher Integration: heartbeat_emit

Simulates the SynapsCLI watcher pushing a heartbeat from inside a workspace container:

```bash
echo '{"op":"heartbeat_emit","component":"workspace","id":"<WORKSPACE_ID>","healthy":true,"details":{"cpu":12,"memory_mb":512},"synaps_user_id":"<SYNAPS_USER_ID>"}' \
  | socat - UNIX-CONNECT:~/.synaps-cli/bridge/control.sock
```

**Expected response:**
```json
{"ok":true,"ts":"<ISO8601>"}
```

**When supervisor is disabled:**
```json
{"ok":true,"supervisor":"noop"}
```

### Test ownership mismatch (defense-in-depth):

```bash
echo '{"op":"heartbeat_emit","component":"workspace","id":"<WORKSPACE_ID>","synaps_user_id":"<WRONG_USER_ID>"}' \
  | socat - UNIX-CONNECT:~/.synaps-cli/bridge/control.sock
```

**Expected response:**
```json
{"ok":false,"code":"unauthorized","error":"workspace owner mismatch"}
```

---

## Smoke Test 4 — Scheduler Disabled

Test the graceful degradation path when `[scheduler] enabled = false`:

```bash
echo '{"op":"scheduled_task_create","synaps_user_id":"u","institution_id":"i","name":"n","cron":"* * * * *","channel":"c","prompt":"p"}' \
  | socat - UNIX-CONNECT:~/.synaps-cli/bridge/control.sock
```

**Expected response:**
```json
{"ok":false,"code":"scheduler_disabled","error":"scheduler is not enabled"}
```

---

## Smoke Test 5 — Hooks Disabled

Test with `[hooks] enabled = false`:

```bash
echo '{"op":"hook_create","scope":{"type":"global"},"event":"pre_tool","action":{"type":"webhook","config":{"url":"https://x.com","secret":"s"}}}' \
  | socat - UNIX-CONNECT:~/.synaps-cli/bridge/control.sock
```

**Expected response:**
```json
{"ok":false,"code":"hooks_disabled","error":"hooks feature is not enabled"}
```

---

## Verifying Inbox Notifications (InboxNotifier)

When the Phase-5 Reaper reaps a stale workspace, it writes an event file to the watcher's inbox:

```bash
# After a workspace is reaped, check for the event file:
ls ~/.synaps-cli/inbox/
# Expected: reaper-<workspace-id>-<YYYYMMDD-HHMMSS>.json

# Inspect the payload:
cat ~/.synaps-cli/inbox/reaper-<workspace-id>-*.json | jq .
```

**Expected payload shape:**
```json
{
  "id": "<uuid>",
  "timestamp": "<ISO8601>",
  "source": { "source_type": "reaper", "name": "<workspace-id>", "callback": null },
  "channel": null,
  "sender": null,
  "content": {
    "text": "Workspace '<workspace-id>' reaped (stale_heartbeat, 31m idle)",
    "content_type": "workspace_reaped",
    "severity": "High",
    "data": {
      "workspace_id": "<workspace-id>",
      "synaps_user_id": "<user-id>",
      "reason": "stale_heartbeat",
      "details": {}
    }
  },
  "expects_response": false,
  "reply_to": null
}
```

---

## Error Code Reference

| Code                 | Trigger                                          |
|----------------------|--------------------------------------------------|
| `invalid_request`    | Missing or wrong-typed required fields           |
| `not_found`          | Entity ID does not exist                         |
| `unauthorized`       | Ownership mismatch (e.g. wrong synaps_user_id)   |
| `scheduler_disabled` | `[scheduler] enabled = false` or NoopScheduler  |
| `hooks_disabled`     | `[hooks] enabled = false` or NoopHookBus         |
| `supervisor_disabled`| heartbeatRepo absent (supervisor off)            |
| `internal_error`     | Unexpected server-side error                     |
