# pria-fsmon-plugin

The **Pria in-VM file-write monitor** (`synaps_fsmon`) — a Rust **sibling
daemon** that enforces file-write policy *inline* on Pria Account / ephemeral
task VMs (spec §4.7). Track B slices **B7** (the daemon) and **B8** (the
guest-agent policy-push + audit-emit contract).

## Why a sibling daemon and not a Synaps sidecar (HS-5)

SynapsCLI's `provides.sidecar` / `crates/agent-engine/src/sidecar/spawn.rs` is a
**purpose-built protocol** (the only in-tree example, `local-voice-plugin`,
speaks a voice STT protocol), not a generic daemon supervisor. Having SynapsCLI
lifecycle this monitor would require a **core change** → HARD STOP HS-5.
Therefore `synaps_fsmon` ships as an **independent OS daemon**, built by
`scripts/setup.sh` and launched/supervised by the Pria guest agent + systemd
(A11/A13) — exactly the spec-sanctioned "sibling daemon under `synaps_system`"
placement. The plugin manifest declares **no** `extension` and **no**
`provides.sidecar` block, so SynapsCLI never spawns it.

## What it does (B7)

- `fanotify` `FAN_OPEN_PERM` / `FAN_ACCESS_PERM` → synchronous ALLOW/DENY
  **before the write commits** (pure inotify can't block).
- In-memory **L1 policy/decision cache** keyed `(uid, path, op)` — the hot path
  makes no synchronous network call (sub-ms decisions).
- Denies cross-instance / out-of-home writes, immutable policy/identity files
  (mirrors `chattr +i`), and DLP path rules.
- **Fail-closed**: on monitor failure, high-risk paths deny, low-risk degrade to
  log-only; the control socket stays up for re-push/alert.
- Emits structured `file.write.allowed` / `file.write.denied` records
  (`source: synaps-sidecar`) to a durable JSONL spool + the guest-agent audit
  socket (which forwards to Pria ingest, A15).

## Control + audit contract (B8)

- **Policy push:** guest agent's `POST /guest/v1/policy/apply` (A11) terminates
  at fsmon's `--control` Unix socket: `{"type":"policy_apply","policy":{...}}`.
  Applying clears the L1 cache (hot refresh, no restart).
- **Audit forward:** fsmon streams NDJSON `AuditForwardEnvelope`s to the guest
  agent's `--forward` socket; the guest agent (holding the ingest token + the
  `uid→session` map) performs the authenticated ingest POST.

## Build / verify

```bash
bash scripts/test.sh         # validate + cargo build/test (+ clippy if installed) + smoke
bash scripts/setup.sh        # release build only
```

The Rust crate lives in `extensions/synaps-fsmon/`
(`src/{policy,audit,control,daemon,fanotify,main}.rs`,
`tests/control_socket.rs`).
