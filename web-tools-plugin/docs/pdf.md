# pdf — Text and metadata from PDFs

Extract text, metadata, and page info from local or remote PDFs.
Handles URL→text in one shot.

## Setup

### Required: `pdftotext` (poppler)
```bash
# Ubuntu/Debian/WSL:
sudo apt install poppler-utils

# macOS:
brew install poppler
```

### Optional: `pdfplumber` (for `--layout`)
```bash
pip install pdfplumber
```

### Optional: `pypdf` (metadata fallback when poppler unavailable)
```bash
pip install pypdf
```

## Commands

```bash
# Text extraction (full document)
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/pdf/pdf.py text paper.pdf
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/pdf/pdf.py text https://arxiv.org/pdf/2310.06825.pdf

# Page range
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/pdf/pdf.py text paper.pdf --pages 1-5
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/pdf/pdf.py text paper.pdf --pages 3
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/pdf/pdf.py text paper.pdf --pages -10
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/pdf/pdf.py text paper.pdf --pages 5-

# Layout-aware (preserves columns/tables; needs pdfplumber)
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/pdf/pdf.py text report.pdf --layout

# Metadata
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/pdf/pdf.py meta paper.pdf
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/pdf/pdf.py meta paper.pdf --json

# Page count + size
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/pdf/pdf.py pages paper.pdf
```

## Backends

| Backend       | Used by         | Provides                  |
|---------------|-----------------|---------------------------|
| `pdftotext`   | text (default)  | Fast, robust text         |
| `pdfplumber`  | text `--layout` | Column/table preservation |
| `pdfinfo`     | meta, pages     | Title, author, dates, dimensions |
| `pypdf`       | meta (fallback) | Title/author when poppler missing |

## Self-healing notes

- **PRE**: recall by host (for URLs) or general `op-pdf`.
- **POST**:
  - `missing_dep` — `pdftotext` not installed; install per platform.
  - `not_pdf` — URL returned non-PDF Content-Type. Verify the URL or escalate
    to `fetch` for the actual format.
  - `too_large` — PDF > 100 MB. Download manually and process locally:
    ```bash
    curl -sL URL -o /tmp/big.pdf
    pdftotext /tmp/big.pdf -
    ```
  - `bad_args` — `--pages` syntax. Use `1-5`, `3`, `-10`, or `5-`.
  - `timeout` — pdftotext exceeded 60s on a large/complex PDF. Try `--pages`
    to chunk, or use `--layout` only on the section you need.

## Limits

- 100 MB cap on URL downloads (avoid silent giant fetches). Override by
  curl-ing locally first.
- `pdftotext` strips ligatures and ignores layout — use `--layout` for forms,
  reports, or anything with columns/tables.
- Encrypted PDFs are detected by `pdfinfo`; we don't try passwords.

## Tips

- **arxiv**: replace `/abs/` with `/pdf/` to get the PDF directly:
  ```bash
  pdf.py text https://arxiv.org/pdf/2310.06825.pdf --pages 1-5
  ```
- **Dump table of contents**: `pdftotext -bbox file.pdf - | grep <heading>`
  (poppler-only; outside this script).
- **Combine with scholar**: get a paper's PDF URL via `scholar.py paper`,
  then pipe to `pdf.py text`.

## Env

| Variable          | Default | Notes                                  |
|-------------------|---------|----------------------------------------|
| `WEB_HOOKS_QUIET` | unset   | Suppress hook stderr surface           |
