---
name: dynamic-theme
description: Use when generating or refining a per-repo Plan Site identity & visual theme (engtheme/1) — title, tagline, monogram, color palette, and font pairing — from a repository's own files. Covers the `plan theme` digest→write loop, the strict color/contrast rules, the bundled (no-CDN) font registry, and the never-break fallback chain.
---

# Dynamic Per-Repo Theme (`engtheme/1`)

*Where this fits: an enhancement to the **Plan Site**. The site's identity and
palette are dynamic and per-repo — an LLM inspects the repo and generates a
fitting `engtheme/1` theme so the served site **feels like that project**, not a
generic dashboard. The Maha-Media look is just the default/fallback.*

Goal (from the operator): **a distinct, fitting identity per project keeps human
operators engaged.** Taste and legibility matter.

---

## When to use this skill

- The operator asks to "theme the plan site", "give this repo its own identity",
  or "regenerate the theme".
- You are landing a feature on a repo whose Plan Site still shows the default
  (Maha) brand and you want a fitting identity.
- A `theme.json` exists but reads poorly (low contrast, off-vibe fonts/colors).

You do **not** need this skill for normal plan work — the site always renders
(inferred or default theme) without any LLM.

---

## The model (how generation works)

The plans-server is a dumb Node process: it **cannot call an LLM**. Generation is
**agent-driven** through a CLI:

1. `plan theme --digest` → prints a compact, prompt-ready **repo digest**: title
   candidates, detected languages, any brand color found, a README excerpt, the
   current resolved theme, the `engtheme/1` schema, and the bundled font registry.
2. **You (the LLM)** read the digest and design a theme that fits the project's
   domain and vibe.
3. `plan theme --write <file.json>` (or `… --write -` for stdin) → validates your
   JSON with the strict validator, **rejects** (non-zero exit, no write) on any
   error, and on success writes `.plans/theme.json` (`generated_by:"llm"`). The
   live site re-themes via SSE — no full reload.

Other entry points: `plan theme` (show current + source), `plan theme --infer`
(write the deterministic, no-LLM inferred theme).

---

## The loop

```
plan theme --digest > /tmp/digest.txt      # read the repo
# … design the theme (see rules below) …
cat > /tmp/theme.json <<'JSON'             # schema-valid engtheme/1
{ "schema": "engtheme/1", "title": "…", … }
JSON
plan theme --write /tmp/theme.json         # validate + write (or reject)
```

If `--write` reports rejected fields, **fix them and rerun** — never hand-edit
`.plans/theme.json` to bypass validation.

---

## The `engtheme/1` schema

```json
{
  "schema": "engtheme/1",
  "title": "Synaps Engineering",
  "tagline": "agentic toolkit for shipping software",
  "monogram": "SE",
  "palette": {
    "bg": "#0d0d0d", "surface": "#1e1e1e", "surface2": "#161616",
    "text": "#f5f2eb", "muted": "#b8b4aa", "border": "rgba(245,242,235,.10)",
    "accent": "#d4a574", "accentSoft": "rgba(212,165,116,.12)",
    "stateTodo": "#6a8296", "stateDoing": "#d4a574", "stateDone": "#7faf8a",
    "stateBlocked": "#d47474", "warn": "#d4a054", "review": "#d48a74"
  },
  "fonts": { "display": "Cormorant Garamond", "ui": "Outfit" },
  "generated_by": "llm",
  "rationale": "why these choices fit the project"
}
```

- **title** ≤ 80 chars (sanitized to text). **tagline** ≤ 140 (optional).
  **monogram** ≤ 3 chars (optional; else derived from title initials).
- **palette**: every value MUST be a strict color: `#rgb`, `#rrggbb`,
  `#rrggbbaa`, or `rgb()/rgba()` with numeric args only. Any other value is
  **dropped** and the default used. (This is the CSS-injection guard — there is
  no way to smuggle CSS through a color.)
- **fonts.display / fonts.ui**: a family name from the registry (case-insensitive)
  **or** a system-stack id. Anything else falls back to the default pairing.

---

## Bundled font registry (local, no CDN)

Display/UI families (one variable WOFF2 each, served from `/_assets/fonts/`):
**Cormorant Garamond**, **Outfit**, **Space Grotesk**, **Inter**,
**JetBrains Mono**, **Fraunces**, **Work Sans**, **Archivo**.

System stacks (always available, no `@font-face`): `system-serif`,
`system-sans`, `system-mono`.

Suggested pairings (you may mix any display+ui, but these read well):
- `editorial` — Cormorant Garamond + Outfit (the Maha default; refined/editorial)
- `geometric` — Space Grotesk + Inter (modern product/tooling)
- `techno` — JetBrains Mono + Inter (systems/infra/Rust/Go)
- `expressive` — Fraunces + Work Sans (brand/marketing/docs)
- `bold` — Archivo + Archivo (punchy, condensed)
- `clean` — Inter + Inter (neutral, utilitarian)

**No external fonts.** v1 is the curated bundled library only — never reference a
Google-Font/CDN URL.

---

## Design rules (taste + safety)

1. **Fit the domain.** A Rust systems tool wants `techno`/`geometric` + a cool
   accent; a docs/marketing repo wants `expressive`/`editorial` + a warmer one.
   Read the README excerpt and languages from the digest.
2. **Contrast & legibility (non-negotiable).** Body `text` on `bg` must be clearly
   readable (aim WCAG AA, ~7:1 for body). `accent` must read on both `bg` and
   `surface`. Keep `muted` distinct from `text` but still legible. Dark, low-glare
   surfaces work best for long review sessions.
3. **Cohesive palette.** Derive `surface`/`surface2` as subtle steps from `bg`;
   keep `border` a low-alpha tint of `text`. Make `accentSoft` a low-alpha tint of
   `accent`. The four state colors should stay semantically clear (done=green-ish,
   blocked=red-ish, doing=accent, todo=cool/neutral).
4. **Identity.** A short, human **title** (the project's real name, prettified),
   an optional one-line **tagline**, and a 1–3 char **monogram** (initials or a
   fitting glyph). The title becomes the wordmark + browser tab title.
5. **Write a `rationale`** — one sentence on why the choices fit. It documents
   intent for the next agent.

---

## Guardrails (do not violate)

- **Validate, don't bypass.** Always go through `plan theme --write`. If it
  rejects a field, fix the source — never edit `.plans/theme.json` to sneak past
  the validator.
- **No CDN / no network.** Fonts are the bundled families only; colors are plain
  CSS values. The generated `theme.css` references only `/_assets/fonts/*`.
- **Never break the site.** A bad/missing theme degrades to inferred → default;
  the render path never throws. Your job is to make it *fitting*, not to make it
  *load* — that already works.
- **Commit it.** `.plans/theme.json` is tracked (regenerable). Commit the theme
  so the operator sees the identity on next serve.
