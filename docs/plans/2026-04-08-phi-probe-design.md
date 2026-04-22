# φ-Probe: Golden Ratio Convergence Analyzer — Design Document

## Purpose

A CLI tool that analyzes numeric sequences for golden ratio (φ = 1.618..., 1/φ = 0.618...) relationships. Primary use case: analyzing BBE pipeline score progressions to detect whether convergence patterns exhibit φ-structure. Secondary: general-purpose φ-analysis of any numeric sequence.

## Core Thesis

LLMs trained via gradient descent may settle toward attractors related to 1/φ because the quadratic equation — the simplest polynomial that can store structured data — has φ as its fundamental root (x² - x - 1 = 0). If BBE's multi-agent feedback loop creates coherent convergence, the score trajectories should show measurable φ-relationships: consecutive ratios approaching φ, difference sequences following Fibonacci-like decay, and natural partition points falling at golden section positions.

## Architecture

Single Python module (`phi_probe.py`) with a CLI entry point. No external dependencies — stdlib only (math, json, sys, argparse, statistics).

### Input Modes

1. **Direct sequence**: `--sequence 0.4,0.6,0.72,0.81,0.85`
2. **JSON file**: `--file scores.json` (expects `{"scores": [0.4, 0.6, ...]}` or plain array)
3. **BBE convergence dir**: `--convergence .convergence/` (reads `scores/history.json`)
4. **Stdin**: pipe a JSON array

### Analysis Modules

| Module | What it computes | φ-signal |
|--------|-----------------|----------|
| **ConsecutiveRatios** | r[i] = seq[i+1] / seq[i] | Ratios clustering near φ or 1/φ |
| **DifferenceRatios** | d[i] = seq[i+1] - seq[i], then d[i]/d[i+1] | Difference ratios approaching φ (Fibonacci property) |
| **GoldenSection** | For each subsequence, where does the min-error partition fall? | Partition points near 0.618 of the range |
| **ConvergenceDecay** | Fit residuals (target - seq[i]) to exponential decay | Decay base near 1/φ = 0.618 |
| **FibonacciProximity** | Map normalized values to nearest Fibonacci ratios | Clustering around F(n)/F(n+1) ratios |

### Output Schema

```json
{
  "input_length": 5,
  "sequence": [0.4, 0.6, 0.72, 0.81, 0.85],
  "phi": 1.6180339887,
  "inv_phi": 0.6180339887,
  "analyses": {
    "consecutive_ratios": {
      "ratios": [1.5, 1.2, 1.125, 1.049],
      "phi_proximity": 0.72,
      "mean_deviation_from_phi": 0.31,
      "trend": "approaching"
    },
    "difference_ratios": {
      "differences": [0.2, 0.12, 0.09, 0.04],
      "ratios": [1.667, 1.333, 2.25],
      "phi_proximity": 0.58,
      "fibonacci_like": false
    },
    "golden_section": {
      "partition_point": 0.63,
      "deviation_from_phi": 0.012,
      "phi_proximity": 0.95
    },
    "convergence_decay": {
      "target": 1.0,
      "decay_base": 0.64,
      "deviation_from_inv_phi": 0.022,
      "phi_proximity": 0.89,
      "r_squared": 0.97
    },
    "fibonacci_proximity": {
      "nearest_fib_ratios": [0.382, 0.618, 0.724, 0.809, 0.854],
      "mean_fib_distance": 0.03,
      "phi_proximity": 0.85
    }
  },
  "composite_phi_score": 0.798,
  "interpretation": "Moderate φ-structure detected. Convergence decay closely follows 1/φ base. Consecutive ratios trending toward φ but not yet locked."
}
```

### Composite Scoring

Each module produces a `phi_proximity` score (0.0–1.0):
- 1.0 = perfect φ-relationship
- 0.0 = no φ-relationship detected

Composite: weighted average
- consecutive_ratios: 0.20
- difference_ratios: 0.20
- golden_section: 0.20
- convergence_decay: 0.25
- fibonacci_proximity: 0.15

### Interpretation Bands

| Score | Interpretation |
|-------|---------------|
| ≥ 0.85 | Strong φ-structure — sequence converges along golden ratio attractor |
| 0.65–0.84 | Moderate φ-structure — partial alignment with φ patterns |
| 0.40–0.64 | Weak φ-structure — some coincidental alignment |
| < 0.40 | No φ-structure detected |

## CLI Interface

```bash
# Direct sequence
python3 phi_probe.py --sequence 0.4,0.6,0.72,0.81,0.85

# From BBE convergence directory
python3 phi_probe.py --convergence .convergence/

# From file
python3 phi_probe.py --file scores.json

# JSON output only (for piping)
python3 phi_probe.py --sequence 0.4,0.6,0.72 --json

# Set convergence target (default: 1.0)
python3 phi_probe.py --sequence 0.4,0.6,0.72 --target 0.85
```

## Constraints

- Python 3.8+ stdlib only — no numpy, scipy, or external deps
- Single file: `phi_probe.py`
- All math implemented from scratch (φ constants, exponential fitting, Fibonacci generation)
- Minimum 3 values in sequence required for meaningful analysis
- Handles edge cases: constant sequences, descending sequences, single values
