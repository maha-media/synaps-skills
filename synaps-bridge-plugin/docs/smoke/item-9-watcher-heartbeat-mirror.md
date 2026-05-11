# Item 9 — Watcher Heartbeat-Mirror Live Smoke Report

**Date:** 2026-05-11
**Branch:** `fix/scp-item-9-watcher-wiring`
**Bug fix commit:** `412fcdc`
**Test commit:** `412fcdc`

## Summary

Phase 5 built the receiver side of the watcher heartbeat-mirror protocol
(`heartbeat_emit` op in `ControlSocket`), but the wiring in `BridgeDaemon` never
threaded `heartbeatRepo` / `workspaceRepo` into the `controlSocketFactory`. As a
result every watcher tick landed as `{ok:true, supervisor:"noop"}` and **no
heartbeats were persisted** — defeating the whole point of the integration.

This PR fixes the wiring, adds two regression-guard tests, and confirms end-to-end
operation with the real `synaps watcher` v0.1.6 binary against a live bridge
daemon and live MongoDB.

## Root Cause

`bridge/index.js` line 1042 (pre-fix):

```js
this._controlSocket = this._controlSocketFactory({
  sessionRouter, identityRouter, credBroker, hookBus,
  mcpTokenRepo, mcpToolAclRepo, mcpToolAclResolver,
  // ← heartbeatRepo + workspaceRepo MISSING
  logger, version,
});
```

`ControlSocket._opHeartbeatEmit` short-circuits when `_heartbeatRepo == null`:

```js
// bridge/control-socket.js:531
if (!this._heartbeatRepo) {
  return { ok: true, supervisor: 'noop' };
}
```

## Fix

`bridge/index.js`:
- `defaultControlSocketFactory` now accepts + forwards `heartbeatRepo`, `workspaceRepo`
- The daemon constructs `controlSocketFactory` args with
  `heartbeatRepo: this.supervisor ? this.supervisor.repo : null` and
  `workspaceRepo: this._workspaceRepo ?? null`

When `supervisor.enabled = false` both stay `null` → ControlSocket replies with
`{ok:true, supervisor:"noop"}` (pre-existing back-compat path), unchanged.

## Verification

### 1. Unit tests — 130 + 115 + 2 new regression guards

```
✓ bridge/control-socket.test.js  (130 tests)  — receiver side, no change
✓ bridge/index.test.js           (115 tests)  — +2 new wiring-guard tests:
    • controlSocketFactory receives non-null heartbeatRepo+workspaceRepo
      when supervisor.enabled=true (Item 9)
    • controlSocketFactory receives null heartbeatRepo
      when supervisor.enabled=false (Item 9)
```

Both new tests would have FAILED before this fix.

### 2. Manual wire-level round-trip — 4/4 ops + Mongo persistence

Custom Node script (`/tmp/smoke/item-9-roundtrip.mjs`) sends the **byte-identical
wire frame** from PR #44's `bridge_client.rs` directly to the bridge UDS:

```
✅ happy path — agent component       → {"ok":true,"ts":"2026-05-11T01:48:53.517Z"}
✅ unhealthy heartbeat                 → {"ok":true,"ts":"2026-05-11T01:48:53.523Z"}
✅ invalid component rejected          → {"ok":false,"code":"invalid_request",...}
✅ missing synaps_user_id rejected     → {"ok":false,"code":"invalid_request",...}

Mongo verify — expected 2, found 2:
  • component=agent id=research-bot-item9-…  healthy=true   ts=2026-05-11T01:48:53.510Z
  • component=agent id=unhealthy-bot-item9-… healthy=false  ts=2026-05-11T01:48:53.520Z

=== item 9 round-trip: 4/4 ops + mongo=PASS ===
```

### 3. Real `synaps watcher` v0.1.6 → live bridge daemon → MongoDB

Bridge daemon: `/tmp/smoke/bridge.toml` (smoke config, `[supervisor] enabled=true`).
Synaps config: `bridge.heartbeat_mirror = true`, `bridge.heartbeat_timeout_ms = 500`.
Test agent: `~/.synaps-cli/watcher/item9-test/config.toml` (interval_secs=2).

```
$ synaps watcher run > /tmp/smoke/watcher.log 2>&1 &
[watcher] starting supervisor
[watcher] bridge heartbeat mirror ENABLED
        (uds=/home/jr/.synaps-cli/bridge/control.sock, timeout=500ms)
[watcher] [item9-test] started (pid: 3298966)
[item9-test] session started — entering agentic loop
...
```

MongoDB after ~30s of watcher ticks:

```
total heartbeats for item9-test: 1   ← upsert on {component,id}; ts advances each tick

ts before wait: 2026-05-11T01:52:37.547Z
ts after  wait: 2026-05-11T01:52:42.548Z
advanced: true                        ← ts moves forward each cycle ✅
healthy=true  pid=3298966  session_count=1
```

Doc payload matches PR #44 spec exactly:
- `component = "agent"` ✅
- `id = "item9-test"` ✅
- `healthy = true` ✅
- `details = {"pid": 3298966, "session_count": 1}` ✅

## Out of Scope

- Watcher `bridge.uds_path` override (default `~/.synaps-cli/bridge/control.sock`
  resolves correctly today; no need to expose it via bridge config).
- Bridge metrics for heartbeat_emit traffic — Phase 9 metrics registry already
  has `bridge.heartbeat_age_seconds` for the bridge self-heartbeat; per-agent
  metrics can land later if we need them.

## Sign-Off

- Receiver side unit-tested + 2 new wiring regression guards
- Wire format proven byte-identical to PR #44 sender
- Real binary E2E round-trip persists to live MongoDB with advancing timestamps
- No changes to ControlSocket op handler — fix is wiring-only
