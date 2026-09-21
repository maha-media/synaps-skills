# Synthetic router benchmark

From `jev-plugin`:

```sh
python3 scripts/benchmark_router.py
python3 -m unittest discover -s tests -p 'test_benchmark_router.py'
# Foreman only, later; uses existing key discovery, never writes settings:
python3 scripts/benchmark_router.py --live --model jev-latest
```

Default is offline: no credential discovery, transport import/client, network,
worker dispatch, or config access. It reports labels and deterministic planned
counts, **not measured accuracy, tokens, cost, or latency** (those are null).
Seven short public synthetic cases produce baseline **6 calls / 12 questions**
and optimized **4 calls / 5 questions** on successful cacheable answers. Question
counts alone do not establish token/cost savings. No extra snapshot call is made.

`baseline.json` contains verbatim AST-selected definitions from
`git show f3a6d07:jev-plugin/extensions/jev/router.py`: ROLES, TIERS, RouterConfig,
questions, plan_fill and handle. Only transport/type bindings are injected;
baseline logs and raw audit writes are discarded. This retains old prompts,
always role+needs_write on incomplete requests, old state shaping, and no cache.
Both model maps are empty: no tier questions, model selection, or model fills.
“All explicit” means all actionable fields (role/write policy); model remains
absent/inherited because tier maps are disabled.

Live mode creates one fresh client per arm, same `--model` (pin a version for
reproducibility), and interleaves baseline then optimized per case. This reduces
but does not eliminate time/order bias. SingleAttemptClient invokes the bounded
stdlib transport directly, never its retrying decide method. Shared maximum is
12 wire attempts, normally 10; failed/non-cacheable repeats may use all 12.
There is no retry and no real worker dispatch. Only these fixed synthetic inputs
are accepted. Reports contain no raw responses, exception messages, key paths,
or baseline raw audit payloads. Missing/invalid usage stays null, not zero;
zero-call rows have measured zero cost. Cost is an estimate from actual returned
input tokens at $0.042/million (output free), not a billed-cost guarantee.
Latency is per wire attempt, not hook/cache lookup timing.

Rows show expected **complete fill sets**, explicit-field preservation counts,
no-model checks, cache hits, calls/questions/tokens/cost/latency, and assessment.
Research/review role alternatives are declared in each read label. Missing
allowed fills are abstentions; wrong/extra fills or changed originals are
incorrect. Read-only on the writing case is critical. Correctly leaving writing
policy unset is correct, not an abstention. Audit counters distinguish errors;
an escaping legacy malformed-response exception is counted separately by the
harness without changing the frozen code. Totals and baseline-minus-optimized
deltas split unique cases from repeats, separating sparse-question gains from
cache reuse. These seven cases are a smoke benchmark, not population accuracy.
No live measurements or savings claims are checked in here.
