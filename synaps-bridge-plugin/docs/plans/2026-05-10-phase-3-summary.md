# Phase 3 — Web Dashboard + Identity: Release Summary

**Date:** 2026-05-10
**Branch:** `feat/scp-phase-3-web-identity`
**PR:** #N (pending)
**Status:** ✅ Wave C complete — acceptance tests + smoke playbook + README landed

---

## What shipped

### Backend (synaps-bridge-plugin)

#### New collections (MongoDB)

| Collection | Purpose |
|-----------|---------|
| `synaps_users` | One document per pria user; holds `memory_namespace = u_<_id>` |
| `synaps_channel_identities` | Maps `(channel, external_id, external_team_id)` → `SynapsUser`; unique compound index |
| `synaps_link_codes` | 6-char ephemeral codes enabling Slack↔web identity reconciliation |

#### New modules

| Module | Description |
|--------|-------------|
| `bridge/core/identity-router.js` | `IdentityRouter` (live DB) + `NoOpIdentityRouter` (Phase-2 fallback) |
| `bridge/core/web-stream-bridge.js` | Pure functions: RPC chunks → AI SDK numbered data-stream frames |
| `bridge/core/db/models/synaps-user.js` | Mongoose schema + model factory |
| `bridge/core/db/models/synaps-channel-identity.js` | Mongoose schema + model factory |
| `bridge/core/db/models/synaps-link-code.js` | Mongoose schema + model factory |
| `bridge/core/db/repositories/user-repo.js` | `UserRepo` — create / findById / findByPriaUserId / ensure |
| `bridge/core/db/repositories/channel-identity-repo.js` | `ChannelIdentityRepo` — findByExternal / upsertExternal |
| `bridge/core/db/repositories/link-code-repo.js` | `LinkCodeRepo` — issue / findActiveByCode / redeem |

#### Modified modules

| Module | Changes |
|--------|---------|
| `bridge/config.js` | New `[identity]` config section: `enabled`, `link_code_ttl_secs`, `default_institution_id` |
| `bridge/control-socket.js` | Three new identity ops + `chat_stream_start` long-lived streaming op |
| `bridge/index.js` | `defaultIdentityRouterFactory`; identity router wired into daemon start; Slack adapter + ControlSocket receive the router |

#### New ControlSocket ops

| Op | Direction | Purpose |
|----|-----------|---------|
| `link_code_issue` | pria-ui-v22 → bridge | Issue a 6-char link code for a logged-in pria user |
| `link_code_redeem` | Slack adapter → bridge | Redeem a link code, binding Slack identity to SynapsUser |
| `identity_resolve_web` | pria-ui-v22 → bridge | Resolve pria user → SynapsUser (creates if new) |
| `chat_stream_start` | pria-ui-v22 → bridge | Long-lived streaming op: SSE-over-UDS for web chat |

#### Config additions

```toml
[identity]
enabled             = false        # default off — Phase 2 behaviour preserved
link_code_ttl_secs  = 300          # 5 min
default_institution_id = ""        # optional ObjectId hex
```

### Frontend (pria-ui-v22 — `feat/synaps-web-dashboard`)

| Component | Description |
|-----------|-------------|
| `routes/synaps/chat.js` | Express SSE endpoint: proxies `chat_stream_start` UDS stream to HTTP SSE |
| `routes/synaps/link.js` | Express API: `POST /api/synaps/link/issue`, `POST /api/synaps/link/redeem` |
| `src/synaps/SynapsChat.jsx` | React chat UI consuming the SSE stream |
| `src/synaps/SynapsLink.jsx` | React link-code page (generate + display) |

---

## Test delta

| Suite | Tests before | Tests after | Δ |
|-------|-------------|-------------|---|
| All bridge tests (baseline) | 1266 | 1266 | +0 |
| `tests/scp-phase-3/` (new) | — | 40 | +40 |
| **Total** | **1266** | **1306** | **+40** |

### New acceptance test files

| File | Tests | Coverage focus |
|------|-------|----------------|
| `tests/scp-phase-3/00-identity-router-mongo.test.mjs` | 10 | IdentityRouter × live MongoDB |
| `tests/scp-phase-3/01-control-socket-link-flow.test.mjs` | 6 | ControlSocket link ops × live MongoDB |
| `tests/scp-phase-3/02-control-socket-chat-stream.test.mjs` | 5 | `chat_stream_start` × fake EventEmitter RPC |
| `tests/scp-phase-3/03-web-stream-bridge-integration.test.mjs` | 12 | AI SDK frame translation (pure) |
| `tests/scp-phase-3/04-bridge-daemon-config-toggle.test.mjs` | 7 | BridgeDaemon identity-toggle DI |

---

## Key invariants verified

- ✅ `identity.enabled = false` → `NoOpIdentityRouter` → zero DB writes → Slack works as Phase 2
- ✅ `identity.enabled = true` + unreachable mongo → falls back to `NoOpIdentityRouter`, no crash
- ✅ Same pria user web + Slack after link → same `memory_namespace`
- ✅ Different `external_team_id` with same `external_id` → distinct `SynapsUser`
- ✅ Link code is single-use; second redemption → `already_redeemed`
- ✅ Expired link code (backdated) → `expired`
- ✅ AI SDK frames: all 7 chunk types round-trip correctly, special chars + unicode safe

---

## Known limitations (documented)

1. **Phase 2 → Phase 3 memory namespace migration:** `u_<slackUserId>` → `u_<synapsUserId>` — existing brain files not migrated. Acceptable; manual rename documented in smoke playbook.
2. **Orphaned synthetic Slack users:** pre-link synthetic `SynapsUser` docs remain after linking. Phase 5 cleanup job will reap.
3. **Web chat: no rich task-tree styling** — data arrives, basic JSON rendering only. Phase 5.
4. **Link code CSRF:** endpoint protected by JWT cookie middleware; no additional CSRF tokens. Phase 5 hardening.

---

## Smoke playbook

See `docs/smoke/phase-3-web-identity.md` for full 14-step manual verification
procedure, including cross-channel memory recall (the core Phase 3 acceptance
criterion).

---

## Spec references

- `PLATFORM.SPEC.md` §3.2 — identity data model
- `PLATFORM.SPEC.md` §7.1 — AI SDK numbered data-stream protocol
- `PLATFORM.SPEC.md` §14.1 — link-code flow
- `PHASE_3_BRIEF.md` — wave plan and key invariants
