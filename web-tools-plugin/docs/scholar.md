# scholar — Academic papers via OpenAlex

Search 200M+ academic works, fetch full metadata, generate BibTeX.
**No API key required.** Generous rate limits (100 req/s).

## Setup

```bash
pip install requests          # only dep
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/scholar/scholar.py --help
```

## Search

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/scholar/scholar.py search "machine learning"
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/scholar/scholar.py search "neural networks" --limit 5
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/scholar/scholar.py search "transformer" --year-from 2020
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/scholar/scholar.py search "CRISPR" --year-from 2018 --year-to 2023
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/scholar/scholar.py search "RL" --sort citations
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/scholar/scholar.py search "quantum" --sort date --limit 20
```

| Option                     | Description                                |
|----------------------------|--------------------------------------------|
| `--limit N`                | Number of results (default: 10)            |
| `--year-from YYYY`         | From this year onwards                     |
| `--year-to YYYY`           | Up to this year                            |
| `--sort relevance\|citations\|date` | Sort order                        |

## Paper details

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/scholar/scholar.py paper "Attention Is All You Need"
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/scholar/scholar.py paper "10.1038/s41586-021-03819-2"
```

Returns: title, authors with affiliations, year, venue, citation count,
abstract, concepts, URL, PDF link.

## BibTeX

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/scholar/scholar.py cite "BERT: Pre-training of Deep Bidirectional Transformers"
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/scholar/scholar.py cite "10.1145/3474085.3475688"
```

## Self-healing notes

- **PRE**: recall `domain-api-openalex-org` + `op-scholar`.
- **POST**:
  - `http_429` — script auto-retries with exponential backoff up to 3×; if it
    still fails, log + exit. Recurring? Commit a `kind-lesson` with rate-limit
    window data.
  - `not_found` — title may be too imprecise; retry with DOI if available, or
    add author/year context to the query.
  - `bad_json` — upstream broken response; retry usually fixes it.

## Tips

- DOI lookups are faster and more precise than title searches.
- Use quotes around multi-word queries for phrase matching.
- `--sort citations` finds landmark papers in a field.
- `--sort date` for the latest research.
- Year filters scope literature reviews to specific periods.

## Output channels

OpenAlex provides:
- `url` — landing page (publisher site)
- `pdf_url` — open-access PDF (when available; via `oa_url` or location PDF)
- `doi` — for citation export and cross-checking
