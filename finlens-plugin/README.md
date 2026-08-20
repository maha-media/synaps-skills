# finlens-plugin

**finlens** — a deterministic, multi-lens financial-research engine exposed as
Synaps tools. Six research-corrected lenses, fused by a Meff-gated synthesis
stage, produce a ranked watchlist of *research leads* — never advice, never
fabricated numbers.

The plugin registers two tools — `finlens_scan` (full multi-lens workflow on
one or more tickers) and `finlens_lens` (single targeted lens) — over the
standard JSON-RPC-over-stdio extension protocol (`synaps-extension/main.py`).

## The 6 lenses

| Lens          | What it measures                                              | Free source                |
| ------------- | ------------------------------------------------------------- | -------------------------- |
| insider       | Cluster-buys by officers/directors (Form 4)                   | SEC EDGAR                  |
| fundamentals  | Revenue/margin/FCF trajectory + earnings cadence              | yfinance                   |
| technicals    | Trend, momentum, volatility regime                            | yfinance                   |
| sentiment     | Contrarian crowd-sentiment skew                               | StockTwits                 |
| news          | Catalyst density + tone over recent window                    | yfinance / fd.ai           |
| search-trend  | Public-attention slope (Google Trends)                        | pytrends                   |

Each lens is **deterministic and self-contained**. The synthesis stage scores
convergence/divergence across lenses, gates results by the **Meff threshold**
(`FINLENS_MEFF_THRESHOLD`, default 2.5), and emits a structured report.

## Doctrine: research leads, not advice — AI never invents numbers

finlens is built on a hard invariant: **every number in a report comes from a
lens call.** The optional Stage-2 LLM exists only to *explain* the math that
the deterministic stage already produced. With no LLM key set, finlens emits a
fully deterministic narrative. With a key, the LLM is barred from inventing
figures — it narrates what the lenses found, nothing more.

This is the same guarantee `xcal-plugin` relies on: xcal is a ReAct agent that
**reasons over finlens lens calls** and cites them in its `Verdict`. **xcal
depends on this plugin** — finlens is the deterministic data engine that xcal
is built on top of.

## Setup

```bash
bash scripts/setup.sh         # creates .venv, installs requirements.txt
bash scripts/setup.sh --check # verifies .venv and runs the pytest suite
```

Or via Synaps:

```
finlens-setup
finlens-check
```

## Data path: free vs. paid

**Free path (default, no key needed):** `yfinance` + SEC EDGAR + StockTwits +
pytrends. Works out of the box.

**Paid path (recommended for reliable insider/fundamentals):** set
`FINANCIALDATASETS_API_KEY` from <https://financialdatasets.ai>. This gives a
single clean API for insider transactions, fundamentals, news, and prices —
much more reliable than scraping yfinance for the heavier lenses.

Copy `.env.example` → `.env` and fill what you want; the defaults run free.

## Tools exposed

- **`finlens_scan(tickers)`** — full 6-lens analysis + Meff-gated synthesis on
  a comma-separated list of tickers. Returns a ranked watchlist with
  convergence/divergence flags. ~10–25s per ticker (live data).
- **`finlens_lens(ticker, lens)`** — a single targeted lens on one ticker.
  `lens ∈ {insider, fundamentals, technicals, sentiment, news, search_trend}`.

## Layout

```
finlens-plugin/
├── .synaps-plugin/plugin.json   # JR manifest (finlens-setup / finlens-check)
├── synaps-extension/
│   ├── main.py                  # JSON-RPC stdio extension entrypoint
│   └── .synaps-plugin/plugin.json  # extension manifest (relative venv path)
├── finlens/                     # the package (lenses/, data/, synthesis/, …)
├── tests/                       # pytest suite for every lens + synthesis
├── scripts/setup.sh             # venv build + --check
├── requirements.txt
└── .env.example                 # config template (safe; placeholders only)
```

## Dependency note

`xcal-plugin` in this repo **depends on finlens** as its deterministic data
engine. Install finlens-plugin alongside xcal-plugin and point
`XCAL_FINLENS_HOME` at this plugin's root.

## Author

Haseeb Khalid (0x04am) — <https://github.com/HaseebKhalid1507>
