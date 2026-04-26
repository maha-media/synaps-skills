# fetch — Lightweight HTTP→markdown

The first thing to try for any web fetch. Pure Node, native `fetch()`,
no Playwright launch. Auto-detects content type and pretty-prints
HTML→markdown / JSON / text. Escalates to `browser-content` when
JS rendering is needed.

## Setup

```bash
cd "${CLAUDE_PLUGIN_ROOT}/scripts/fetch"
npm install                          # only deps: readability, jsdom, turndown
```

## Usage

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/fetch/fetch.js <url> [options]
```

| Option              | Default     | Notes                                          |
|---------------------|-------------|------------------------------------------------|
| `--render`          | off         | Delegate to `browser-content.js` (Playwright)  |
| `--raw`             | off         | Print raw response body, no transformations    |
| `--json`            | auto        | Pretty-print JSON (auto-detected from CT)      |
| `--headers`         | off         | Include response headers                       |
| `--max-bytes N`     | 5242880     | Response size cap (bytes)                      |
| `--timeout SEC`     | 30          | Request timeout                                |
| `--user-agent UA`   | web-tools/0.2 | Override User-Agent                          |
| `--no-redirect`     | off         | Disable redirect following                     |
| `--header 'K: V'`   | —           | Additional request header (repeatable)         |

## Examples

```bash
# Static HTML → markdown
${CLAUDE_PLUGIN_ROOT}/scripts/fetch/fetch.js https://example.com

# JSON API
${CLAUDE_PLUGIN_ROOT}/scripts/fetch/fetch.js https://api.github.com/repos/anthropics/anthropic-sdk-python

# With auth header
${CLAUDE_PLUGIN_ROOT}/scripts/fetch/fetch.js https://api.x.com/2/tweets \
  --header "Authorization: Bearer $TOKEN"

# Force JS rendering (delegates to browser-content.js)
${CLAUDE_PLUGIN_ROOT}/scripts/fetch/fetch.js https://news.ycombinator.com --render

# Inspect response headers
${CLAUDE_PLUGIN_ROOT}/scripts/fetch/fetch.js https://api.github.com/zen --headers --raw

# Raw body to a file
${CLAUDE_PLUGIN_ROOT}/scripts/fetch/fetch.js https://example.com/data.csv --raw > data.csv
```

## Content-type handling

| Server returns…              | Default behavior                    |
|------------------------------|-------------------------------------|
| `text/html` / `xhtml+xml`    | Readability + Turndown → markdown   |
| `application/json` / `+json` | `JSON.parse` → pretty-printed JSON  |
| Other `text/*`               | Echo unchanged                      |
| Anything else                | Save to /tmp/fetch-…, report path   |

## Self-healing notes

- **PRE**: recall `domain-<host>` + `op-fetch` notes.
- **POST**:
  - `dns` — sanity-check URL; not a transient issue.
  - `timeout` — increase `--timeout` or escalate to `--render`.
  - `http_403` / `http_429` — auth/rate-limit; check memory for known fixes.
  - `http_404` — wrong URL; not a fetch-tooling issue.
  - **`needs_render` (exit 3)** — heuristic detected JS-only page (empty body
    or "Please enable JavaScript"). Retry the same URL with `--render`.

## Escalation chain

```
fetch <url>                 # primary — fast, no browser
  ↓ exit 3 (needs_render)
fetch <url> --render        # delegates to browser-content.js
  ↓ still bad
browser-start.js + browser-content.js
  ↓ behind auth?
browser-start.js --profile + browser-content.js
```

## When NOT to use fetch

- **Plain file URLs** (raw `.md`, `.json` via curl) — fetch handles them, but
  for binary downloads `curl -sL URL -o FILE` is more obvious.
- **Pages requiring login** — use `browser-start.js --profile` + `browser-*`.
- **Search-style queries** — use `search.js` (Exa).
- **GitHub-specific data** — Phase 4 `github` capability (typed API).

## Env

| Variable          | Default                     | Notes                              |
|-------------------|-----------------------------|------------------------------------|
| `WEB_HOOKS_QUIET` | unset                       | Suppress hook stderr surface       |
