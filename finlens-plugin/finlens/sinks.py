"""finlens.sinks — push run results to an external API (the cloud output channel).

The pipeline writes a markdown report to disk AND, if FINLENS_RESULTS_API is set,
POSTs the structured verdicts as JSON to that endpoint. Failure to POST is logged
but does NOT fail the run (the analysis still succeeded) unless FINLENS_RESULTS_API_REQUIRED=1.
urllib only — no new deps.
"""
from __future__ import annotations

import json
import time
import urllib.request
import urllib.error

from .config import Config


def build_payload(run_id: str, watchlist: list[str], verdicts: list[dict]) -> dict:
    """The JSON body POSTed to the results API. Stable, documented shape."""
    return {
        "schema": "finlens.results/1.0",
        "run_id": run_id,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "watchlist": list(watchlist),
        "disclaimer": "RESEARCH LEADS — NOT FINANCIAL ADVICE. Paper-only.",
        "count": len(verdicts),
        "verdicts": verdicts,
    }


def post_results(payload: dict, cfg: Config, *, retries: int = 3, log=print) -> bool:
    """POST results to cfg.results_api. Returns True on 2xx. Never raises into the run."""
    url = cfg.results_api
    if not url:
        return False
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "finlens/0.1"}
    if cfg.results_api_token:
        headers["Authorization"] = f"Bearer {cfg.results_api_token}"
    last_err = None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, data=body, headers=headers,
                                     method=cfg.results_api_method)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                code = getattr(r, "status", r.getcode())
                if 200 <= code < 300:
                    log(f"[sink] results POSTed to {url} → {code}")
                    return True
                last_err = f"HTTP {code}"
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}: {e.reason}"
        except Exception as e:  # noqa: BLE001 — a flaky endpoint must not kill the run
            last_err = f"{type(e).__name__}: {e}"
        if attempt < retries:
            time.sleep(min(2 ** attempt, 8))
    log(f"[sink] results POST FAILED after {retries} tries: {last_err}")
    return False
