# Phase 5 — Supervisor & Heartbeat Smoke Playbook

> **Pass 2 run record**: See [`phase-5-pass-2-report.md`](phase-5-pass-2-report.md) for the
> full real-host run on 2026-05-10 (Ubuntu 26.04, Tetragon v1.7.0). That report documents the
> v1.2 → v1.7 API migration findings, egress-block end-to-end verification (3× rc=137), the
> kernel-symbol sensitivity finding for `block-kernel-modules`, and the `kill-fork-bomb`
> known-gap status.

Manual verification procedure for Phase 5 (heartbeat infrastructure + Tetragon
security policies).

**Host requirements**: Ubuntu 24.04, Docker ≥ 26, `tetra` CLI, Node.js ≥ 22,
MongoDB ≥ 7 (or the bridge daemon will start its own via the SCP stack).

**Estimated time**: ~25 minutes (most of which is waiting for Tetragon events).

---

## Step 1 — Start Tetragon (cilium docker method)

The simplest verification path uses the official Tetragon container image.
No Kubernetes required.

```bash
docker run --name tetragon \
  --detach \
  --privileged \
  --pid=host \
  --cgroupns=host \
  -v /sys/kernel/btf:/sys/kernel/btf:ro \
  -v /sys/fs/cgroup:/sys/fs/cgroup:ro \
  quay.io/cilium/tetragon:v1.7.0 \
  /usr/bin/tetragon
```

> **Note**: `v1.2` tag was removed from quay.io; `v1.7.0` is the latest stable as of this
> playbook revision.

Wait for readiness:

```bash
docker logs -f tetragon 2>&1 | grep -m1 "Tetragon running"
# Expected: level=info msg="Tetragon running"
```

Install the `tetra` CLI (if not already present):

```bash
TETRA_VERSION=v1.7.0
curl -fsSL https://github.com/cilium/tetragon/releases/download/${TETRA_VERSION}/tetra-linux-amd64.tar.gz \
  | tar xz -C /usr/local/bin tetra
tetra version
```

---

## Step 2 — Apply Tetragon TracingPolicies

> **Note**: `kill-fork-bomb.yaml` **will fail to load on Tetragon v1.7+** with
> `unknown field "matchRateLimit"`. This is a documented known gap — see the header
> comment in that file for full explanation. Apply only the three working policies below:

```bash
cd /path/to/synaps-bridge-plugin

tetra tracingpolicy add config/tetragon/block-egress-metadata.yaml
tetra tracingpolicy add config/tetragon/block-kernel-modules.yaml
# kill-fork-bomb.yaml is NOT applied — it fails to load on v1.7+ (matchRateLimit
# is not a stable Tetragon primitive). Fork-bomb defence is provided by the
# workspace container's pids.max cgroup limit instead.
# kill-cpu-runaway.yaml is a documented stub — skip or apply for audit:
tetra tracingpolicy add config/tetragon/kill-cpu-runaway.yaml
```

Each command should exit 0. If a policy conflicts with an existing name, remove
it first: `tetra tracingpolicy delete <name>`.

---

## Step 3 — Verify Policies Are Loaded

```bash
tetra tracingpolicy list
```

Expected output (abbreviated):

```
NAME                     STATE     FILTERID
block-egress-metadata    enabled   1
block-kernel-modules     enabled   2
kill-cpu-runaway         enabled   3   # stub — 0 tracepoints but loads cleanly
```

All applied policies must show `STATE=enabled`. If any shows `error`, check
`docker logs tetragon` for the BPF compilation error.

---

## Step 4 — Fork-Bomb Test

**SKIPPED — see Step 2 note.** `kill-fork-bomb.yaml` does not load on Tetragon
v1.7+ (`matchRateLimit` field rejected). Fork-bomb defence is provided by the
workspace container's `pids.max` cgroup limit set at workspace-creation time;
verify that limit is set correctly at container launch instead.

```bash
# Verify the pids.max cgroup limit on a workspace container:
# docker inspect <container> --format '{{ .HostConfig.PidsLimit }}'
# Expected: a non-zero value (e.g. 512)
```

<!-- Tetragon fork-bomb test — preserved for future Tetragon-version revisit
     when/if a per-PID counting primitive lands in Tetragon stable.

docker run --name workspace-alice --rm -d ubuntu:24.04 sleep infinity

docker exec -it workspace-alice bash -c ':() { :|: & }; :'
# Expected (future): process SIGKILLed within ~100 ms; Tetragon event visible:
# tetra getevents --event-types PROCESS_KPROBE 2>/dev/null | grep -A5 "Sigkill"
# Expected event: action="Sigkill", function="wake_up_new_task"

docker stop workspace-alice
-->

---

## Step 5 — Cloud Metadata Egress Test

```bash
docker run --name workspace-alice --rm -d ubuntu:24.04 sleep infinity
docker exec workspace-alice apt-get install -y -q curl 2>/dev/null

docker exec workspace-alice curl -m 2 http://169.254.169.254/latest/meta-data/
```

**Expected**:
- `Killed` — curl is terminated by SIGKILL mid-connect (not an EPERM/ECONNREFUSED)
- Exit code **137** (= 128 + SIGKILL)
- The request must NOT return any metadata content

Verify the Tetragon kill event:

```bash
tetra getevents --event-types PROCESS_KPROBE 2>/dev/null | grep -A5 "block-egress-metadata"
# Expected: event with function_name="tcp_connect", action="KPROBE_ACTION_SIGKILL",
#           policy_name="block-egress-metadata", args showing daddr=169.254.169.254
# NPOST / NENFORCE counters on the policy tick up by 1 per curl attempt.
```

Cleanup:

```bash
docker stop workspace-alice
```

---

## Step 6 — Heartbeat /health Smoke

### 6a. Start the bridge daemon in SCP mode with supervisor enabled

Create a minimal test config:

```toml
# /tmp/smoke-bridge.toml
[platform]
mode = "scp"

[supervisor]
enabled               = true
heartbeat_interval_ms = 5000      # fast beats for smoke test
reaper_interval_ms    = 30000

[web]
enabled   = true
http_port = 18080
bind      = "127.0.0.1"

[mongodb]
uri = "mongodb://localhost/synaps_smoke"

[sources.slack]
enabled = false
```

Start the daemon:

```bash
node bridge/bin/synaps-bridge.js --config /tmp/smoke-bridge.toml &
BRIDGE_PID=$!
sleep 3
```

### 6b. Verify /health returns ok

```bash
curl -s http://localhost:18080/health | jq .
```

**Expected**:
```json
{
  "status": "ok",
  "mode":   "scp",
  "ts":     "<ISO timestamp>",
  "components": [
    { "component": "bridge", "id": "main", "healthy": true, "ageMs": 500 }
  ]
}
```
HTTP 200.

### 6c. Freeze the bridge process (simulate hang), wait for stale threshold

```bash
kill -STOP $BRIDGE_PID
echo "Bridge frozen at $(date). Waiting 70 s for heartbeat to go stale..."
sleep 70

curl -s http://localhost:18080/health | jq .
```

**Expected**:
```json
{ "status": "down", "mode": "scp", ... }
```
HTTP 503 (bridge heartbeat > 60 s old → critical stale).

### 6d. Resume bridge — heartbeat recovers

```bash
kill -CONT $BRIDGE_PID
echo "Bridge resumed. Waiting for next heartbeat interval (5 s)..."
sleep 8

curl -s http://localhost:18080/health | jq .
```

**Expected**: HTTP 200, `status: "ok"` again.

---

## Step 7 — Reaper Smoke

With the bridge daemon still running from Step 6, inject a stale workspace
heartbeat directly into MongoDB to trigger the reaper.

```bash
mongosh synaps_smoke --eval '
  db.synaps_heartbeat.insertOne({
    component: "workspace",
    id:        "ws_smoke_test",
    ts:        new Date(Date.now() - 31 * 60 * 1000),   // 31 min ago
    healthy:   true,
    details:   {}
  })
'
```

Wait for the reaper interval (configured to 30 s in the smoke config):

```bash
sleep 35
```

Check the bridge daemon log for the reap event:

```bash
journalctl -u synaps-bridge --since "1 min ago" | grep "reaper sweep complete"
# or if running in foreground, check stdout:
# Expected: { reaped: { workspaces: ['ws_smoke_test'], rpcs: [] }, scpStale: [], errors: [] }
```

Verify the row was deleted:

```bash
mongosh synaps_smoke --eval '
  db.synaps_heartbeat.findOne({ id: "ws_smoke_test" })
'
# Expected: null
```

---

## Step 8 — Component Table with Multiple Workspaces

Start two additional workspace containers (they do not need to run real SCP
workloads — just seed their heartbeats):

```bash
mongosh synaps_smoke --eval '
  const now = new Date();
  db.synaps_heartbeat.insertMany([
    { component: "workspace", id: "ws_alice", ts: now, healthy: true, details: {} },
    { component: "workspace", id: "ws_bob",   ts: now, healthy: true, details: {} },
    { component: "rpc",       id: "sess_xyz", ts: now, healthy: true, details: {} },
  ])
'
```

Query /health:

```bash
curl -s http://localhost:18080/health | jq '.components | length'
# Expected: 4  (bridge + 2 workspaces + 1 rpc)

curl -s http://localhost:18080/health | jq '[.components[] | .component]'
# Expected: ["bridge", "rpc", "workspace", "workspace"]  (sorted by component, id)
```

HTTP status must remain 200 + `status: "ok"` because all ageMs values are small.

---

## Step 9 — Resource Cleanup

Stop the bridge daemon:

```bash
kill $BRIDGE_PID 2>/dev/null; wait $BRIDGE_PID 2>/dev/null || true
```

Drop the test MongoDB collection:

```bash
mongosh synaps_smoke --eval 'db.synaps_heartbeat.drop()'
```

Remove Tetragon policies:

```bash
tetra tracingpolicy delete block-egress-metadata
tetra tracingpolicy delete block-kernel-modules
tetra tracingpolicy delete kill-cpu-runaway
# kill-fork-bomb was not applied (known gap — see Step 2 note)
```

Stop the Tetragon container:

```bash
docker stop tetragon
docker rm tetragon
```

Remove the smoke config:

```bash
rm /tmp/smoke-bridge.toml
```

---

## Step 10 — Audit Trail Review

Before tearing down Tetragon, capture the full event log for the test window:

```bash
tetra getevents \
  --event-types PROCESS_KPROBE,PROCESS_TRACEPOINT \
  --output json \
  > /tmp/tetragon-smoke-audit-$(date +%Y%m%d-%H%M%S).json

# Summarise actions taken:
jq -r '.process_kprobe | "\(.action)\t\(.function_name)\t\(.process.pid)\t\(.process.binary)"' \
  /tmp/tetragon-smoke-audit-*.json 2>/dev/null | sort | uniq -c | sort -rn
```

**Expected entries** (at minimum):
- `Sigkill` / `tcp_connect` — metadata egress block (Step 5)

If either entry is absent, re-run the relevant step and confirm the policy
is in `enabled` state via `tetra tracingpolicy list`.

---

## Pass/Fail Criteria

| Check | Expected |
|---|---|
| block-egress-metadata and block-kernel-modules load without error | ✅ `tetra tracingpolicy list` shows `enabled` |
| kill-cpu-runaway loads cleanly (stub) | ✅ `tetra tracingpolicy list` shows `enabled` |
| kill-fork-bomb fails to load with `matchRateLimit` error (known gap) | ✅ documented expected behaviour |
| Metadata curl terminated with SIGKILL (exit code 137) | ✅ No metadata content returned; `tetra getevents` shows `KPROBE_ACTION_SIGKILL` |
| `tetra getevents` shows `tcp_connect` + `KPROBE_ACTION_SIGKILL` + `block-egress-metadata` | ✅ NPOST/NENFORCE tick per attempt |
| `/health` 200 + `status:ok` when bridge fresh | ✅ HTTP 200 |
| `/health` 503 + `status:down` after 70 s freeze | ✅ HTTP 503 |
| `/health` 200 again after resume + one interval | ✅ HTTP 200 |
| Stale workspace row reaped within `reaper_interval_ms` | ✅ Row absent from MongoDB |
| Multiple components visible in component table | ✅ `components.length` = expected count |
| Audit log captures SIGKILL events for egress test | ✅ JSON log non-empty |

---

## Reference

- Tetragon policy docs: <https://tetragon.io/docs/concepts/tracing-policy/>
- RateLimit selector: <https://tetragon.io/docs/concepts/policy-rules/rate-limit/>
- Heartbeat config: `bridge.toml` `[supervisor]` section → see `README.md § Phase 5`
- YAML sources: `config/tetragon/*.yaml`
- JS Reaper: `bridge/core/reaper.js`
- JS HeartbeatEmitter: `bridge/core/heartbeat-emitter.js`
- Pass 2 smoke report: [`docs/smoke/phase-5-pass-2-report.md`](phase-5-pass-2-report.md)
