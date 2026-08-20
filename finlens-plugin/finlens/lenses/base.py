"""finlens.lenses.base — the Lens interface every analysis lens implements.

A lens reads data for ONE ticker and emits ONE LensOutput (or None if it has no
read). Lenses are isolated, independent, and concurrency-safe — the orchestrator
runs them in parallel. A lens NEVER decides direction for the portfolio; it just
reports its narrow view honestly with a confidence.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from ..contract import LensOutput


class Lens(ABC):
    #: short stable id, e.g. "sentiment", "insider", "fundamentals"
    name: str = "base"
    #: one-line description of what this lens reads
    description: str = ""
    #: True if safe to run concurrently with other lenses (almost always True)
    concurrency_safe: bool = True

    @abstractmethod
    def analyze(self, ticker: str) -> LensOutput | None:
        """Analyze one ticker. Return a LensOutput, or None if no read is possible
        (e.g. no data). MUST NOT raise on ordinary data gaps — return None and let
        the orchestrator record the miss. May raise only on programmer error.
        """
        raise NotImplementedError
