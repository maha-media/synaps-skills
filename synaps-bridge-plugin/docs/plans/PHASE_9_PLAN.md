# Phase 9 Plan — Production polish: streaming, isolation, auth, gating

**Repo:** `maha-media/synaps-skills`
**Base branch:** `feat/scp-phase-8-hardening` (PR #40, tip `f66e95f`)
**Branch:** `feat/scp-phase-9-polish` (to be created)
**Plan branch (this doc):** `docs/scp-phase-9-plan`
**Status:** Plan only — implementation has not started.

---

## TL;DR

Phase 9 ships **six independent tracks** that close the loop on the
production-hardening work from Phase 8. Every track is **additive,
behind a feature flag, and stacked on PR #40**. No track touches the
data layer; no track adds new dependencies.

| # | Track | Size | Wave | Fixes |
|---|---|---|---|---|
| 1 | Per-session prompt serialization | **S** | A | Phase 8 smoke #19 partial |
| 2 | True SSE per-delta token streaming for `synaps_chat` | **M** | A/B | Phase 8 known limitation |
| 3 | OAuth 2.1 Authorization Code flow (PKCE) | **L** | A/B/C | Phase 8 spec addendum stretch |
| 4 | Per-tool ACL resolver | **M** | A/B | Phase 7 carry-over |
| 5 | `rpcFactory` stub → real spawn (watcher cutover) | **S** | C | Phase 5/6/8 carry-over |
| 6 | Observability metrics (counters + histograms) | **S** | C | Phase 8 spec addendum stretch |

**Estimated LoC:** ≈2,400 net add (excluding tests).
**Estimated tests:** ≈250 new (covering 6 new modules + wiring + acceptance).
**Estimated commits:** ≈14 across 4 waves.
**Estimated PR:** **PR #41** stacked on PR #40.

---

## Cardinal Rules (carry-over — DO NOT VIOLATE)

- **ESM only**, **Node ≥ 20**, no top-level `await` in modules.
- **MongoDB only** — no Postgres, no Redis. `directConnection=true` in
  smoke environments.
- **Core slack-free** rule under `bridge/core/**`.
- **`pool: 'vmThreads'`** in vitest; agenda mocked in acceptance tests.
- **NEVER `npx vitest --run` without a path** — per-file targeted runs only.
- **Daemon HTTP server**: Node built-in `http.createServer` only — no
  `express`, no `ws` library, no parser deps.
- **Additive feature flags** — every new behaviour off by default until
  explicitly enabled in `[mcp]` (or its sub-block).
- **No `slack` imports** under `bridge/core/**`; **`bridge` is not a
  Synaps extension**.
- **`platform.mode = "scp"` gates everything Phase 9 adds** — bridge mode
  must remain pristine.
- **Smoke verification** must follow the per-file targeted pattern; full
  suite runs ban remains in force.
- **`synaps_user_id` is the cross-cutting identity primitive** — never
  invent new identity primitives in Phase 9.

---

## Track 1 — Per-session prompt serialization (S)

### Problem statement

Phase 8 smoke item #19 exposed the following sequence:

1. Client issues N concurrent `tools/call synaps_chat` requests on the
   same MCP token.
2. `McpToolRegistry.callTool` resolves the per-user session via
   `SessionRouter.getOrCreateSession({source:'mcp', conversation,
   thread:'default'})` — all N calls hit the **same** `SynapsRpc`
   instance.
3. `SynapsRpc.prompt()` is single-in-flight by design — second arrival
   throws `another prompt is in flight; abort first`.
4. Result: **1 succeeds; N-1 return `INTERNAL_ERROR` ("Internal error")**.

Daemon stability, routing, id-echo, audit, and per-token isolation are
all intact. The failure is purely a **queuing gap** in
`McpToolRegistry`.

### Goal

Concurrent calls on the same `(token, tool, session)` triple **serialize
transparently**: all callers receive their own correct result; daemon
latency for the N-th caller is the sum of the prior N−1 wall times plus
its own; no caller sees `"Internal error"`.

### Design

Add a per-session promise chain to `McpToolRegistry`:

```js
// bridge/core/mcp/mcp-tool-registry.js
this._sessionLocks = new Map(); // sessionKey -> Promise<void>

async _runSerialized(sessionKey, fn) {
  const prev = this._sessionLocks.get(sessionKey) ?? Promise.resolve();
  // chain — never let a rejection break subsequent waiters
  const next = prev.catch(() => {}).then(fn);
  this._sessionLocks.set(sessionKey, next.catch(() => {}));
  try {
    return await next;
  } finally {
    if (this._sessionLocks.get(sessionKey) === next.catch(() => {})) {
      // best-effort cleanup; race with the GC is fine
      this._sessionLocks.delete(sessionKey);
    }
  }
}
```

`sessionKey` is the **same composite key** the SessionRouter uses:
`${source}|${conversation}|${thread}` — for MCP that is
`mcp|<synaps_user_id>|default`.

`_invokeChat` becomes:

```js
async _invokeChat({ args, synaps_user_id }) {
  const sessionKey = `mcp|${synaps_user_id}|default`;
  return this._runSerialized(sessionKey, () =>
    this._invokeChatOnce({ args, synaps_user_id })
  );
}
```

`_invokeChatOnce` is the prior body of `_invokeChat` unchanged.

### Config

Track 1 has **no config knob**. The behaviour is the *intended*
contract; making it opt-in would re-introduce the bug.

### Files

| File | Change |
|---|---|
| `bridge/core/mcp/mcp-tool-registry.js` | Add `_sessionLocks` + `_runSerialized`; wrap `_invokeChat` |
| `bridge/core/mcp/mcp-tool-registry.test.js` | +6 tests (serial order, rejection isolation, key isolation, parallel different keys, cleanup, timeout in chain) |

### Acceptance tests (unit)

1. **Serial order**: 5 calls dispatched within the same tick on the same
   `sessionKey` resolve in submission order; assert by attaching
   incrementing timestamps in the `fn` and verifying monotonic.
2. **Rejection isolation**: 3 calls; mid-call rejects → first and third
   still resolve correctly; chain does **not** dead-lock on the rejection.
3. **Key isolation**: 2 calls on `mcp|u1|default` and 2 on `mcp|u2|default`
   run with overlap (timestamps prove parallelism across keys).
4. **Map cleanup**: after 10 sequential calls on one key, `_sessionLocks`
   has size ≤ 1.
5. **Timeout participation**: a call that times out via the existing
   `chat_timeout_ms` does not deadlock the chain; the next caller proceeds.
6. **EventEmitter cleanup interaction**: the existing `cleanup()` inside
   `_invokeChatOnce` still removes all listeners after a serialised call
   (no listener leak — verify via `rpc.listenerCount('message_update')`).

### Live smoke

Re-run `/tmp/smoke/concurrent-test.mjs` from Phase 8 unchanged:

- **Expected**: Test A — 5 / 5 PASS, each returns the requested word;
  Test B — 6 / 6 PASS, ids correctly mapped, no `"Internal error"`.
- **Anti-regression**: `/tmp/smoke/reconnect-test.mjs` Test A still PASS
  (single-in-flight abort semantics for the live SSE branch unchanged).

### Risk & rollback

- **Risk**: bug in the chain primitive could deadlock callers. Mitigation:
  use `prev.catch(() => {})` so a rejected predecessor never blocks
  successors; map cleanup is best-effort.
- **Rollback**: revert one commit; `_invokeChat` falls back to direct
  call; #19 partial returns. No data-layer impact.

---

## Track 2 — True SSE per-delta token streaming (M)

### Problem statement

Phase 8's `McpSseTransport` buffers the full `synaps_chat` reply, emits a
single `synaps/result` notification, then the final `result` frame, then
closes. The client cannot render tokens as they arrive. This was
explicitly scoped out of Phase 8.

### Goal

When a request carries `Accept: text/event-stream` for a `tools/call`
that maps to `synaps_chat`, every `text_delta` event from the underlying
`SynapsRpc` is forwarded to the client as a `synaps/delta`
JSON-RPC-notification SSE frame, followed by a single final `result`
frame that carries the aggregated text.

### Design

1. **`McpSseTransport`** already has `notify(method, params)`. Add a
   thin `delta(token)` helper that writes one notification frame:
   ```js
   delta(text) {
     this.notify('synaps/delta', { id: this._id, text });
   }
   ```

2. **`McpToolRegistry._invokeChat`** grows an optional `onDelta` callback:
   ```js
   async _invokeChatOnce({ args, synaps_user_id, onDelta = null }) { … }
   ```
   The collect-deltas branch (Phase 8 EventEmitter rewrite) calls
   `onDelta?.(event.delta)` synchronously inside the existing
   `onMessage` handler before appending to the buffer.

3. **`McpServer`** in its SSE branch wires the callback:
   ```js
   const sse = new McpSseTransport({ res, id, logger: this._logger });
   sse.start();
   try {
     const result = await this._toolRegistry.callTool({
       name, args, synaps_user_id,
       onDelta: (text) => sse.delta(text),   // streams every text_delta
     });
     sse.result(id, result);                 // final aggregated reply
   } catch (err) {
     sse.error(id, err);
   }
   ```

4. **Wire-format contract** added to `PHASE_9_SPEC_ADDENDUM.md`:

   ```
   data: {"jsonrpc":"2.0","method":"synaps/delta","params":{"id":"123","text":"To"}}\n\n
   data: {"jsonrpc":"2.0","method":"synaps/delta","params":{"id":"123","text":" be"}}\n\n
   data: {"jsonrpc":"2.0","method":"synaps/delta","params":{"id":"123","text":" or "}}\n\n
   ...
   data: {"jsonrpc":"2.0","id":"123","result":{"content":[{"type":"text","text":"To be or ..."}],"isError":false}}\n\n
   ```

   Reasoning: keeping the final `result` frame as the source of truth
   means non-streaming clients (plain `Accept: application/json`) still
   work; SSE clients can prefer either the aggregated final frame or the
   running deltas. No breaking change vs Phase 8 SSE wire format.

5. **Backward compatibility**: clients that ignore unknown notifications
   degrade gracefully — they receive only the final `result` frame.

### Config

```toml
[mcp.sse]
enabled        = true   # Phase 8
stream_deltas  = false  # Phase 9 — opt-in until clients validated
```

Default `stream_deltas = false` keeps Phase 8 behaviour byte-identical
on upgrade.

### Files

| File | Change |
|---|---|
| `bridge/core/mcp/mcp-sse-transport.js` | Add `delta(text)` helper; new test |
| `bridge/core/mcp/mcp-sse-transport.test.js` | +5 tests |
| `bridge/core/mcp/mcp-tool-registry.js` | Thread `onDelta` through `callTool` → `_invokeChat` → `_invokeChatOnce` |
| `bridge/core/mcp/mcp-tool-registry.test.js` | +4 tests (onDelta invoked, ordering, no-op when omitted, buffer integrity) |
| `bridge/core/mcp/mcp-server.js` | Wire `onDelta` in SSE branch when `stream_deltas = true` |
| `bridge/core/mcp/mcp-server.test.js` | +3 tests |
| `bridge/config.js` | New `[mcp.sse] stream_deltas` knob with validator |
| `bridge/config.test.js` | +2 tests |

### Acceptance tests (live, scripted)

New `/tmp/smoke/sse-deltas-test.mjs` (≈100 lines, Node 22 built-ins):

1. **A — opt-in flag respected**: `stream_deltas = false` → exactly 2
   frames (notify + final result). `stream_deltas = true` → ≥ 2 delta
   frames before the final result.
2. **B — delta concatenation matches final**: collect every `synaps/delta`
   `text` and concatenate; `===` the final `result.content[0].text`.
3. **C — non-SSE client unaffected**: `Accept: application/json` → plain
   JSON-RPC response; no deltas; identical to Phase 8 contract.
4. **D — abort mid-stream**: client aborts after 3rd delta; daemon
   completes the chain (Track 1 ensures next caller is unblocked);
   `/health` still ok.

### Risk & rollback

- **Risk**: a very chatty model could overwhelm the client with thousands
  of single-token frames. Mitigation v1: ship as-is and measure (Track 6
  ships per-token-frame counters); Mitigation v2 (deferred): introduce a
  configurable `delta_min_chars` coalescer.
- **Rollback**: flip `stream_deltas = false` in `bridge.toml`; daemon
  reverts to Phase 8 behaviour. No code revert needed.

---

## Track 3 — OAuth 2.1 Authorization Code flow with PKCE (L)

### Problem statement

Phase 8 ships **Dynamic Client Registration (RFC 7591)** with the
`client_credentials` grant. That covers headless integrations
(scripts, CI, automation). It does **not** cover **user-facing OAuth
flows** where an end-user must consent to a third-party client
(Claude.ai, IDE plugins, etc.) accessing their Synaps workspace.

### Goal

Implement OAuth 2.1 Authorization Code flow with PKCE (RFC 7636) for
MCP token issuance, fully self-contained inside the bridge daemon. End
state: a third-party MCP client redirects the user to
`/mcp/v1/authorize` → the user consents → the daemon issues an
authorization code → the client exchanges it at `/mcp/v1/token` for a
bearer token compatible with the existing `MCP-Token` header.

### Design

#### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/mcp/v1/authorize` | Render consent page or redirect to auth-anchor |
| `POST` | `/mcp/v1/authorize` | Handle consent form submission |
| `POST` | `/mcp/v1/token` | Exchange authorization code for bearer token |
| `GET`  | `/.well-known/oauth-authorization-server` | RFC 8414 metadata document |
| `GET`  | `/.well-known/oauth-protected-resource` | RFC 9728 protected-resource metadata |

#### Authorization Code lifecycle

New Mongoose model `synaps_oauth_codes`:

```js
{
  code:                String,   // 32-byte random, base64url
  client_id:           String,
  synaps_user_id:      String,
  institution_id:      String,
  redirect_uri:        String,
  code_challenge:      String,   // PKCE
  code_challenge_method: 'S256',
  scope:               String,
  expires_at:          Date,     // 10-minute TTL
  redeemed_at:         Date,     // null until /token
  created_at:          Date,
}
```

TTL index: `{ expires_at: 1 }` with `expireAfterSeconds: 0`.
Unique index on `code` (partial: only where `redeemed_at: null`).

#### Consent UX

Phase 9 v0: **server-rendered HTML** (no SPA, no React). One file
template:

```
bridge/core/mcp/oauth/consent.html
```

Form posts back to `/mcp/v1/authorize` with the user's session cookie
(reused from the web dashboard cookie — same `priadb` `session` collection).
**Identity binding** uses the existing `IdentityRouter` —
unauthenticated visits redirect to the web dashboard's `/agents/login`
with a `next=` parameter.

This keeps Track 3 dependency-free; a richer React consent page can ship
in Phase 10 once Track 3's protocol surface is locked.

#### PKCE verification

`code_verifier` submitted at `/token` must satisfy
`base64url(sha256(code_verifier)) === code_challenge` (constant-time
compare). `code_challenge_method` other than `S256` is rejected at
`/authorize` with `unsupported_challenge_method`.

#### Token issuance

Reuses `McpTokenRepo.create()` (same path as DCR). The same audit hooks
fire. `token_name` is the OAuth `client_name` from the registered client.

### Module layout

```
bridge/core/mcp/oauth/
├── oauth-server.js              # http handler dispatch
├── oauth-authorize-handler.js   # GET + POST /authorize
├── oauth-token-handler.js       # POST /token
├── oauth-metadata-handler.js    # /.well-known/*
├── oauth-code-repo.js           # Mongoose model wrapper
├── oauth-pkce.js                # PKCE verification utility
├── consent.html                 # server-rendered template
└── *.test.js                    # one test file per handler
```

### Config

```toml
[mcp.oauth]
enabled              = false               # opt-in
issuer               = "http://localhost:18080"
authorize_path       = "/mcp/v1/authorize"
token_path           = "/mcp/v1/token"
code_ttl_seconds     = 600
allowed_redirect_uri_prefixes = ["http://localhost:", "https://"]
require_pkce         = true                # MUST stay true
```

### Files

| File | Lines | Tests |
|---|---|---|
| `bridge/core/mcp/oauth/oauth-server.js` | ~180 | 8 |
| `bridge/core/mcp/oauth/oauth-authorize-handler.js` | ~220 | 14 |
| `bridge/core/mcp/oauth/oauth-token-handler.js` | ~160 | 12 |
| `bridge/core/mcp/oauth/oauth-metadata-handler.js` | ~70 | 4 |
| `bridge/core/mcp/oauth/oauth-code-repo.js` | ~90 | 8 |
| `bridge/core/mcp/oauth/oauth-pkce.js` | ~40 | 6 |
| `bridge/core/mcp/oauth/consent.html` | ~80 | — |
| `bridge/core/db/models/synaps-oauth-code.js` | ~50 | 3 |
| `bridge/core/scp-http-server.js` (wire) | +60 | +4 |
| `bridge/config.js` (`[mcp.oauth]`) | +30 | +4 |
| **TOTAL** | **~980** | **63** |

### Acceptance tests (live, scripted)

New `/tmp/smoke/oauth-test.mjs`:

1. **A — metadata discovery**: `GET
   /.well-known/oauth-authorization-server` returns RFC 8414 fields with
   matching paths.
2. **B — authorize redirect when unauthenticated**: `GET
   /mcp/v1/authorize?...` with no session cookie → 302 to
   `/agents/login?next=...`.
3. **C — authorize happy path**: with valid session cookie + matching
   redirect_uri prefix → consent HTML returned (200, `text/html`).
4. **D — consent POST → code**: form post with consent → 302 to
   `redirect_uri?code=<...>&state=<...>`.
5. **E — token exchange**: POST `/mcp/v1/token` with `grant_type=authorization_code`,
   `code`, `code_verifier`, `client_id`, `redirect_uri` → 200 with
   `access_token`, `token_type:"bearer"`, `expires_in`.
6. **F — PKCE failure**: wrong `code_verifier` → 400 `invalid_grant`.
7. **G — code reuse rejected**: replay the same code → 400 `invalid_grant`.
8. **H — code expiry**: wait 11 minutes (or fast-forward clock via test
   hook) → 400 `invalid_grant`.
9. **I — issued token authorises**: `Authorization: Bearer <access_token>`
   on `POST /mcp/v1` `tools/list` → 200 with tool list (token usable
   identically to a manually-issued one).

### Risk & rollback

- **Risk**: consent page is a server-rendered HTML form; XSS or CSRF
  bugs are real. Mitigation: HTML uses no user-supplied content in
  `innerHTML` paths (`textContent` only via template-replace); CSRF
  token bound to session cookie and validated on POST; `Content-Security-Policy:
  default-src 'self'` header on the consent response.
- **Risk**: redirect-URI open-redirect. Mitigation: strict prefix
  allow-list in `[mcp.oauth].allowed_redirect_uri_prefixes`; localhost
  prefix is acceptable in v0 because dev clients run on localhost.
- **Rollback**: flip `[mcp.oauth] enabled = false`; routes return 404.
  No data left behind (codes TTL out within 10 minutes).

---

## Track 4 — Per-tool ACL resolver (M)

### Problem statement

Phase 7 wired `McpApprovalGate` against the existing pria `mcpservers`
collection. Approval today is **all-or-nothing per MCP server policy**:
`tool_configuration.enabled` toggles all tools at once;
`allowed_tools` is honoured but lives outside the bridge's normal write
path. There is no separate, per-tool, per-token ACL.

### Goal

Add a layered ACL resolver that runs **after** the `mcpservers` approval
gate and **before** dispatch:

```
request → auth → rate-limit → approval-gate → ACL → dispatch
```

ACLs are keyed on `(synaps_user_id, tool_name)` and can be `allow`,
`deny`, or unset (fall back to the approval gate's decision).

### Design

New Mongoose model `synaps_mcp_tool_acls`:

```js
{
  synaps_user_id: String,         // required
  tool_name:      String,         // required; '*' = all tools
  policy:         'allow' | 'deny',
  reason:         String,         // free-form audit note
  created_at:     Date,
  expires_at:     Date,           // optional TTL
}
```

Compound unique index: `{ synaps_user_id: 1, tool_name: 1 }`.
TTL index on `expires_at` (sparse).

### Resolver

```js
// bridge/core/mcp/mcp-tool-acl-resolver.js
export class McpToolAclResolver {
  constructor({ repo, logger, clock = Date.now } = {}) { … }
  /**
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  async check({ synaps_user_id, tool_name }) {
    // 1. Exact (user, tool) wins
    // 2. (user, '*') wildcard wins
    // 3. Fall through to upstream (allowed:true)
  }
}
```

The resolver is **deny-list-first**: an explicit `deny` for `(user, *)`
trumps an `allow` for `(user, tool)` (security default).

### Wiring

`McpServer.handle()` adds one step between approval-gate and dispatch:

```js
const aclDecision = await this._aclResolver?.check({ synaps_user_id, tool_name });
if (aclDecision && !aclDecision.allowed) {
  return errResponse(id, MCP_ERROR_CODES.METHOD_NOT_FOUND, // align with Phase 7 deny
    `Tool denied by ACL: ${aclDecision.reason ?? 'no reason'}`);
}
```

Audit logs (`synaps_mcp_audit`) gain an `acl_outcome` field when present.

### Config

```toml
[mcp.acl]
enabled = false   # opt-in
```

When `enabled = false`, the resolver is not instantiated — zero overhead.

### Files

| File | Lines | Tests |
|---|---|---|
| `bridge/core/mcp/mcp-tool-acl-resolver.js` | ~140 | 12 |
| `bridge/core/db/models/synaps-mcp-tool-acl.js` | ~40 | 3 |
| `bridge/core/db/repositories/mcp-tool-acl-repo.js` | ~100 | 10 |
| `bridge/core/mcp/mcp-server.js` (wire) | +25 | +4 |
| `bridge/control-socket.js` (3 new ops) | +90 | +9 |
| `bridge/config.js` (`[mcp.acl]`) | +20 | +2 |
| **TOTAL** | **~415** | **40** |

### New ControlSocket ops

| Op | Args | Effect |
|---|---|---|
| `mcp_acl_list` | `{ synaps_user_id? }` | List ACLs for a user (or all) |
| `mcp_acl_set` | `{ synaps_user_id, tool_name, policy, reason?, expires_at? }` | Upsert ACL |
| `mcp_acl_delete` | `{ synaps_user_id, tool_name }` | Remove ACL |

### Acceptance tests (live, scripted)

`/tmp/smoke/acl-test.mjs`:

1. **A — default allow**: with `[mcp.acl] enabled = false`, call any tool
   → succeeds (Phase 8 baseline).
2. **B — enabled with no rules**: `enabled = true`, no rows → all tools
   succeed (resolver returns `allowed:true` on miss).
3. **C — explicit deny**: ControlSocket `mcp_acl_set` `(user, web_fetch,
   deny, "test")` → next `tools/call web_fetch` returns
   `-32601` with reason in `data.message`.
4. **D — explicit allow + wildcard deny**: `(user, *, deny)` + `(user,
   synaps_chat, allow)` → `synaps_chat` denied (security default).
5. **E — wildcard allow + specific deny**: `(user, *, allow)` + `(user,
   web_fetch, deny)` → `web_fetch` denied; `synaps_chat` allowed.
6. **F — TTL expiry**: insert ACL with `expires_at = now()-1s` → 
   subsequent call falls through (TTL pruned).
7. **G — audit logging**: every denial writes a row with `outcome: 'denied'`,
   `acl_outcome: 'deny'`, `tool_name`, `reason`.

### Risk & rollback

- **Risk**: ACL repository round-trip on every request adds latency.
  Mitigation: in-memory LRU cache keyed on `(user, tool)`, invalidated
  via ControlSocket op (`mcp_acl_set` publishes an invalidation event).
  Cache TTL 60s as safety net.
- **Rollback**: `[mcp.acl] enabled = false`; resolver disengages.

---

## Track 5 — `rpcFactory` stub → real spawn (S)

### Problem statement

Phase 8 daemon wires `rpcFactory` to use a safe stub (plain `SynapsRpc`
on host via `[rpc] host_mode = true`) because the production
`DockerExecSynapsRpc` path depends on `tools_list` being supported by
the `synaps` CLI binary, which only lands once **SynapsCLI PR #44
(`feat/watcher-bridge-heartbeat`)** merges into `dev` and a new
SynapsCLI release ships.

### Goal

Once SynapsCLI v0.1.7 (or later) is installed and
`synaps tools_list` returns a valid JSON tool descriptor list, promote
the daemon to use `DockerExecSynapsRpc` in production by default while
keeping `host_mode` as a documented dev knob.

### Design

The branch has already been built (`bridge/index.js`):

```js
const useDockerWorkspace = isScp && !config.rpc.host_mode;
const rpcFactory = useDockerWorkspace
  ? ({sessionId, model}) => new DockerExecSynapsRpc({ workspaceManager, … })
  : ({sessionId, model}) => new SynapsRpc({ … });
```

Phase 9 changes:

1. **Probe at boot**: on daemon start, when `useDockerWorkspace === true`,
   spawn `synaps tools_list --json` once and verify a non-empty array is
   returned. On failure, log a clear error and fall back to host mode
   with a one-line warning (configurable: `[rpc] strict = true` makes
   the probe failure fatal).
2. **Update spec**: `PHASE_9_SPEC_ADDENDUM.md` documents the probe and
   how `host_mode` interacts with `strict`.
3. **Smoke playbook update**: production smoke must include the Docker
   exec path; dev smoke can keep `host_mode = true`.

### Config

```toml
[rpc]
binary    = "synaps"
host_mode = false   # production default flips back to false
strict    = false   # if true: probe failure aborts daemon start
```

### Files

| File | Change |
|---|---|
| `bridge/index.js` | Add probe step after rpcFactory chooser; honour `strict` |
| `bridge/index.test.js` | +3 tests (probe success, probe failure non-strict, probe failure strict) |
| `bridge/config.js` | Add `[rpc] strict` boolean |
| `bridge/config.test.js` | +2 tests |
| `synaps-bridge-plugin/docs/plans/PHASE_9_SPEC_ADDENDUM.md` | Probe section |

### Acceptance

- SynapsCLI PR #44 merged to `dev`; v0.1.7 tagged from `dev`; installed
  to `~/.cargo/bin/synaps`.
- Smoke daemon started **without** `host_mode = true` → `tools/list`
  returns the real registry from the workspace.
- `synaps_chat` round-trip via the Docker exec path returns a real reply.

### Risk & rollback

- **Risk**: workspace image is missing or `synaps tools_list` is broken
  → daemon may refuse to start. Mitigation: `strict = false` default
  falls back to host mode with a loud warning.
- **Rollback**: `host_mode = true` in bridge.toml; one-line revert.

### Sequencing constraint

Track 5 is **C-wave only** and gated by SynapsCLI PR #44 + release.
If PR #44 hasn't merged when Phase 9 Waves A+B land, Track 5 is split
out into a follow-up commit on the same Phase 9 branch.

---

## Track 6 — Observability metrics (S)

### Problem statement

Phase 8 ships an `/health` endpoint with bridge heartbeat. It does
**not** expose per-token, per-tool, per-session metrics needed to debug
production issues (slow tools, runaway clients, rate-limit hot spots).

### Goal

Expose a Prometheus-compatible text endpoint at `/metrics` (gated by
`[metrics] enabled = true`) carrying:

- `synaps_mcp_requests_total{outcome,tool}`
- `synaps_mcp_request_duration_seconds_bucket{tool,le}`
- `synaps_mcp_rate_limit_blocked_total{dimension}`
- `synaps_mcp_session_queue_depth{user}` (gauge — depends on Track 1)
- `synaps_mcp_sse_delta_frames_total` (counter — depends on Track 2)
- `synaps_mcp_acl_denials_total{tool}` (counter — depends on Track 4)
- `synaps_mongoose_connection_state` (gauge — `1` if connected)
- `synaps_bridge_heartbeat_age_seconds` (gauge)

### Design

No Prometheus library — emit the text format by hand from a tiny
`MetricsRegistry`:

```js
// bridge/core/metrics/metrics-registry.js
export class MetricsRegistry {
  counter(name, labels) { … }
  histogram(name, labels) { … }
  gauge(name, labels) { … }
  render() { /* returns Prometheus text exposition format */ }
}
```

`MetricsRegistry` is injected into every component that records metrics.
Pure stateless aggregation; no I/O.

`/metrics` endpoint is added to `ScpHttpServer` — simple text response.

### Config

```toml
[metrics]
enabled = false       # opt-in
path    = "/metrics"
bind    = "127.0.0.1" # bind only to loopback by default
```

### Files

| File | Lines | Tests |
|---|---|---|
| `bridge/core/metrics/metrics-registry.js` | ~180 | 14 |
| `bridge/core/metrics/metrics-registry.test.js` | (above) | |
| `bridge/core/scp-http-server.js` (wire) | +35 | +3 |
| `bridge/core/mcp/mcp-server.js` (record) | +20 | +2 |
| `bridge/core/mcp/mcp-rate-limiter.js` (record) | +10 | +1 |
| `bridge/core/mcp/mcp-tool-registry.js` (record + queue depth) | +15 | +2 |
| `bridge/core/mcp/mcp-sse-transport.js` (record delta count) | +5 | +1 |
| `bridge/core/mcp/mcp-tool-acl-resolver.js` (record) | +5 | +1 |
| `bridge/config.js` (`[metrics]`) | +15 | +2 |
| **TOTAL** | **~285** | **26** |

### Acceptance tests (live)

`/tmp/smoke/metrics-test.mjs`:

1. **A — endpoint disabled by default**: with `[metrics] enabled = false`,
   `GET /metrics` → 404.
2. **B — counter increments**: enable; fire 3 `tools/call synaps_chat`;
   `synaps_mcp_requests_total{outcome="ok",tool="synaps_chat"}` ≥ 3.
3. **C — histogram populated**: at least one request must populate a
   non-zero bucket in `synaps_mcp_request_duration_seconds_bucket`.
4. **D — rate-limit dimension**: trigger a 429 burst (reuse Phase 8
   ratelimit-test); `synaps_mcp_rate_limit_blocked_total{dimension="per_token"} ≥ 1`.
5. **E — heartbeat age tracks**: `synaps_bridge_heartbeat_age_seconds < 10`
   while daemon healthy.

### Risk & rollback

- **Risk**: unbounded label cardinality (per-token labels) blows up
  memory. Mitigation: per-token metrics are explicitly disabled by
  default; only per-tool / per-outcome cardinality ships in v0.
- **Rollback**: `[metrics] enabled = false`.

---

## Wave plan

### Wave A — Foundations (parallel, 4 subagents)

| ID | Track | Output | Tests |
|---|---|---|---|
| A1 | T1 | `_runSerialized` in `McpToolRegistry`; tests | +6 |
| A2 | T2 | `McpSseTransport.delta` + `onDelta` thread-through in registry; tests | +9 |
| A3 | T4 | `McpToolAclResolver` + model + repo; tests | +25 |
| A4 | T6 | `MetricsRegistry` module + tests | +14 |

Wave A produces **all new modules in isolation** — no daemon wiring
yet. Each subagent owns one branch of `bridge/core/mcp/...` so
parallelism is safe.

**Expected duration:** ≈25 min wall.
**Expected merge:** clean — no overlapping files.

### Wave B — Wiring (parallel after A, 4 subagents)

| ID | Tracks | Output | Tests |
|---|---|---|---|
| B1 | T2 + T6 | Wire `onDelta` + delta-frame counter into `McpServer` SSE branch | +6 |
| B2 | T4 + T6 | Wire ACL resolver + denial counter into `McpServer` post-approval-gate | +8 |
| B3 | T4 | 3 ControlSocket ops (`mcp_acl_list/set/delete`) | +9 |
| B4 | T1 + T6 | Wire `_runSerialized` into `_invokeChat` + queue-depth gauge | +4 |

**Expected duration:** ≈25 min wall.

### Wave C — Integration + sequential (1 subagent serial)

| ID | Track | Output | Tests |
|---|---|---|---|
| C1 | T3 | OAuth 2.1 module — all 7 files | +51 |
| C2 | T3 | Wire OAuth into `ScpHttpServer` + config + smoke | +14 |
| C3 | T5 | `rpcFactory` probe + strict-mode + config | +5 |
| C4 | all | Acceptance tests (4 files) + smoke playbook + `PHASE_9_SPEC_ADDENDUM.md` | +27 |
| C5 | all | README / final docs sweep | — |

OAuth is sequenced serially because every OAuth file references the
same handler dispatch — splitting would create merge churn.

**Expected duration:** ≈90 min wall (largest).

### Total estimate

| Metric | Value |
|---|---|
| Files changed/created | ≈45 |
| Net LoC added (excl. tests) | ≈2,400 |
| New tests | ≈250 |
| Wave A duration | ≈25 min |
| Wave B duration | ≈25 min |
| Wave C duration | ≈90 min |
| **Total wall (with parallelism)** | **≈2 h 30 min** |

---

## Acceptance criteria — Phase 9

A Phase 9 PR is mergeable when **all** of the following hold:

1. **Per-file targeted vitest** passes for every file in
   `bridge/core/mcp/**`, `bridge/core/metrics/**`,
   `bridge/core/db/models/**`, `bridge/core/db/repositories/**`,
   `bridge/core/scp-http-server.{js,test.js}`,
   `bridge/control-socket.{js,test.js}`, `bridge/config.{js,test.js}`,
   `bridge/index.{js,test.js}`.
2. **No regression** in any test file touched by Phase 7 or Phase 8.
3. **Live smoke playbook** (`/tmp/smoke/phase-9-playbook.sh`) runs end
   to end on a fresh daemon and yields **≥ 95 % PASS** across all
   sub-items (5 / 5 if Track 3 is fully wired and SynapsCLI v0.1.7 is
   installed; 4 / 5 acceptable if Track 5's Docker path is deferred to
   a follow-up commit).
4. **All new config knobs default OFF** (additive feature flags).
5. **`platform.mode = "bridge"` daemon boots and serves Slack traffic
   unchanged** (anti-regression smoke).
6. **`PHASE_9_SPEC_ADDENDUM.md`** is committed alongside code.
7. **Phase 8 live smoke #19** flips from PARTIAL → PASS after Track 1.
8. **No new top-level deps** in `package.json`.

---

## Smoke playbook outline

A single shell script `/tmp/smoke/phase-9-playbook.sh` runs the six new
suite files in order on a fresh daemon. **All scripts** use Node 22
built-ins only.

```
0. Health check        — /health 200 OK
1. Track 1 — concurrent-test.mjs               (5 ALL PASS now)
2. Track 2 — sse-deltas-test.mjs               (4 sub-tests)
3. Track 3 — oauth-test.mjs                    (9 sub-tests)
4. Track 4 — acl-test.mjs                      (7 sub-tests)
5. Track 5 — manual: install SynapsCLI v0.1.7, flip host_mode=false,
   re-run tools/list, expect real registry
6. Track 6 — metrics-test.mjs                  (5 sub-tests)
99. Anti-regression    — Phase 8 full smoke pack (19 items)
```

Each step writes to `/tmp/smoke/phase-9-results/<n>-<name>.out`;
the playbook prints a final tally.

---

## Open questions (to be resolved before Wave A starts)

1. **Q1 — Track 3 consent UX**: server-rendered HTML in v0, or punt to
   Phase 10 with a React consent page mounted under `/agents/consent`
   in pria-ui-v22?
   - **Default if no decision**: server-rendered HTML in this repo (no
     pria-ui-v22 dependency).

2. **Q2 — Track 4 conflict semantics**: should an explicit `allow` for
   `(user, tool)` override a `deny` for `(user, *)`? RFC-style allow
   would say yes; security default says no.
   - **Default if no decision**: deny wins (most-restrictive policy).

3. **Q3 — Track 5 strict-mode default**: should production daemons fail
   to start if `tools_list` probe fails, or fall back to host mode?
   - **Default if no decision**: fall back with WARN log; operators
     who want strict semantics opt into `strict = true`.

4. **Q4 — Track 6 cardinality limits**: cap labels at N distinct values
   per dimension, or trust operator configuration?
   - **Default if no decision**: explicit allow-list of label dimensions
     in v0 (no per-token labels by default).

5. **Q5 — Phase 9 PR target**: stack on PR #40 (current Phase 8 tip,
   unmerged) or rebase on `main` after the Phase 1–8 cascade merges?
   - **Default if no decision**: stack on PR #40, rebase later if the
     cascade is still un-merged when Phase 9 finishes.

---

## Dependencies on other repos

- **SynapsCLI PR #44** (`feat/watcher-bridge-heartbeat` → `dev`)
  must merge **and** v0.1.7 must be released **before Track 5 lands in
  production**. If unmerged, Track 5 is split into a follow-up commit
  on the same Phase 9 branch.
- **pria-ui-v22**: no new MR required unless Q1 picks the React consent
  page route.
- **axel-memory-manager**: unchanged.
- **Infisical / Tetragon / KasmVNC**: unchanged.

---

## Stretch goals (NOT in Phase 9 scope — backlog for Phase 10)

- React consent page under `/agents/consent` (pria-ui-v22 MR).
- Per-tool rate limits (currently only per-token and per-IP).
- WebSocket transport (in addition to HTTP/SSE).
- `synaps_chat` tool-call cancellation API (`tools/cancel`).
- Per-token metrics labels (gated by a separate strict allow-list).
- Tenant-isolated metrics endpoints (institution-scoped `/metrics`).

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OAuth consent page XSS/CSRF | M | H | Template-only output, CSRF token bound to session, strict CSP |
| Open redirect via OAuth `redirect_uri` | M | H | Strict prefix allow-list in config |
| Per-session queue deadlock | L | H | `prev.catch(() => {})` chain — rejection never blocks |
| SSE delta overflow on chatty model | L | M | Track 6 counter → operator visibility; future coalescer |
| ACL repo latency on every call | M | M | LRU cache with invalidation on `mcp_acl_set` |
| Metrics label cardinality blow-up | M | M | Per-token labels off by default; explicit allow-list |
| Track 5 daemon refuses to start | L | H | `strict = false` default; loud warning fallback |
| SynapsCLI v0.1.7 not yet released | M | M | Track 5 splits into follow-up commit |

---

## Sign-off

This plan covers six independent tracks totalling ≈2,400 LoC and ≈250
new tests, organised into three waves with maximum parallelism in Waves
A and B and serial OAuth work in Wave C. Every track is additive,
feature-flagged, and rollback-safe. Phase 9 closes the loop on every
known gap from Phase 8 smoke (#19) and the documented Phase 8 spec
addendum stretch goals, plus introduces production-grade observability
and ACLs.

**Ready for implementation pending sign-off on Q1–Q5.**
