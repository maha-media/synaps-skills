---
name: exa-search
description: Web search and content extraction via Exa API. Use for searching documentation, facts, news, research papers, companies, people, or any web content. Supports neural, keyword, and deep search. Lightweight, no browser required.
---

# Exa Search

Web search and content extraction using the Exa API. No browser required. Exa provides neural search with built-in content extraction.

## Setup

Requires an Exa API key from https://dashboard.exa.ai/api-keys

1. Add to your shell profile (`~/.profile` or `~/.zprofile` for zsh):
   ```bash
   export EXA_API_KEY="your-api-key-here"
   ```
2. No `npm install` needed — zero dependencies, uses native `fetch`.

## Search

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query"                                         # Basic search (5 results)
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query" -n 10                                   # More results
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query" --content                               # Include full page text
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query" --highlights                            # Include key excerpts (lighter)
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query" --fast                                  # Fast search, basic depth
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query" --instant                               # Fastest (alias for --fast)
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query" --deep                                  # Thorough deep search
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query" --deep-reasoning                        # Complex multi-step research
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query" --freshness pw                          # Results from past week
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query" --freshness 2024-01-01to2024-06-30      # Date range
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query" --category news                         # News articles only
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query" --category "research paper"             # Academic papers only
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query" --domain github.com                     # Only from github.com
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query" --domain github.com --exclude gist.github.com  # Domain filtering
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/search.js "query" -n 10 --content --deep                  # Combined options
```

### Options

- `-n <num>` - Number of results (default: 5)
- `--content` - Include full page text via Exa extraction (max 5000 chars)
- `--highlights` - Include key excerpts instead of full text (max 4000 chars, lighter)
- `--instant` - Fastest search (alias for `--fast`)
- `--fast` - Fast search, basic depth
- `--auto` - Balanced relevance & speed (default, ~1s)
- `--deep` - Thorough search, multiple query variations
- `--deep-reasoning` - Complex research, multi-step reasoning
- `--category <cat>` - Filter by content type:
  - `news` - News articles
  - `research paper` - Academic papers
  - `company` - Company profiles
  - `people` - People profiles
- `--freshness <period>` - Filter by time:
  - `pd` - Past day
  - `pw` - Past week
  - `pm` - Past month
  - `py` - Past year
  - `YYYY-MM-DDtoYYYY-MM-DD` - Custom date range
- `--domain <domain>` - Include only this domain (repeatable)
- `--exclude <domain>` - Exclude this domain (repeatable)

## Extract Page Content

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/content.js https://example.com/article                           # Full text extraction
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/content.js https://example.com/a https://example.com/b           # Multiple URLs
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/content.js https://example.com/article --highlights              # Key excerpts only
${CLAUDE_PLUGIN_ROOT}/scripts/exa-search/content.js https://example.com/live-page --fresh                 # Force livecrawl
```

### Options

- `--highlights` - Return key excerpts instead of full text
- `--fresh` - Force livecrawl, bypass cache (for live/dynamic content)

## Output Format

### Search Results
```
--- Result 1 ---
Title: Page Title
Link: https://example.com/page
Published: 2024-03-15T00:00:00.000Z
Author: John Doe
Score: 0.195
Content: (if --content used)
  Full page text...

--- Result 2 ---
...
```

### Content Extraction
```
# Page Title

URL: https://example.com/article
Author: John Doe
Published: 2024-03-15T00:00:00.000Z

Full extracted text content...
```

## When to Use

- Searching for documentation or API references
- Looking up facts or current information
- Fetching content from specific URLs
- Finding news, research papers, companies, or people
- Deep research with `--deep`
- Any task requiring web search without interactive browsing

## Tips

- Use `--highlights` instead of `--content` to reduce token usage
- Use `--auto` for most queries (default)
- Use `--deep` when you need thorough research results
- Use `--instant` or `--fast` for quick lookups
- Categories can be restrictive — try without one first if results are sparse
- Use `--domain` to target specific authoritative sources
