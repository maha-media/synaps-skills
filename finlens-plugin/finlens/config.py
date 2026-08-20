"""finlens.config — load settings from environment / .env (no external deps)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def load_dotenv(path: str = ".env") -> None:
    """Minimal .env loader. Pre-set env vars always win. Missing file = no-op."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)


DEFAULT_WATCHLIST = ["NVDA", "TSLA", "AAPL", "AMD", "MSFT", "META", "AMZN", "GOOGL"]


@dataclass
class Config:
    watchlist: list[str] = field(default_factory=lambda: list(DEFAULT_WATCHLIST))
    output_dir: str = "output"
    # data
    financialdatasets_api_key: str | None = None
    use_financialdatasets: bool = False
    # synthesis LLM (optional — pipeline runs without it via deterministic narrative)
    llm_provider: str = "none"          # none | anthropic | openai
    llm_api_key: str | None = None
    llm_model: str = ""
    # synthesis params
    meff_convergence_threshold: float = 2.5
    max_workers: int = 6
    # results sink (the cloud output channel)
    results_api: str | None = None
    results_api_token: str | None = None
    results_api_method: str = "POST"
    results_api_required: bool = False

    @staticmethod
    def from_env(dotenv: str = ".env") -> "Config":
        load_dotenv(dotenv)
        wl = os.environ.get("FINLENS_WATCHLIST", "")
        watchlist = [t.strip().upper() for t in wl.split(",") if t.strip()] or list(DEFAULT_WATCHLIST)
        fd_key = os.environ.get("FINANCIALDATASETS_API_KEY") or None
        return Config(
            watchlist=watchlist,
            output_dir=os.environ.get("FINLENS_OUTPUT_DIR", "output"),
            financialdatasets_api_key=fd_key,
            use_financialdatasets=bool(fd_key) and os.environ.get("FINLENS_USE_FD", "1") != "0",
            llm_provider=os.environ.get("FINLENS_LLM_PROVIDER", "none").lower(),
            llm_api_key=(os.environ.get("ANTHROPIC_API_KEY")
                         or os.environ.get("OPENAI_API_KEY")
                         or os.environ.get("FINLENS_LLM_API_KEY") or None),
            llm_model=os.environ.get("FINLENS_LLM_MODEL", ""),
            meff_convergence_threshold=float(os.environ.get("FINLENS_MEFF_THRESHOLD", "2.5")),
            max_workers=int(os.environ.get("FINLENS_MAX_WORKERS", "6")),
            results_api=os.environ.get("FINLENS_RESULTS_API") or None,
            results_api_token=os.environ.get("FINLENS_RESULTS_API_TOKEN") or None,
            results_api_method=os.environ.get("FINLENS_RESULTS_API_METHOD", "POST").upper(),
            results_api_required=os.environ.get("FINLENS_RESULTS_API_REQUIRED", "0") == "1",
        )
