# search — Web search via Exa

Lightweight neural/keyword/deep search + content extraction. **No browser
required**, no rate-limit-style cookies. Best default for "look up a fact",
"find documentation", "what's new in X".

All scripts auto-call memory recall on start and auto-log failures.

## Setup

The Exa API key is read from **two sources** (in order of precedence):

1. **`process.env.EXA_API_KEY`** — already set in the calling shell.
2. **`~/.config/synaps/web-tools.env`** — auto-loaded by `_lib/hooks.mjs`
   on every script invocation. **This is the canonical location** because
   non-interactive shells (agent bash tool calls, cron, CI) DO NOT source
   `~/.bashrc`. File format is dotenv-style (`KEY=VALUE` per line).

Recommended: write the key to the canonical file.

```bash
# Easiest — via setup.sh (creates the file with mode 0600):
bash ${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh --exa-key=YOUR_KEY

# Equivalent manual:
mkdir -p ~/.config/synaps
echo 'EXA_API_KEY=YOUR_KEY' > ~/.config/synaps/web-tools.env
chmod 600 ~/.config/synaps/web-tools.env
```

Get a key at https://dashboard.exa.ai/api-keys.

No `npm install` needed — uses native `fetch`.

## Search

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/search/search.js "query"                                         # 5 results
${CLAUDE_PLUGIN_ROOT}/scripts/search/search.js "query" -n 10                                   # more results
${CLAUDE_PLUGIN_ROOT}/scripts/search/search.js "query" --content                               # full page text
${CLAUDE_PLUGIN_ROOT}/scripts/search/search.js "query" --highlights                            # excerpts only
${CLAUDE_PLUGIN_ROOT}/scripts/search/search.js "query" --instant                               # fastest
${CLAUDE_PLUGIN_ROOT}/scripts/search/search.js "query" --fast
${CLAUDE_PLUGIN_ROOT}/scripts/search/search.js "query" --auto                                  # default
${CLAUDE_PLUGIN_ROOT}/scripts/search/search.js "query" --deep                                  # multi-query
${CLAUDE_PLUGIN_ROOT}/scripts/search/search.js "query" --deep-reasoning                        # multi-step
${CLAUDE_PLUGIN_ROOT}/scripts/search/search.js "query" --freshness pw                          # past week
${CLAUDE_PLUGIN_ROOT}/scripts/search/search.js "query" --freshness 2024-01-01to2024-06-30
${CLAUDE_PLUGIN_ROOT}/scripts/search/search.js "query" --category news                         # news, "research paper", company, people
${CLAUDE_PLUGIN_ROOT}/scripts/search/search.js "query" --domain github.com --domain stackoverflow.com
${CLAUDE_PLUGIN_ROOT}/scripts/search/search.js "query" --domain github.com --exclude gist.github.com
```

### Search-mode tradeoff

| Mode               | Latency | Best for                                |
|--------------------|---------|-----------------------------------------|
| `--instant/--fast` | < 0.5s  | Quick lookup, navigation, autocomplete  |
| `--auto` (default) | ~1s     | Most queries                            |
| `--deep`           | ~3-5s   | Research summaries, multiple variations |
| `--deep-reasoning` | ~10-30s | Multi-step questions, hard reasoning    |

## Extract page content

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/search/content.js https://example.com/article
${CLAUDE_PLUGIN_ROOT}/scripts/search/content.js https://a.com/x https://b.com/y --highlights
${CLAUDE_PLUGIN_ROOT}/scripts/search/content.js https://live.example.com/data --fresh    # bypass Exa cache
```

## Self-healing notes

- **PRE**: scripts run `recall(query, op=search)` and surface hits.
- **POST on failure**:
  - `no_api_key` → `EXA_API_KEY` not set; fix env, no retry needed.
  - `http_429` → backoff and retry; commit a `kind-lesson` if it's chronic.
  - `http_5xx` → upstream issue; try again later, or fall back to a target-host
    direct fetch via `browser-content.js`.
  - `empty_response` from `content.js` → URL is not in Exa's index; use
    `browser-content.js` instead.

## Escalation chain

```
search.js              # primary
  ↓ (no/poor results)
search.js --deep       # broader
  ↓
search.js --deep-reasoning
  ↓
browser-content.js     # direct fetch + Readability
```

## Tips

- Prefer `--highlights` over `--content` for token economy.
- Use `--domain` to scope to authoritative sources (e.g. `--domain rust-lang.org`).
- Categories are restrictive — try without `--category` first if results are sparse.
- DOI/title-style queries: try `--category "research paper"` to filter to academic.

## Env

| Variable          | Default | Notes                                  |
|-------------------|---------|----------------------------------------|
| `EXA_API_KEY`     | —       | **Required.** Set live, or in `~/.config/synaps/web-tools.env` |
| `WEB_HOOKS_QUIET` | unset   | Suppress hook stderr surface           |

## When to use what

| Need                            | Tool                          |
|---------------------------------|-------------------------------|
| Search the web                  | `search.js`                   |
| Extract one URL's text          | `content.js` (Exa-cached)     |
| Extract one URL needing JS      | `browser-content.js`          |
| Academic papers                 | `scholar.py` (OpenAlex)       |
| GitHub-specific                 | (Phase 4) `github` capability |
