# Spec: The Plan Site (unified SPA shell + Maha Media brand)

**Status:** Draft (pre-implementation)
**Owner:** engineering plugin
**Builds on:** `engplan/1` (HTML Plan Ecosystem), plans-server extension/sidecar
**Related skills:** `spec-driven-development`, `planning-and-task-breakdown`, `worktrees-by-default`, `incremental-implementation`, `verification-before-completion`

---

## 0. TL;DR

Today the plans-server serves **two disconnected pages**:

- `/` → `shell.html`: a sidebar that lists plans, with a static "Select a plan."
  main pane. Clicking a plan does a **full-page navigation**.
- `/plan/:slug` → the plan's **own self-contained HTML file**, which has **no
  sidebar at all** — just the rendered plan.

The result is not a site; it's two screens that don't know about each other, with
plain GitHub-dark styling.

This spec turns the plans-server into **one cohesive single-page application** —
"The Plan Site" — with a **persistent sidebar**, **client-side routing**, a
**cooler plan-detail view**, and a **distinct Maha Media visual identity** (dark
+ warm-gold editorial aesthetic). Plan `.html` files stay self-contained so
`file://` degraded mode still works, but when **served**, the SPA shell takes
over and renders everything in-app with live SSE updates.

This is **v1**: unified shell + sidebar + cooler plan detail + brand. The
Dashboard, Fleet, and Inbox views are scoped as a **follow-up** (§9).

---

## 1. Objective

### 1.1 What we are building

A served experience in which:

1. **One app shell** owns the chrome (sidebar + main pane + brand header) and is
   served for `/`, `/plan/:slug`, and any future view route.
2. **Client-side routing** (History API) — navigating between plans never
   full-reloads; the sidebar persists and the main pane swaps.
3. **A JSON plan API** (`GET /api/plan/:id`) returns the parsed `engplan/1` JSON
   so the SPA fetches + renders without scraping HTML.
4. **A cooler plan-detail view** — progress bar (done/total tasks), status pills,
   section-type icons, sticky section-jump nav, collapsible sections, inline
   inbox threads (the existing Plan Inbox UI, restyled).
5. **The Maha Media brand** — bundled fonts, warm-gold palette, logo, subtle
   gold-glow textures — applied across the whole site.
6. **Live everywhere** — SSE plan patches + sidebar attention counters update in
   place without reloads.
7. **Backward compatible** — standalone plan files and `file://` degraded mode
   keep working unchanged.

### 1.2 Who the user is

- **Human operator** — opens the served site to watch/steer agent work; the
  "cooler" experience is for them. They are the gate reviewer (§8).
- **Orchestrator / Builder agents** — unaffected; the existing API surface
  (`/api/plans`, `/api/notes`, `/api/stream`, `/plan/:id`) is preserved.

---

## 2. Design tenets (non-negotiable)

1. **Local-first, zero external deps, no CDN.** Fonts are **bundled** as WOFF2
   under `/_assets/fonts/`. No network calls at runtime. (Node stdlib only,
   vanilla JS, no framework, no build step.)
2. **Self-contained plan files preserved.** `plan new` still emits a standalone
   `*.plan.html` with embedded `engplan/1` JSON that renders on `file://` with no
   server (degraded mode). The SPA is an **enhancement layer on top**, never a
   replacement of the embedded artifact.
3. **Additive, not destructive.** The existing API routes, token gate, asset
   confinement, SSE contract, and Plan Inbox semantics are preserved exactly.
   No existing test may regress (baseline **447/447**).
4. **Graceful degradation.** If JS fails or the renderer is absent, a served
   plan still shows its content (server can fall back to embedded JSON). If
   fonts fail to load, system serif/sans fallbacks apply.
5. **Security unchanged.** Token gate still applies to all non-`/_assets/`
   routes; `/_assets/*` (now including `fonts/` and the logo) stays exempt but
   path-confined via `safeRealpath`; CSP unchanged; token resolver order
   preserved (`window.__PLAN_TOKEN__` → URL `?token=` → ctx).

---

## 3. Architecture

### 3.1 One shell, many routes

The server serves the **same app shell HTML** for all SPA routes:

- `/` — home (v1: redirect/route to the first/most-recent plan, or an empty
  state inviting selection; full Dashboard is §9).
- `/plan/:slug` — when requested **as a navigation** (HTML accept), serve the
  shell; the SPA reads the slug from the URL and fetches `/api/plan/:slug`.
- `/_assets/*` — static assets (CSS, JS, fonts, logo), served before the token
  gate, path-confined.

**Backward-compat carve-out:** direct/standalone consumption of a plan file
(opening `*.plan.html` from disk, or any non-SPA fetch) must still work. The
server keeps the ability to return the **standalone plan file** for `/plan/:id`
when appropriate (see §3.4 decision). The SPA itself never needs the standalone
file — it uses the JSON API.

### 3.2 Client-side router

A tiny vanilla router (`site.js`) using the History API:

- Intercepts in-app `<a>` clicks to known routes → `pushState` + render, no
  reload.
- Handles `popstate` (back/forward).
- Resolves the active view from `location.pathname`:
  `/` → home, `/plan/:slug` → plan detail.
- Always carries the `?token=` param across navigations (token resolver order).
- Falls back to normal navigation for unknown/external links.

### 3.3 JSON plan API

`GET /api/plan/:id` → `200` `{ ...engplan/1 JSON... }` (token-gated):

- Server-side: locate the plan file (existing `findPlanPath`), read it, extract
  the embedded `engplan/1` JSON (reuse `discovery.extractPlanJson`), validate
  via `EngPlan.parseEngPlan`, return it.
- `404` if not found; `400` if id invalid (`EngPlan.validId`); `422`/`409` (TBD
  in impl) if the file exists but JSON is unparseable — with enough info for the
  SPA to show a useful error.
- Notes/events for the plan continue to come from `GET /api/notes?plan=:id`
  (unchanged), so the detail view composes plan + notes.

### 3.4 `/plan/:id` content negotiation (decision point)

Two acceptable strategies — **the impl plan picks one and documents it**:

- **(A) Always serve the shell** for `/plan/:id` HTML navigations; the SPA
  fetches JSON. Standalone file access remains available via a distinct path
  (e.g. `/raw/plan/:id` or the file on disk). Cleanest SPA, but changes what a
  curl of `/plan/:id` returns.
- **(B) Content-negotiate**: serve the shell when the request looks like a
  browser navigation (`Accept: text/html` + SPA marker), else serve the
  standalone file. Preserves `curl /plan/:id` behavior; slightly more logic.

Either is fine; **(B) preferred** to avoid breaking existing expectations and the
447 baseline. The standalone file must remain reachable somehow.

### 3.5 Plan-detail view (the "cooler" part)

Reuse the existing `PlanRenderer` (`plan.js`) for section rendering and the Plan
Inbox UI (actions + threads) — **restyle**, don't rewrite the inbox logic.
Add, in `site.js` / CSS:

- **Plan header**: title (display serif), status pill, kind, convergence badge,
  last-updated, and a **progress bar** = `done tasks / total tasks` with a
  numeric label. Progress computed client-side from `sections[type==task].state`.
- **Section-jump nav**: a sticky in-page nav (right rail or under the header)
  listing sections with their type icon + state dot; click scrolls to section.
- **Section cards**: type icons (prose/task/risk/gate/criteria/evidence), state
  dots/pills using the brand status palette; collapsible (remember open/closed
  per session is optional).
- **Inline inbox**: existing thread + action composer, restyled to brand.
- **Live**: subscribe to `/api/stream?plan=:slug`; apply section patches via the
  existing `applySectionPatch`; update the progress bar + sidebar counters on
  change.

### 3.6 Sidebar (hooked in properly)

Persistent across all routes. From `GET /api/plans`:

- Brand header: **mahamedia logo** + "Plans" wordmark.
- **Filter/search** box (client-side filter by title/slug/kind/status).
- Plan rows: title, kind glyph, **status pill**, and the attention counters
  (blocking / unresolved / needs-review) as colored chips (existing data).
- **Active-route highlight** for the current plan.
- Live: subscribe to `/api/agents/stream` (roster) is out of v1 scope, but the
  sidebar **attention counters refresh** when the open plan changes (re-fetch
  `/api/plans` on `filechange`/note events, debounced).
- Collapsible on narrow viewports (responsive).

### 3.7 Brand system

CSS custom properties (single source of truth in `plan.css` / a new
`site.css`):

```
--bg:#0d0d0d  --surface:#1e1e1e  --surface-2:#161616
--text:#f5f2eb  --muted:#b8b4aa  --border:rgba(245,242,235,.08)
--gold:#d4a574  --gold-soft:rgba(212,165,116,.12)
--state-todo:#6a8296  --state-doing:#d4a574  --state-done:#7faf7f(*) 
--state-blocked:#d47474  --warn:#d4a054  --review:#d48a74
(* exact done-green TBD; harmonize with warm palette, may use a muted sage)
--font-display:"Cormorant Garamond",Georgia,serif
--font-ui:"Outfit",system-ui,-apple-system,sans-serif
```

- **Fonts**: `@font-face` for the two bundled WOFF2 (variable fonts; one file
  each covers all weights), with system fallbacks. `font-display:swap`.
- **Display serif** for plan/section headings + brand wordmark; **Outfit** for
  all UI/body.
- **Texture**: subtle radial gold-glow background on the shell; thin gold
  divider lines; gold focus rings.
- **Logo**: bundled SVG at `/_assets/mahamedia-logo.svg`, recolored via
  `currentColor`/CSS to off-white.
- Existing `plan.css` tokens are migrated to the brand palette so standalone
  plan files (which load `/_assets/plan.css`) also get the new look.

---

## 4. Routes & API summary

| Route | Method | Auth | Returns |
|---|---|---|---|
| `/` | GET | token | app shell (SPA) |
| `/plan/:id` | GET | token | app shell (HTML nav) **or** standalone file (§3.4) |
| `/api/plan/:id` | GET | token | `engplan/1` JSON (**new**) |
| `/api/plans` | GET | token | plan list (unchanged) |
| `/api/notes?plan=:id` | GET/POST | token | inbox (unchanged) |
| `/api/stream?plan=:id` | GET (SSE) | token | live patches (unchanged) |
| `/_assets/*` | GET | none (pre-gate) | css/js/fonts/logo, path-confined |

All other existing routes unchanged.

---

## 5. File plan

**New:**
- `assets/site.js` — SPA shell: router, sidebar, view mounting, live wiring.
- `assets/site.css` — brand + shell + sidebar + plan-detail layout (or fold into
  `plan.css`; impl decides; keep one source of brand tokens).
- `assets/fonts/outfit-latin.woff2`, `assets/fonts/cormorant-garamond-latin.woff2`
  (already staged).
- `assets/mahamedia-logo.svg` (already staged).

**Changed:**
- `assets/shell.html` — becomes the SPA shell template (brand header, sidebar
  container, main mount point, load `site.js` + `site.css`).
- `assets/plan.css` — migrate tokens to brand palette (shared by standalone
  files).
- `extensions/plans_server.js` — add `GET /api/plan/:id`; implement `/plan/:id`
  content negotiation (§3.4); ensure new asset types (`woff2`, `svg`) are served
  with correct MIME + caching and remain path-confined.
- `assets/plan.js` — minor: expose any helpers `site.js` needs (e.g. compute
  progress, render into a provided container) **without breaking its existing
  universal-module / boot contract** used by standalone files and tests.

**Possibly changed:**
- `bin/plan.js` — `plan new` scaffold may reference the new shell/assets; verify
  the standalone template still self-renders on `file://`.

---

## 6. Non-goals (v1)

- Dashboard / Fleet / global-Inbox views (→ §9 follow-up).
- Editing plans in the browser (notes/events only, as today).
- Auth beyond the existing token gate.
- Any framework, bundler, transpiler, or external runtime dependency.
- Mobile-first design (responsive-acceptable, but desktop is the target).

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Breaking the 447 baseline | Additive routes; content-negotiate `/plan/:id`; run full suite each checkpoint. |
| Breaking `file://` degraded mode | Keep standalone template self-contained; add an explicit degraded-mode test. |
| Fonts/logo via CDN sneaking in | Bundle WOFF2 + SVG; grep the build for any `http`/`fonts.googleapis` reference; CSP stays restrictive. |
| Token lost across SPA nav | Router always re-appends `?token=`; reuse `resolveToken`. |
| Asset traversal via new types | `safeRealpath` confinement covers `fonts/`, `*.svg`, `*.woff2`; add a traversal test. |
| `plan.js` contract drift breaks tests | Keep exports + boot behavior; add SPA helpers as new exports only. |

---

## 8. Acceptance (the gate)

**Automated (must pass before human review):**
- Full suite green: **≥447/447** (baseline preserved + new tests).
- New tests: `GET /api/plan/:id` (200 valid / 404 missing / 400 bad-id /
  unparseable case); `/plan/:id` content negotiation (shell vs standalone);
  asset serving for `woff2`/`svg` with path confinement (traversal → 403);
  standalone `file://` degraded-mode render still works; token carried across
  a simulated SPA navigation (router unit).
- No-CDN proof: grep finds zero external font/asset URLs in served HTML/CSS/JS.

**Human (the meaningful review for this work):**
- Operator opens the live served site and confirms:
  - Sidebar persists; clicking plans swaps the main pane with **no full reload**;
    active plan highlighted; search/filter works.
  - Plan detail shows progress bar, status pills, section icons, section-jump
    nav; live SSE updates land without reload.
  - The Maha Media brand is applied and looks good (fonts, gold, logo, texture).
  - Back/forward buttons work; deep-linking to `/plan/:slug?token=…` works.
- Operator **approves the gate** in the plan.

---

## 9. Follow-up (post-v1)

- **Dashboard / Home**: aggregate cards (plan count, total attention, recent
  activity, fleet status).
- **Fleet view**: live agent roster (`/api/agents/stream`).
- **Global Inbox**: every event needing attention across all plans, with
  jump-to-section.
- **Theme toggle**: light variant of the brand.
- **Command palette / keyboard nav.**
