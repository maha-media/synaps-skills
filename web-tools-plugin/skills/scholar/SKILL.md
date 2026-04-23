---
name: scholar
description: Academic paper search, details, and citation generation via OpenAlex API. Search 200M+ works, get abstracts, BibTeX citations, and PDF links. No API key required.
---

# Scholar — Academic Paper Search

Search and retrieve academic papers using the [OpenAlex API](https://openalex.org/). Covers 200M+ works across all fields. No API key required — generous rate limits (100 req/s).

## Setup

Requires Python 3 and the `requests` library:

```bash
pip install requests
```

## Search

Find papers by topic, keywords, or phrases:

```bash
python3 ${baseDir}/../scripts/scholar/scholar.py search "machine learning"
python3 ${baseDir}/../scripts/scholar/scholar.py search "neural networks" --limit 5
python3 ${baseDir}/../scripts/scholar/scholar.py search "transformer architecture" --year-from 2020
python3 ${baseDir}/../scripts/scholar/scholar.py search "CRISPR gene editing" --year-from 2018 --year-to 2023
python3 ${baseDir}/../scripts/scholar/scholar.py search "reinforcement learning" --sort citations
python3 ${baseDir}/../scripts/scholar/scholar.py search "quantum computing" --sort date --limit 20
```

### Search Options

| Option | Description |
|--------|-------------|
| `--limit N` | Number of results (default: 10) |
| `--year-from YYYY` | Filter papers from this year onwards |
| `--year-to YYYY` | Filter papers up to this year |
| `--sort relevance\|citations\|date` | Sort order (default: relevance) |

## Paper Details

Get full metadata for a specific paper by title or DOI:

```bash
python3 ${baseDir}/../scripts/scholar/scholar.py paper "Attention Is All You Need"
python3 ${baseDir}/../scripts/scholar/scholar.py paper "10.1038/s41586-021-03819-2"
```

Returns: title, authors with affiliations, year, venue, citation count, abstract, concepts, URL, and PDF link.

## BibTeX Citations

Generate ready-to-use BibTeX entries:

```bash
python3 ${baseDir}/../scripts/scholar/scholar.py cite "BERT: Pre-training of Deep Bidirectional Transformers"
python3 ${baseDir}/../scripts/scholar/scholar.py cite "10.1145/3474085.3475688"
```

## Output

Search results include:
- **Title** and publication year
- **Authors** with institutional affiliations
- **Venue** (journal/conference) and paper type
- **Citation count**
- **Abstract** (reconstructed from OpenAlex inverted index)
- **URL** and **PDF link** (when available via open access)

## Tips

- Use quotes around multi-word queries for phrase matching
- Sort by `citations` to find landmark papers in a field
- Sort by `date` to find the latest research
- Use year filters to scope literature reviews to specific periods
- DOI lookups are faster and more precise than title searches
