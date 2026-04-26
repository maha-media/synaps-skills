# docs — DOCX / PPTX / EPUB / RTF / ODT ↔ markdown

Pandoc wrapper for converting between rich-text document formats and
markdown. Handles local files and remote URLs.

## Setup

### Required: pandoc
```bash
# Ubuntu/Debian/WSL:
sudo apt install pandoc

# macOS:
brew install pandoc

# Windows:
# https://pandoc.org/installing.html
```

### Optional: LaTeX (for `--to pdf`)
```bash
# Ubuntu/Debian/WSL:
sudo apt install texlive-xetex

# macOS:
brew install --cask mactex
```

## Commands

```bash
# Convert any supported format → markdown (gfm)
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/docs/docs.py to-md report.docx
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/docs/docs.py to-md slides.pptx --out slides.md
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/docs/docs.py to-md https://example.com/spec.docx

# Convert between any two formats
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/docs/docs.py convert notes.md   --to docx --out notes.docx
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/docs/docs.py convert article.md --to html --out article.html
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/docs/docs.py convert spec.docx  --to epub --out spec.epub
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/docs/docs.py convert paper.md   --to pdf  --out paper.pdf   # needs LaTeX

# Inspect a file
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/docs/docs.py info contract.docx
```

## Supported formats

### Source (auto-detected by extension; override with `--from`)

| Ext            | Pandoc fmt | Notes                                     |
|----------------|------------|-------------------------------------------|
| `.docx`        | docx       | Word (modern)                             |
| `.doc`         | docx       | Pandoc only reads `.docx` — convert first |
| `.pptx`        | pptx       | PowerPoint                                |
| `.odt`         | odt        | LibreOffice / OpenOffice                  |
| `.rtf`         | rtf        | Rich Text Format                          |
| `.epub`        | epub       | E-book                                    |
| `.html`/`.htm` | html       |                                           |
| `.tex`         | latex      |                                           |
| `.rst`         | rst        | reStructuredText                          |
| `.org`         | org        | Org-mode                                  |
| `.md`          | markdown   |                                           |

### Target (`--to`)

| Format     | Default ext | Notes                                  |
|------------|-------------|----------------------------------------|
| `markdown` | `.md`       | gfm flavor by default                  |
| `gfm`      | `.md`       | Explicit GitHub-flavored markdown      |
| `html`     | `.html`     | Standalone HTML5                       |
| `docx`     | `.docx`     |                                        |
| `pptx`     | `.pptx`     |                                        |
| `odt`      | `.odt`      |                                        |
| `rtf`      | `.rtf`      |                                        |
| `epub`     | `.epub`     |                                        |
| `latex`    | `.tex`      |                                        |
| `pdf`      | `.pdf`      | Requires `xelatex` or `pdflatex`       |

## Self-healing notes

- **PRE**: recall by host (for URLs) + `format-<ext>` tag.
- **POST**:
  - `missing_dep` — pandoc missing (or LaTeX for `--to pdf`); install per platform.
  - `unknown_format` — extension not recognised; pass `--from <fmt>`.
  - `http_*` — fetching a remote document failed; use `fetch.js` to debug.
  - `timeout` — pandoc exceeded 120s. Convert in pieces or simplify the source.
  - `too_large` — > 100 MB cap on URL downloads. Curl manually first.

## Tips

- **`to-md` defaults to gfm** with `--wrap=preserve` — tables and lists
  round-trip cleanly. If you want plain CommonMark, use:
  ```bash
  docs.py convert report.docx --to markdown --out report.md
  ```
- **Word → PDF** without going through Word: `--to pdf` (needs LaTeX).
- **Embedded images**: pandoc extracts them to a media folder next to the
  output (markdown links to them). For self-contained HTML, add
  `--standalone --self-contained` (already passed for `--standalone`).
- **Round-trip warning**: `docx → md → docx` loses some Word-specific
  formatting (track-changes, comments). If you need to preserve those, work
  in `.docx` directly.

## Combine with other capabilities

```bash
# Spec doc on the web → markdown summary
docs.py to-md "https://example.com/spec.docx" --out /tmp/spec.md

# YouTube auto-captions → DOCX with chapter breaks
youtube/transcript.js VIDEO_ID > /tmp/captions.txt
docs.py convert /tmp/captions.txt --to docx --out captions.docx

# Academic paper PDF → editable docx (lossy but ok for notes)
scholar.py paper "10.1038/..." | grep PDF
pdf.py text URL > /tmp/paper.txt   # often better than docs.py for PDFs
```

## Env

| Variable          | Default | Notes                                  |
|-------------------|---------|----------------------------------------|
| `WEB_HOOKS_QUIET` | unset   | Suppress hook stderr surface           |
