# github — Typed GitHub API

Direct GitHub API access without launching a browser. Rate-limit aware
(60/h anon, 5000/h authed). Auto-decodes file contents (base64 → bytes).

## Setup

For 5000 req/h instead of 60, set a Personal Access Token:
```bash
# Repo scope (read public only — no scope needed for unauth requests).
# For private repos, generate a token at:
#   https://github.com/settings/tokens
export GITHUB_TOKEN="ghp_..."
# (GH_TOKEN also accepted, in case you already use that env var)
```

Check your status:
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js rate
```

## Commands

```bash
# Repo metadata (stars, language, default branch, etc.)
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js repo OWNER/REPO
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js repo https://github.com/OWNER/REPO

# Fetch a file (raw, decoded). Listing a directory: same command, dir path.
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js file OWNER/REPO README.md
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js file OWNER/REPO src/lib/foo.js --ref main
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js file OWNER/REPO src/                 # list directory

# Recursive tree (blobs only, with file sizes)
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js tree OWNER/REPO
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js tree OWNER/REPO --ref v2.1.0

# Issues
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js issue  OWNER/REPO 42
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js issues OWNER/REPO --state open --limit 20
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js issues OWNER/REPO --labels bug,help-wanted

# Pull requests
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js pr  OWNER/REPO 17
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js prs OWNER/REPO --state closed --limit 10

# Code search (uses the search API; counts toward separate quota)
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js search-code "useState" --language typescript --limit 10
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js search-code "AbortController" --repo nodejs/node

# Repo search
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js search-repos "vector database" --language rust --limit 5

# User
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js user OWNER

# Rate-limit status
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js rate
```

## Self-healing notes

- **PRE**: recall `domain-api-github-com` + `op-github`.
- **POST**:
  - `http_403` — auth wall or secondary rate limit (search). Set `GITHUB_TOKEN`
    or wait for reset window. The script auto-warns when remaining < 5.
  - `http_404` — repo/file/path not found (or private + no auth).
  - `http_422` — search query is malformed; check brackets/quotes.
  - `bad_args` — wrong `OWNER/REPO` or missing required argument.

## Rate-limit awareness

The script prints a warning to stderr when `X-RateLimit-Remaining < 5`:
```
[github] rate-limit warning: 3 requests remaining (reset 2026-04-26T05:13:59.000Z)
```

`search-code` uses a separate, much smaller quota (10/min unauthed, 30/min
authed). Don't loop search-code without a delay.

## Common patterns

### Read a single file
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js file owner/repo path/to/file.js > /tmp/file.js
```

### Snapshot a repo's structure
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js tree owner/repo > /tmp/tree.txt
```

### Find similar code across GitHub
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js search-code 'class TokenBucket' --language python --limit 20
```

### Triage open bugs
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js issues owner/repo --state open --labels bug --limit 50
```

### Check a PR before reviewing
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/github/github.js pr owner/repo 123
```

## When NOT to use github

- **General web search** that happens to mention GitHub → use `search.js --domain github.com`.
- **Cloning a whole repo** → use `git clone` directly.
- **CI logs** → GitHub's REST API exposes them but it's verbose; use `gh run view` (the official `gh` CLI) instead.

## Env

| Variable          | Default | Notes                                  |
|-------------------|---------|----------------------------------------|
| `GITHUB_TOKEN`    | —       | Bearer token (5000/h instead of 60/h)  |
| `GH_TOKEN`        | —       | Alternate name (same purpose)          |
| `WEB_HOOKS_QUIET` | unset   | Suppress hook stderr surface           |
