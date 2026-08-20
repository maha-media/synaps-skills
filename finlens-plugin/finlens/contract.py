"""
finlens.contract — the shared output schema every lens emits.

THE SPINE. Every lens returns a LensOutput. The synthesis layer consumes ONLY
LensOutput objects, never a lens's internals. score and confidence are SEPARATE:
a strong read on thin data = high |score|, low confidence.

Doctrine: signals are research LEADS, not advice. Most lenses are weak/contrarian
standalone — value lives in orthogonal fusion + honest confidence.
"""
from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field, asdict
from typing import Literal

SCHEMA_VERSION = "1.0"

Signal = Literal["bullish", "bearish", "neutral"]
_VALID_SIGNALS = ("bullish", "bearish", "neutral")


def _utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class ContractError(ValueError):
    """Raised when a LensOutput violates the contract."""


@dataclass
class LensOutput:
    """The one object every lens emits, per ticker.

    Fields:
      lens          : lens name, e.g. "sentiment", "insider"
      ticker        : uppercase symbol, e.g. "NVDA"
      signal        : "bullish" | "bearish" | "neutral" (direction of the read)
      score         : -1.0 (max bearish) .. +1.0 (max bullish). MUST agree in sign with signal.
      confidence    : 0.0 .. 1.0 — data sufficiency / reliability (NOT strength of the read)
      evidence      : human-readable bullet strings explaining the read
      data_freshness: ISO ts of the underlying data (how stale the inputs are)
      meta          : optional lens-specific extras (sample sizes, sub-signals, etc.)
      schema_version, timestamp: auto-stamped
    """

    lens: str
    ticker: str
    signal: Signal
    score: float
    confidence: float
    evidence: list[str] = field(default_factory=list)
    data_freshness: str | None = None
    meta: dict = field(default_factory=dict)
    schema_version: str = SCHEMA_VERSION
    timestamp: str = field(default_factory=_utc_now_iso)

    def __post_init__(self) -> None:
        self.ticker = str(self.ticker).upper().strip()
        self.lens = str(self.lens).strip()
        self.validate()

    def validate(self) -> "LensOutput":
        if not self.lens:
            raise ContractError("lens name is required")
        if not self.ticker:
            raise ContractError("ticker is required")
        if self.signal not in _VALID_SIGNALS:
            raise ContractError(f"signal must be one of {_VALID_SIGNALS}, got {self.signal!r}")
        try:
            self.score = float(self.score)
            self.confidence = float(self.confidence)
        except (TypeError, ValueError) as e:
            raise ContractError(f"score/confidence must be numeric: {e}")
        if not -1.0 <= self.score <= 1.0:
            raise ContractError(f"score must be in [-1, 1], got {self.score}")
        if not 0.0 <= self.confidence <= 1.0:
            raise ContractError(f"confidence must be in [0, 1], got {self.confidence}")
        # sign/signal coherence (neutral allows a small dead-band)
        if self.signal == "bullish" and self.score < 0:
            raise ContractError(f"bullish signal with negative score {self.score}")
        if self.signal == "bearish" and self.score > 0:
            raise ContractError(f"bearish signal with positive score {self.score}")
        if not isinstance(self.evidence, list):
            raise ContractError("evidence must be a list of strings")
        return self

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict) -> "LensOutput":
        known = {f for f in LensOutput.__dataclass_fields__}  # type: ignore[attr-defined]
        return LensOutput(**{k: v for k, v in d.items() if k in known})


def signal_from_score(score: float, deadband: float = 0.05) -> Signal:
    """Helper so lenses keep signal and score coherent automatically."""
    if score > deadband:
        return "bullish"
    if score < -deadband:
        return "bearish"
    return "neutral"


def make_output(
    lens: str,
    ticker: str,
    score: float,
    confidence: float,
    evidence: list[str] | None = None,
    data_freshness: str | None = None,
    meta: dict | None = None,
    deadband: float = 0.05,
) -> LensOutput:
    """Convenience constructor that derives a coherent signal from score."""
    score = max(-1.0, min(1.0, float(score)))
    return LensOutput(
        lens=lens,
        ticker=ticker,
        signal=signal_from_score(score, deadband),
        score=score,
        confidence=max(0.0, min(1.0, float(confidence))),
        evidence=list(evidence or []),
        data_freshness=data_freshness,
        meta=dict(meta or {}),
    )
