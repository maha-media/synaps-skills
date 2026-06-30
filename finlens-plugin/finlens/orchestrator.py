"""finlens.orchestrator — wires data + lenses + synthesis + report into one run.

Flow:  build data source (financialdatasets primary → yfinance fallback)
    → build lenses → run every (ticker, lens) in parallel → collect LensOutputs
    → Stage 1 deterministic aggregate per ticker → rank
    → Stage 2 synthesis narrative (LLM or deterministic fallback)
    → write report.  Everything recorded to an append-only scratchpad.
"""
from __future__ import annotations

import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed

from .config import Config
from .contract import LensOutput
from .scratchpad import Scratchpad
from .data import MultiSource
from .data.yfinance_source import YFinanceSource


def build_data_source(cfg: Config):
    sources = []
    if cfg.use_financialdatasets and cfg.financialdatasets_api_key:
        try:
            from .data.financialdatasets_source import FinancialDatasetsSource
            sources.append(FinancialDatasetsSource(cfg.financialdatasets_api_key))
        except Exception:
            pass
    sources.append(YFinanceSource())
    return MultiSource(sources)


def build_lenses(cfg: Config, data) -> list:
    """Construct lenses defensively — a lens that fails to construct is skipped, not fatal."""
    specs = []
    # (module, class, kwargs-factory)
    def add(modpath, clsname, make_kwargs):
        try:
            mod = __import__(f"finlens.lenses.{modpath}", fromlist=[clsname])
            cls = getattr(mod, clsname)
            specs.append(cls(**make_kwargs()))
        except Exception as e:  # noqa: BLE001
            print(f"  ! lens {modpath}.{clsname} unavailable: {type(e).__name__}: {e}")
    add("insider", "InsiderLens", lambda: {"data": data})
    add("fundamentals", "FundamentalsLens", lambda: {"data": data})
    add("technicals", "TechnicalsLens", lambda: {"data": data})
    add("sentiment", "SentimentLens", lambda: {})
    add("news", "NewsLens", lambda: {"data": data})
    add("search_trend", "SearchTrendLens", lambda: {})
    return specs


def _run_one(lens, ticker) -> tuple[str, str, LensOutput | None, str | None]:
    try:
        out = lens.analyze(ticker)
        return lens.name, ticker, out, None
    except Exception:  # noqa: BLE001 — a lens must never kill the run
        return lens.name, ticker, None, traceback.format_exc(limit=3)


def run(cfg: Config) -> dict:
    from .synthesis.aggregate import aggregate_ticker, rank
    from .synthesis.synthesis import synthesize
    from .report import write_report

    data = build_data_source(cfg)
    lenses = build_lenses(cfg, data)
    print(f"→ {len(lenses)} lenses, {len(cfg.watchlist)} tickers: {', '.join(cfg.watchlist)}")
    if not lenses:
        raise RuntimeError("no lenses available — aborting")

    by_ticker: dict[str, list[LensOutput]] = {t: [] for t in cfg.watchlist}
    sp = Scratchpad(cfg.output_dir)
    try:
        jobs = [(lens, t) for t in cfg.watchlist for lens in lenses]
        with ThreadPoolExecutor(max_workers=cfg.max_workers) as ex:
            futs = [ex.submit(_run_one, lens, t) for (lens, t) in jobs]
            for fut in as_completed(futs):
                name, ticker, out, err = fut.result()
                sp.lens_result(name, ticker, out.to_dict() if out else None, err)
                if out is not None:
                    by_ticker[ticker].append(out)
                tag = "✓" if out else ("✗err" if err else "·none")
                print(f"  {tag} {name:<13} {ticker}")

        verdicts = [aggregate_ticker(t, by_ticker[t], cfg.meff_convergence_threshold)
                    for t in cfg.watchlist]
        verdicts = rank(verdicts)
        sp.event("synthesis.verdicts", {"verdicts": verdicts})

        narrative = synthesize(verdicts, by_ticker, cfg)
        path = write_report(verdicts, by_ticker, narrative, cfg.output_dir, sp.run_id)
        sp.event("report.written", {"path": path})
        print(f"→ report: {path}")

        # Cloud output channel: POST structured results to the configured API.
        posted = None
        if cfg.results_api:
            from .sinks import build_payload, post_results
            payload = build_payload(sp.run_id, cfg.watchlist, verdicts)
            posted = post_results(payload, cfg)
            sp.event("results.posted", {"api": cfg.results_api, "ok": posted})
            if not posted and cfg.results_api_required:
                raise RuntimeError(
                    f"results POST to {cfg.results_api} failed and FINLENS_RESULTS_API_REQUIRED=1")

        return {"run_id": sp.run_id, "report": path, "verdicts": verdicts, "posted": posted}
    finally:
        sp.close()
