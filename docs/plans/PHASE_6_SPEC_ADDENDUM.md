# Phase 6 Spec Addendum

> **Note:** This addendum will be folded into `PLATFORM.SPEC.md` when PR #32
> (`docs/scp-platform-spec` branch) merges into `dev`.  It must not be applied
> as a standalone edit to that file — the merge will reconcile the two.
>
> **Branch context:** `feat/scp-phase-6-scheduler`  
> **Affects:** §9 (Supervisor) and §10.3 (Acceptance) of PLATFORM.SPEC.md

---

## Addendum A — §9.x Layer-Boundary (new subsection)

Insert after §9.2 ("SynapsCLI Watcher") in PLATFORM.SPEC.md:

---

### §9.x Layer-Boundary Addendum

**Two supervisor layers coexist; they must never overlap.**

| Layer | Process | Scope | Owns |
|-------|---------|-------|------|
| `synaps watcher` | Rust binary, in-container | Per-agent process reaping | `~/.synaps-cli/inbox/` event drops |
| `Reaper` (Phase 5) | JS, host-level | Workspace container reaping | `WorkspaceManager.stopWorkspace()` |

#### Watcher (Rust, in-container)

- Reaps individual agent processes and sessions via heartbeat files and POSIX signals.
- Owns `~/.synaps-cli/inbox/` — writes `Event` JSON files that the SynapsCLI
  event bus picks up automatically.
- **In-container scope only.** The watcher cannot stop or restart the Docker
  container it lives in.

#### Reaper (JS, host-level — Phase 5)

- Reaps the *workspace container itself* via `WorkspaceManager.stopWorkspace()`.
- **Cross-container scope.** The Reaper operates on the Docker host; it has no
  visibility into per-agent processes running inside the container.

#### Communication (Phase 6 additions)

The two layers communicate via two narrow, explicitly-typed interfaces:

**In → bridge: `heartbeat_emit` ControlSocket op**

The watcher (Rust, in-container) pushes heartbeats outward to the bridge's
Unix domain socket:

```
op: 'heartbeat_emit'
in:
  component:      'workspace' | 'rpc' | 'agent'
  id:             string       // workspace_id, session_id, or agent_name
  healthy:        boolean      // optional, default true
  details:        object       // optional, free-form metadata
  synaps_user_id: string       // for audit and ownership cross-check
out (success):  { ok: true, ts: ISO8601 }
out (disabled): { ok: true, supervisor: 'noop' }   // silent in mixed deployments
out (error):    { ok: false, code, error }
```

Authorization: v0 trusts the local UDS (same-host, same-user process boundary).
For `component === 'workspace'`, the bridge cross-checks `synaps_user_id` against
`WorkspaceRepo.byId(id).synaps_user_id` as a defense-in-depth measure — not a
cryptographic guarantee, but protection against misconfiguration.

For `component === 'rpc'` and `'agent'`, ownership checking is skipped
(the watcher is trusted by virtue of its UDS access).

**Out → watcher: `InboxNotifier`**

When the Phase-5 Reaper successfully stops a workspace container, it calls the
injected `InboxNotifier.notifyWorkspaceReaped()`.  This writes a Rust
`Event`-shaped JSON file into the workspace's inbox mount:

```
~/.synaps-cli/inbox/reaper-<workspaceId>-<YYYYMMDD-HHMMSS>.json
```

The SynapsCLI event bus picks this up automatically (mirrors
`watcher::supervisor::notify_inbox_completion` in the Rust source).

The payload **exactly** matches the Rust `Event` / `EventSource` / `EventContent`
struct serialization:

```json
{
  "id":        "<uuid v4>",
  "timestamp": "<ISO8601>",
  "source": {
    "source_type": "reaper",
    "name":        "<workspaceId>",
    "callback":    null
  },
  "channel":  null,
  "sender":   null,
  "content": {
    "text":         "Workspace '<workspaceId>' reaped (stale_heartbeat, 31m idle)",
    "content_type": "workspace_reaped",
    "severity":     "High",
    "data": {
      "workspace_id":   "<workspaceId>",
      "synaps_user_id": "<userId>",
      "reason":         "stale_heartbeat",
      "details":        { "ageMs": 1860000, "threshold": 1800000 }
    }
  },
  "expects_response": false,
  "reply_to":         null
}
```

Inbox write errors are **always non-fatal** — the reap is marked successful
regardless of the inbox write outcome.  Errors are warn-logged only; they never
propagate to the caller.

#### Scope enforcement (hard rules)

- The bridge **never reads** from `~/.synaps-cli/` — only writes inbox files.
- The watcher **never reads** bridge state directly — only writes to the control
  socket and reads inbox files it created itself.
- **Never overlap:** the watcher does not stop containers; the Reaper does not
  signal in-container processes directly.

---

## Addendum B — §10.3 Acceptance update

Append the following to the existing §10.3 acceptance section in PLATFORM.SPEC.md:

---

### Watcher integration deliverables (Phase 6)

In addition to the scheduler and HookBus acceptance criteria above, Phase 6
ships end-to-end acceptance tests for the watcher integration layer:

| Deliverable | Test file | Coverage |
|-------------|-----------|----------|
| `heartbeat_emit` ControlSocket op | `tests/scp-phase-6/03-heartbeat-emit-control-socket.test.mjs` | Happy path (workspace + rpc); owner mismatch → unauthorized; supervisor disabled → silent ok; invalid_request codes |
| `InboxNotifier` filesystem writes | `tests/scp-phase-6/02-inbox-notifier-fs.test.mjs` | File name pattern; payload shape vs Rust struct; mkdir on missing dir; mkdir error → non-fatal; writeFile error → non-fatal; Noop writes nothing |
| All three disabled | `tests/scp-phase-6/04-phase-6-disabled.test.mjs` | scheduler_disabled / hooks_disabled / supervisor_disabled codes; NoopScheduler / NoopHookBus / NoopInboxNotifier behaviour |

**Key acceptance criteria:**

1. `heartbeat_emit` with a valid workspace heartbeat persists to `synaps_heartbeat`
   in MongoDB and returns `{ ok: true, ts: <ISO8601> }`.
2. `heartbeat_emit` with a mismatched `synaps_user_id` returns
   `{ ok: false, code: 'unauthorized', error: 'workspace owner mismatch' }`.
3. `heartbeat_emit` with no `heartbeatRepo` (supervisor disabled) returns
   `{ ok: true, supervisor: 'noop' }` — the SynapsCLI watcher must be kept
   silent in mixed deployments where the JS bridge runs without the supervisor.
4. `InboxNotifier.notifyWorkspaceReaped()` writes a file whose content
   deserializes as a valid Rust `Event` struct (all required fields present,
   correct types, correct `content_type: 'workspace_reaped'`, `severity: 'High'`).
5. `InboxNotifier` filesystem errors (mkdir failure, writeFile failure) return
   `{ written: false }` and warn-log — they **never throw** and **never fail
   the workspace reap**.

---

*End of Phase 6 Spec Addendum. See PR #32 for merge target.*
