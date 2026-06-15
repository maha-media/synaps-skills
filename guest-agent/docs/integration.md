# GA-B9 — End-to-end alignment (no SynapsCLI core change)

This documents how the Rust guest-agent integrates with the two existing
sibling components in `synaps-skills`, and how the alignment is verified. **No
SynapsCLI core file is modified** — every integration point uses a
plugin/file/socket boundary (plan §4 HARD STOPs).

## 1. Session-context plugin (`pria-session-context-plugin`)

- **Producer:** the guest agent (`src/synaps/session_context.rs`, GA-B6) writes
  the context JSON at the plugin's resolution-order path #1
  `${XDG_RUNTIME_DIR}/synaps/sessions/<id>/context.json` (plus the run-root
  fallback and the `${HOME}/.synaps-cli/...` mirror).
- **Consumer:** the plugin's `pria/sessionctx.py` `load_context()` reads that
  exact file on `on_session_start` and stamps every audit record with the IDs.
- **Why a file, not env (HS-2/HS-7 CONFIRMED):** `process.rs:643-648` runs
  `env_clear()` and forwards only `PATH,HOME,LANG,TERM,XDG_RUNTIME_DIR`; a
  repo-wide grep for `SYNAPS_SESSION_CONTEXT` returns zero hits in core. The
  guest agent still sets the env on the synaps **parent** (best-effort) but the
  file is authoritative.
- **Verification:** `tests/alignment_tests.rs::session_context_file_is_readable_by_plugin`
  writes a guest-format context and drives the *real* `sessionctx.load_context`
  + `SessionContext.tags()`, asserting `context: "resolved"` and the full tag
  set. Skips cleanly if `python3`/the plugin are absent.

## 2. fsmon daemon (`pria-fsmon-plugin/extensions/synaps-fsmon`)

- **Control push:** the guest agent (`src/fsmon/client.rs`, GA-B7) connects to
  the fsmon control UDS and sends `ControlRequest::PolicyApply { policy }` as
  newline-delimited JSON. The wire types (`src/fsmon/types.rs`) mirror the
  daemon's `control.rs`/`policy.rs` exactly (tagged `type`, snake_case fields).
- **Audit forward:** fsmon streams `AuditForwardEnvelope` NDJSON to the guest
  agent's forward socket (`src/fsmon/relay.rs`, GA-B8); the guest agent enriches
  with the uid→session map and performs the authenticated `/internal/agentic-vm/audit`
  POST. fsmon embeds no TLS client by design — the hot path never blocks on the
  network.
- **Sibling daemon (HS-5 CONFIRMED):** `sidecar/spawn.rs` is a plugin-arg RPC,
  not a daemon supervisor; fsmon runs as an independent daemon launched by the
  guest agent / systemd.
- **Verification:**
  - `tests/alignment_tests.rs::fsmon_control_vector_parses` deserialises the
    daemon's own `control.rs` test vector into the guest type.
  - `tests/alignment_tests.rs::fsmon_control_serialisation_matches_daemon_expectation`
    asserts the guest serialisation matches the daemon's receive-side test.
  - **Live round-trip (manual, opt-in):** build `synaps_fsmon`, start
    `synaps_fsmon run --control <sock>`, and send the guest agent's exact
    serialised `PolicyApply`/`Ping`/`Stats`. The daemon replies
    `{"type":"ok","cache_len":0}` which `UdsFsmonControl` parses as
    `ControlResponse::Ok`. Confirmed on a dev box (fanotify degraded without
    `CAP_SYS_ADMIN`, but the control socket remains available — by design).

## 3. Reusing existing peer contracts

The guest agent does **not** fork or duplicate the peer contracts:
- It speaks the `ControlRequest` / `ControlResponse` / `AuditForwardEnvelope`
  protocol defined in `pria-fsmon-plugin/.../control.rs`.
- It writes the session-context schema defined in
  `pria-session-context-plugin/docs/session-context.schema.json`.

## 4. Synaps OAuth credential contract (spec §8 G8, §11.3) — NO core change

The real Synaps usage call (E2E step 14) must use the OpenAI **Codex / GPT-5.5**
OAuth path. This is **already fully supported by SynapsCLI** — no core change is
required (HS-S1 / HS-G5 do NOT fire):

- **OAuth flow:** `crates/agent-core/src/core/auth/openai_codex.rs` implements the
  full PKCE flow for provider `openai-codex` (client id
  `app_EMoamEEZ73f0CkXaXp7hrann`, ChatGPT auth) and persists
  `{type:"oauth", refresh, access, expires, account_id}` to `auth.json`.
- **Credential storage:** `auth.json` lives under `base_dir()` =
  `$SYNAPS_BASE_DIR` or `$HOME/.synaps-cli` (`core/config.rs`). The guest-agent
  launches `synaps` with `env_clear()` + a controlled allowlist plus the
  Pria-supplied session `environment` map (`api/sessions.rs` →
  `LaunchSpec.env`). The bootstrap therefore delivers the per-user
  `openai-codex` credential by injecting `auth.json` into a per-user dir and
  setting `SYNAPS_BASE_DIR` (or `HOME`) in the session `environment` — no env
  var or file path needs SynapsCLI changes.
- **Model routing:** `openai-codex/gpt-5.5` resolves via
  `crates/agent-engine/src/runtime/openai/registry.rs::resolve_codex_shorthand`
  (line 308) against the static catalog
  (`crates/agent-engine/src/runtime/openai/catalog/codex.rs` lists `gpt-5.5`).
  The engine refreshes the token automatically via
  `auth::ensure_fresh_provider_token(client, "openai-codex")`
  (`crates/agent-core/src/core/auth/token.rs:178`).
- **Usage attribution:** the `on_usage` hook (protocol v2,
  `crates/agent-engine/src/extensions/hooks/events.rs`, permission `LlmContent`
  in `crates/agent-engine/src/extensions/permissions.rs`) carries raw token
  usage.
  `pria-session-context-plugin` (manifest `protocol_version: 2`, subscribes
  `on_usage`) forwards it to the guest-agent usage proxy, which signs +
  attributes (`src/synaps/launcher.rs::tag_plugin_usage`). The permission model
  is sufficient (HS-S2 does NOT fire).
- **Anthropic OAuth is explicitly NOT used** (spec §2.13).

**Conclusion:** the OAuth Codex/GPT-5.5 path is drivable end-to-end using
existing SynapsCLI capabilities. No SynapsCLI HARD STOP.
