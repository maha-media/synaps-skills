# pria-guest-agent

Pria's trusted **in-VM supervisor / control endpoint** for Account Agentic VMs
(Track B of the Rust guest-agent plan). It is a small, narrow, HMAC-authenticated
Rust HTTP API server (`/guest/v1/*`) that makes local VM state match Pria's
desired control-plane state: Linux principals, Synaps sessions, session-context
files, policy, fsmon coordination, and signed audit/heartbeat callbacks.

It is **not** Synaps and **not** the LLM agent. It **never modifies SynapsCLI
core** — every integration rides a file/socket/plugin boundary (see the HARD
STOP register in `docs/contract.md` §5 and `docs/integration.md`).

## Build & test

```bash
cargo build --release
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
# opt-in: real OS users / libvirt E2E (skipped by default)
cargo test --all-features -- --ignored
```

## Run

```bash
PRIA_GUEST_AGENT_CONFIG=/etc/pria/guest-agent.yaml cargo run --bin pria-guest-agent
```

See `config.example.yaml` (spec §14). The HMAC secret is read from
`pria.hmac_secret_file` (mode 0600) — never inline, never committed.

## API (`/guest/v1`)

| Method/path | Slice | Auth |
|---|---|---|
| `GET /health` | GA-B3 | none (liveness) |
| `POST /principals/reconcile` · `/principals/disable` | GA-B5 | HMAC |
| `POST /sessions/start` · `/sessions/:id/{send,cancel,close}` · `GET /sessions/:id/status` | GA-B6 | HMAC (status: none) |
| `POST /policy/apply` | GA-B7 | HMAC |
| `GET /fsmon/status` · `POST /fsmon/reload` | GA-B8 | reload: HMAC |

Callbacks to Pria (`/internal/agentic-vm/{heartbeat,audit,session-event,credential-request}`)
are all signed (GA-B4).

## Layout

```
src/
  config.rs error.rs ids.rs paths.rs runtime.rs versions.rs
  hmac.rs                     # SignedJson extractor + nonce replay cache (GA-B2)
  api/{mod,health,principals,sessions,policy,fsmon}.rs
  pria_client/{mod,payloads,signer}.rs   # signed callbacks + spool (GA-B4)
  os/{mod,users}.rs           # abstract principal layer (GA-B5)
  synaps/{launcher,session_context}.rs   # drop-priv launch + context file (GA-B6)
  fsmon/{client,compile,types,relay}.rs  # control + policy + audit relay (GA-B7/B8)
  supervisor/mod.rs           # guest-emitted heartbeat loop (HS-3)
docs/{contract.md,integration.md}
```
