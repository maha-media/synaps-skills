"""
finlens.synthesis.aggregate — Stage 1: DETERMINISTIC math-only synthesis.

Consumes list[LensOutput] per ticker, produces a structured verdict dict.
Pure numpy, no LLM, no network. This is the hard math backbone.

Design choices (from RESEARCH-FINDINGS.md):
 - confidence-weighted aggregate: weight = LensOutput.confidence.
 - Meff (effective number of independent lenses) as orthogonality gate.
 - Divergence flagged as HIGH-INFORMATION, not suppressed.
 - Single-lens → state="thin", low conviction.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from finlens.contract import LensOutput


# ---------------------------------------------------------------------------
# Meff estimation
# ---------------------------------------------------------------------------

def _meff_from_weights(weights: np.ndarray) -> float:
    """Approximate effective number of independent lenses from confidence weights.

    Uses the "effective-N" / Kish's formula:  Meff = (Σwi)² / Σ(wi²)
    This measures how many *equally-weighted* lenses the weighted sum behaves
    like.  It ranges from 1 (all weight on one lens) to N (uniform weights).

    NOTE: This is NOT a true correlation-based Meff (we can't compute a real
    correlation matrix from a single observation per lens).  It captures weight
    concentration — if one lens dominates via high confidence, Meff stays low
    even with many lenses.  When a precomputed correlation matrix is available,
    use meff_from_corr() instead for the eigenvalue participation-ratio Meff.
    """
    total = float(np.sum(weights))
    if total == 0:
        return 0.0
    return (total ** 2) / float(np.sum(weights ** 2))


def meff_from_corr(corr: np.ndarray) -> float:
    """Eigenvalue participation-ratio Meff from a precomputed correlation matrix.

    Meff = (Σλ)² / Σ(λ²)   (participation ratio of eigenvalues)

    When signals are perfectly independent, eigenvalues are all ~1 and Meff ≈ N.
    When signals are perfectly correlated, one eigenvalue dominates and Meff ≈ 1.
    This is the Fonseca (2026) approach referenced in RESEARCH-FINDINGS.md.
    """
    eigenvalues = np.linalg.eigvalsh(corr)
    # Clamp tiny negatives from numerical noise
    eigenvalues = np.maximum(eigenvalues, 0.0)
    total = float(np.sum(eigenvalues))
    if total == 0:
        return 0.0
    return (total ** 2) / float(np.sum(eigenvalues ** 2))


# ---------------------------------------------------------------------------
# Core: single-ticker aggregation
# ---------------------------------------------------------------------------

def aggregate_ticker(
    ticker: str,
    outputs: list[LensOutput],
    meff_threshold: float = 2.5,
    corr_matrix: Optional[np.ndarray] = None,
) -> dict:
    """Produce a structured verdict for one ticker from its lens outputs.

    Parameters
    ----------
    ticker : str
        Uppercase ticker symbol.
    outputs : list[LensOutput]
        All lens outputs for this ticker.
    meff_threshold : float
        Minimum Meff to declare "convergent" state (default 2.5 from config).
    corr_matrix : np.ndarray, optional
        Precomputed lens correlation matrix (N×N). If provided, uses eigenvalue
        Meff instead of the weight-based proxy.

    Returns
    -------
    dict with keys:
        ticker, aggregate_score, direction, conviction, meff, n_lenses,
        agreeing, dissenting, state, summary, lens_details
    """
    ticker = ticker.upper().strip()

    if not outputs:
        return _empty_verdict(ticker)

    n = len(outputs)
    scores = np.array([o.score for o in outputs], dtype=np.float64)
    weights = np.array([o.confidence for o in outputs], dtype=np.float64)
    lens_names = [o.lens for o in outputs]

    # --- Confidence-weighted aggregate score ---
    w_sum = float(np.sum(weights))
    if w_sum == 0:
        agg_score = 0.0
    else:
        agg_score = float(np.dot(scores, weights) / w_sum)

    # Clamp to [-1, 1]
    agg_score = float(np.clip(agg_score, -1.0, 1.0))

    # --- Direction ---
    if agg_score > 0.05:
        direction = "bullish"
    elif agg_score < -0.05:
        direction = "bearish"
    else:
        direction = "neutral"

    # --- Meff ---
    if corr_matrix is not None and corr_matrix.shape == (n, n):
        meff = meff_from_corr(corr_matrix)
    else:
        meff = _meff_from_weights(weights)

    # --- Agreeing / Dissenting ---
    # Majority sign = sign of aggregate score (weighted)
    if agg_score > 0.05:
        majority_sign = 1
    elif agg_score < -0.05:
        majority_sign = -1
    else:
        # Neutral aggregate: majority = whichever side has more weighted mass
        pos_mass = float(np.sum(weights[scores > 0.05]))
        neg_mass = float(np.sum(weights[scores < -0.05]))
        majority_sign = 1 if pos_mass >= neg_mass else -1

    agreeing = []
    dissenting = []
    for i, o in enumerate(outputs):
        if abs(scores[i]) <= 0.05:
            # Neutral lenses: neither agree nor dissent strongly
            agreeing.append(o.lens)
        elif (scores[i] > 0.05 and majority_sign > 0) or \
             (scores[i] < -0.05 and majority_sign < 0):
            agreeing.append(o.lens)
        else:
            dissenting.append(o.lens)

    n_agreeing_weighted = 0.0
    for i, o in enumerate(outputs):
        if o.lens in agreeing and abs(scores[i]) > 0.05:
            n_agreeing_weighted += weights[i]

    # --- State classification ---
    state = _classify_state(
        n_lenses=n,
        meff=meff,
        meff_threshold=meff_threshold,
        n_agreeing=len([l for l in agreeing if l not in
                        [outputs[j].lens for j in range(n) if abs(scores[j]) <= 0.05]]),
        n_dissenting=len(dissenting),
        weights=weights,
        scores=scores,
    )

    # --- Conviction ---
    # |agg_score| gated by Meff and convergence quality
    raw_conviction = abs(agg_score)
    if n == 1:
        # Single lens: cap conviction hard
        conviction = raw_conviction * 0.3
    elif state == "convergent":
        # Good convergence: conviction = |agg| scaled by meff quality
        meff_bonus = min(meff / meff_threshold, 1.5)  # cap at 1.5x
        conviction = raw_conviction * min(meff_bonus, 1.0)
    elif state == "divergent":
        # Divergence: moderate conviction (it's informative, but direction unclear)
        conviction = raw_conviction * 0.5
    else:  # weak
        conviction = raw_conviction * 0.4

    conviction = float(np.clip(conviction, 0.0, 1.0))

    # --- Summary ---
    summary = _build_summary(ticker, direction, state, conviction, meff,
                             agreeing, dissenting, n)

    # --- Lens details for downstream synthesis ---
    lens_details = []
    for o in outputs:
        lens_details.append({
            "lens": o.lens,
            "signal": o.signal,
            "score": o.score,
            "confidence": o.confidence,
            "evidence": o.evidence,
        })

    return {
        "ticker": ticker,
        "aggregate_score": round(agg_score, 4),
        "direction": direction,
        "conviction": round(conviction, 4),
        "meff": round(meff, 2),
        "n_lenses": n,
        "agreeing": agreeing,
        "dissenting": dissenting,
        "state": state,
        "summary": summary,
        "lens_details": lens_details,
    }


def _empty_verdict(ticker: str) -> dict:
    """Verdict when no lens outputs available."""
    return {
        "ticker": ticker,
        "aggregate_score": 0.0,
        "direction": "neutral",
        "conviction": 0.0,
        "meff": 0.0,
        "n_lenses": 0,
        "agreeing": [],
        "dissenting": [],
        "state": "thin",
        "summary": f"{ticker}: no lens data available.",
        "lens_details": [],
    }


def _classify_state(
    n_lenses: int,
    meff: float,
    meff_threshold: float,
    n_agreeing: int,
    n_dissenting: int,
    weights: np.ndarray,
    scores: np.ndarray,
) -> str:
    """Classify the verdict state.

    States:
      - "thin"       : only 1 lens (or 0)
      - "convergent"  : ≥2 lenses agree in sign AND Meff ≥ threshold
      - "divergent"   : material disagreement between lenses (some agree, some dissent)
      - "weak"        : multiple lenses but either Meff too low or weak agreement
    """
    if n_lenses <= 1:
        return "thin"

    # Detect divergence: at least one dissenter with meaningful confidence
    has_material_dissent = n_dissenting >= 1

    if has_material_dissent:
        # Check if the dissent is material (not just a tiny-confidence outlier)
        # We already classified by sign, so if anyone dissents, flag it
        return "divergent"

    # All lenses agree in sign (or are neutral)
    # Adaptive threshold: with only 2 lenses, max possible Meff is 2.0 (equal
    # weights), so a fixed 2.5 gate would be unreachable.  Scale the threshold
    # by what's achievable:  effective_threshold = min(configured, n * 0.85).
    # This means 2 well-balanced independent lenses CAN converge (gate ≈ 1.7),
    # while 3+ lenses still face the full 2.5 gate.
    effective_threshold = min(meff_threshold, n_lenses * 0.85)
    if n_agreeing >= 2 and meff >= effective_threshold:
        return "convergent"

    return "weak"


def _build_summary(
    ticker: str,
    direction: str,
    state: str,
    conviction: float,
    meff: float,
    agreeing: list[str],
    dissenting: list[str],
    n_lenses: int,
) -> str:
    """One-line machine summary."""
    if state == "thin":
        lens_name = agreeing[0] if agreeing else "unknown"
        return (f"{ticker}: THIN — single lens ({lens_name}), "
                f"direction={direction}, low conviction ({conviction:.2f}).")

    if state == "divergent":
        return (f"{ticker}: DIVERGENT — {', '.join(agreeing)} vs {', '.join(dissenting)}, "
                f"direction={direction}, conviction={conviction:.2f}, Meff={meff:.1f}. "
                f"High-information clash — investigate.")

    if state == "convergent":
        return (f"{ticker}: CONVERGENT — {n_lenses} lenses agree {direction}, "
                f"conviction={conviction:.2f}, Meff={meff:.1f}.")

    # weak
    return (f"{ticker}: WEAK — {n_lenses} lenses, "
            f"direction={direction}, conviction={conviction:.2f}, Meff={meff:.1f}. "
            f"Insufficient orthogonal agreement.")


# ---------------------------------------------------------------------------
# Rank: sort verdicts for the watchlist
# ---------------------------------------------------------------------------

def rank(verdicts: list[dict]) -> list[dict]:
    """Sort verdicts for the ranked watchlist.

    Primary: conviction descending.
    Exception: divergent-but-high-info cases get a boost so they surface
    prominently — divergence IS signal per RESEARCH-FINDINGS.md.

    Sorting key: effective_rank_score = conviction + divergence_boost.
    Divergent cases with decent Meff get +0.15 so they aren't buried.
    """
    def _rank_key(v: dict) -> float:
        base = v.get("conviction", 0.0)
        if v.get("state") == "divergent":
            # Divergent cases are high-information: boost them in ranking
            # The boost scales with how many lenses are involved
            n = v.get("n_lenses", 0)
            boost = 0.15 * min(n / 3.0, 1.0)
            return base + boost
        return base

    return sorted(verdicts, key=_rank_key, reverse=True)
