---
name: pria-fsmon
description: Use when deploying, operating, or troubleshooting the Pria in-VM file-write monitor (synaps_fsmon) — building the binary, wiring the systemd unit and guest-agent control/audit sockets, pushing policy, and reading file-write deny audit records.
---

# pria-fsmon — in-VM file-write monitor (sibling daemon)

`synaps_fsmon` is a Rust **sibling daemon** (NOT a Synaps-managed sidecar — see
HS-5) that enforces file-write policy inline on a Pria Account/ephemeral VM using
the kernel's synchronous `fanotify` permission events (`FAN_OPEN_PERM` /
`FAN_ACCESS_PERM`). It serves ALLOW/DENY from an in-memory **L1 policy cache** so
the hot path never makes a network call (spec §4.7), denies cross-instance /
out-of-home / immutable-path writes, **fails closed** on high-risk paths, and
emits structured `file.write.denied` / `file.write.allowed` audit records.

## When to use

Use when you need to build, deploy, or debug the file-write monitor on an
Account VM or ephemeral task VM, or when investigating a `file.write.denied`
audit event.

## Build

```bash
bash scripts/setup.sh            # cargo release build -> extensions/synaps-fsmon/target/release/synaps_fsmon
bash scripts/setup.sh --check    # verify binary + policy parse
```

## Run (as the narrow `synaps_fsmon` principal, CAP_SYS_ADMIN for fanotify)

```bash
synaps_fsmon run \
  --mount   /srv \
  --spool   /srv/synaps/audit-spool/fsmon.jsonl \
  --control /run/synaps/fsmon/control.sock \
  --forward /run/synaps/guest-agent/audit.sock \
  --policy  /srv/synaps/policy/fsmon.json
```

- `--control` Unix socket: the guest agent pushes policy here
  (`{"type":"policy_apply","policy":{...}}`) — hot, no restart (B8).
- `--forward` Unix socket: fsmon streams NDJSON audit envelopes to the guest
  agent, which performs the authenticated `POST /agents/ingest/events` (the
  guest agent holds the ingest token + the `uid → session` map).

## Placement (spec §4.7, HS-5)

Ships as an **independent OS daemon** launched by the guest agent / systemd, not
declared as a SynapsCLI `extension` or `provides.sidecar`. SynapsCLI never
spawns or lifecycles it. See `docs/deployment.md` for the systemd unit.

## Fail posture

On fanotify init failure the daemon enters **degraded** mode: high-risk path
writes deny (`reason: monitor_degraded`), low-risk paths degrade to log-only,
and the control socket stays up so the guest agent can re-push policy / alert.
