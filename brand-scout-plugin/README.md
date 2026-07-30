# Brand Scout v1

`brand-scout-plugin` is a zero-dependency Synaps process plugin with one catalogue-compatible tool:

```text
analyze_brand_palette(url)
```

It is an **LLM-first source-evidence tool**: it statically examines HTML, inline styles, `<style>` blocks, SVG `fill`/`stroke`, and **same-origin** linked stylesheets, then returns bounded facts for an agent LLM to interpret. The tool does **not** claim which colour is primary, accent, or background.

The response contains:

- `observations` — normalized `#RRGGBB` colour occurrences with their property and source context;
- `design_tokens` — CSS custom properties (for example `--bg` and `--accent`), their declared value, normalized colours, and source context;
- `declarations` — static colour-bearing CSS/SVG/inline-style declarations with normalized colours and source context;
- `warnings` — fetch, parse, and evidence-truncation notices; and
- `rendered: false` — this is not a browser render and does not execute JavaScript.

Evidence is capped (20 linked stylesheets, 100 design tokens, 200 declarations, and 300 observations) so the static fetch tool supplies bounded source facts. The calling LLM makes any primary/accent/background judgement from those facts.

## Security boundary

Only HTTPS URLs with port 443 and no userinfo are accepted. Before **each request and redirect** (at most 3 redirects), DNS is resolved and every answer must be globally routable: loopback, private, link-local, multicast, reserved, and unspecified addresses are rejected. The selected vetted address is pinned for the TLS connection, avoiding DNS rebinding between validation and connect. Requests use a 5-second timeout. HTML is capped at 1 MB and each CSS response at 500 KB. Linked CSS is restricted to the original page hostname; redirects are independently URL/DNS checked.

The output is static-source evidence, not a statement about pixels actually rendered. CSS parsing intentionally uses only Python stdlib and supports CSS variables, `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`, `rgb(a)`, and `hsl(a)`; transparent colors are omitted. No deterministic role classifier is applied.

## Protocol and use

`main.py` speaks Content-Length-framed JSON-RPC over stdin/stdout. `initialize` advertises the single tool; call it with:

```json
{"method":"tool.call","params":{"name":"analyze_brand_palette","input":{"url":"https://example.com/"}}}
```

Run tests (stdlib `unittest` only):

```bash
python3 -m unittest discover -s tests -v
python3 -m json.tool .synaps-plugin/plugin.json >/dev/null
```

## Files

- `main.py` — process protocol entrypoint
- `brand_scout.py` — safe fetcher and bounded static colour-evidence extraction
- `.synaps-plugin/plugin.json` — manifest
- `tests/` — network-safety, extraction, and subprocess protocol tests
