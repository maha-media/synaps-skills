"""finlens entry point — `python -m finlens` runs the workflow over the watchlist."""
from __future__ import annotations

import sys

from .config import Config
from . import orchestrator


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    cfg = Config.from_env()
    # optional: tickers as CLI args override the watchlist
    tickers = [a.upper() for a in argv if not a.startswith("-")]
    if tickers:
        cfg.watchlist = tickers
    print("=" * 64)
    print(" finlens — multi-lens finance research workflow")
    print(" RESEARCH LEADS, NOT ADVICE · paper-only")
    print("=" * 64)
    try:
        result = orchestrator.run(cfg)
    except Exception as e:  # noqa: BLE001
        print(f"FATAL: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    print(f"\n✓ done — run {result['run_id']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
