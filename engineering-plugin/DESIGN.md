# DESIGN CONTRACT — HTML Plan Ecosystem (engplan/1)

Authoritative interface contract for all implementation work. Spec:
`specs/html-plan-ecosystem.md`. Plan: `specs/html-plan-ecosystem.impl-plan.md`.

## Hard constraints
- **Node.js stdlib only.** No third-party npm packages, no network install, no
  build step. Renderer is vanilla JS. (Decisions A,#1,#7 → Node stdlib.)
- Server lives **inside** `engineering-plugin/` (Decision B,#4).
- Transport: **SSE**. **One server per repo**, bound to `127.0.0.1` random port.
- `.plans/` committed by default; `agents.json` gitignored.
- Tests: `node --test`. No jsdom — use the vendored DOM shim (`test/harness/dom.js`).

## Universal module pattern (works in Node `require` AND browser `<script>`)
Every shared `assets/*.js` module ends with:
```js
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.EngPlanFoo = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  // ... define API ...
  return { /* public API */ };
});
```
Node tests do `const X = require("../../assets/engplan.js")`. Browser gets
`window.EngPlanFoo`. Renderer (`plan.js`) consumes globals in browser and
`require` in tests via the same pattern.

## File ownership map (avoid collisions)
| File | Owner task(s) | Exports |
|---|---|---|
| `assets/engplan.js` | P0-1, P3-0 | `parseEngPlan`, `parseSection`, `parseEvent`, `parseNote`, enums, `lifecycle` (transition validator) |
| `assets/md.js` | P0-2 | `mdToHtml(src)` (raw, unsafe HTML string) |
| `assets/sanitize.js` | P0-2 | `sanitizeHtml(html)`, `renderMarkdown(src)` = sanitize(mdToHtml(src)) |
| `assets/plan.js` | P0-3,P0-4,P0-5,P2-3,P3-2,P3-6,P4-1,P3-7 | `renderPlan(appEl,plan,opts)`, `applySectionPatch(plan,patch,appEl)`, `subscribeLive(slug,cb,opts)`, `mountActions`, `boot()` |
| `assets/plan.css` | P0-3,P3-2 | styles |
| `assets/shell.html` | P1-4,P3-7,P5-3 | sidebar shell |
| `lib/paths.js` | P4-SEC-3 | `safeResolve(root, p)`, `isInside(root, p)`, `canonical(p)` |
| `lib/inbox.js` | P3-4,P3-5,P3-6,P3-7 | `transition(ev,next)`, `reconcile(plan,events,agentFns)`, `computeAttention(events,plan)`, `blockedSections(events)`, `haltedTasks(plan,events)` |
| `lib/store.js` | P3-1 | `readNotes(plansDir,slug)`, `appendEvent(plansDir,slug,ev)`, atomic write, body/event caps |
| `lib/discovery.js` | P1-3 | `discover(repoRoot, opts)` bounded scan |
| `lib/watch.js` | P2-1 | `watchPlans(plansDir, onChange, opts)` debounced |
| `lib/registry/index.js` | P5-1 | agent registry CRUD + reaper |
| `lib/tmux/index.js` | P5-0,P5-2 | detect, pane controller (own-pane-only, caps) |
| `extensions/plans_server.js` | P1-1..P1-4,P2-2,P2-4,P3-1,P3-3,P5-1 | `createServer({repoRoot,pluginDir,token,limits})` → returns `{httpServer, port, url, close}`; JSON-RPC stdio loop guarded by `if (require.main === module)` |
| `test/harness/dom.js` | H-0 | minimal DOM shim: `makeDocument()` → document with createElement, getElementById, querySelector(All), classList, dataset, addEventListener, dispatchEvent, textContent, innerHTML (stored+serialized), `serialize()` |
| `test/harness/runner.js` | H-0 | `withServer(fn)` ephemeral SUT in temp repo; `withTempRepo`, injectable `clock`, `ids` |
| `test/harness/scenarios/*.js` | H-1..H-7 | S1..S21 |
| `test/harness/cli.js` | H-0 | `--list`, run scenario by name, `--prove` |
| `test/harness/e2e.js` | H-5 | run all scenarios headless, exit non-zero on fail |

## Core types (engplan/1) — see spec §5
- Plan: `{schema:"engplan/1", kind:"plan"|"spec", slug, title, status, convergence, created_at, updated_at, sections:Section[]}`
- Section: `{id, heading, type:prose|task|risk|gate|criteria|evidence, md?, state?:todo|doing|done|blocked, approval?:none|needs-human-review|approved, risk?:none|risky|security-sensitive, acceptance?:string[], verification?:string[], depends_on?:string[], human_notes?, agent_response_required?}`
- Event: `{id, plan_id, section_id, type:<14 actions>, actor:human|orchestrator|agent, author, text, status:open|acknowledged|incorporated|rejected|deferred|blocked, created_at, agent_status?, agent_response?, changed_sections?:string[], responded_at?}`
- 14 actions: comment, request_change, block, approve, reprioritize, mark_risky, add_acceptance_criterion, clarify, force_verification, defer, split_task, merge_task, escalate_convergence, require_security_review, do_not_touch
- Lifecycle: `open → acknowledged → incorporated|rejected|deferred|blocked`. Terminal: incorporated/rejected/deferred.

## Attention counter mapping (Decision G)
- `blocking`: count of open/acknowledged `block` events.
- `unresolved`: count of open/acknowledged `comment|request_change|clarify` events.
- `needs_review`: count of sections with `approval=="needs-human-review"` PLUS open `approve` requests.

## Server endpoints (spec §6)
GET `/_assets/<file>`, GET `/`, GET `/api/plans`, GET `/plan/<id>`,
GET `/api/stream?plan=<id>`, GET `/api/notes?plan=<id>`, POST `/api/notes`,
POST `/api/events/:id/respond`, GET/POST `/api/agents`, DELETE `/api/agents/:id`,
GET `/api/agents/stream`.

## Security controls (spec §7) — all test-first
loopback-only + random port; per-session token (on by default) on every request
via `?token=` or `X-Plan-Token`; path canonicalization + traversal/symlink reject;
write confinement to `*.notes.json`/`*.events.json`/`agents.json` under `.plans/`;
body-size limit, event cap, SSE conn cap, bounded discovery; CSP header
`script-src 'self' /_assets/`; sanitize all markdown+note text.

## Token convention
`createServer` generates a token (crypto.randomBytes hex) unless passed. Renderer
reads token from `window.__PLAN_TOKEN__` injected by server into served HTML, or
from `?token=` in URL. Never written into `.plans/` artifacts.
