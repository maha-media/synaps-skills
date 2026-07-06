# Credential Broker + Guest-Agent: S234 Status and Roadmap

**Date:** 2026-07-06
**Branches referenced:**
- `synaps-skills-jr/guest-agent:feat/guest-agent-reaper`
- `pria-ui-v22:feat/agent-credential-broker`

## 1. Overview

This document describes recent work on the institution-level credential broker
and the guest-agent runtime. It covers what has shipped, what remains, and
coordination points before subsequent work begins.

The credential broker mints short-lived Codex OAuth access tokens for VMs
running in ECS Fargate, avoiding the need to bake long-lived refresh tokens
into container images. Each VM authenticates to the broker with a per-VM
HMAC-signed machine token. The guest-agent, running inside each VM, signs Pria
callbacks with the per-VM HMAC key, launches `synaps rpc` as a scoped Linux
user, and relays reply frames back to Pria for streaming to the browser.

Three integration seams connect the components:

- **Seam 1:** Institution admin to broker (OAuth "Connect ChatGPT" flow)
- **Seam 2:** Broker to VM (short-lived Codex JWT vending via machine token)
- **Seam 3:** Browser to Pria to guest-agent to synaps to Codex to SSE reply

Seam 3 was proven end-to-end in Session 231 on the local-virsh substrate. This
document covers the ECS-substrate wiring required to run the same loop in
production.

## 2. Changes on `feat/guest-agent-reaper`

Four commits ahead of `origin/main`.

### 2.1 `8c3d3fd feat(guest-agent): relay synaps rpc reply frames to Pria`

Session 231. Added a signed session-output callback to `src/pria_client/mod.rs`
and updated `relay_agent_end_usage` in `src/synaps/launcher.rs` to forward
`message_update`, `response`, and `agent_end` frames to Pria's
`/internal/agentic-vm/session-output` endpoint. Built for Debian 12
(glibc <= 2.34) using the standard `docker run rust:bookworm` build.

### 2.2 `ad1210a feat(sessions): reap dead children and smoke-check spawn survival`

Session 234. Prior behavior: when `synaps rpc` exited unexpectedly, the
`SessionEntry` remained in the store indefinitely. `GET /sessions/{sid}/status`
returned HTTP 200 with a stale PID while `POST /sessions/{sid}/send` returned
HTTP 404 (broken pipe on the dead stdin, mislabeled as `SessionNotFound`).

Changes:

- Added `SessionProcess::wait_for_exit()` to the trait, backed by
  `tokio::sync::watch<bool>` for `ChildProcess` and `oneshot` for
  `FakeProcess`.
- Split the child process's stdin mutex from the wait mutex so `send()` can
  run concurrently with the OS-level wait task.
- `cancel()` and `close()` send signals directly via `libc::kill` rather than
  contending for the child mutex.
- `/sessions/start` performs a 500ms smoke check via
  `tokio::time::timeout(process.wait_for_exit())`. Processes that exit within
  the window are surfaced as `SynapsLaunchFailed` at start time rather than
  discovered through downstream 404s.
- A per-session reaper task removes the `SessionEntry` on natural child exit,
  keeping `status` and `send` endpoint responses consistent.

### 2.3 `ee4a047 fix(sessions): make close(grace_ms) actually respect the grace period`

Session 234. Prior behavior: `close(_grace_ms)` ignored the parameter and
immediately sent SIGKILL, dropping synaps' final `agent_end` frame before the
usage-relay task could read it.

Change: `close()` now sends SIGTERM, waits up to `grace_ms` via
`tokio::time::timeout(self.wait_for_exit())`, and falls back to SIGKILL if the
grace period elapses. `cancel()` remains unchanged (still immediate SIGKILL,
matching abort semantics).

### 2.4 `f8d988d perf(sessions): O(1) find_by_uid via secondary uid index`

Session 234. Prior behavior: `find_by_uid` performed a linear scan of the
`sessions` map under a mutex, called on every fsmon audit event.

Change: added `uid_index: Mutex<HashMap<u32, String>>` alongside the main
sessions map, maintained on `insert()` and `remove()`. Locks are acquired
sequentially, never nested. The single-session-per-uid invariant is documented
on the `SessionStore` struct; extending to multi-session would require
`HashMap<u32, Vec<String>>`.

## 3. Changes on `pria-ui-v22:feat/agent-credential-broker`

Twenty-five commits ahead of `origin/main`, grouped by function.

### 3.1 Broker infrastructure (S228-S230)

Approximately ten commits establishing the credential broker foundation:

- OAuth device flow for admin "Connect ChatGPT" enrollment
- Encrypted institution OAuth credential store in Mongo, with a pluggable
  crypto provider (KMS drop-in seam)
- Distributed refresh lock ensuring a single refresher across Node instances
- Credential revocation (per-institution disable, disconnect endpoint,
  broker refuses disabled credentials)
- Token endpoint mounted at `/internal/agent-llm-cred/token` outside the
  agentic-VM HMAC guard, allowing VM callers to reach it

### 3.2 Seam 3 wire-up (S231)

Approximately six commits implementing the browser-to-broker chat loop:

- `deployModelResolver` routes Codex-connected institutions to
  `openai-codex/gpt-5.5`
- Catalogue "Deploy" button posts to `startInstanceSession`, which mints the
  machine token via `buildAgentAuthEnv` and injects it as `SYNAPS_AUTH_ENDPOINT`
  plus `SYNAPS_MACHINE_TOKEN` in the guest-agent `/sessions/start` request
- `set_model` frame driven on session-start so the first turn routes correctly
  through the broker
- Chat handler at `POST /api/user/agents/chat` with SSE streaming
- Session output bus (in-memory, keyed by sessionId) for SSE fan-out to
  subscribers
- Frontend `useAgentsChat` hook repointed to the new endpoints

### 3.3 ECS Secrets Manager backend track (S234)

Five commits implementing the ECS-substrate HMAC injection path:

| Commit | Change |
|---|---|
| `09013ce1` | Add Secrets Manager client shim: `createSecret`, `deleteSecret`, `updateSecret` (SDK-backed and deterministic stubs) |
| `944abfa8` | Extend `registerWorkspaceTaskDefinition` to accept and inject `secrets: [{PRIA_HMAC_SECRET valueFrom: <ARN>}]` and guest-agent environment variables |
| `2c457f07` | Cleanup HMAC secret on account VM terminate (7-day recovery window) |
| `0ecac314` | Mint per-VM HMAC secret in Secrets Manager during provision, thread ARN into task definition |
| `20adc68d` | Persist `hmacSecretArn` on the `agentic_vm.runtime` document for terminate-path cleanup |

All feature-gated by `AGENT_ECS_ENABLE_HMAC_SECRETS=true`. Default is off; the
production path is unaffected until the environment variable is set.

### 3.4 Review follow-up fixes (S234)

Four commits addressing findings from a code review of the shipped work:

| Commit | Change |
|---|---|
| `cd8a52fe` | Make `createSecret` idempotent on `ResourceExistsException` (handles re-provision within the 7-day recovery window); thread guest-agent environment through `wakeEcs` (previously omitted, silent regression on wake) |
| `7e25ca19` | `terminateVm` refuses when the row is mid-provision, returning HTTP 409 `VM_BUSY` (prevents TOCTOU race where terminate and provision left orphan AWS resources) |
| `279fe9f8` | Align `agentic_vm.runtime.hmacSecretArn` schema field with sibling ARN fields: `{ type: String, maxLength: 500, default: '' }` |
| `7e25625f` | Rollback newly-minted HMAC secret when a downstream provision step fails, using the `reused` flag from the idempotency fix to avoid deleting pre-existing secrets |

## 4. Follow-up work required in the guest-agent

### 4.1 Environment variable handling in configuration loader

The Pria backend now conditionally emits the following environment variables
in the ECS TaskDefinition:

| Environment variable | Description | Config field |
|---|---|---|
| `PRIA_VM_ID` | Mongo ObjectId of the `agentic_vm` document | `vm_id` |
| `PRIA_REPLICA_ID` | Multi-replica identity, defaults to `replica_0` | `replica_id` |
| `PRIA_BROKER_ENDPOINT` | URL base for the credential broker | `pria.callback_url` |
| `PRIA_HEARTBEAT_URL` | Heartbeat endpoint URL | `pria.heartbeat_url` |
| `PRIA_LOG_LEVEL` | Tracing verbosity | Runtime tracing filter |

The existing configuration loader reads `hmac_secret_file:
/etc/pria/guest-agent.hmac`, which matches the virsh cloud-init contract and
requires no change. However, the new environment variables above should be
mapped explicitly in the container entrypoint script (see section 6.1), or the
loader should be updated to consume them directly.

### 4.2 Open decision: `PRIA_ACCOUNT_ID`

The design document lists `PRIA_ACCOUNT_ID` as a required environment
variable. The shipped code omits it based on the assumption that the existing
`INSTITUTION_ID` variable carries the account identity for the Account-VM
path. This should be confirmed. If the guest-agent requires a distinct
`account_id` field separate from `institution_id`, the backend needs to emit
it.

### 4.3 Task metadata endpoint fetching

For ECS Fargate, task replacement events (spot reclaim, deployment, health
check failure) invalidate in-memory session state while Mongo continues to
report sessions as running. Recommended pattern: at guest-agent startup, fetch
the task ARN from the ECS Task Metadata Endpoint v4
(`http://169.254.170.2/v4/${TASK_ID}/task`), cache it in `RuntimeState`, and
include it in every heartbeat. The Pria backend can then detect task
replacement by diffing the `taskArn` field across heartbeats and mark stale
sessions completed. Approximately twenty lines of code, no external
dependencies.

## 5. Follow-up work required in the Pria backend

### 5.1 HMAC rotation infrastructure

The `updateSecret` shim is in place but no callers exist. Three follow-up
items are tracked:

- Administrative endpoint and runbook for rotating a compromised HMAC key
  (mint new key in Mongo, `PutSecretValue` to Secrets Manager, force ECS
  service redeployment, mark old key inactive).
- Recovery operation for HMAC secrets accidentally deleted via the AWS
  console.
- Reconciliation job that detects divergence between the Mongo HMAC key
  registry and Secrets Manager.

### 5.2 Design document updates

The design document requires approximately eight small updates to align with
shipped behavior: the `PRIA_ACCOUNT_ID` decision (section 4.2), `terminateEcs`
swallowing `deleteSecret` errors, feature flag default state, `algo` versus
`algorithm` inconsistency in the architecture diagram, and related items.

## 6. Coordination checkpoints

Two upcoming work items should be reviewed with JR before implementation
begins, as they modify infrastructure adjacent to the guest-agent runtime.

### 6.1 Container image update

The `AGENT_WORKSPACE_IMAGE` container requires:

- Inclusion of the `pria-guest-agent` binary (Debian bookworm build)
- Entrypoint script that parses `PRIA_HMAC_SECRET` (JSON blob), writes
  `secret_hex` to `/etc/pria/guest-agent.hmac` with mode 0600, renders
  `/etc/pria/guest-agent.yaml` from the new environment variables, and execs
  the guest-agent binary
- `unset PRIA_HMAC_SECRET` prior to `exec` to prevent inheritance into the
  KasmVNC subprocess environment (flagged in security review)

Two options for how this work proceeds: (a) prepared as a proposal (binary
artifact, entrypoint script, and Dockerfile diff) for review before merging,
or (b) implemented directly by JR. Either approach is workable.

### 6.2 IAM policies

The ECS task role and execution role require the following permission:

```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:*:*:secret:pria/agents/vm/*"
}
```

This follows the standard AWS Secrets Manager injection pattern. Same two
options as section 6.1: prepared as a policy JSON diff for review, or applied
directly.

### 6.3 End-to-end verification on dev ECS

Once sections 6.1 and 6.2 land, the full seam 3 loop can be verified on a dev
ECS cluster by reproducing the S234 dev-loop receipts: a usage event tagged
`source: synaps-rpc-agent-end` (indicating a broker-authenticated Codex
turn) for a session created on the Fargate substrate.

## 7. Test coverage

- `guest-agent`: 136/136 tests passing (`cargo test --lib`)
- `pria-ui-v22`: 126/126 tests passing across the ECS-related suites
- API-level end-to-end driver: six scenarios covering provision, rollback,
  terminate, schema defaults, feature-flag backward compatibility, and the
  reused-secret safety path — all passing against real code with stub AWS
  clients
- Live regression on the local-virsh substrate: chat end-to-end confirmed,
  usage event tagged `source: synaps-rpc-agent-end` recorded in the
  `agentic_usage_events` collection

## 8. References

- Original seam 3 completion note: Session 231
- Pria backend branch: `pria-ui-v22:feat/agent-credential-broker`
- Guest-agent branch: `synaps-skills-jr/guest-agent:feat/guest-agent-reaper`
