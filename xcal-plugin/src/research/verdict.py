"""Verdict — the load-bearing no-fabrication invariant.

Per SPEC §3.3 / §4.1: a numeric Finding with no citation cannot be finalized,
and only finalized Verdicts can be serialized. Two-check defense.
"""
from dataclasses import dataclass, field, asdict
from typing import Literal, Optional
import json

CallId = str


class CitationError(ValueError):
    """Raised when a numeric finding lacks (or mis-cites) a lens citation."""


class FinalizationError(RuntimeError):
    """Raised when serializing a Verdict that has not been finalized."""


@dataclass(frozen=True)
class LensCall:
    call_id: CallId
    lens: str
    status: Literal["ok", "error"]
    latency_ms: int
    error: Optional[str] = None


@dataclass(frozen=True)
class Finding:
    claim: str
    kind: Literal["numeric", "qualitative"]
    citations: tuple[CallId, ...] = ()
    value: Optional[float] = None
    confidence: float = 0.0


@dataclass
class Verdict:
    ticker: str
    question: str
    skill_used: str = ""
    lens_calls: list[LensCall] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    synthesis: str = ""
    axel_memory_id: Optional[str] = None
    reflection: dict = field(default_factory=lambda: {"status": "queued"})
    _finalized: bool = field(default=False, repr=False)

    def finalize(self) -> "Verdict":
        valid_ids = {lc.call_id for lc in self.lens_calls if lc.status == "ok"}
        for f in self.findings:
            needs_citation = f.kind == "numeric" or f.value is not None
            if needs_citation:
                if not f.citations:
                    raise CitationError(
                        f"finding with numeric value has no citation: {f.claim!r}"
                    )
                missing = [c for c in f.citations if c not in valid_ids]
                if missing:
                    raise CitationError(
                        f"finding cites unknown call_id(s) {missing}: {f.claim!r}"
                    )
        self._finalized = True
        return self


def verdict_to_json(v: Verdict) -> str:
    """Serialize a finalized Verdict. Refuses non-finalized Verdicts."""
    if not getattr(v, "_finalized", False):
        raise FinalizationError("verdict_to_json requires a finalized Verdict")
    d = asdict(v)
    d.pop("_finalized", None)
    # tuples → lists for JSON
    for f in d["findings"]:
        f["citations"] = list(f["citations"])
    return json.dumps(d, ensure_ascii=False)
