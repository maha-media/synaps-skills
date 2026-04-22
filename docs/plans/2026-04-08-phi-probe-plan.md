# φ-Probe Implementation Plan

**Goal:** Build a Python CLI tool that analyzes numeric sequences for golden ratio (φ) convergence patterns.
**Architecture:** Single-file Python module (`phi_probe.py`) — five analysis modules, CLI interface, composite scoring. Stdlib only.
**Design Doc:** `docs/plans/2026-04-08-phi-probe-design.md`
**Estimated Tasks:** 7 tasks
**Complexity:** Medium

---

## Task 1: Core Constants and Utility Functions

**Files:**
- Create: `phi_probe.py`

Create the foundation: φ constants, proximity scoring, Fibonacci generator, and sequence validation.

```python
"""phi_probe.py — Golden Ratio Convergence Analyzer"""
import math
import json
import sys
import argparse
import statistics

PHI = (1 + math.sqrt(5)) / 2        # 1.6180339887...
INV_PHI = PHI - 1                     # 0.6180339887...  (also 1/PHI)
PHI_SQ = PHI ** 2                     # 2.6180339887...

def fibonacci_ratios(n=20):
    """Generate first n Fibonacci ratios F(k+1)/F(k)."""
    a, b = 1, 1
    ratios = []
    for _ in range(n):
        a, b = b, a + b
        ratios.append(b / a if a != 0 else 0)
    return ratios

def phi_proximity(value, target, max_deviation=1.0):
    """Score how close value is to target on 0-1 scale. 1.0 = exact match."""
    deviation = abs(value - target)
    return max(0.0, 1.0 - (deviation / max_deviation))

def validate_sequence(seq):
    """Validate input sequence. Returns (clean_list, error_string_or_None)."""
    if not isinstance(seq, (list, tuple)):
        return None, "Input must be a list of numbers"
    clean = []
    for i, v in enumerate(seq):
        if isinstance(v, (int, float)) and math.isfinite(v):
            clean.append(float(v))
        else:
            return None, f"Non-finite value at index {i}: {v}"
    if len(clean) < 3:
        return None, f"Need at least 3 values, got {len(clean)}"
    return clean, None
```

---

## Task 2: Consecutive Ratios Analyzer

**Files:**
- Modify: `phi_probe.py`

Analyze ratios between consecutive values. In a φ-convergent sequence, these ratios should cluster near φ (1.618) or 1/φ (0.618).

```python
def analyze_consecutive_ratios(seq):
    """Compute ratios seq[i+1]/seq[i] and measure φ-proximity."""
    ratios = []
    for i in range(len(seq) - 1):
        if seq[i] != 0:
            ratios.append(seq[i + 1] / seq[i])
        else:
            ratios.append(float('inf'))

    finite_ratios = [r for r in ratios if math.isfinite(r)]
    if not finite_ratios:
        return {"ratios": ratios, "phi_proximity": 0.0, "mean_deviation_from_phi": float('inf'), "trend": "undefined"}

    # Test proximity to both φ and 1/φ — take whichever is closer per ratio
    deviations = [min(abs(r - PHI), abs(r - INV_PHI)) for r in finite_ratios]
    mean_dev = statistics.mean(deviations)

    # Trend: are later ratios closer to φ/1/φ than earlier ones?
    if len(deviations) >= 2:
        first_half = statistics.mean(deviations[:len(deviations)//2])
        second_half = statistics.mean(deviations[len(deviations)//2:])
        trend = "approaching" if second_half < first_half else "diverging" if second_half > first_half else "stable"
    else:
        trend = "insufficient_data"

    prox = phi_proximity(mean_dev, 0.0, max_deviation=1.0)

    return {
        "ratios": [round(r, 6) for r in ratios],
        "phi_proximity": round(prox, 4),
        "mean_deviation_from_phi": round(mean_dev, 6),
        "trend": trend
    }
```

---

## Task 3: Difference Ratios Analyzer

**Files:**
- Modify: `phi_probe.py`

Analyze ratios of consecutive differences. In Fibonacci-like sequences, d[i]/d[i+1] approaches φ.

```python
def analyze_difference_ratios(seq):
    """Compute differences and their ratios. Fibonacci-like sequences have d[i]/d[i+1] → φ."""
    diffs = [seq[i + 1] - seq[i] for i in range(len(seq) - 1)]
    
    ratios = []
    for i in range(len(diffs) - 1):
        if diffs[i + 1] != 0:
            ratios.append(diffs[i] / diffs[i + 1])
        else:
            ratios.append(float('inf'))

    finite_ratios = [r for r in ratios if math.isfinite(r)]

    if not finite_ratios:
        return {
            "differences": [round(d, 6) for d in diffs],
            "ratios": ratios,
            "phi_proximity": 0.0,
            "fibonacci_like": False
        }

    deviations = [min(abs(r - PHI), abs(r - INV_PHI)) for r in finite_ratios]
    mean_dev = statistics.mean(deviations)
    prox = phi_proximity(mean_dev, 0.0, max_deviation=1.0)

    # Fibonacci-like: ratios consistently near φ (within 0.2)
    fib_like = all(d < 0.2 for d in deviations) and len(deviations) >= 2

    return {
        "differences": [round(d, 6) for d in diffs],
        "ratios": [round(r, 6) if math.isfinite(r) else None for r in ratios],
        "phi_proximity": round(prox, 4),
        "fibonacci_like": fib_like
    }
```

---

## Task 4: Golden Section and Convergence Decay Analyzers

**Files:**
- Modify: `phi_probe.py`

Two analyzers:
1. Golden section — where does the sequence naturally partition?
2. Convergence decay — does the residual (target - value) decay with base 1/φ?

```python
def analyze_golden_section(seq):
    """Find where the sequence's cumulative energy partitions and test for golden section."""
    total_range = seq[-1] - seq[0]
    if total_range == 0:
        return {"partition_point": 0.5, "deviation_from_phi": 0.5, "phi_proximity": 0.0}

    # Find the index where cumulative progress crosses 61.8% of total range
    target_value = seq[0] + total_range * INV_PHI
    closest_idx = min(range(len(seq)), key=lambda i: abs(seq[i] - target_value))
    partition_point = closest_idx / (len(seq) - 1) if len(seq) > 1 else 0.5

    deviation = abs(partition_point - INV_PHI)
    prox = phi_proximity(deviation, 0.0, max_deviation=0.5)

    return {
        "partition_point": round(partition_point, 4),
        "deviation_from_phi": round(deviation, 6),
        "phi_proximity": round(prox, 4)
    }


def analyze_convergence_decay(seq, target=1.0):
    """Fit residuals to exponential decay and test if decay base ≈ 1/φ."""
    residuals = [abs(target - v) for v in seq]

    # Filter out zero residuals (already converged)
    nonzero = [(i, r) for i, r in enumerate(residuals) if r > 1e-10]
    if len(nonzero) < 2:
        return {
            "target": target,
            "decay_base": 0.0,
            "deviation_from_inv_phi": 1.0,
            "phi_proximity": 0.0,
            "r_squared": 0.0
        }

    # Log-linear regression: log(residual) = log(a) + i * log(base)
    # Using least squares on log(residuals) vs index
    indices = [i for i, _ in nonzero]
    log_res = [math.log(r) for _, r in nonzero]
    
    n = len(indices)
    mean_x = statistics.mean(indices)
    mean_y = statistics.mean(log_res)
    
    ss_xx = sum((x - mean_x) ** 2 for x in indices)
    ss_xy = sum((x - mean_x) * (y - mean_y) for x, y in zip(indices, log_res))
    
    if ss_xx == 0:
        return {"target": target, "decay_base": 0.0, "deviation_from_inv_phi": 1.0, "phi_proximity": 0.0, "r_squared": 0.0}

    slope = ss_xy / ss_xx
    decay_base = math.exp(slope)

    # R-squared
    ss_tot = sum((y - mean_y) ** 2 for y in log_res)
    intercept = mean_y - slope * mean_x
    ss_res = sum((y - (intercept + slope * x)) ** 2 for x, y in zip(indices, log_res))
    r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0.0

    deviation = abs(decay_base - INV_PHI)
    prox = phi_proximity(deviation, 0.0, max_deviation=0.5)

    return {
        "target": target,
        "decay_base": round(decay_base, 6),
        "deviation_from_inv_phi": round(deviation, 6),
        "phi_proximity": round(prox, 4),
        "r_squared": round(max(0, r_squared), 4)
    }
```

---

## Task 5: Fibonacci Proximity Analyzer

**Files:**
- Modify: `phi_probe.py`

Map normalized sequence values to nearest Fibonacci ratios and measure clustering.

```python
def analyze_fibonacci_proximity(seq):
    """Map normalized values to nearest Fibonacci ratios F(k)/F(k+1)."""
    if seq[-1] == seq[0]:
        return {"nearest_fib_ratios": [], "mean_fib_distance": 1.0, "phi_proximity": 0.0}

    # Normalize to 0-1 range
    lo, hi = min(seq), max(seq)
    span = hi - lo
    if span == 0:
        normalized = [0.5] * len(seq)
    else:
        normalized = [(v - lo) / span for v in seq]

    # Generate Fibonacci ratios: 1/2, 2/3, 3/5, 5/8, 8/13, ...
    fib_rats = sorted(set([0.0, 1.0] + fibonacci_ratios(20)))
    # Also include inverse Fibonacci ratios
    fib_set = sorted(set(fib_rats + [1 - r for r in fib_rats if 0 <= 1-r <= 1]))

    nearest = []
    distances = []
    for v in normalized:
        closest = min(fib_set, key=lambda f: abs(v - f))
        nearest.append(round(closest, 6))
        distances.append(abs(v - closest))

    mean_dist = statistics.mean(distances) if distances else 1.0
    prox = phi_proximity(mean_dist, 0.0, max_deviation=0.25)

    return {
        "nearest_fib_ratios": nearest,
        "mean_fib_distance": round(mean_dist, 6),
        "phi_proximity": round(prox, 4)
    }
```

---

## Task 6: Composite Scoring and Interpretation

**Files:**
- Modify: `phi_probe.py`

Combine all analyzers into a unified analysis with composite score and interpretation.

```python
WEIGHTS = {
    "consecutive_ratios": 0.20,
    "difference_ratios": 0.20,
    "golden_section": 0.20,
    "convergence_decay": 0.25,
    "fibonacci_proximity": 0.15
}

INTERPRETATION_BANDS = [
    (0.85, "Strong φ-structure — sequence converges along golden ratio attractor"),
    (0.65, "Moderate φ-structure — partial alignment with φ patterns"),
    (0.40, "Weak φ-structure — some coincidental alignment"),
    (0.00, "No φ-structure detected"),
]

def compute_composite(analyses):
    """Weighted composite of all phi_proximity scores."""
    total = 0.0
    for key, weight in WEIGHTS.items():
        score = analyses.get(key, {}).get("phi_proximity", 0.0)
        total += score * weight
    return round(total, 4)

def interpret(score):
    """Map composite score to interpretation string."""
    for threshold, text in INTERPRETATION_BANDS:
        if score >= threshold:
            return text
    return INTERPRETATION_BANDS[-1][1]

def full_analysis(seq, target=1.0):
    """Run all analyzers and produce unified report."""
    seq, err = validate_sequence(seq)
    if err:
        return {"error": err}

    analyses = {
        "consecutive_ratios": analyze_consecutive_ratios(seq),
        "difference_ratios": analyze_difference_ratios(seq),
        "golden_section": analyze_golden_section(seq),
        "convergence_decay": analyze_convergence_decay(seq, target),
        "fibonacci_proximity": analyze_fibonacci_proximity(seq),
    }

    composite = compute_composite(analyses)

    return {
        "input_length": len(seq),
        "sequence": seq,
        "phi": round(PHI, 10),
        "inv_phi": round(INV_PHI, 10),
        "analyses": analyses,
        "composite_phi_score": composite,
        "interpretation": interpret(composite),
    }
```

---

## Task 7: CLI Interface and Input Parsing

**Files:**
- Modify: `phi_probe.py`

Add argument parsing, input modes (--sequence, --file, --convergence, stdin), and output formatting.

```python
def load_from_file(path):
    """Load sequence from JSON file."""
    data = json.load(open(path))
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        if "scores" in data:
            entries = data["scores"]
            if entries and isinstance(entries[0], dict):
                return [e.get("overall", e.get("score", 0)) for e in entries]
            return entries
        if "sequence" in data:
            return data["sequence"]
    raise ValueError(f"Cannot extract sequence from {path}")

def load_from_convergence(conv_dir):
    """Load scores from BBE .convergence/ directory."""
    import os
    history = os.path.join(conv_dir, "scores", "history.json")
    if not os.path.exists(history):
        raise FileNotFoundError(f"No score history at {history}")
    data = json.load(open(history))
    return [s["overall"] for s in data["scores"]]

def format_human(result):
    """Format result as human-readable text."""
    lines = []
    lines.append(f"φ-Probe Analysis — {result['input_length']} values")
    lines.append(f"Sequence: {result['sequence']}")
    lines.append(f"φ = {result['phi']}, 1/φ = {result['inv_phi']}")
    lines.append("")
    for name, data in result["analyses"].items():
        label = name.replace("_", " ").title()
        prox = data.get("phi_proximity", 0)
        bar = "█" * int(prox * 20) + "░" * (20 - int(prox * 20))
        lines.append(f"  {label:25s} [{bar}] {prox:.2f}")
        for k, v in data.items():
            if k != "phi_proximity":
                lines.append(f"    {k}: {v}")
        lines.append("")
    lines.append(f"Composite φ-Score: {result['composite_phi_score']:.4f}")
    lines.append(f"Interpretation: {result['interpretation']}")
    return "\n".join(lines)

def main():
    parser = argparse.ArgumentParser(description="φ-Probe: Golden Ratio Convergence Analyzer")
    parser.add_argument("--sequence", "-s", help="Comma-separated values: 0.4,0.6,0.72")
    parser.add_argument("--file", "-f", help="JSON file with scores array")
    parser.add_argument("--convergence", "-c", help="BBE .convergence/ directory path")
    parser.add_argument("--target", "-t", type=float, default=1.0, help="Convergence target (default: 1.0)")
    parser.add_argument("--json", "-j", action="store_true", help="Output JSON only")
    args = parser.parse_args()

    seq = None
    if args.sequence:
        seq = [float(x.strip()) for x in args.sequence.split(",")]
    elif args.file:
        seq = load_from_file(args.file)
    elif args.convergence:
        seq = load_from_convergence(args.convergence)
    elif not sys.stdin.isatty():
        seq = json.load(sys.stdin)
        if isinstance(seq, dict):
            seq = seq.get("scores", seq.get("sequence", []))
    else:
        parser.print_help()
        sys.exit(1)

    result = full_analysis(seq, target=args.target)

    if "error" in result:
        print(f"Error: {result['error']}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(format_human(result))
        print()
        print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
```
