# Worker-report triage: supplied synthetic live results

[results.json](results.json) retains the supplied `/tmp/jev-reports-benchmark-live.json`
report from four fixed public synthetic collect envelopes. The source was reviewed
for publication: it contains aggregate/per-case measurements and fixed labels,
not raw exceptions, credentials, host secrets or worker prose; no fields needed
removal. This documentation increment did not rerun the benchmark, launch real
workers, execute checks, or contact an API. Runtime code, thresholds and labels
were not changed.

Report triage is **default off**, opt-in and independent of guard. It annotates
claims; it neither validates their sources nor grants host authority.

## Observed measurements

| Measurement | Supplied result |
|---|---|
| Initial API calls / questions | 4 / 8 |
| Pinned and returned model | `jev-1.13.0` (all four calls) |
| Input tokens | 2236 |
| Estimated input-token cost | $0.000093912, assuming $0.042 per million input tokens; not an invoice |
| Median initial hook latency | 338.461 ms |
| Total initial hook latency | 1469.799 ms |
| Initial output bytes | 2649 |
| Net output byte delta | +303 (2346 input bytes); includes JSON formatting changes |
| Exact synthetic cache repeats | 4 hits, 0 additional API calls / questions |
| Free variants | 28, 0 API calls / questions |

Hook timings are not just network timings. Output sizes total the four initial
raw tool-result serializations, not hook envelopes or the size of `results.json`.
The byte increase is **not tokens saved**, compression, or end-to-end savings.

## Fixed weak-label outcomes

| Synthetic case | Expected flags | Observed flags | Interpretation |
|---|---|---|---|
| Simple unrun tests (`gap`) | `verification_gap` | `verification_gap`, `reported_failure` | Gap found; extra failure flag is a false positive under the fixed labels |
| Contradiction | `conflicting_claims` | `conflicting_claims` | Correct primary flag |
| Clean claim | none | none | No flags, not a success certificate or a known abstention reason |
| Injection | `verification_gap` | `verification_gap` | Gap found; reference values unchanged in this fixture, not universal injection resistance |

All **3 expected flags** were found, with **1 false positive** and **0 false
negatives**: micro flag precision **0.75**, recall **1.0**. These are fixed weak
labels on four examples, not calibrated ground truth or broad quality evidence.
The contradiction could also plausibly report failure; the fixed primary label
remains `conflicting_claims`. No labels or thresholds were tuned after the run.
No flags is ambiguous (including possible abstention), never certification.

The comparison is a trivial deterministic **no-semantic-flags** baseline: zero
calls, zero questions, zero true positives, three false negatives, recall 0 and
undefined precision (`null`). It is not an LLM cost comparison, a frontier-model
comparison, or evidence of net task savings.

## Preservation and authority limits

The supplied rows record `original_values_preserved`, `input_not_mutated`, and
`no_authority` as true across initial cases, repeats and free variants. All
original JSON values—including error, note, authorization, status, collected and
handle—are preserved; input objects are unmutated. Annotation may reserialize
JSON, so this is not byte-perfect preservation.

These are **structural checks**, not independent source validation of worker
prose, proof that claimed checks ran, or proof that AI prompt injection cannot
succeed. The injection fixture's unchanged reference values and gap flag support
only that narrow observation. Advice does not authorize execution, retries,
collection, reconciliation, skipping checks, merging, or success certification.
No real workers or checks were run by this benchmark.

## Cache and free-path scope

The four repeats reuse identical synthetic payloads with the same session,
handle and model; the cache key includes the **exact raw payload + session +
handle + model**. They demonstrate exact-repeat caching, including no-flag advice,
not a large real-workflow cache benefit. In the real host, the first recollection
changes `collected` from `false` to `true`: that intentionally misses this cache.
This report is not an instruction to recollect.

The 28 free variants are seven per fixture: off, no key, running, malformed,
failed, timed out and cancelled. The first four pass through; the three terminal
failure states receive fixed local status flags without an API call. These are
separate from the initial semantic flag-quality totals.

## Validation provenance

The supplied historical protocol checkpoints were **219 offline tests**, then
**229 full offline tests plus 154 subtests**, run sequentially. Those checks were
not rerun for this documentation update and are not measurements stored in the
JSON report. This increment only parsed the JSON, recomputed report arithmetic
and invariants locally, and ran `git diff --check`; it did not run tests or builds.
