# Phase 9 — Live E2E Smoke Report

**Date**: _to be filled in by operator_
**Branch**: `feat/scp-phase-9-polish`
**Daemon SHA**: _`git rev-parse HEAD` output at time of run_
**Daemon config**: `~/.synaps-cli/bridge/bridge.toml` _(path or copy location)_
**Smoke scripts**: `/tmp/smoke/phase-9-playbook.sh`
**Endpoint**: `http://127.0.0.1:18080/mcp/v1`
**Verifier**: _operator name_

---

## TL;DR

- **/ items full PASS**.
- **/ items partial or FAIL**.
- **Daemon stability**: _(fill in: zero/N unhandledRejection, rpc subprocess restarts, write-after-end errors)_

---

## 0-health — Daemon pre-flight

| Check | Result | Detail |
|---|---|---|
| `GET /health` → 200 `status:ok` | - [ ] | |
| `bridge.healthy === true` | - [ ] | |
| `bridge.ageMs < 10 000` | - [ ] | |

---

## Track 1 — Per-session Prompt Serialisation (`concurrent-v2-test.mjs`)

**Script**: `/tmp/smoke/concurrent-v2-test.mjs`
**Config required**: standard Phase 9 daemon (Track 1 always active).

### Sub-test A — 5 concurrent identity prompts on Token A

| Assertion | Result | Detail |
|---|---|---|
| A: HTTP 200 id=1 | - [ ] | |
| A: no Internal error id=1 | - [ ] | |
| A: uuid echoed id=1 | - [ ] | |
| A: HTTP 200 id=2 | - [ ] | |
| A: no Internal error id=2 | - [ ] | |
| A: uuid echoed id=2 | - [ ] | |
| A: HTTP 200 id=3 | - [ ] | |
| A: no Internal error id=3 | - [ ] | |
| A: uuid echoed id=3 | - [ ] | |
| A: HTTP 200 id=4 | - [ ] | |
| A: no Internal error id=4 | - [ ] | |
| A: uuid echoed id=4 | - [ ] | |
| A: HTTP 200 id=5 | - [ ] | |
| A: no Internal error id=5 | - [ ] | |
| A: uuid echoed id=5 | - [ ] | |

### Sub-test B — Response id round-trip

| Assertion | Result | Detail |
|---|---|---|
| B: id round-trip id=1 | - [ ] | |
| B: id round-trip id=2 | - [ ] | |
| B: id round-trip id=3 | - [ ] | |
| B: id round-trip id=4 | - [ ] | |
| B: id round-trip id=5 | - [ ] | |

### Sub-test C — /health after burst

| Assertion | Result | Detail |
|---|---|---|
| C: /health HTTP 200 | - [ ] | |
| C: status === "ok" | - [ ] | |
| C: bridge.healthy === true | - [ ] | |
| C: bridge.ageMs < 15 000 | - [ ] | |

### Sub-test D — 10 sequential calls (no-leak proof)

| Assertion | Result | Detail |
|---|---|---|
| D: all 10 sequential calls succeed | - [ ] | _N/10 ok_ |

### Sub-test E — Cross-user parallelism (2×A + 2×C)

| Assertion | Result | Detail |
|---|---|---|
| E: Token-A call 0 succeeds | - [ ] | |
| E: Token-A call 1 succeeds | - [ ] | |
| E: Token-C call 0 succeeds | - [ ] | |
| E: Token-C call 1 succeeds | - [ ] | |
| E: wall time < 2× single-call latency | - [ ] | _wall=___ ms  2×single=___ ms_ |

---

## Track 2 — SSE Per-Delta Token Streaming (`sse-deltas-test.mjs`)

**Script**: `/tmp/smoke/sse-deltas-test.mjs`
**Config required**: `[mcp.sse] enabled=true`. Sub-test B additionally requires `stream_deltas=true`.

### Sub-test A — stream_deltas=false (Phase 8 baseline)

| Assertion | Result | Detail |
|---|---|---|
| A: HTTP 200 | - [ ] | |
| A: Content-Type text/event-stream | - [ ] | |
| A: exactly 2 data frames | - [ ] | |
| A: synaps/result notify present | - [ ] | |
| A: final result frame present | - [ ] | |
| A: NO synaps/delta frames | - [ ] | |

### Sub-test B — stream_deltas=true; delta concat == final text

| Assertion | Result | Detail |
|---|---|---|
| B: HTTP 200 | - [ ] | |
| B: Content-Type text/event-stream | - [ ] | |
| B: ≥2 synaps/delta frames | - [ ] | _N frames_ |
| B: final result frame present | - [ ] | |
| B: delta concat === final text | - [ ] | |

### Sub-test C — non-SSE client unaffected

| Assertion | Result | Detail |
|---|---|---|
| C: HTTP 200 | - [ ] | |
| C: Content-Type application/json | - [ ] | |
| C: jsonrpc 2.0 | - [ ] | |
| C: id echoed as 42 | - [ ] | |
| C: top-level result present | - [ ] | |
| C: result.content[0].text present | - [ ] | |

### Sub-test D — abort mid-stream; daemon stays healthy

| Assertion | Result | Detail |
|---|---|---|
| D: abort fired (≥3 delta frames seen) | - [ ] | |
| D: follow-up tools/list HTTP 200 | - [ ] | |
| D: tools list non-empty | - [ ] | |
| D: /health ok after abort | - [ ] | |

---

## Track 3 — OAuth 2.1 Authorization Code flow with PKCE (`oauth-test.mjs`)

**Script**: `/tmp/smoke/oauth-test.mjs`
**Config required**: `[mcp.oauth] enabled=true`, `allow_test_auth=true` (dev), `redirect_uri_allow_list` set.

### Sub-test A — oauth-authorization-server metadata

| Assertion | Result | Detail |
|---|---|---|
| A: HTTP 200 | - [ ] | |
| A: field "issuer" present | - [ ] | |
| A: field "authorization_endpoint" present | - [ ] | |
| A: field "token_endpoint" present | - [ ] | |
| A: field "response_types_supported" present | - [ ] | |
| A: field "grant_types_supported" present | - [ ] | |
| A: field "code_challenge_methods_supported" present | - [ ] | |
| A: code_challenge_methods includes S256 | - [ ] | |
| A: authorization_code in grant_types_supported | - [ ] | |

### Sub-test B — GET /mcp/v1/authorize without session → 302

| Assertion | Result | Detail |
|---|---|---|
| B: HTTP 302 | - [ ] | |
| B: redirects to /agents/login | - [ ] | |
| B: ?next= query param present | - [ ] | |

### Sub-test C — GET /mcp/v1/authorize with X-Synaps-Test-Auth → 200 consent HTML

| Assertion | Result | Detail |
|---|---|---|
| C: HTTP 200 | - [ ] | |
| C: Content-Type text/html | - [ ] | |
| C: body contains client_id | - [ ] | |
| C: csrf_token hidden input present | - [ ] | |

### Sub-test D — POST /mcp/v1/authorize consent=allow → 302 + code

| Assertion | Result | Detail |
|---|---|---|
| D: HTTP 302 | - [ ] | |
| D: redirects to redirect_uri | - [ ] | |
| D: code param present | - [ ] | |
| D: code is ≥32 chars | - [ ] | |
| D: state echoed | - [ ] | |

### Sub-test E — POST /mcp/v1/token (happy path)

| Assertion | Result | Detail |
|---|---|---|
| E: HTTP 200 | - [ ] | |
| E: access_token present | - [ ] | |
| E: token_type === "bearer" | - [ ] | |
| E: expires_in is positive number | - [ ] | |

### Sub-test F — wrong code_verifier → 400 invalid_grant

| Assertion | Result | Detail |
|---|---|---|
| F: HTTP 400 | - [ ] | |
| F: error === "invalid_grant" | - [ ] | |

### Sub-test G — code replay → 400 invalid_grant

| Assertion | Result | Detail |
|---|---|---|
| G: HTTP 400 | - [ ] | |
| G: error === "invalid_grant" | - [ ] | |

### Sub-test H — expired code (manual; set SKIP_EXPIRY=0)

| Assertion | Result | Detail |
|---|---|---|
| H: HTTP 400 | - [ ] SKIP / - [ ] | _Run with SKIP_EXPIRY=0 and [mcp.oauth] code_ttl_ms=1_ |
| H: error === "invalid_grant" | - [ ] SKIP / - [ ] | |

### Sub-test I — use access_token for tools/list

| Assertion | Result | Detail |
|---|---|---|
| I: HTTP 200 | - [ ] | |
| I: jsonrpc 2.0 | - [ ] | |
| I: id echoed as 77 | - [ ] | |
| I: tools array non-empty | - [ ] | |
| I: synaps_chat in tools list | - [ ] | |

---

## Track 4 — Per-Tool ACL Resolver (`acl-test.mjs`)

**Script**: `/tmp/smoke/acl-test.mjs`
**Config required**: `[mcp.acl] enabled=true`. Sub-test A requires a separate daemon run with `enabled=false`.

### Sub-test A — ACL disabled; all calls succeed (SKIP_DEFAULT_FLAG=0)

| Assertion | Result | Detail |
|---|---|---|
| A: HTTP 200 | - [ ] SKIP / - [ ] | _Set SKIP_DEFAULT_FLAG=0_ |
| A: no ACL denial | - [ ] SKIP / - [ ] | |

### Sub-test B — ACL enabled, no rows → allow

| Assertion | Result | Detail |
|---|---|---|
| B: aclSet succeeded | - [ ] | |
| B: HTTP 200 | - [ ] | |
| B: no ACL denial | - [ ] | |

### Sub-test C — web_fetch deny → -32601

| Assertion | Result | Detail |
|---|---|---|
| C: aclSet succeeded | - [ ] | |
| C: HTTP 200 (JSON-RPC error in body) | - [ ] | |
| C: error.code -32601 | - [ ] | |
| C: message contains "ACL" | - [ ] | |
| C: synaps_chat still allowed | - [ ] | |

### Sub-test D — wildcard deny + exact allow → deny-wins

| Assertion | Result | Detail |
|---|---|---|
| D: HTTP 200 (JSON-RPC body) | - [ ] | |
| D: synaps_chat denied (deny-wins rule) | - [ ] | _Wildcard deny must win_ |

### Sub-test E — wildcard allow + specific deny

| Assertion | Result | Detail |
|---|---|---|
| E: web_fetch denied | - [ ] | |
| E: synaps_chat allowed | - [ ] | |

### Sub-test F — TTL expiry → falls through (allowed)

| Assertion | Result | Detail |
|---|---|---|
| F: expired ACL not enforced | - [ ] | |

### Sub-test G — Audit log (mongosh or skip)

| Assertion | Result | Detail |
|---|---|---|
| G: acl_outcome "deny" present in recent audit | - [ ] SKIP / - [ ] | _mongosh required_ |
| G: duration_ms present | - [ ] SKIP / - [ ] | |

---

## Track 6 — Prometheus `/metrics` Endpoint (`metrics-test.mjs`)

**Script**: `/tmp/smoke/metrics-test.mjs`
**Config required**: sub-tests B–E require `[metrics] enabled=true`; sub-test A requires `enabled=false`.

### Sub-test A — metrics disabled → 404

| Assertion | Result | Detail |
|---|---|---|
| A: /metrics returns 404 when disabled | - [ ] SKIP / - [ ] | _Re-run with [metrics] enabled=false_ |

### Sub-test B — requests_total counter ≥ 3

| Assertion | Result | Detail |
|---|---|---|
| B: call 1 succeeded | - [ ] | |
| B: call 2 succeeded | - [ ] | |
| B: call 3 succeeded | - [ ] | |
| B: counter ≥ 3 | - [ ] | _value=_ |

### Sub-test C — histogram +Inf bucket ≥ 1

| Assertion | Result | Detail |
|---|---|---|
| C: +Inf bucket ≥ 1 | - [ ] | _value=_ |

### Sub-test D — rate-limit blocked counter ≥ 1

| Assertion | Result | Detail |
|---|---|---|
| D: at least 1 rate-limit 429 in burst | - [ ] | _N × 429_ |
| D: synaps_mcp_rate_limit_blocked_total ≥ 1 | - [ ] | _perToken=_ perIp=_ |

### Sub-test E — heartbeat age gauge < 10 s

| Assertion | Result | Detail |
|---|---|---|
| E: heartbeat gauge present | - [ ] | |
| E: heartbeat age < 10 s | - [ ] | _value=_ |

---

## Integration Bugs Found & Fixed (Live)

_Fill in during the smoke run — one row per bug found and patched._

| # | File | Bug | Fix |
|---|---|---|---|
| — | — | — | — |

---

## Test Verification (Per-File, Targeted)

_Fill in with per-file vitest results after any live patches._

```
(run after each fix: npx vitest --run <path/to/changed.test.js>)
```

| File | Tests | Result |
|---|---|---|
| | | |

---

## Tally

| Track | Script | Sub-tests | PASS | FAIL | SKIP | Overall |
|---|---|---|---|---|---|---|
| pre-flight | health | 3 | | | | |
| 1 | concurrent-v2-test.mjs | 25 | | | | |
| 2 | sse-deltas-test.mjs | 16 | | | | |
| 3 | oauth-test.mjs | 31 | | | | |
| 4 | acl-test.mjs | 14 | | | | |
| 6 | metrics-test.mjs | 9 | | | | |
| **TOTAL** | | **98** | | | | |

---

## Artifacts

| Path | Purpose |
|---|---|
| `/tmp/smoke/phase-9-playbook.sh` | Top-level playbook driver |
| `/tmp/smoke/concurrent-v2-test.mjs` | Track 1 regression script |
| `/tmp/smoke/sse-deltas-test.mjs` | Track 2 SSE delta script |
| `/tmp/smoke/oauth-test.mjs` | Track 3 OAuth 2.1 script |
| `/tmp/smoke/acl-test.mjs` | Track 4 ACL script |
| `/tmp/smoke/metrics-test.mjs` | Track 6 metrics script |
| `/tmp/smoke/phase-9-results/` | Per-step output logs (created by playbook) |
| `~/.synaps-cli/bridge/bridge.toml` | Smoke daemon config |
| `~/.synaps-cli/bridge/bridge.log` | Live daemon log during smoke run |

---

## Sign-Off

_To be completed by the operator after the smoke run._

Phase 9 shippable: **YES / NO** _(circle one)_

Notes:
_________________________________________________________________________________
_________________________________________________________________________________
