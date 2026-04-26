# wiki — Wikipedia REST API

Direct access to Wikipedia's REST API and action API. No auth, no rate
limits in practice (~200 req/s ceiling). Supports any Wikipedia language.

## Commands

```bash
# One-paragraph summary (REST API)
${CLAUDE_PLUGIN_ROOT}/scripts/wiki/wiki.js summary "Erlang (programming language)"
${CLAUDE_PLUGIN_ROOT}/scripts/wiki/wiki.js summary "Marie Curie" --lang fr

# Full plain-text article (action API extract)
${CLAUDE_PLUGIN_ROOT}/scripts/wiki/wiki.js article "Kubernetes"
${CLAUDE_PLUGIN_ROOT}/scripts/wiki/wiki.js article "Algorithm" --lang de

# Search
${CLAUDE_PLUGIN_ROOT}/scripts/wiki/wiki.js search "distributed consensus"
${CLAUDE_PLUGIN_ROOT}/scripts/wiki/wiki.js search "BERT model" -n 10

# Random article (for fun, or for benchmarking)
${CLAUDE_PLUGIN_ROOT}/scripts/wiki/wiki.js random
```

## Options

| Option       | Default | Notes                                   |
|--------------|---------|-----------------------------------------|
| `--lang LANG`| `en`    | Wikipedia language code (en, fr, de, …) |
| `-n N`       | 5       | Result count for `search`               |
| `--limit N`  | 5       | Same as `-n`                            |

## Self-healing notes

- **PRE**: recall `domain-<lang>-wikipedia-org` + `op-wiki`.
- **POST**:
  - `not_found` — title is wrong or doesn't exist. Try `search` first to
    discover the canonical title.
  - `disambiguation` (warn-only on stderr) — title resolved to a
    disambiguation page; pick a more specific title.
  - `bad_args` — missing query or title.

## Output formats

### `summary`
```
Title: <article>
Description: <short noun-phrase>

<single-paragraph extract>

URL: https://<lang>.wikipedia.org/wiki/<title>
Thumbnail: https://upload.wikimedia.org/...
```

### `article`
```
Title: <article>
URL: https://<lang>.wikipedia.org/wiki/<title>

<full plain-text body>
```

### `search`
```
[1] <title>
    <snippet>
    https://<lang>.wikipedia.org/wiki/<title>

[2] ...
```

## Common patterns

### Fact-check / quick lookup
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/wiki/wiki.js summary "Treaty of Westphalia"
```

### Discover the canonical title for an entity
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/wiki/wiki.js search "Moon landing 1969" -n 3
# pick the right title, then:
${CLAUDE_PLUGIN_ROOT}/scripts/wiki/wiki.js article "Apollo 11"
```

### Summarise a person's life into prose
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/wiki/wiki.js article "Linus Torvalds"
```

## When NOT to use wiki

- **Latest news** → use `search.js --freshness pd` (Wikipedia lags by hours/days).
- **Academic sources** → use `scholar.py` (Wikipedia is *tertiary*, not primary).
- **Subjective / opinion content** → not Wikipedia's mission.

## User-Agent

Wikimedia requires a User-Agent that identifies the consumer. The script
sends a descriptive UA with a contact URL. Don't strip it.

## Env

| Variable          | Default | Notes                                  |
|-------------------|---------|----------------------------------------|
| `WEB_HOOKS_QUIET` | unset   | Suppress hook stderr surface           |
