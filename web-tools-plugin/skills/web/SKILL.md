---
name: web
description: Swiss-army web toolkit — fetch, browser, search, youtube, scholar, transcribe, pdf, docs, github, wiki. Self-healing memory via VelociRAG.
---

# web — Index

A single entry point for every web/browser capability. Read this index, then
read **only the doc for the capability you're about to use**.

---

## First-run setup (or: a capability just failed with "missing dep")

If anything web-tools-related fails with a missing-binary error
(`yt-dlp not found`, `pdftotext not found`, `Cannot find module 'playwright'`,
etc.) run the plugin's idempotent setup script:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh --check    # status only
bash ${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh            # install missing deps
bash ${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh --minimal  # only fetch + memory
bash ${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh --reinstall  # nuke node_modules first
bash ${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh --exa-key=KEY   # set EXA_API_KEY
```

It covers: Node ≥ 18, `npm install` for fetch/browser/youtube, yt-dlp + JS-runtime
config, `python3-secretstorage` (Linux), Whisper, pdftotext, pandoc, Playwright
browsers, VelociRAG, the memory tree at `~/.synaps-cli/memory/web/`, and the
secrets file at `~/.config/synaps/web-tools.env` (chmod 600).

Hard issues (Node missing, `npm install` failed) exit 1; soft warnings
(optional capabilities not installed) exit 0.

### Secrets and non-interactive shells

API keys live in `~/.config/synaps/web-tools.env` (chmod 600), auto-loaded by
every web capability via `_lib/hooks.mjs`. **This is required because agent
bash tool calls don't source `~/.bashrc`** — a key that only lives in your
shell profile won't reach a non-interactive subprocess.

```env
# ~/.config/synaps/web-tools.env
EXA_API_KEY=…
```

Pre-set environment variables always win over file contents, so you can still
override per-call. The file is missing-tolerant (no warning if absent).

---

## Step 1 — Always recall first

Before any web operation, ask memory:

```bash
velocirag search "<intent or hostname>" --db ~/.synaps-cli/memory/web/db -l 5
```

Pay attention to results tagged `kind-fix` for the relevant `domain-` or `op-`.
Scripts also do this automatically before they run, but doing it manually
sharpens your strategy.

## Step 2 — Pick a capability

Read the doc only when you actually use the capability. Each doc has its own
detailed flags, gotchas, and escalation rules.

| Need                          | Doc                  | Status      |
|-------------------------------|----------------------|-------------|
| Quick page fetch (light)      | `docs/fetch.md`      | shipped     |
| Full browser (JS / auth)      | `docs/browser.md`    | shipped     |
| Web search                    | `docs/search.md`     | shipped     |
| YouTube                       | `docs/youtube.md`    | shipped     |
| Academic papers               | `docs/scholar.md`    | shipped     |
| Audio / video → text          | `docs/transcribe.md` | shipped     |
| PDF text & metadata           | `docs/pdf.md`        | shipped     |
| DOCX / PPTX / EPUB ↔ markdown | `docs/docs.md`       | shipped     |
| GitHub (repos, issues, code)  | `docs/github.md`     | shipped     |
| Wikipedia                     | `docs/wiki.md`       | shipped     |
| Status / dashboard            | `docs/status.md`     | shipped     |
| Memory ops (recall / commit)  | `docs/memory.md`     | shipped     |
| Self-healing protocol         | `docs/self-healing.md` | shipped   |

## Step 3 — On failure: re-recall, escalate, then commit a fix

Every script auto-logs failures to `~/.synaps-cli/memory/web/failures.jsonl`.
When something fails:

1. **Re-recall** with the error class:
   ```bash
   velocirag search "<host> <err_class>" --db ~/.synaps-cli/memory/web/db -l 5
   ```
2. **Try the escalation chain** documented in `docs/<capability>.md`. Common ones:
   - `fetch` returns junk → `fetch --render` (browser fallback)
   - search facts → `wiki` for entities, `scholar` for papers
   - `403` / `429` → check memory for auth or rate-limit notes before retry
3. **If you found a fix, commit a memory** so the next agent benefits.
   The easiest way is to use the helper:
   ```bash
   node -e "require('${CLAUDE_PLUGIN_ROOT}/scripts/_lib/memory').commit(
     'github.com fetch hits 403 anonymously → set Authorization Bearer GITHUB_TOKEN',
     {kind:'fix', tags:['domain-github-com','op-fetch','err-http_403']}
   )"
   ```
   Or write a markdown file directly under `~/.synaps-cli/memory/web/notes/`
   with YAML frontmatter and run `velocirag index ~/.synaps-cli/memory/web/notes
   --db ~/.synaps-cli/memory/web/db -s web`.

## Self-healing protocol

The full PRE / ACT / POST contract, staleness rules, and tag conventions
live in `docs/self-healing.md`. Read it once.

## Health checks

Run `web-status` periodically to see what's broken and what's stale:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/status/web-status.js              # dashboard
node ${CLAUDE_PLUGIN_ROOT}/scripts/status/web-status.js --since 24h  # recent only
```

Recurring failures trigger a STALE warning. To consolidate them into
notes (review-gated):

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/status/web-consolidate.js          # dry-run
node ${CLAUDE_PLUGIN_ROOT}/scripts/status/web-consolidate.js --commit # write notes
```

See `docs/status.md` for the full workflow.

## Conventions

- All capability docs live under `docs/`.
- All scripts live under `scripts/<capability>/`.
- Shared helpers (memory wrapper, output formatter) live under `scripts/_lib/`.
- The web plugin's memory store is at `~/.synaps-cli/memory/web/`.
  - `notes/` — markdown source of truth (git-friendly)
  - `db/` — VelociRAG index (derived, rebuildable)
  - `failures.jsonl` — raw operational log
