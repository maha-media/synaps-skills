# Spec: Dynamic Per-Repo Plan Site Identity & Theme (`engtheme/1`)

**Status:** Draft (pre-implementation)
**Owner:** engineering plugin
**Builds on:** The Plan Site (`plan-site`), HTML Plan Ecosystem (`engplan/1`),
plans-server extension/sidecar
**Related skills:** `spec-driven-development`, `planning-and-task-breakdown`,
`worktrees-by-default`, `incremental-implementation`, `verification-before-completion`

---

## 0. TL;DR

Today the Plan Site is hardcoded to the **Maha Media** brand — a fixed logo,
fixed warm-gold palette, fixed Cormorant/Outfit fonts. Every repo's Plan Site
looks identical and generic.

This spec makes the Plan Site's **identity and visual theme dynamic and
per-repo**: an **LLM inspects the repo** (README, manifests, languages, existing
brand colors/logos, directory name) and generates a `engtheme/1` artifact —
**project title**, **tagline**, a full **color palette**, a **font pairing**, and
an optional **monogram** — that the site renders. The Maha Media brand becomes
just the **default/fallback theme**.

Goal (explicit, from the operator): **a distinct, fitting identity per project
keeps human operators engaged** — the site should feel like *that* project, not a
generic dashboard. Dopamine matters.

This is **v1**: theme schema + store + server rendering + a curated **bundled,
local (no-CDN) font library** + a **deterministic fallback** that works with zero
LLM + the **LLM generation workflow** (`plan theme` + skill) + a real generated
theme for *this* repo on landing.

---

## 1. Objective

### 1.1 What we are building

1. **`engtheme/1` schema + validator** — a small, self-describing theme object.
2. **Theme store** — `.plans/theme.json` (committed, regenerable). One per repo.
3. **Server rendering** — the plans-server applies the theme:
   - browser `<title>` = theme title,
   - sidebar **identity block** (generated wordmark + optional monogram chip)
     **replaces the static Maha logo**,
   - a CSP-safe **`GET /_assets/theme.css`** that emits `:root { --… }` from the
     theme palette + the chosen font `@font-face`s,
   - **live reload** when `theme.json` changes (SSE/file-watch).
4. **Curated bundled font library** — ~5 local WOFF2 font pairings + system-font
   stacks; **zero CDN, zero runtime network**. The LLM picks a pairing by name.
5. **Deterministic fallback inference** (`lib/theme.js`) — when no `theme.json`
   exists, infer a sane title + palette + fonts from repo signals so the site is
   never blank and works **without any LLM**.
6. **LLM generation workflow** — `plan theme` (CLI) emits a **repo digest** for an
   LLM and **validates + writes** the LLM's returned `theme.json`; a skill
   documents how any agent generates a fitting theme for any repo.
7. **Backward compatible** — `engplan/1`, the existing Plan Site, standalone
   `file://` plans, the token gate, asset confinement, SSE, and the Plan Inbox
   are all preserved. No existing test regresses (baseline **493/493**).

### 1.2 Who the user is

- **Human operator** — opens the served site; the per-project identity is *for
  them* (engagement). They are the gate reviewer.
- **LLM agent** (orchestrator or a dispatched subagent) — the one that
  **generates** the theme from the repo. This is the "by the LLM" requirement.
- **Builder/other agents** — unaffected; all existing API surface preserved.

---

## 2. Design tenets (non-negotiable)

1. **Local-first, zero external deps, no CDN, no runtime network.** Fonts are
   **bundled** WOFF2 under `/_assets/fonts/`. The theme palette is plain CSS
   custom properties. Node stdlib only; vanilla JS; no framework/build step.
2. **Never blank, never broken.** If `theme.json` is missing/invalid, the
   deterministic fallback (and ultimately the Maha default) applies. A bad theme
   must **degrade**, never 500 or hide the site.
3. **Additive, not destructive.** Existing routes, token gate, asset confinement
   (`safeRealpath`/`isInside`), SSE contract, CSP, and Plan Inbox semantics are
   preserved exactly. The Maha brand becomes the *default theme*, not deleted.
4. **Self-contained plan files preserved.** Standalone `*.plan.html` on `file://`
   still render (they don't depend on the server theme; they keep their bundled
   `plan.css` fallback look).
5. **Security unchanged.** Token gate on all non-`/_assets/` routes; `theme.css`
   is generated server-side from a **validated** theme (no injection: all values
   pass a strict allowlist/sanitizer before reaching CSS); `/_assets/*` stays
   pre-gate but path-confined; CSP unchanged (theme delivered as a linked
   stylesheet + DOM `setProperty`, never inline `<style>`/`<script>`).

---

## 3. The `engtheme/1` schema

```json
{
  "schema": "engtheme/1",
  "title": "Synaps Engineering",
  "tagline": "agentic toolkit for shipping software",
  "monogram": "SE",
  "palette": {
    "bg": "#0d0d0d",
    "surface": "#161616",
    "surface2": "#1e1e1e",
    "text": "#f5f2eb",
    "muted": "#b8b4aa",
    "border": "rgba(245,242,235,.10)",
    "accent": "#d4a574",
    "accentSoft": "rgba(212,165,116,.12)",
    "stateTodo": "#6a8296",
    "stateDoing": "#d4a574",
    "stateDone": "#7faf8a",
    "stateBlocked": "#d47474",
    "warn": "#d4a054",
    "review": "#d48a74"
  },
  "fonts": { "display": "Cormorant Garamond", "ui": "Outfit" },
  "generated_by": "llm",
  "generated_at": "2026-…Z",
  "rationale": "short note on why these choices fit the project"
}
```

**Validation rules (`lib/theme.js` `parseTheme`):**

- `schema === "engtheme/1"`.
- `title`: non-empty string, ≤ 80 chars (sanitized to text — no markup).
- `tagline`: optional string, ≤ 140 chars.
- `monogram`: optional string, ≤ 3 chars (else derived from title initials).
- `palette`: object; **every** value must be a **strict color** — `#rgb`,
  `#rrggbb`, `#rrggbbaa`, or `rgb()/rgba()` with numeric args only (regex
  allowlist). Any value failing the allowlist is **dropped** and the default
  used (per-key fallback). Unknown keys ignored.
- `fonts.display` / `fonts.ui`: must resolve in the **font registry** (§5) by
  family name (case-insensitive) **or** be one of the system-stack ids; else
  fall back to the default pairing.
- `generated_by` ∈ `{ "llm", "inferred", "default", "human" }` (advisory).
- Anything malformed → that field falls back; a wholly invalid file → the
  inferred theme. **parseTheme never throws** for the render path; a strict
  variant (`parseThemeStrict`) is used by `plan theme` to report errors.

---

## 4. Theme store & resolution order

- File: `.plans/theme.json` (**committed**; not gitignored).
- Resolution order at render time (`lib/theme.js` `resolveTheme(repoRoot)`):
  1. `.plans/theme.json` if present and parseable (per-key fallback applied),
  2. else **deterministic inference** from repo signals (§6),
  3. else the **Maha default** (the current look, as a built-in constant).
- The resolved theme is what the server renders + serves at `/api/theme`.

---

## 5. Bundled font library (local, no-CDN)

A registry (`lib/theme.js` `FONT_REGISTRY`) maps a **family name** → its bundled
WOFF2 + a CSS fallback stack + role hints. Variable fonts; one file per family.

| Family | File (`/_assets/fonts/…`) | Fallback stack | Vibe |
|---|---|---|---|
| Cormorant Garamond | cormorant-garamond-latin.woff2 | Georgia, serif | editorial serif (default display) |
| Outfit | outfit-latin.woff2 | system-ui, sans-serif | clean UI (default ui) |
| Space Grotesk | space-grotesk-latin.woff2 | system-ui, sans-serif | geometric display |
| Inter | inter-latin.woff2 | system-ui, sans-serif | neutral UI |
| JetBrains Mono | jetbrains-mono-latin.woff2 | ui-monospace, monospace | techno/mono display |
| Fraunces | fraunces-latin.woff2 | Georgia, serif | expressive serif display |
| Work Sans | work-sans-latin.woff2 | system-ui, sans-serif | humanist UI |
| Archivo | archivo-latin.woff2 | system-ui, sans-serif | bold/condensed display |

Plus **system stacks** (no file, always available): `system-serif`
(`Georgia, "Times New Roman", serif`), `system-sans`
(`system-ui, -apple-system, Segoe UI, Roboto, sans-serif`), `system-mono`
(`ui-monospace, SFMono-Regular, Menlo, monospace`).

**Suggested pairings** (the LLM may mix any display+ui, but these read well):
`editorial` (Cormorant + Outfit · the Maha default), `geometric` (Space Grotesk
+ Inter), `techno` (JetBrains Mono + Inter), `expressive` (Fraunces + Work Sans),
`bold` (Archivo + Archivo), `clean` (Inter + Inter).

`theme.css` emits `@font-face` **only** for the two families the resolved theme
actually uses (display + ui), then sets `--font-display` / `--font-ui` to
`"<Family>", <fallback stack>`.

---

## 6. Deterministic inference (no-LLM fallback)

`lib/theme.js` `inferTheme(repoRoot)` — bounded, stdlib-only, no network:

- **Title**: first of — `package.json` `name` (prettified) · `Cargo.toml`
  `[package].name` · `pyproject.toml` `name` · top `# H1` of `README*` · the
  repo directory name (title-cased). Tagline: `description` field or README
  subtitle if present.
- **Accent / palette**: scan a small, bounded set of likely brand sources for a
  dominant hex color (e.g. `**/theme*.css`, `**/tailwind.config.*`, an existing
  `:root{--...}`, an SVG logo `fill=`); seed the palette from that accent
  (derive surfaces/text via fixed transforms) — else a **deterministic** accent
  chosen from the repo name hash (stable per repo, varied across repos).
- **Fonts**: a light heuristic from primary language/keywords (e.g. systems/Rust
  → `techno`; docs/marketing → `editorial`/`expressive`; default → `geometric`).
- Always returns a complete, valid theme. `generated_by:"inferred"`.

This guarantees a **distinct-feeling** site even before any LLM runs.

---

## 7. LLM generation workflow (the "by the LLM" part)

The plans-server is a dumb Node process and cannot call an LLM. Generation is
driven by an **agent** via a CLI + skill:

- **`plan theme --digest`** → prints a compact **repo digest** (title candidates,
  detected languages, existing colors found, README excerpt, current theme) +
  the `engtheme/1` schema + the font registry, as a single prompt-ready blob for
  an LLM to consume.
- **`plan theme --write <file.json>`** (or stdin) → validates the LLM's theme
  with `parseThemeStrict`, reports any rejected fields, and writes
  `.plans/theme.json` (`generated_by:"llm"`). On success the live site reloads.
- **`plan theme`** (no args) → prints current resolved theme + source.
- **`plan theme --infer`** → writes the deterministic inferred theme (no LLM).
- A **skill** (`skills/…` or a section in an existing skill) documents the loop:
  read the digest → choose a palette + font pairing + title/tagline/monogram that
  *fit the project's domain and vibe* → return schema-valid JSON → write it. The
  skill stresses **contrast/legibility** (WCAG-ish: text on bg, accent on
  surface) and **taste** (cohesive palette, fitting fonts).
- **Dogfood:** on landing, the orchestrator LLM generates a real theme for *this*
  repo (Synaps engineering toolkit) and commits it so the operator sees a live,
  fitting identity — not the Maha default.

---

## 8. Server changes (`extensions/plans_server.js`)

- `GET /api/theme` (token-gated) → resolved theme JSON `{...engtheme/1...,
  _source: "file|inferred|default"}`.
- `GET /_assets/theme.css` (**pre-gate**, like other assets, but generated, not a
  file) → `:root{ --bg:…; --accent:…; --font-display:…; --font-ui:… }` +
  `@font-face` for the two used families. **All values pass the §3 allowlist
  before emission** (no CSS injection). `Content-Type: text/css`. Short cache.
- `renderShell()` injects the **title** into `<title>` and the **identity block**
  (wordmark text + optional monogram) into the sidebar header — replacing the
  static logo markup. The shell links `/_assets/theme.css` **before**
  `site.css`/`plan.css` so theme vars win.
- File-watch: a change to `.plans/theme.json` broadcasts a `theme` SSE event so
  the open site re-applies the theme (and `theme.css` is re-fetched) **without a
  full reload**.
- New asset type already covered (svg). `theme.css` uses the existing CSS MIME.

---

## 9. Client changes (`assets/site.js`, `assets/site.css`, `assets/shell.html`)

- `shell.html` becomes theme-driven: identity block (`#brand-title`,
  `#brand-monogram`) instead of the fixed logo; link `theme.css`.
- `site.js`: on boot, the theme is already applied via the linked `theme.css`
  (no flash). On a `theme` SSE event, re-fetch `/api/theme`, update the title +
  identity text, and re-link/refresh `theme.css` (cache-bust) — applying new
  palette/fonts live. Use `documentElement.style.setProperty` only if needed
  (CSP-safe); prefer swapping the linked stylesheet.
- `site.css` / `plan.css`: replace any **hardcoded brand values** with the CSS
  variables so the whole UI tracks the theme. The Maha values move into the
  default theme constant (server) + remain as CSS fallbacks for `file://`.

---

## 10. Routes & API summary (delta)

| Route | Method | Auth | Returns |
|---|---|---|---|
| `/api/theme` | GET | token | resolved `engtheme/1` JSON (+ `_source`) **(new)** |
| `/_assets/theme.css` | GET | none (pre-gate) | generated `:root` vars + `@font-face` **(new, sanitized)** |
| `/api/stream?plan=…` | GET (SSE) | token | now also emits `theme` events on theme.json change |

All other routes unchanged.

---

## 11. File plan

**New:**
- `lib/theme.js` — schema/validator (`parseTheme`/`parseThemeStrict`),
  `FONT_REGISTRY`, `resolveTheme`, `inferTheme`, `themeCss(theme)` (sanitized
  emitter), `defaultTheme` (Maha).
- `assets/fonts/{space-grotesk,inter,jetbrains-mono,fraunces,work-sans,archivo}-latin.woff2`
  (already staged; plus existing cormorant + outfit).
- Tests under `test/server/` (see §13).
- (Optional) `skills/dynamic-theme/SKILL.md` *or* a section in an existing skill
  documenting the LLM generation loop.

**Changed:**
- `extensions/plans_server.js` — `/api/theme`, `/_assets/theme.css`, themed
  `renderShell`, theme file-watch → SSE.
- `assets/shell.html` — identity block + `theme.css` link.
- `assets/site.js` — live theme apply on SSE; identity text update.
- `assets/site.css`, `assets/plan.css` — drive off CSS vars; Maha values become
  fallbacks/default.
- `bin/plan.js` — `plan theme` subcommand (`--digest`/`--write`/`--infer`/none).
- `.synaps-plugin/plugin.json` — register `theme.css` is generated (no manifest
  entry needed); add the new font files to the asset manifest; (maybe) a `plan
  theme` command alias.

---

## 12. Non-goals (v1)

- LLM **calls** from inside the plugin (no API keys / no network at runtime;
  generation is agent-driven via the digest).
- Per-user / multi-theme switching in the browser (one resolved theme per repo).
- Arbitrary Google-Font fetching at generation time (curated bundled library
  only in v1; agent-time fetch+bundle is a documented future option).
- Generated raster logos / image assets (wordmark + monogram text only; inline
  SVG monogram allowed if it passes sanitize).
- Light/dark *toggle* (the theme itself sets the mood; a toggle is future work).

---

## 13. Acceptance (the gate)

**Automated (must pass before human review):**
- Full suite green: **≥493/493** (baseline preserved + new tests).
- New tests:
  - `parseTheme` accepts a valid theme; **rejects/repairs** bad colors
    (injection attempt like `red;}body{...` → dropped), over-long title, bogus
    font → per-key fallback; `parseThemeStrict` reports errors.
  - `resolveTheme` order: file → inferred → default; `inferTheme` returns a
    valid theme from a fixture repo (title from package.json; accent from a
    fixture css).
  - `GET /api/theme` → 200 resolved (file vs inferred vs default); token still
    required (401 without).
  - `GET /_assets/theme.css` → 200 `text/css`, contains the resolved
    `--accent`, `@font-face` for the used families only, **no** unsanitized
    input echoed (CSS-injection fixture proves it's stripped); pre-gate (no
    token) but path/behavior confined.
  - `theme` SSE event fires when `.plans/theme.json` changes (file-watch).
  - `renderShell` injects the theme title + identity block (no static Maha logo
    when a theme is set).
  - No-CDN proof: grep served HTML/CSS finds zero external font/asset URLs;
    `@font-face` references only `/_assets/fonts/*.woff2`.
  - Degraded `file://` standalone plan still renders.
- `plan theme --infer` writes a valid `.plans/theme.json`; `plan theme --write`
  rejects an invalid theme with a clear error and **does not** write.

**Human (the meaningful review):**
- Operator opens the live served site for **this** repo and confirms:
  - The sidebar header shows the **generated project title/wordmark** (+ monogram)
    — **not** the Maha logo; browser tab title matches.
  - The **palette + fonts** are distinct and fitting, legible/contrasty, applied
    across sidebar + plan detail.
  - Editing `.plans/theme.json` (or re-running `plan theme`) **re-themes the live
    site without a full reload**.
  - It still works (plans list, detail, live updates) and **feels** like a
    distinct product — the engagement goal.
- Operator **approves the gate**.

---

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| CSS injection via theme values | Strict allowlist for every color; title/tagline/monogram sanitized to text; `themeCss` emits only validated tokens; CSS-injection test. |
| Unreadable/low-contrast LLM palette | Skill stresses contrast; inference uses safe transforms; (optional) a contrast check warns in `plan theme --write`. |
| Breaking the 493 baseline | Additive routes; Maha becomes default theme; per-key fallback; full suite each checkpoint. |
| Fonts via CDN sneaking in | Bundle WOFF2; `theme.css` references only `/_assets/fonts/*`; no-CDN grep test. |
| `theme.json` malformed → site breaks | `parseTheme` never throws on render path; falls back to inferred/default. |
| Flash of default theme before JS | `theme.css` is a **linked stylesheet in `<head>`** (applied pre-paint), not JS-applied. |
| Asset traversal via theme.css path | `theme.css` is generated (not a file read); other `/_assets` confinement unchanged; keep traversal test. |
```
