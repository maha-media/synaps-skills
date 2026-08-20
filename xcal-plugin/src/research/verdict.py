"""Verdict — the load-bearing no-fabrication invariant.

Per SPEC §3.3 / §4.1: a numeric Finding with no citation cannot be finalized,
and only finalized Verdicts can be serialized. Two-check defense.
"""
from dataclasses import dataclass, field, asdict
from typing import Literal, Optional
import re
import json

CallId = str


class CitationError(ValueError):
    """Raised when a numeric finding lacks (or mis-cites) a lens citation."""


class FinalizationError(RuntimeError):
    """Raised when serializing a Verdict that has not been finalized."""


class MirrorTestError(ValueError):
    """Raised when a 'pass' verdict lacks a valid mirror_test (≤5 sentences)."""


class CrossValidationError(ValueError):
    """Raised when corroborations violate cross-source independence rules."""


class VetoError(ValueError):
    """Raised when a 'pass' verdict has red flags tripped."""


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
    corroborations: tuple[CallId, ...] = ()
    info_richness: Optional[Literal["A", "B", "C"]] = None


@dataclass(frozen=True)
class Recommendation:
    tier: Literal["aggressive", "steady", "conservative"]
    action: str
    price_low: Optional[float] = None
    price_high: Optional[float] = None
    citations: tuple[CallId, ...] = ()


def _sentence_count(text: str) -> int:
    """Count sentences by terminal punctuation: . ! ?"""
    return len(re.findall(r'[.!?]', text))


def is_cross_validated(finding: Finding, lens_calls: list[LensCall]) -> bool:
    """True iff finding has ≥1 corroboration from a lens DIFFERENT from its primary citation lens(es)."""
    if not finding.corroborations:
        return False
    id_to_lens = {lc.call_id: lc.lens for lc in lens_calls}
    primary_lenses = {id_to_lens[c] for c in finding.citations if c in id_to_lens}
    for cid in finding.corroborations:
        corr_lens = id_to_lens.get(cid)
        if corr_lens is not None and corr_lens not in primary_lenses:
            return True
    return False


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
    # Forced Verdict fields
    stance: Optional[Literal["pass", "fail", "grey_zone"]] = None
    recommendations: list[Recommendation] = field(default_factory=list)
    mirror_test: Optional[str] = None
    # Anti-Bias Rig fields
    inversion: Optional[str] = None
    red_flags: tuple[str, ...] = field(default_factory=tuple)

    def finalize(self) -> "Verdict":
        valid_ids = {lc.call_id for lc in self.lens_calls if lc.status == "ok"}

        # Existing: numeric findings must cite valid ok-lens call_ids
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

        # New: mirror_test gate for pass verdicts
        if self.stance == "pass":
            mt = self.mirror_test or ""
            if not mt.strip() or _sentence_count(mt) > 5:
                raise MirrorTestError(
                    "a 'pass' verdict requires a mirror_test of <=5 sentences"
                )

        # New: recommendations with price targets must cite valid ok-lens call_ids
        for rec in self.recommendations:
            if rec.price_low is not None or rec.price_high is not None:
                if not rec.citations:
                    raise CitationError(
                        f"recommendation with price target has no citation: {rec.action!r}"
                    )
                missing = [c for c in rec.citations if c not in valid_ids]
                if missing:
                    raise CitationError(
                        f"recommendation cites unknown call_id(s) {missing}: {rec.action!r}"
                    )

        # New: cross-validation discipline
        id_to_lens = {lc.call_id: lc.lens for lc in self.lens_calls}
        for f in self.findings:
            if not f.corroborations:
                continue
            # Each corroboration must be a real ok-lens call_id
            missing = [c for c in f.corroborations if c not in valid_ids]
            if missing:
                raise CitationError(
                    f"corroboration cites unknown call_id(s) {missing}: {f.claim!r}"
                )
            # A call_id may not appear in both citations and corroborations
            overlap = set(f.citations) & set(f.corroborations)
            if overlap:
                raise CrossValidationError(
                    f"call_id(s) {sorted(overlap)} appear in both citations and "
                    f"corroborations: {f.claim!r}"
                )
            # Each corroboration must come from a different lens than primary citation(s)
            primary_lenses = {id_to_lens[c] for c in f.citations if c in id_to_lens}
            for cid in f.corroborations:
                corr_lens = id_to_lens.get(cid)
                if corr_lens is not None and corr_lens in primary_lenses:
                    raise CrossValidationError(
                        "corroboration must come from a different lens than the primary citation"
                    )

        # Anti-Bias Rig: info_richness must be A/B/C if set
        for f in self.findings:
            if f.info_richness is not None and f.info_richness not in ("A", "B", "C"):
                raise ValueError(
                    f"info_richness must be 'A', 'B', or 'C', got {f.info_richness!r}: {f.claim!r}"
                )

        # Anti-Bias Rig: red-flag veto — a 'pass' cannot stand with red flags tripped
        if self.red_flags and self.stance == "pass":
            flags = ", ".join(repr(r) for r in self.red_flags)
            raise VetoError(
                f"a 'pass' verdict cannot stand with red flags tripped: {flags}"
            )

        self._finalized = True
        return self


def verdict_to_json(v: Verdict) -> str:
    """Serialize a finalized Verdict. Refuses non-finalized Verdicts."""
    if not getattr(v, "_finalized", False):
        raise FinalizationError("verdict_to_json requires a finalized Verdict")
    d = asdict(v)
    d.pop("_finalized", None)
    # tuples → lists for JSON; add derived cross_validated per finding
    id_to_lens = {lc["call_id"]: lc["lens"] for lc in d["lens_calls"]}
    for f in d["findings"]:
        f["citations"] = list(f["citations"])
        corroborations = list(f.get("corroborations") or [])
        f["corroborations"] = corroborations
        # Derived: cross_validated — True iff ≥1 corroboration from a different lens
        primary_lenses = {id_to_lens[c] for c in f["citations"] if c in id_to_lens}
        f["cross_validated"] = any(
            id_to_lens.get(c) not in primary_lenses and id_to_lens.get(c) is not None
            for c in corroborations
        )
        # info_richness: already present as-is (None or "A"/"B"/"C")
    for rec in d.get("recommendations", []):
        rec["citations"] = list(rec["citations"])
    # red_flags: tuple → list for JSON
    d["red_flags"] = list(d.get("red_flags") or [])
    return json.dumps(d, ensure_ascii=False)
