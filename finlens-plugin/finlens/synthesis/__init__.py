"""finlens.synthesis — two-stage synthesis: deterministic math + optional LLM narrative."""
from finlens.synthesis.aggregate import aggregate_ticker, rank, meff_from_corr
from finlens.synthesis.synthesis import synthesize

__all__ = ["aggregate_ticker", "rank", "meff_from_corr", "synthesize"]
