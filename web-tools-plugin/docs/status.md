# status — Memory & failure dashboard

Two scripts for inspecting and curating the plugin's self-healing memory:

- `scripts/status/web-status.js` — read-only dashboard
- `scripts/status/web-consolidate.js` — review-gated note generator

Both shell out to the same `failures.jsonl` and `_lib/memory.js` the
capability scripts use.

---

## web-status — dashboard

Surfaces:

- **Notes inventory** — total, by kind, by domain, by status
- **Failure counts** — total, last 24h, last 7d
- **Top recurring tuples** — `(host, op, err_class)` sorted by count
- **STALE flags** — tuples with ≥2× failures in 7d (the threshold that
  triggers the in-script `STALE:` warning)
- **Suggested next actions** — per-tuple advice keyed off `err_class`
- **VelociRAG health** — binary present, db built, db size

### Usage

```bash
node scripts/status/web-status.js                         # full dashboard
node scripts/status/web-status.js --since 24h             # recent only
node scripts/status/web-status.js --top 5                 # top-N tuples
node scripts/status/web-status.js --host github.com       # filter
node scripts/status/web-status.js --op fetch              # filter
node scripts/status/web-status.js --json                  # machine-readable
node scripts/status/web-status.js --json-failures         # raw log as JSON array
node scripts/status/web-status.js --purge-old 30          # trim raw log
```

### Sample output

```
┌─ web-tools status ─────────────────────────────────────────────────
│  memory root:  ~/.synaps-cli/memory/web
│  velocirag:    ✓ velocirag, version 0.7.4
│  db:           ✓ 290 KB
├─ notes ────────────────────────────────────────────────────────────
│  total: 12
│  by kind:    fix=8  runbook=3  caveat=1
│  top domains: github-com=4  arxiv-org=3  youtube-com=2
├─ failures ─────────────────────────────────────────────────────────
│  total: 47   last_24h: 6   last_7d: 18
│  by class:   http_403=12  timeout=8  http_429=7  dns=5
│  by host:    github.com=15  scholar.google.com=9  ...
│  by op:      fetch=22  scholar=9  browser=8  ...
├─ top recurring tuples (host, op, err_class) — top 10 ─────────────
│    7× github.com  fetch  http_403 ⚠ STALE
│        last: 2026-04-26T04:21:46Z  recent_7d: 5
│        ↳ HTTP 403 — rate limit or auth required
│    ...
├─ suggested next actions ──────────────────────────────────────────
│  • (github.com, fetch, http_403) is stale — try:
│      velocirag search "github.com http_403" --db ~/.synaps-cli/memory/web/db
│      → if no useful note: web-consolidate --host github.com --op fetch
│      → may need cookies / auth header — try `browser` capability
└────────────────────────────────────────────────────────────────────
```

---

## web-consolidate — review-gated note generator

Scans `failures.jsonl` for recurring `(host, op, err_class)` tuples and
drafts markdown notes (with frontmatter, `kind-fix` tag) from them.

**Default mode is dry-run** — proposals print to stdout. The agent (or
human) reviews, then either:

- runs again with `--commit` to actually write notes + reindex, or
- runs with `--draft DIR` to save drafts for human edit

This is the **review gate**: scripts auto-log raw failures, but
curated notes only land via this command.

### Usage

```bash
# Dry-run — print all proposals (≥2× recurrence)
node scripts/status/web-consolidate.js

# Filter to one tuple
node scripts/status/web-consolidate.js --host github.com --op fetch

# Higher threshold (only patterns seen 5+ times)
node scripts/status/web-consolidate.js --threshold 5

# Save drafts for human review (you can edit these before committing)
node scripts/status/web-consolidate.js --draft ./drafts

# Auto-commit (skips review — use only when you trust the patterns)
node scripts/status/web-consolidate.js --commit

# Machine-readable
node scripts/status/web-consolidate.js --json
```

### What gets generated

For each `(host, op, err_class)` tuple seen ≥ threshold times:

```markdown
---
tags: ["kind-fix", "op-fetch", "err-http_403", "domain-github-com"]
status: proposed
title: "github.com · fetch · http_403"
samples_count: 7
created: 2026-04-26
---
# github.com · fetch · http_403

**Pattern:** `http_403` from `github.com` during `fetch`.
**Seen:** 7× between 2026-04-19 and 2026-04-26.

## Symptoms
- `HTTP 403 FORBIDDEN — Bad credentials`

## Reproducers
- `github.js repo private-org/private-repo`

## Probable cause
Server is rejecting requests. Likely missing/bad auth, blocked UA, or geo/IP filter.

## Workaround
- Set a User-Agent header (most APIs require it).
- For browser content, use `browser-start` + `browser-content`.
- Check if the host needs auth (env var token).

## Verified fix
_TODO: agent or human fills this in once a fix is confirmed._

## Notes
_TODO: anything else worth remembering._
```

The TODO sections are intentional — the consolidator can't verify a
fix; that's the agent's (or human's) job after the next retry.

---

## Recommended workflow

```bash
# Daily: see what's broken
web-status --since 24h

# When you see ⚠ STALE flags: draft proposals for review
web-consolidate --draft ./tmp-drafts

# Edit drafts, fill in "Verified fix" section, then commit:
cp ./tmp-drafts/*.md ~/.synaps-cli/memory/web/notes/
velocirag index ~/.synaps-cli/memory/web/notes --db ~/.synaps-cli/memory/web/db -s web

# OR: trust the auto-draft and commit directly
web-consolidate --commit

# Periodically: trim the raw log
web-status --purge-old 30
```

## Tag conventions

`web-consolidate` always tags with:

- `kind-fix`
- `op-<op>` (e.g. `op-fetch`, `op-github`)
- `err-<class>` (e.g. `err-http_403`, `err-dns`)
- `domain-<host>` (dots → hyphens; e.g. `domain-github-com`)

These match what PRE-recall hooks search for, so a note with all four
tags will be the highest-ranked hit on the next failure.

## See also

- `docs/memory.md` — note schema, tag conventions, VelociRAG layout
- `docs/self-healing.md` — PRE/ACT/POST protocol, error classes
- `docs/specs/web-toolkit-v2.md` — full architecture spec
