# Supplied live evidence benchmark

This documents the supplied `jev-evidence-benchmark-live.json`, not a new run.
[Sanitized results](results.json) retain the public synthetic measurements and
labels, omitting free-form caveat/fallback text; no host details, credentials or
raw exceptions are included. Four fixed descriptor batches cover parser
whitespace, contradictory auth, keyboard/injection and vague evidence. No source
contents were read or fetched. No retries or additional live calls were made
for this documentation; verification was offline report arithmetic/invariant
checking and `git diff --check`, not test execution.

## Measurements

| Measurement | Result |
|---|---:|
| Batches / optional questions / retries | 4 / 12 / 0 |
| Pinned and returned model (all four calls) | `jev-1.13.0` |
| Input tokens | 2,872 |
| Estimated total Jev input cost, assuming $0.042/M input tokens | $0.000120624 |
| Hook median / p95 | 390.17 / 422.02 ms |
| Network median / p95 | 389.97 / 421.63 ms |
| Total serialized output bytes (four live cases) | 4,102 |
| Known-relevant optionals placed first (weak-label recall) | 3/5 = 60% |
| Relevant among inspect-first selections (weak-label precision) | 3/3 = 100% |
| Wrong inspect-first priorities | 0 |
| Review outcomes / expected review labels | 8/12 / 4/12 |
| Decisive optional outcomes (inspect-first or later) | 4/12 = 33.3% |

Cost is 2,872 × $0.042 / 1,000,000, an estimate, not an invoice. Percentiles use
linear interpolation over four observations. Hook percentiles and total bytes
were recomputed from per-case data; network timing and input usage are supplied
aggregates, not independently remeasured. Output bytes are **total serialized
output**, not incremental bytes or incremental main-model cost.

## Outcomes and limits

| Case | Inspect first | Review | Later |
|---|---|---|---|
| Parser | `parser` | `http`, `edge` | — |
| Auth | `current`, `historic` | — | `css` |
| UI | — | `injected`, `keyboard`, `unclear` | — |
| Vague | — | `note`, `page`, `item` | — |

Parser `edge` and UI `keyboard` missed priority and remained review. The report
contains no per-answer confidence or explanation; their causes cannot be
inferred. Both contradictory current and historic auth descriptors were placed
first: relevance is not a finding about which is true or authoritative.

The injection descriptor remained **review**, not `later`. No reference
corruption was reported, but this single synthetic outcome does not demonstrate
universal injection resistance. Unknown/review outcomes are not counted as
successful relevance classifications.

All four live cases and all twelve free variants report caller-required
preservation, every ID exactly once, exact references, unchanged input and stable
input order within priority buckets. All report `fetched:false` and
`trust_certified:false`. The all-required, disabled and no-key variants each
ran for all four cases: **12 variants, zero wire calls**. These are recorded
structural invariants, not proof that the caller supplied all mandatory evidence,
coverage, source truth or trust.

The comparator deliberately prioritizes only the first optional item; every
case starts with a distractor or ambiguous item. It achieves **0/5 recall and
four wrong priorities**. This is a deliberately weak starting-order baseline,
not a fair savings, speedup or LLM comparison. Actual main-model cost and
end-to-end task quality/cost/latency are absent; there is no end-to-end savings
claim. No cache benefit is measured.

Weak fixed labels, four batches, missed relevant priorities and high review
frequency justify **advisory-only** use. Evidence remains **off by default** and
the production **>=0.8 confidence gate is unchanged**. Lower priority never
permits discarding evidence; required preservation is not exhaustive coverage.
