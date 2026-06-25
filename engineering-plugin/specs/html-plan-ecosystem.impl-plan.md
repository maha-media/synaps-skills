# Implementation Plan: HTML Plan Ecosystem

**Derived from:** `engineering-plugin/specs/html-plan-ecosystem.md`
**Schema:** `engplan/1`
**Status:** Planning (read-only; no source code written yet)
**Plan owner:** engineering plugin

> This is a planning document only. It contains **no source code**. It decomposes
> the spec into dependency-ordered, individually verifiable tasks grouped by the
> spec's phases (P0–P4), with checkpoints, a test-layer mapping, a
> security-hardening task set, and a Definition-of-Done cross-check.

---

## Assumptions

These are working assumptions made to produce a concrete plan. Each is flagged so
it can be confirmed or corrected before code begins.

1. **Runtime/language (spec open decision #4 & #7):** the plans-server extension
   is implemented in **Node.js** using only the standard library (`http`, `fs`,
   `path`, `url`, `crypto`) so there is **no network install** and no build step.
   No `npm install` of third-party packages. (If the team prefers a self-contained
   Rust/Go binary or Python, the task structure stays the same; only the
   language-specific files in §11 change. See open decisions below.)
2. **Renderer language:** `plan.js` is **dependency-light vanilla JavaScript**
   (no TypeScript build step, no bundler, no CDN), per spec §12. Type discipline
   is enforced via runtime boundary parsing, not a compiler.
3. **Markdown rendering:** a **small, vendored/local** markdown-to-HTML routine
   (or a tiny pinned local lib copied into `assets/`) is used; sanitization is
   applied unconditionally regardless of source. No CDN, no runtime fetch.
4. **Server topology (decision #1, #5, #6):** server-backbone primary + static
   `file://` fallback; **SSE** for live transport; **one server per repo**, bound
   to `127.0.0.1` on a random ephemeral port.
5. **Persistence (decision #2):** `.plans/` is **committed by default**; notes
   live in `<slug>.notes.json` and events in `<slug>.events.json` (split file as
   the spec's "optional split" — we adopt the split for clarity). Opt-out is a
   later settings concern, out of scope for v1 unless trivial.
6. **Synaps extension contract:** the extension is a long-running JSON-RPC over
   stdio process that receives `${PLUGIN_DIR}` in its environment and is started
   on session start, as described in spec §4.1. The exact JSON-RPC method names
   for `/plan` commands follow existing plugin conventions; where unknown, we
   define a minimal internal contract and document it.
7. **Test runner:** tests use Node's built-in test runner (`node --test`) plus a
   headless DOM harness (`jsdom`, vendored/local or a hand-rolled minimal DOM
   shim) for renderer tests, to keep the "no network install" constraint. If a
   DOM lib cannot be vendored, renderer tests use a thin DOM stub.
8. **Browser launch:** "open browser" uses an OS-appropriate opener
   (`xdg-open`/`open`/`start`); failure to open is non-fatal (prints the URL).
9. **Single repo target:** the plugin repo itself (`engineering-plugin/`) is the
   working repo; `.plans/` may be created at repo root during integration tests in
   a temp fixture, not committed from tests.
10. **One vertical slice per phase minimum:** each phase delivers an
    end-to-end-usable increment, per spec §16.

---

## Spec ambiguities / open decisions (blocking or planning-relevant)

| # | Ambiguity / open decision | Impact | Planning resolution |
|---|---|---|---|
| A | **Extension language/runtime** (spec §15 #4, #7 — "Open") | Determines all `extensions/` files & test harness | Assumed Node.js stdlib-only (Assumption 1). **Confirm before P1.** Task P1-0 is a spike/decision gate. |
| B | **Server location**: inside `engineering` vs sibling `plan-viewer` plugin (spec §15 #4) | Affects `plugin.json`, slug/worktree coupling | Assumed **inside `engineering`** for tight slug integration. Confirm at P1 checkpoint. |
| C | **Notes vs events file split** (spec §5.4 says events file "optional split") | Minor schema/IO branching | Adopt the split (`*.notes.json` + `*.events.json`). Reconcile reads events file. |
| D | **Token enforcement scope** — is the session token mandatory or optional? (spec §6 "optionally gated") | Security posture | Plan implements token as **on-by-default**, with the renderer fetches carrying it. Confirm at security checkpoint. |
| E | **JSON-RPC method surface** for `/plan` commands not fully specified | Command wiring details | Define a minimal internal RPC contract in P1; document in plan artifacts. |
| F | **Markdown lib choice** (vendored vs hand-rolled) (spec §12 "tiny pinned/local lib") | Sanitization surface, footprint | Choose smallest viable; sanitizer is mandatory regardless. Decided in P0-2. |
| G | **Attention counter exact semantics** — which event types map to `blocking` / `unresolved` / `needs_review` (spec §3.8, §6) | Counter correctness | Define mapping table in P3-1 (block→blocking; open comment/request_change/clarify→unresolved; needs-human-review approval→needs_review). Confirm. |
| H | **`do_not_touch` enforcement** — advisory vs hard-enforced by tooling (spec §3.2, §7.2) | Agent behaviour vs server behaviour | Treated as **durable data the agent must honor**; not server-enforced FS lock in v1. |
| I | **Legacy `.md` stable-id strategy** when headings collide (spec §8) | Note drift | Slugify + disambiguate by ordinal suffix; documented as degraded. |
| J | **`/plan migrate`** explicitly deferred (spec §8) | Out of v1 scope | Excluded from this plan; noted as future. |

None of these fully block planning. Items A and B should be confirmed at the P1
gate because they affect file layout; the rest can be resolved within their tasks.

---

## Engineering ground rules (apply to every task)

- **Worktree isolation:** each phase runs in a dedicated worktree
  (`feat/<slug>` per `worktrees-by-default`); `<slug>` is shared across branch,
  worktree, and plan artifacts.
- **Test-first:** write failing tests before implementation, especially for
  security controls (§7) and event lifecycle (§3.3), per `test-driven-development`.
- **Incremental slices:** small vertical slices per `incremental-implementation`.
- **Verification before completion:** no task is "done" without its verification
  commands passing on fresh evidence.
- **Subagent dispatch invariant (spec §9.1):** any subagent dispatch in any phase
  must carry a non-empty `agent` name **or** inline `system_prompt`.
- **Scope sizing:** XS ≈ <1h trivial; S ≈ half-day; M ≈ ~1–2 days. Anything
  larger was split.

---

## Phase P0 — Schema + Renderer (standalone `file://`)

**Goal (spec §16):** `engplan/1` schema + `plan.js`/`plan.css`; self-contained
`file://` artifact with `localStorage` notes. Proves the format and renderer work
standalone.

### P0-0 — Bootstrap repo skeleton & test harness
- **Description:** Create the directory skeleton (`assets/`, `tests/{schema,render,server,security}/`) and a no-network test harness (Node built-in test runner; vendored/stubbed DOM). No feature code.
- **Acceptance criteria:**
  - `tests/` runs with a single command and reports "0 failures" on an empty suite.
  - No third-party packages fetched from the network (lockfile/offline verified).
  - Directory layout matches spec §11 (assets, extensions placeholder, tests subdirs).
- **Verification:** `node --test tests/ ; echo exit=$?` ; `ls assets tests/schema tests/render tests/server tests/security`
- **Dependencies:** None
- **Files likely touched:** `assets/.gitkeep`, `tests/**`, test bootstrap/config, `engineering-plugin/README.md` (dev notes)
- **Scope:** S

### P0-1 — `engplan/1` schema definition & validator (tests first)
- **Description:** Define the `engplan/1` plan-document and section shapes (spec §5.1, §5.2) and a boundary validator/parser (`parseEngPlan`) that validates `schema=="engplan/1"`, required fields, rejects bad section ids, and handles unknown fields per policy.
- **Acceptance criteria:**
  - Valid documents parse into a typed shape; `schema != "engplan/1"` rejected.
  - Required fields enforced: `kind`, `slug`, `title`, `status`, `sections[]`; each section requires `id`, `heading`, `type`.
  - Invalid/empty/duplicate section ids rejected with a clear error.
  - Unknown top-level/section fields handled per documented policy (preserve-and-ignore).
  - Section `type`, `state`, `approval`, `risk` constrained to enums from §5.2.
- **Verification:** `node --test tests/schema/`
- **Dependencies:** P0-0
- **Files likely touched:** `assets/plan.js` (parse boundary) or `assets/engplan.js`, `tests/schema/*.test.js`
- **Scope:** M

### P0-2 — Markdown→HTML sanitizer (tests first)
- **Description:** Vendor/select a tiny local markdown renderer and wrap it with a mandatory sanitizer that strips inline scripts, event handlers, `javascript:` URLs, and disallowed tags (spec §7.3, §13 Renderer row). Decide markdown lib here (ambiguity F).
- **Acceptance criteria:**
  - Known XSS payloads (`<script>`, `<img onerror>`, `javascript:` href, `<svg onload>`) are neutralized in output.
  - Standard markdown (headings, lists, code, links, emphasis) renders correctly.
  - No network/CDN reference in the lib; runs offline.
- **Verification:** `node --test tests/render/sanitize.test.js`
- **Dependencies:** P0-0
- **Files likely touched:** `assets/md.js` (vendored), `assets/sanitize.js`, `tests/render/*`
- **Scope:** M

### P0-3 — Core renderer: render sections from JSON
- **Description:** Implement `renderPlan(appEl, plan)` projecting `engplan/1` data into DOM: section blocks keyed by `section.id`, type-specific rendering (prose/task/risk/gate/criteria/evidence), state/approval/risk badges, acceptance/verification lists (spec §4.3, §12).
- **Acceptance criteria:**
  - Each section renders with a stable `data-section-id` anchor.
  - `type:"task"` shows `state` badge; `risk`/`approval` badges shown when set.
  - `acceptance[]` and `verification[]` render as lists.
  - Renderer reads embedded `#plan` JSON via the P0-1 parser; bad data shows a safe error, not a crash.
- **Verification:** `node --test tests/render/render.test.js`
- **Dependencies:** P0-1, P0-2
- **Files likely touched:** `assets/plan.js`, `assets/plan.css`, `tests/render/*`
- **Scope:** M

### P0-4 — Section-id keyed patch application
- **Description:** Implement `applySectionPatch(plan, patch)` that appends or replaces a section by id without full reload, preserving scroll and in-progress UI (spec §6.1, §12).
- **Acceptance criteria:**
  - Appending a new section id adds a block; replacing an existing id updates in place.
  - Unrelated sections' DOM nodes are not recreated (identity preserved).
  - Patch with unknown/invalid section is rejected safely.
- **Verification:** `node --test tests/render/patch.test.js`
- **Dependencies:** P0-3
- **Files likely touched:** `assets/plan.js`, `tests/render/patch.test.js`
- **Scope:** S

### P0-5 — Static `file://` artifact + `localStorage` notes fallback
- **Description:** Produce the self-describing artifact bootstrap (`shell`/inline) per spec §4.3, with asset resolution trying `/_assets/plan.js` then `./_assets/plan.js` (spec §4.4). In raw `file://` mode, notes persist to `localStorage` keyed by `plan.slug`+`section.id`.
- **Acceptance criteria:**
  - Opening a sample `<slug>.plan.html` via `file://` renders sections from embedded JSON.
  - A note attached to a section persists across reloads in the same browser (localStorage).
  - Asset fallback order is `/_assets/` then `./_assets/`.
- **Verification:** `node --test tests/render/fallback.test.js` ; manual: open `tests/fixtures/sample.plan.html` in a browser (documented steps)
- **Dependencies:** P0-3, P0-4
- **Files likely touched:** `assets/shell.html`, `assets/plan.js`, `tests/fixtures/sample.plan.html`, `tests/render/fallback.test.js`
- **Scope:** S

### ✅ Checkpoint C0 (gate before P1)
**Pass conditions:**
- All `tests/schema/` and `tests/render/` suites green; zero network installs.
- A sample artifact opens via `file://` and renders sections with badges.
- A localStorage note round-trips across reload.
- Markdown XSS test corpus fully neutralized.
- Decision F (markdown lib) recorded in the plan artifact.

---

## Phase P1 — Plans-server extension (serve assets, discovery, sidebar)

**Goal (spec §16):** serve assets from `${PLUGIN_DIR}`, `/api/plans` discovery,
sidebar shell. Proves repo-wide discovery + single JS source.

### P1-0 — Runtime/location decision gate (spike)
- **Description:** Resolve open decisions A (runtime) and B (server location). Produce a 1-page decision record in the plan artifact confirming Node-stdlib + in-`engineering` (or alternative) and the JSON-RPC method surface (ambiguity E).
- **Acceptance criteria:**
  - Decision record committed; runtime confirmed runnable with **no network install**.
  - `plugin.json` extension/command/asset wiring approach documented.
- **Verification:** review the decision record section in `.plans/html-plan-ecosystem.plan.html`; `node --version` (or chosen runtime) present.
- **Dependencies:** C0
- **Files likely touched:** plan artifact (decision record), `.synaps-plugin/plugin.json` (draft)
- **Scope:** XS

### P1-1 — Extension scaffold: JSON-RPC over stdio + bound HTTP server (tests first)
- **Description:** Stand up the long-running extension process: JSON-RPC stdio loop and a tiny HTTP server bound to `127.0.0.1` on a **random ephemeral port**, receiving `${PLUGIN_DIR}` from env (spec §4.1, §4.2, §6).
- **Acceptance criteria:**
  - Server binds `127.0.0.1` only (never `0.0.0.0`); port is random/ephemeral.
  - JSON-RPC handshake responds to a `ping`/init method.
  - Server prints/returns the local URL.
- **Verification:** `node --test tests/server/bind.test.js` (asserts bind address is loopback; asserts non-`0.0.0.0`)
- **Dependencies:** P1-0
- **Files likely touched:** `extensions/plans_server.js`, `.synaps-plugin/plugin.json`, `tests/server/bind.test.js`
- **Scope:** M

### P1-2 — Serve renderer assets from `${PLUGIN_DIR}` (`GET /_assets/...`)
- **Description:** Implement `GET /_assets/plan.js` and `/_assets/plan.css` served from `${PLUGIN_DIR}/assets`, as the single source of truth (spec §4.4, §6).
- **Acceptance criteria:**
  - `GET /_assets/plan.js` returns the plugin's `assets/plan.js` with correct content-type.
  - Path requests outside `assets/` are rejected (no traversal) — basic check here, full hardening in P4-SEC.
- **Verification:** `node --test tests/server/assets.test.js`
- **Dependencies:** P1-1
- **Files likely touched:** `extensions/plans_server.js`, `tests/server/assets.test.js`
- **Scope:** S

### P1-3 — Repo plan discovery (`GET /api/plans`) with bounded scan (tests first)
- **Description:** Implement discovery scanning the repo for `**/*.{plan,spec}.html` and `.plans/`, returning the index shape in spec §6 (id, title, kind, status, mtime, path, attention). Scan is **bounded** (depth/file-count) per spec §7.2.
- **Acceptance criteria:**
  - Discovery returns one entry per artifact with required fields.
  - `attention` object present (zeros until P3 wires counters).
  - Scan respects a depth/file-count bound and ignores `.git`/`node_modules`.
  - Malformed artifacts are skipped, not fatal.
- **Verification:** `node --test tests/server/discovery.test.js`
- **Dependencies:** P1-1
- **Files likely touched:** `extensions/plans_server.js`, `tests/server/discovery.test.js`
- **Scope:** M

### P1-4 — Render endpoint (`GET /plan/<id>`) + sidebar shell (`GET /`)
- **Description:** Serve a single artifact at `/plan/<id>` and a sidebar `shell.html` at `/` listing all discovered plans with attention counters (spec §6, §4.2).
- **Acceptance criteria:**
  - `GET /plan/<id>` serves the artifact and it renders in server mode (loads `/_assets/plan.js`).
  - `GET /` lists every discovered plan with title/kind/status and an attention summary.
  - Unknown `<id>` returns a safe 404.
- **Verification:** `node --test tests/server/render_endpoint.test.js`
- **Dependencies:** P1-2, P1-3
- **Files likely touched:** `extensions/plans_server.js`, `assets/shell.html`, `tests/server/*`
- **Scope:** M

### ✅ Checkpoint C1 (gate before P2)
**Pass conditions:**
- Server binds loopback-only on a random port; asset/render/discovery tests green.
- Sidebar at `/` lists all repo plans; a plan opens in server mode using the
  single `${PLUGIN_DIR}` JS source.
- Decisions A & B confirmed and recorded.

---

## Phase P2 — SSE live-watch (watch it being written)

**Goal (spec §16):** SSE live-watch; agent streams sections during planning.
Proves "watch it being written."

### P2-1 — File watcher + change debounce (tests first)
- **Description:** Watch `.plans/` artifacts for changes and emit normalized change events (which plan, which section ids changed) with debounce (spec §6.1).
- **Acceptance criteria:**
  - Editing a plan artifact produces exactly one change event after debounce.
  - Watcher computes a section-id delta (append/replace) where feasible, else a full-refresh signal.
  - Watcher is bounded (no unbounded watch handles).
- **Verification:** `node --test tests/server/watch.test.js`
- **Dependencies:** C1
- **Files likely touched:** `extensions/plans_server.js`, `tests/server/watch.test.js`
- **Scope:** M

### P2-2 — SSE endpoint (`GET /api/stream?plan=<id>`) (tests first)
- **Description:** One-way server→browser SSE stream firing on file-watch change; caps concurrent connections per spec §7.2.
- **Acceptance criteria:**
  - Client receives an SSE event when the watched plan changes.
  - Connection cap enforced; excess connections rejected gracefully.
  - Stream sends section-id-keyed patch payloads consumable by `applySectionPatch`.
- **Verification:** `node --test tests/server/sse.test.js`
- **Dependencies:** P2-1
- **Files likely touched:** `extensions/plans_server.js`, `tests/server/sse.test.js`
- **Scope:** M

### P2-3 — Renderer live subscription (`subscribeLive`)
- **Description:** Wire `plan.js` to subscribe to SSE and apply section patches live, preserving scroll and in-progress annotations (spec §6.1, §12).
- **Acceptance criteria:**
  - A streamed new section appears without full reload.
  - Scroll position and any open note input are preserved across a patch.
  - SSE drop/reconnect handled without duplicating sections.
- **Verification:** `node --test tests/render/live.test.js`
- **Dependencies:** P2-2, P0-4
- **Files likely touched:** `assets/plan.js`, `tests/render/live.test.js`
- **Scope:** S

### P2-4 — Agent section-append streaming path (end-to-end slice)
- **Description:** Implement the write path the agent uses to append sections to an artifact incrementally so the live view streams during planning (spec §4.3, §16 P2). Pretty-printed JSON, one section per block (spec §5.4, clean diffs).
- **Acceptance criteria:**
  - Appending a section to the artifact JSON triggers watcher→SSE→renderer append within bounds.
  - Output JSON is pretty-printed, one section block per change (diff-friendly).
- **Verification:** `node --test tests/server/stream_integration.test.js`
- **Dependencies:** P2-2, P2-3
- **Files likely touched:** `extensions/plans_server.js`, helper write routine, `tests/server/stream_integration.test.js`
- **Scope:** S

### ✅ Checkpoint C2 (gate before P3)
**Pass conditions:**
- Appending a section server-side causes the browser to render it live via SSE
  with no full reload and preserved scroll.
- SSE connection cap and watcher bounds verified.
- Diffs remain clean (one section per block, pretty-printed).

---

## Phase P3 — Plan Inbox (the killer feature)

**Goal (spec §16):** server-side notes/events, section actions, agent reconcile
loop, blocking semantics, attention counters. Proves the killer feature.

### P3-0 — Event/note data model (`engplan/1` event shape) (tests first)
- **Description:** Define and validate Note and Event shapes (spec §5.3): id, plan_id, section_id, type (action list §3.2), author, text, status, agent_status, agent_response, changed_sections, timestamps. Boundary parse like P0-1.
- **Acceptance criteria:**
  - All §3.2 action types accepted; invalid types rejected.
  - Lifecycle status enum enforced: `open → acknowledged → incorporated|rejected|deferred|blocked`.
  - Round-trips to/from `<slug>.notes.json` / `<slug>.events.json` (ambiguity C split).
- **Verification:** `node --test tests/schema/events.test.js`
- **Dependencies:** C2
- **Files likely touched:** `assets/engplan.js`/`extensions/plans_server.js` (shared shape), `tests/schema/events.test.js`
- **Scope:** M

### P3-1 — Notes/events persistence endpoints (tests first)
- **Description:** Implement `GET /api/notes?plan=<id>`, `POST /api/notes` (append note/event), confined to writing **only** `*.notes.json`/`*.events.json` under `.plans/` (spec §6, §7.2). Body-size limit + per-plan event cap.
- **Acceptance criteria:**
  - POST appends a well-formed event; GET returns notes+events for a plan.
  - Writes are rejected for any path outside `.plans/` or any non-notes/events file.
  - Oversized bodies rejected; event cap enforced.
  - Concurrent appends do not corrupt the file (atomic write/lock).
- **Verification:** `node --test tests/server/notes.test.js`
- **Dependencies:** P3-0
- **Files likely touched:** `extensions/plans_server.js`, `tests/server/notes.test.js`
- **Scope:** M

### P3-2 — Section action UI (renderer) for the 14 actions
- **Description:** Add structured per-section action UI (spec §3.2): comment, request_change, block, approve, reprioritize, mark_risky, add_acceptance_criterion, clarify, force_verification, defer, split_task, merge_task, escalate_convergence, require_security_review, do_not_touch. Posts to `POST /api/notes`.
- **Acceptance criteria:**
  - Every action in §3.2 is selectable and produces a correctly typed event.
  - Free-text note still available (lightweight `comment`).
  - Submitted events appear in the section's note thread after round-trip.
  - Note input is sanitized on display (no stored-XSS).
- **Verification:** `node --test tests/render/actions.test.js`
- **Dependencies:** P3-1, P0-3
- **Files likely touched:** `assets/plan.js`, `assets/plan.css`, `tests/render/actions.test.js`
- **Scope:** M

### P3-3 — Agent response endpoint (`POST /api/events/:id/respond`) (tests first)
- **Description:** Implement agent ack/incorporate/reject/defer, writing `agent_status`, `agent_response`, `changed_sections`, `responded_at` (spec §3.3, §6).
- **Acceptance criteria:**
  - Valid transitions only (`open|acknowledged → incorporated|rejected|deferred|blocked`); invalid transitions rejected.
  - Response payload persisted with `changed_sections` and timestamp.
  - Write confinement identical to P3-1.
- **Verification:** `node --test tests/server/respond.test.js`
- **Dependencies:** P3-1, P3-0
- **Files likely touched:** `extensions/plans_server.js`, `tests/server/respond.test.js`
- **Scope:** S

### P3-4 — Event lifecycle state machine (tests first)
- **Description:** Centralize the lifecycle transitions (spec §3.3) as a validated state machine used by both notes and respond endpoints.
- **Acceptance criteria:**
  - All legal transitions accepted; all illegal transitions rejected with clear errors.
  - Terminal states (`incorporated`/`rejected`/`deferred`) cannot transition further except documented re-open policy.
- **Verification:** `node --test tests/inbox/lifecycle.test.js`
- **Dependencies:** P3-3
- **Files likely touched:** `extensions/plans_server.js` (lifecycle module), `tests/inbox/lifecycle.test.js`
- **Scope:** S

### P3-5 — Agent reconcile loop (tests first)
- **Description:** Implement the reconcile algorithm (spec §3.5): read open events ordered by `created_at`; acknowledge; evaluate; apply incorporate/reject/defer/(raise) block; write `agent_response` + `changed_sections`; recompute attention counters. Invoked at the four checkpoints (after writing a section; before each task; before completion claims; explicit trigger).
- **Acceptance criteria:**
  - Open events are acknowledged then resolved with a recorded outcome+response.
  - Reconcile is idempotent on already-resolved events.
  - Reconcile recomputes attention counters (P3-7).
  - Reconcile honors ordering by `created_at`.
- **Verification:** `node --test tests/inbox/reconcile.test.js`
- **Dependencies:** P3-4
- **Files likely touched:** `extensions/plans_server.js` (reconcile), `tests/inbox/reconcile.test.js`
- **Scope:** M

### P3-6 — Blocking semantics: halt dependent work (tests first)
- **Description:** Enforce that an `open` `block` event on an in-scope section is a real stop condition; dependent work (via `depends_on`) must not advance until the block is acknowledged and resolved (spec §3.4). Non-blocking events do not halt autonomy.
- **Acceptance criteria:**
  - A blocked section marks its `depends_on` dependents as halted/ineligible to start.
  - Resolving the block (`incorporated`/`rejected`/`deferred` w/ rationale) lifts the halt.
  - Non-blocking events never halt dependent work.
  - The halt state is surfaced in the plan/section state.
- **Verification:** `node --test tests/inbox/blocking.test.js`
- **Dependencies:** P3-5
- **Files likely touched:** `extensions/plans_server.js`, `assets/plan.js` (halt badge), `tests/inbox/blocking.test.js`
- **Scope:** M

### P3-7 — Attention counters + sidebar wiring (tests first)
- **Description:** Compute per-plan attention counters (spec §3.8, §6): `Agent attention needed`, `Blocking notes`, `Unresolved comments`, `New acceptance criteria`; map event types→counters (ambiguity G). Surface in `/api/plans` `attention` object and the sidebar.
- **Acceptance criteria:**
  - Counters reflect current open/unresolved events correctly.
  - `/api/plans` `attention.{blocking,unresolved,needs_review}` populated.
  - Sidebar shows per-plan attention badges; counters update after reconcile.
  - Counter mapping table documented in the plan artifact.
- **Verification:** `node --test tests/inbox/counters.test.js` ; `node --test tests/server/discovery.test.js`
- **Dependencies:** P3-6, P1-3
- **Files likely touched:** `extensions/plans_server.js`, `assets/shell.html`, `assets/plan.js`, `tests/inbox/counters.test.js`
- **Scope:** S

### ✅ Checkpoint C3 (gate before P4)
**Pass conditions:**
- End-to-end: human posts a `block` on a section → agent reconcile acknowledges →
  dependent work is halted → agent resolves as `incorporated` with
  `agent_response` + `changed_sections` → section shows `incorporated` and the
  halt lifts.
- Attention counters correct on plan + sidebar.
- All `tests/inbox/` suites green; write-confinement holds for all endpoints.

---

## Phase P4 — Legacy markdown, `/plan` commands, skill updates, security hardening

**Goal (spec §16):** legacy markdown rendering; `/plan` commands; skill updates
(§9) incl. subagent-dispatch rule; security hardening pass (§7). Ecosystem
complete + backward compatible.

### P4-1 — Legacy `.md` best-effort rendering (tests first)
- **Description:** Render a plain `.md` in degraded legacy mode: sections from `#`/`##` headings, slugified (disambiguated) ids, no live/state/approval badges; notes anchored best-effort to heading slugs (spec §8, ambiguity I).
- **Acceptance criteria:**
  - A `.md` file renders heading-derived sections.
  - Section ids are slugified headings; collisions disambiguated by ordinal.
  - No live state badges; UI clearly flags "legacy / degraded."
  - Notes can attach to heading-slug anchors (best-effort).
- **Verification:** `node --test tests/render/legacy.test.js`
- **Dependencies:** C3
- **Files likely touched:** `assets/plan.js`, `tests/render/legacy.test.js`, `tests/fixtures/legacy.md`
- **Scope:** M

### P4-2 — `/plan` commands: `new`, `open`, `list`, `serve`, `reconcile`
- **Description:** Implement the five commands (spec §10, §4.5): `new` scaffolds `.plans/`, copies fallback assets into `.plans/_assets/`, writes the artifact, opens browser; `open` opens via server; `list` prints attention counters; `serve` ensures the server is running and prints URL; `reconcile` forces a reconcile pass.
- **Acceptance criteria:**
  - `/plan new <kind> <slug>` creates `.plans/`, `_assets/` fallback, `<slug>.<kind>.html`, and self-connects the repo (spec §4.5).
  - `/plan list` shows attention counters per plan.
  - `/plan serve` reports the loopback URL; idempotent if already running.
  - `/plan reconcile <slug>` runs P3-5 and reports outcomes.
  - Browser-open failure is non-fatal (URL printed).
- **Verification:** `node --test tests/server/commands.test.js`
- **Dependencies:** P4-1, P3-5
- **Files likely touched:** `.synaps-plugin/plugin.json`, `extensions/plans_server.js`, `assets/*`, `tests/server/commands.test.js`
- **Scope:** M

### P4-3 — `plugin.json` wiring: extension + commands + assets
- **Description:** Register the extension, `/plan` commands, and assets in `.synaps-plugin/plugin.json` (spec §11). Bump version.
- **Acceptance criteria:**
  - `plugin.json` validates; declares extension entry, command surface, asset paths.
  - Plugin loads and starts the extension on session start (smoke).
- **Verification:** `node -e "JSON.parse(require('fs').readFileSync('engineering-plugin/.synaps-plugin/plugin.json'))"` ; documented load smoke
- **Dependencies:** P4-2
- **Files likely touched:** `.synaps-plugin/plugin.json`
- **Scope:** XS

### P4-4 — Skill updates per §9 (integration prose)
- **Description:** Update skills to wire the ecosystem in (spec §9 table): `spec-driven-development` (emit `<slug>.spec.html`), `planning-and-task-breakdown` (emit `<slug>.plan.html`, tasks as sections), `worktrees-by-default` (slug identity), `incremental-implementation` (flip task state live + reconcile before each slice), `verification-before-completion` (evidence sections + reconcile before completion), `convergence-loop` (scores/verdicts as sections; `escalate_convergence`).
- **Acceptance criteria:**
  - Each listed skill references the HTML artifact workflow and reconcile checkpoints.
  - Identity-coherence (slug == branch == worktree == artifact) stated where relevant.
  - No skill instructs CDN use or `0.0.0.0` binding.
- **Verification:** `grep -rl "engplan/1\|\.plan\.html\|reconcile" engineering-plugin/skills` ; manual skill review
- **Dependencies:** P4-3
- **Files likely touched:** `skills/spec-driven-development/*`, `skills/planning-and-task-breakdown/*`, `skills/worktrees-by-default/*`, `skills/incremental-implementation/*`, `skills/verification-before-completion/*`, `skills/convergence-loop/*`
- **Scope:** M

### P4-5 — Subagent-dispatch + coder/model doctrine (§9.1, §9.2) across skills
- **Description:** Encode (a) the hard rule that every subagent dispatch carries `agent` or inline `system_prompt` — never neither (spec §9.1), and (b) the coder-subagent + model-inheritance + poll-and-steer doctrine (spec §9.2, §3.7): Orchestrator Protocol lines, Red Flags, Verification lines, pre-dispatch invariants (`role = agent|system_prompt`; `model = explicit ?? session`). Primary target `convergence-loop`, plus every code-writing/dispatch-bearing skill.
- **Acceptance criteria:**
  - `convergence-loop` contains the §9.1 Orchestrator Protocol, Red Flag, Verification, and pre-dispatch invariant text.
  - The exact `Got neither.` error string is referenced as the failure mode.
  - §9.2 doctrine present: "subagents are the coders," `model = explicit ?? session_model`, poll-and-steer-via-inbox over sleep, and the convergence carve-out.
  - All dispatch/code-writing skills carry both invariants.
- **Verification:** `grep -rn "system_prompt" engineering-plugin/skills/convergence-loop` ; `grep -rn "either 'agent' .* or 'system_prompt'" engineering-plugin/skills` ; `grep -rn "session model\|model = explicit" engineering-plugin/skills`
- **Dependencies:** P4-4
- **Files likely touched:** `skills/convergence-loop/*`, `skills/incremental-implementation/*`, `skills/test-driven-development/*`, `skills/systematic-debugging/*`, `skills/planning-and-task-breakdown/*`
- **Scope:** S

### Security hardening task set (traceable to spec §7 & §14)

> These tasks are **test-first** (spec §13: write failing security tests first).
> Each row below is traceable to a specific §7 control.

### P4-SEC-1 — Loopback-only bind + random port (control §7.2 bullet 1; §14 "Always")
- **Description:** Assert and lock loopback-only binding on a random ephemeral port; regression test prevents `0.0.0.0`.
- **Acceptance criteria:** server refuses/never binds non-loopback; test fails if bind address is not `127.0.0.1`; port is randomized.
- **Verification:** `node --test tests/security/bind.test.js`
- **Dependencies:** P1-1
- **Files likely touched:** `extensions/plans_server.js`, `tests/security/bind.test.js`
- **Scope:** S

### P4-SEC-2 — Per-session token enforcement (control §7.2 bullet 2; ambiguity D)
- **Description:** Require a per-session token on every request (URL/query/header); renderer fetches include it.
- **Acceptance criteria:** requests without/with wrong token rejected (401/403); valid token passes; token not committed into artifacts (§14 "Never").
- **Verification:** `node --test tests/security/token.test.js`
- **Dependencies:** P1-1
- **Files likely touched:** `extensions/plans_server.js`, `assets/plan.js`, `tests/security/token.test.js`
- **Scope:** S

### P4-SEC-3 — Path canonicalization & traversal/symlink confinement (control §7.2 bullet 3; §14 "Never")
- **Description:** Canonicalize every served/written path; reject `..`, absolute surprises, symlink escape; serve only within repo root + `.plans/`.
- **Acceptance criteria:** traversal (`../../etc/passwd`), absolute, and symlink-escape requests rejected; legitimate in-repo paths allowed.
- **Verification:** `node --test tests/security/paths.test.js`
- **Dependencies:** P1-2, P1-3
- **Files likely touched:** `extensions/plans_server.js`, `tests/security/paths.test.js`
- **Scope:** M

### P4-SEC-4 — Write confinement allowlist (control §7.2 bullet 4)
- **Description:** Enforce that note/event POSTs and responses write **only** `*.notes.json`/`*.events.json` under `.plans/`; no arbitrary path writes.
- **Acceptance criteria:** attempts to write any other filename/path rejected; only allowlisted files writable.
- **Verification:** `node --test tests/security/write_confine.test.js`
- **Dependencies:** P3-1, P3-3
- **Files likely touched:** `extensions/plans_server.js`, `tests/security/write_confine.test.js`
- **Scope:** S

### P4-SEC-5 — Resource bounds (control §7.2 bullet 5)
- **Description:** Size-limit POST bodies; cap events per plan; cap SSE connections; bound discovery scan (depth/file-count).
- **Acceptance criteria:** oversized body rejected; event cap enforced; SSE connection cap enforced; discovery scan stops at bound on a synthetic huge tree.
- **Verification:** `node --test tests/security/bounds.test.js`
- **Dependencies:** P3-1, P2-2, P1-3
- **Files likely touched:** `extensions/plans_server.js`, `tests/security/bounds.test.js`
- **Scope:** M

### P4-SEC-6 — No code execution from content + CSP (control §7.2 bullets 6–7; §7.3)
- **Description:** Ensure renderer treats embedded JSON/markdown/notes as data only; apply CSP on served pages restricting scripts to `/_assets/`+`self`, disabling inline handlers; reaffirm sanitizer coverage from P0-2 against stored-XSS via plan section and note.
- **Acceptance criteria:** served pages carry a CSP header limiting script-src to `/_assets/`+self and disabling inline event handlers; stored-XSS via a malicious plan section and via a malicious note both neutralized; no content is ever executed as a command.
- **Verification:** `node --test tests/security/csp.test.js` ; `node --test tests/security/stored_xss.test.js`
- **Dependencies:** P0-2, P1-4, P3-2
- **Files likely touched:** `extensions/plans_server.js`, `assets/plan.js`, `assets/sanitize.js`, `tests/security/*`
- **Scope:** M

### P4-6 — End-to-end integration test (spec §13 Integration row)
- **Description:** Full flow: `/plan new` → live SSE stream → human `block` event → agent reconcile → `incorporated` shown, with attention counters and blocking halt verified across server + renderer.
- **Acceptance criteria:** the full happy path passes in one automated test; blocked-dependent-work halt observed and lifted; agent response visible.
- **Verification:** `node --test tests/integration/full_flow.test.js`
- **Dependencies:** P4-2, all P3, all P4-SEC
- **Files likely touched:** `tests/integration/full_flow.test.js`, fixtures
- **Scope:** M

### ✅ Checkpoint C4 (final gate / release)
**Pass conditions:**
- Legacy `.md` renders in degraded mode with the legacy flag.
- All five `/plan` commands work; repo self-connects on first `/plan new`.
- `plugin.json` validates and loads; extension starts on session start.
- Skills updated per §9; subagent-dispatch rule (§9.1) present and grep-verifiable.
- All `tests/security/*` green; all controls in §7.2/§7.3 covered.
- `tests/integration/full_flow.test.js` green.
- Full suite (`node --test tests/`) green with zero network installs.

---

## Test plan mapping (spec §13 Testing Strategy → tasks)

| Test layer (spec §13) | Covering tasks |
|---|---|
| **Schema** — `engplan/1` parse/validate, required fields, unknown-field handling, bad ids rejected | P0-1, P3-0 |
| **Renderer** — renders sections, section-id patches, markdown sanitization (XSS), legacy `.md` | P0-2, P0-3, P0-4, P0-5, P2-3, P3-2, P4-1, P4-SEC-6 |
| **Server** — discovery glob, SSE fires on change, notes/events round-trip, path-traversal/symlink rejection, write-confinement | P1-1, P1-2, P1-3, P1-4, P2-1, P2-2, P2-4, P3-1, P3-3, P4-SEC-3, P4-SEC-4 |
| **Inbox/loop** — lifecycle transitions, blocking halts dependent work, agent response written, counters recompute | P3-0, P3-4, P3-5, P3-6, P3-7 |
| **Security** — 127.0.0.1-only bind, token enforcement, body-size bounds, sanitized output | P4-SEC-1, P4-SEC-2, P4-SEC-5, P4-SEC-6 |
| **Integration** — `/plan new` → live stream → human block → reconcile → `incorporated` | P4-6 (supported by P2-4, P3-5, P3-6, P4-2) |

**TDD note (spec §13):** P0-1, P0-2, P3-0, P3-1, P3-3, P3-4, P3-5, P3-6, P3-7,
and all `P4-SEC-*` are explicitly written failing-tests-first, prioritizing the
security controls (§7) and the event lifecycle (§3.3).

---

## Security-hardening task set (traceable to spec §7)

| Spec §7 control | Task(s) |
|---|---|
| §7.2 — Bind 127.0.0.1 only; random ephemeral port | P4-SEC-1 (locked at P1-1) |
| §7.2 — Optional per-session token on every request | P4-SEC-2 |
| §7.2 — Path safety: canonicalize, reject `..`/absolute/symlink; serve only repo+`.plans/` | P4-SEC-3 |
| §7.2 — Write confinement: only `*.notes.json`/`*.events.json` under `.plans/` | P4-SEC-4 |
| §7.2 — Bounds: body size, event cap, SSE cap, bounded discovery scan | P4-SEC-5 |
| §7.2 — No code execution from plan content; CSP restricting script-src | P4-SEC-6 |
| §7.3 — Markdown/note output sanitization (stored-XSS prevention) | P0-2 (engine), P4-SEC-6 (stored-XSS via section + note) |
| §14 — "Never": no serving outside repo, no arbitrary writes, no command execution, no CDN, no committed secrets | P4-SEC-3, P4-SEC-4, P4-SEC-6, plus P0-2/P1-2 (no CDN) and P4-SEC-2 (no committed token) |

---

## Definition of Done — cross-check against spec §18

| Spec §18 DoD item | Satisfied by | Verified at |
|---|---|---|
| `engplan/1` schema documented, validated, tested | P0-1, P3-0 | C0, C3 |
| Renderer loads server mode + static `file://`; markdown sanitized | P0-3, P0-5, P1-4, P2-3, P0-2, P4-SEC-6 | C0, C1, C2, C4 |
| Plans-server binds 127.0.0.1, serves assets from `${PLUGIN_DIR}`, discovers plans, streams SSE | P1-1, P1-2, P1-3, P2-1, P2-2, P4-SEC-1 | C1, C2 |
| Human can annotate any section; notes/events persist to `.plans/` | P3-1, P3-2 | C3 |
| Plan Inbox lifecycle end-to-end; blocking halts dependent work; agent responses recorded; counters correct | P3-3, P3-4, P3-5, P3-6, P3-7 | C3, C4 |
| Legacy `.md` renders in degraded mode | P4-1 | C4 |
| Skills updated (§9), including subagent-dispatch rule (§9.1) | P4-4, P4-5 | C4 |
| Security controls (§7) implemented and tested | P4-SEC-1…6 | C4 |
| All work in worktrees, test-first, with fresh verification evidence | Ground rules + per-task verification commands + checkpoints | every checkpoint |

**DoD gate:** v1 is "done" only when every row above is checked at checkpoint C4
with fresh, passing verification evidence and the full `node --test tests/` suite
green with zero network installs.

---

## Dependency summary (topological order)

```
P0-0 → P0-1 → P0-3 → P0-4 → P0-5
       P0-2 ↗            ↘ (C0)
(C0) → P1-0 → P1-1 → P1-2 ┐
                    → P1-3 ┼→ P1-4 → (C1)
(C1) → P2-1 → P2-2 → P2-3 → P2-4 → (C2)
(C2) → P3-0 → P3-1 → P3-2
              P3-1 → P3-3 → P3-4 → P3-5 → P3-6 → P3-7 → (C3)
(C3) → P4-1 → P4-2 → P4-3 → P4-4 → P4-5
       P4-SEC-1..6 (depend on their feature tasks) ┐
       P4-6 (integration) ←──────────────────────┴→ (C4)
```

---

## Future / explicitly deferred (out of v1 scope)

- `/plan migrate <file.md>` Markdown→`engplan/1` conversion (spec §8).
- WebSocket / bidirectional transport, live cursors/presence (spec §6.1, §1.4).
- Cloud sync / hosted service; multi-user real-time collaboration (spec §1.4).
- Settings-based notes opt-out (spec §5.4) unless trivial.
- Sibling `plan-viewer` plugin split (open decision #4) if not chosen at P1-0.

---

# Addendum A — Headless End-to-End Test Harness (human-in-the-loop simulated)

> **Why this addendum exists.** The base plan verifies units and slices, but the
> killer feature (§3 Plan Inbox) is a *human↔agent loop*. A loop you can only
> test by hand is a loop you cannot ship continuously. This addendum mandates a
> **fully headless harness** that simulates every human action and every agent
> reconcile step, so the entire ecosystem builds and verifies **end-to-end with
> no human in the loop** — in local dev and in CI.

> **Plugin-wide intent (forward-looking).** This is the first instance of a
> policy the whole `engineering` plugin should adopt: **every build mandatorily
> ships an automated build+test harness.** See Addendum C for where this lands
> in the skills. From now on, "done" includes "a machine can rebuild and
> re-verify this feature, including its human interactions, unattended."

## A.1 Principle: every actor action is an API call

The architecture already routes all steering intent through the Plans Server API
(spec §6: `POST /api/notes`, `POST /api/events/:id/respond`, SSE, discovery).
That is the seam that makes headless testing possible: **anything a human can do
in the browser, a script can do over HTTP — and so can an orchestrator agent.**
The harness is therefore not just a human stand-in; **its drivers are the
reference implementation of the orchestrator-in-the-loop** (spec §3.6). What we
build to test the loop is the same surface a real orchestrator uses to steer a
Builder subagent. The renderer/DOM is verified separately against the same data.
No human, no real browser required for the core loop.

```
        ┌─────────────────────────────────────────────────────────┐
        │                  Headless Harness (CI + local)            │
        │                                                           │
        │  ┌────────────┐   HTTP/SSE   ┌────────────────────────┐  │
        │  │ ActorSim   │ ───────────▶ │   Plans Server (SUT)    │  │
        │  │ human│orch │ ◀─────────── │   + .plans/ on disk     │  │
        │  └────────────┘   events     └───────────┬─────────────┘  │
        │  ┌────────────┐                          │ reads inbox    │
        │  │ AgentSim   │ ◀── reconcile ───────────┘                │
        │  │ (driver)   │ ───── responds (respond endpoint) ──────▶ │
        │  └────────────┘                                           │
        │  ┌────────────┐   jsdom/headless DOM                      │
        │  │ DomProbe   │ ── renders engplan/1 + asserts UI state   │
        │  └────────────┘                                           │
        │  ┌────────────┐                                           │
        │  │ FaultInj   │ ── adversarial inputs, races, traversal   │
        │  └────────────┘                                           │
        └─────────────────────────────────────────────────────────┘
```

## A.2 Harness components

| Component | Role | Drives |
|---|---|---|
| **ActorSim** | Scripted actor driver with two modes: **human** (operator) and **orchestrator** (supervising agent). Emits the 14 section actions (§3.2): comment, request_change, block, approve, reprioritize, mark_risky, add_acceptance_criterion, clarify, force_verification, defer, split_task, merge_task, escalate_convergence, require_security_review, do_not_touch. Stamps each event with the correct `actor`. **This is the orchestrator-in-the-loop reference implementation.** | `POST /api/notes`, reads `/api/plans`, listens on `/api/stream` |
| **AgentSim** | Scripted "agent." Streams plan sections, runs the reconcile loop (§3.5), writes agent responses, flips task states, attaches verification evidence. A deterministic stand-in for the real agent reconcile code (P3-5). | section-append path, `POST /api/events/:id/respond` |
| **DomProbe** | Loads `plan.js` against a fixed `engplan/1` doc in a headless DOM (jsdom or equivalent) and asserts rendered structure, badges, counters, and action affordances — without a real browser. | renderer in-process |
| **FaultInj** | Adversarial driver: malformed JSON, oversized bodies, path-traversal/symlink writes, unauthorized (no-token) calls, non-loopback bind attempts, SSE flooding, racing writers. | raw HTTP + filesystem |
| **Scenario runner** | Orchestrates the above into named end-to-end scenarios; spins up the SUT on an ephemeral port in a temp repo, asserts, tears down. | all |
| **Clock/IDs** | Injectable clock + id generator so timestamps/ULIDs are deterministic and assertions are stable. | all |

All components are libraries first (callable from `node --test`) and thin CLIs
second (so a test *agent* or a human can run any scenario by name).

## A.3 "Make it break, then fix it" — the red-green + adversarial mandate

Two non-negotiable rules:

1. **Red before green (per task).** Every harness scenario must be observed
   **failing** against the not-yet-built feature before the feature is
   implemented, then passing after. A scenario that has never failed proves
   nothing (mirrors `verification-before-completion` and `test-driven-development`).
2. **Adversarial by construction.** The harness does not only assert happy
   paths; it actively tries to **break** the system and asserts correct failure
   behavior (reject, halt, sanitize, refuse) — see the fault catalog A.5.

The harness ships a `--prove` mode that, for a given scenario, runs it against a
"feature-disabled" build (or a deliberately reverted control), asserts failure,
then against the real build, asserts success — recording the red→green
transition as evidence.

## A.4 Canonical end-to-end scenarios (no human)

Each scenario is fully scripted; named so a test agent can invoke it.

| Scenario | Flow | Pass condition |
|---|---|---|
| **S1 live-write** | AgentSim streams 5 sections → DomProbe/SSE client | Sections appear incrementally via SSE; no full reload; order preserved. |
| **S2 comment-roundtrip** | HumanSim `comment` on `task-2` → AgentSim reconcile | Event `open→acknowledged→incorporated`; `agent_response` + `changed_sections` written; unresolved counter +1 then 0. |
| **S3 blocking-halt** | HumanSim `block` on in-scope section → AgentSim attempts dependent task | Dependent work refuses to start while block `open`; resumes only after resolve; blocking counter reflects state. |
| **S4 approve-gate** | HumanSim `approve` a `needs-human-review` section | `approval=approved`; needs_review counter −1; agent may proceed. |
| **S5 force-verification** | HumanSim `force_verification` before a completion claim | AgentSim must attach fresh evidence section before claiming done; otherwise scenario fails. |
| **S6 add-criterion** | HumanSim `add_acceptance_criterion` on a task | Criterion appears in section `acceptance[]`; agent re-plans/acknowledges. |
| **S7 do-not-touch** | HumanSim `do_not_touch` a path → AgentSim tries to "edit" it | Agent records refusal; path treated as data, never executed. |
| **S8 escalate-convergence** | HumanSim `escalate_convergence` | Plan `convergence` field/decision updated; recorded, not silently ignored. |
| **S9 discovery-sidebar** | Seed N plans in temp repo → `/api/plans` + DomProbe sidebar | All plans listed with correct attention counters. |
| **S10 legacy-md** | Load a `.md` plan | Best-effort sections render; degraded-mode flagged; no crash. |
| **S11 full-lifecycle** | spec→plan→stream→multiple human events (incl. one block)→reconcile→tasks done→completion claim | End-to-end green; audit trail of every event + agent response intact. |
| **S12 orchestrator-steer** | Orchestrator-mode ActorSim writes `request_change` + `block` to a **fresh** Builder AgentSim via the Plan Inbox; reads back `agent_response` | Builder steered with **explicit artifacts only** (no hidden context); response + `changed_sections` recorded; mirrors `convergence-loop` fix-loop without `subagent_steer`/`resume`. |
| **S13 orchestrator-convergence** | Orchestrator drives Designer→Builder→Tester→Judge artifacts through plan sections + inbox; `escalate_convergence` honored | Each role's input/output is an explicit Plan Inbox artifact; actor stamped `orchestrator`; full audit trail; every dispatch carries `agent`/`system_prompt` (§9.1). |
| **S14 poll-and-steer** | Orchestrator dispatches a **reactive** coder, polls status (no long sleep), injects an `actor:orchestrator` inbox event mid-run; coder reconciles **without restart** | Coder picks up steering via inbox at its next §3.5 checkpoint; `agent_response` recorded; orchestrator never idle-slept; supervision loop completes. |
| **S15 model-inheritance** | Orchestrator dispatches a coder with **no** `model` set | Dispatch resolves `model = session_model` (e.g. `claude-opus-4-8`), not a weaker default; recorded in the dispatch packet/audit. |

## A.5 Fault-injection catalog (assert correct failure)

Traceable to spec §7 Security and §3 lifecycle. FaultInj asserts the system
**refuses correctly** (not that it crashes):

- **Path traversal / symlink escape** on note/event writes → rejected; nothing
  written outside `.plans/` (ties to P4-SEC-3, P4-SEC-4).
- **Oversized body / event flood** → bounded, rejected past cap (P4-SEC-5).
- **Missing/invalid token** → 401/refused (P4-SEC-2).
- **Non-loopback bind attempt** → refused/forced to 127.0.0.1 (P4-SEC-1).
- **Stored-XSS** in a section `md` or a human note `text` → sanitized; DomProbe
  finds no executable injection (P0-2, P4-SEC-6).
- **Malformed `engplan/1`** doc/event → safe parse error at boundary, no crash
  (P0-1, P3-0).
- **Race:** two writers append events concurrently → no lost update / corrupt
  JSON; deterministic merge.
- **Blocking bypass attempt:** AgentSim tries to advance past an `open` block →
  harness asserts the halt held (P3-6).
- **Instruction-injection:** a note/section/error containing "run this command"
  → treated as data; never executed (mirrors `systematic-debugging`).
- **Dispatch invariant violations:** dispatch with neither `agent` nor
  `system_prompt` → refused before any call (§9.1); dispatch with no `model` →
  resolves to session model, never a silent weaker default (§9.2).
- **Idle-sleep regression:** orchestrator loop that inserts a long blocking sleep
  instead of polling → flagged by the injected clock (§3.7, H-6).

## A.6 New harness tasks (woven into the existing phases)

These run **alongside** the feature tasks; each gates its phase checkpoint.

### H-0 — Harness foundation (extends P0-0)
- **Description:** Scenario runner, ephemeral-port + temp-repo fixtures,
  injectable clock/id, `--prove` red→green mode, `node --test` integration, CLI
  entry so a test agent can run any scenario by name.
- **Acceptance:** `npm run harness -- --list` lists scenarios; a trivial
  scenario shows a red→green transition under `--prove`.
- **Verification:** `node --test test/harness/foundation.test.js`
- **Dependencies:** P0-0 · **Files:** `test/harness/*` · **Scope:** M

### H-1 — DomProbe (extends P0-3/P0-4)
- **Description:** Headless-DOM rendering probe for the renderer.
- **Acceptance:** Asserts sections, badges, counters, action affordances from a
  fixed `engplan/1` doc; covers S10 legacy render.
- **Verification:** `node --test test/harness/domprobe.test.js`
- **Dependencies:** P0-3, P0-4, H-0 · **Scope:** S

### H-2 — ActorSim driver (human + orchestrator modes) (gates C1/C3)
- **Description:** Library + CLI emitting all 14 section actions over HTTP/SSE in
  two modes — **human** and **orchestrator** — stamping the correct `actor`.
  This driver doubles as the orchestrator-in-the-loop reference implementation
  (spec §3.6): the same code a real supervising agent uses to steer a Builder.
- **Acceptance:** Each action type produces a correctly-shaped persisted event
  with the right `actor`; scenarios S2,S4,S6,S7,S8 drivable headlessly in **both**
  human and orchestrator modes; S12/S13 (orchestrator steering) pass.
- **Verification:** `node --test test/harness/actorsim.test.js`
- **Dependencies:** P3-1, H-0 · **Scope:** M

### H-3 — AgentSim driver + reconcile harness (gates C3)
- **Description:** Deterministic agent stand-in: streams sections, runs reconcile
  (P3-5), writes responses (P3-3), flips task states, attaches evidence.
- **Acceptance:** S1,S2,S3,S5,S11 pass; blocking-halt (S3) and force-verification
  (S5) enforced.
- **Verification:** `node --test test/harness/agentsim.test.js`
- **Dependencies:** P3-3, P3-5, P3-6, H-2 · **Scope:** M

### H-4 — FaultInj adversarial suite (gates C4)
- **Description:** Implements the A.5 fault catalog as assertions.
- **Acceptance:** Every fault asserts correct refusal/halt/sanitize; no crash; no
  out-of-`.plans/` write.
- **Verification:** `node --test test/harness/faultinj.test.js`
- **Dependencies:** P4-SEC-1..6, P3-6, P0-2 · **Scope:** M

### H-5 — Full-lifecycle scenario + CI gate (gates C4 / DoD)
- **Description:** S11 end-to-end + a single `npm run e2e` that runs all
  scenarios headless and exits non-zero on any failure; wire into CI.
- **Acceptance:** `npm run e2e` builds and verifies the whole ecosystem with no
  human; red→green provable for at least S1–S5 and S11.
- **Verification:** `npm run e2e`
- **Dependencies:** H-1,H-2,H-3,H-4, P4-6 · **Scope:** M

### H-6 — OrchestratorSim: reactive coder loop (gates C4)
- **Description:** Driver that models the §3.7 operating doctrine: dispatch a
  reactive coder (AgentSim) stand-in, **poll** its status (no long sleeps), inject
  `actor:orchestrator` steering events into the Plan Inbox, and collect results.
  Doubles as the **reference orchestrator** for production. Asserts the §9.1/§9.2
  dispatch invariants (`role = agent|system_prompt`, `model = explicit ?? session`).
- **Acceptance:** S14 (poll-and-steer, no restart) and S15 (model-inheritance)
  pass headless; a dispatch with neither `agent` nor `system_prompt` is refused
  before any call; a dispatch with no `model` resolves to the session model;
  asserts the loop never inserts a blocking sleep (clock-injected).
- **Verification:** `node --test test/harness/orchestratorsim.test.js`
- **Dependencies:** H-3, P3-5, P3-6 · **Scope:** M

Each existing checkpoint gains a headless gate (no human steps allowed):

- **C0** → add: H-0 foundation green; DomProbe (H-1) renders P0 artifact; one
  red→green proof recorded.
- **C1** → add: ActorSim (H-2) can hit discovery/notes endpoints headlessly in both human and orchestrator modes.
- **C2** → add: S1 live-write passes via SSE with no manual browser.
- **C3** → add: S2,S3,S4,S5,S6 pass headless; blocking-halt + force-verification
  enforced by AgentSim (H-3).
- **C4** → add: H-4 fault suite green; **H-6 OrchestratorSim** green (poll-and-
  steer S14, model-inheritance S15, dispatch invariants); **`npm run e2e` is the
  merge gate** and passes unattended.

## A.8 Definition of Done — harness additions (extends spec §18)

- [ ] `npm run e2e` builds + verifies the entire ecosystem **headless** (no human).
- [ ] ActorSim can perform all 14 section actions via API in both human and orchestrator modes.
- [ ] AgentSim drives the full reconcile loop incl. blocking-halt + force-verification.
- [ ] DomProbe asserts renderer/UI state without a real browser.
- [ ] FaultInj asserts correct failure for every A.5 fault.
- [ ] Every scenario has a recorded red→green proof (`--prove`).
- [ ] CI fails the build if any scenario fails.
- [ ] OrchestratorSim (H-6) proves the §3.7 loop: reactive coders, polled (no
      long sleeps), steered via the Plan Inbox.
- [ ] Dispatch invariants enforced: `role = agent|system_prompt`,
      `model = explicit ?? session_model` (§9.1, §9.2).

---

# Addendum B — Reframing the base tasks under the harness mandate

No base task is removed. Each feature task's verification is **augmented**: in
addition to its unit tests, the feature is only "done" when the relevant harness
scenario (A.4) and any applicable fault (A.5) pass headlessly. Concretely:

- Inbox tasks (P3-*) are not done until H-2/H-3 scenarios cover them.
- Security tasks (P4-SEC-*) are not done until H-4 faults assert them.
- Live-write (P2-*) is not done until S1 passes via SSE headlessly.

---

# Addendum C — Plugin-wide mandate: builds ship their own test harness

This feature is the pilot for a standing `engineering`-plugin policy. Proposed
landing spots (to be implemented as a follow-up skill change, not in this build):

| Skill | Proposed change |
|---|---|
| `planning-and-task-breakdown` | Add a mandatory planning output: an **automated build+test harness** task set, including headless simulation of any human-in-the-loop interactions. A plan without it is incomplete. |
| `verification-before-completion` | "Done" requires a **machine** can rebuild + re-verify unattended, including simulated human actions — not just that tests pass once. |
| `incremental-implementation` | Each slice's verification includes the relevant harness scenario, red→green proven. |
| `spec-driven-development` | Boundaries "Always do" gains: *ship an automated harness that exercises the feature end-to-end without a human.* |
| `convergence-loop` | Builder role dispatches a **coder subagent** with `model = explicit ?? session`; keep the fresh-blocking / no-async / no-steer / no-resume rules as the convergence-only exception to §3.7. |
| (new, optional) `automated-test-harness` skill | Formalize ActorSim (human+orchestrator) / AgentSim / DomProbe / FaultInj / OrchestratorSim / scenario-runner patterns + the red-green-adversarial discipline as a reusable skill. Make explicit that the harness drivers are also the **orchestrator-in-the-loop reference implementation**. |

---

# Addendum D — Orchestration doctrine: reactive coder subagents (spec §3.7, §9.2)

The operating model the harness encodes is also the production doctrine. Stated
plainly so the build and the skills enforce it:

1. **Subagents are the coders — always.** The orchestrator plans, reviews,
   reconciles, and steers; it does **not** write ship code. Every code-writing
   task in this plan (P0–P4) is implemented by a dispatched coder subagent in its
   own worktree (`worktrees-by-default`), not inline in the orchestrator context.
2. **Model inheritance.** Coder dispatch resolves `model = explicit ?? session
   model`. This session is `claude-opus-4-8`; a coder dispatched here with no
   `model` runs on `claude-opus-4-8` — never a silent weaker default. Downgrades
   require recorded justification (e.g. a mechanical XS task).
3. **Poll, don't sleep.** The orchestrator dispatches **reactive** coders and
   polls their status. It must not insert long blocking sleeps. Wasted wall-clock
   is wasted supervision capacity; the injected clock (H-6) catches regressions.
4. **Steer via the Plan Inbox.** Guidance to a running coder is written as
   `actor:orchestrator` events (durable, explicit, auditable). A "reconcile now"
   nudge may prompt re-read, but steering **content** lives in the inbox. This is
   the §3.6 explicit-artifact channel — not hidden mid-run injection.
5. **Convergence carve-out.** §3.7 poll-and-steer is the default. `convergence-
   loop` stays strict: fresh blocking one-shot roles, no async/steer/resume. There
   the inbox carries context **between** fresh dispatches; rules 1 and 2 still
   apply to the Builder role.

### How this build is executed (self-application)

This plan is itself executed under the doctrine: the orchestrator dispatches
coder subagents (default model = the session model) per task, polls their status,
and steers them by writing inbox events against this plan's own sections —
dogfooding the ecosystem while building it. The OrchestratorSim (H-6) is the
test-time mirror of that production loop.

### DoD additions (orchestration)

- [ ] All P0–P4 code was produced by dispatched coder subagents, not inline.
- [ ] Coder dispatches resolved `model` to the session model when unspecified.
- [ ] Supervision used poll-and-steer (inbox), with no long blocking sleeps.
- [ ] OrchestratorSim (H-6) green; S14 + S15 pass headless with recorded
      red→green proofs.

Recommended sequencing: build this harness here first (P0–P4 + Addendum A), then
extract the reusable patterns into the skill change so future builds inherit the
mandate by default.

---

# Addendum E — Phase P5: Multi-agent tmux orchestration mode (spec §4.6)

> tmux mode turns the in-process orchestrator into a **fleet controller**: full
> Synaps instances in panes, coordinating through the same Plan Inbox bus, all
> visible in the web portal. This phase is **additive and optional** — when
> `$TMUX` is unset the system runs entirely on in-process subagents (§3.7). It
> depends on the Plan Inbox (P3) and the portal/SSE (P1–P2) already existing.

## P5 assumptions / decisions

- **A-tmux:** `tmux` is available and the orchestrator session is inside it
  (`$TMUX` set). If not, P5 is skipped at runtime (graceful no-op → in-process).
- **B-tmux:** Reuse tmux-tools `tmux` skill conventions (`session:window.pane`
  addressing, pane helpers). Do not reinvent pane plumbing.
- **C-tmux:** `agents.json` is runtime-only and **gitignored** (spec §5.4).
- **D-tmux:** Caps `max_impl_agents` and `max_depth` are declared in the plan
  doc (or settings) before any spawn. Confirm defaults at P5-0.

## Tasks

### P5-0 — tmux-mode decision/detection gate (spike)
- **Description:** Detect `$TMUX`; resolve current pane address; decide caps
  (`max_impl_agents`, `max_depth`) and monitor-arrangement policy. Confirm
  alignment with tmux-tools helpers. Produce a short decision note.
- **Acceptance:** Detection returns correct `session:window.pane`; caps chosen;
  documented fall-back-to-in-process path when `$TMUX` unset.
- **Verification:** `node --test test/server/tmux_detect.test.js` (mocked env)
- **Dependencies:** C3 (Plan Inbox exists) · **Files:** `lib/tmux/*` · **Scope:** S

### P5-1 — Agent registry: model + endpoints (tests first)
- **Description:** Implement the Agent record (spec §5.5) and the registry
  endpoints: `GET/POST /api/agents`, `DELETE /api/agents/:id`,
  `GET /api/agents/stream`. Typed boundary parse of registration payloads;
  bounded; writes `agents.json`.
- **Acceptance criteria:**
  - Register → roster includes agent with pane, role, depth, model, worktree.
  - Heartbeat updates `last_heartbeat`; missed heartbeats mark `dead` (reaper).
  - SSE roster stream emits on register/update/deregister.
  - Malformed/oversized payloads rejected; counts bounded.
- **Verification:** `node --test test/server/agents.test.js`
- **Dependencies:** P5-0, P3-1 · **Files:** `extensions/*`, `lib/registry/*` · **Scope:** M

### P5-2 — Pane lifecycle controller (own-pane-only) (tests first)
- **Description:** Spawn the two-column layout (Orchestrator | Impl), launch a
  Synaps instance in the impl pane, `/clear`, and hand the task **by reference**.
  Track spawned panes in the registry; only control own panes; reap on exit.
  Window-paging for additional impl agents (`27:1.0`, …).
- **Acceptance criteria:**
  - Two full-height columns created; monitors pushed right (stacked).
  - Impl pane gets a fresh Synaps + `/clear` + a by-reference task prompt.
  - Controller refuses to `send-keys`/kill a pane it did not spawn.
  - Spawning past `max_impl_agents`/`max_depth` is refused (backpressure).
  - Orphan/dead panes reaped; mapped worktrees cleaned.
- **Verification:** `node --test test/server/pane_ctl.test.js` (headless tmux server)
- **Dependencies:** P5-1 · **Files:** `lib/tmux/*` · **Scope:** M

### P5-3 — Portal fleet view (monitoring plane) (tests first)
- **Description:** Render the live agent roster in the portal sidebar/dashboard
  from `GET /api/agents` + SSE: who is coding what, pane, worktree, task/section,
  status, attention. Show the agent hierarchy (orchestrator → impl → sub).
- **Acceptance criteria:**
  - Roster renders and updates live as agents register/heartbeat/exit.
  - Hierarchy/tree shown; dead agents drop off; counts correct.
- **Verification:** `node --test test/harness/domprobe.fleet.test.js`
- **Dependencies:** P5-1, P1-4 (sidebar shell) · **Scope:** M

### P5-4 — Grandchild recursion (impl agent as orchestrator) (tests first)
- **Description:** Prove an impl-pane Synaps can itself dispatch in-process
  subagents AND spawn a grandchild pane agent (depth+1), all registering under the
  parent, bounded by `max_depth`.
- **Acceptance criteria:**
  - Impl agent registers grandchildren with `parent` + `depth`.
  - `max_depth` enforced; recursion past it refused.
  - All grandchildren steerable via the same inbox; visible in the portal tree.
- **Verification:** `node --test test/harness/recursion.test.js`
- **Dependencies:** P5-2, P5-3, H-6 · **Scope:** M

### ✅ Checkpoint C5 (gate, after P5)
- [ ] tmux detected → two-column layout spawns; unset → clean in-process fallback.
- [ ] Registry round-trips; reaper marks dead agents; SSE roster live.
- [ ] Own-pane-only enforced; caps/depth enforced; worktrees cleaned on reap.
- [ ] Portal shows the live fleet tree.
- [ ] Headless tmux harness scenarios (S16–S19) green with red→green proofs.

## Harness additions (extends Addendum A)

tmux is fully scriptable headless (own `tmux` server in a temp dir,
`split-window`, `send-keys`, `capture-pane`), so the fleet is CI-testable with
**no human and no real editor**. Stub "agents" are tiny processes that register,
heartbeat, read the inbox, and write `agent_response`.

### New driver — **FleetSim** (extends OrchestratorSim H-6)
Spawns a headless tmux server, drives the pane controller, runs stub agents, and
asserts layout/registry/portal/control.

### New scenarios

| Scenario | Flow | Pass condition |
|---|---|---|
| **S16 two-column-spawn** | Orchestrator spawns impl pane to its right | Layout = two full-height columns; impl pane runs a (stub) agent; monitors pushed right. |
| **S17 fleet-roster** | N stub agents register + heartbeat → portal | `/api/agents` + SSE show all; DomProbe fleet view renders the tree; reaper drops a killed one. |
| **S18 inbox-steer-fleet** | Orchestrator writes `actor:orchestrator` events to two impl agents | Both reconcile via inbox (not pane scraping); responses recorded; audit intact. |
| **S19 grandchild-depth** | Impl agent spawns a grandchild (depth 2); attempt depth past cap | Grandchild registers under parent; over-cap spawn refused; portal tree shows depth. |
| **S20 own-pane-only (fault)** | Controller asked to `send-keys` a foreign pane | Refused; no keystrokes delivered to non-owned pane. |
| **S21 cap-exhaustion (fault)** | Spawn past `max_impl_agents` | Refused/queued; no runaway processes; reap leaves no orphans. |

### New harness task

### H-7 — FleetSim + headless-tmux suite (gates C5)
- **Description:** Headless-tmux harness implementing S16–S21, including the
  own-pane-only and cap-exhaustion faults; integrate into `npm run e2e`.
- **Acceptance:** S16–S21 pass headless; faults assert correct refusal/reap;
  red→green provable; `npm run e2e` includes the fleet suite.
- **Verification:** `node --test test/harness/fleetsim.test.js` ; `npm run e2e`
- **Dependencies:** P5-2, P5-3, P5-4, H-6 · **Scope:** M

## A.5 fault catalog additions (tmux)

- **Foreign-pane control** → refused (own-pane-only, spec §7.2).
- **Untrusted send-keys** (plan/note/pane text into `send-keys`) → never; tasks
  handed by reference only.
- **Cap/depth exhaustion** → refused/queued; bounded processes/worktrees/disk.
- **Orphan panes / leaked worktrees** → reaped + cleaned on agent death.
- **Registry payload injection** (malformed/oversized agent record) → typed
  rejection; a pane-address claim is not authority.

## DoD additions (P5 / fleet)

- [ ] `$TMUX` set → two-column fleet mode; unset → identical results in-process.
- [ ] Agent registry + portal fleet view live and correct.
- [ ] Own-pane-only, caps, depth, and reap/cleanup enforced and fault-tested.
- [ ] Grandchild recursion works and is bounded.
- [ ] FleetSim (H-7) green; S16–S21 with recorded red→green proofs; in `npm run e2e`.

## Addendum C additions (plugin-wide landing)

| Skill | Proposed change |
|---|---|
| `worktrees-by-default` | Add the **agent↔worktree** mapping + fleet cleanup (reap dead agents' worktrees); one worktree per coding agent across the tmux fleet. |
| `convergence-loop` | tmux fleet may run roles as pane agents, but holdout walls + fresh-blocking rules still hold per role; the registry/portal provide the audit trail. |
| (new, optional) `tmux-fleet-orchestration` skill | Formalize the two-column model, pane-addressing-as-agent-space, two-transport control (inbox=content / tmux=lifecycle), bounds/reaping, and the portal monitoring plane. Aligns with tmux-tools `tmux`. |
