# Synthetic router benchmark

From `jev-plugin`:

```sh
python3 scripts/benchmark_router.py
python3 -m unittest discover -s tests -p 'test_benchmark_router.py'
# Optional live reproduction; incurs API cost, never writes settings:
python3 scripts/benchmark_router.py --live --model jev-1.13.0
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
## Recorded pinned live results

The supplied reports are copied verbatim as reproducible evidence:

- [`results/jev-router-live.json`](results/jev-router-live.json): pinned
  `jev-1.13.0`, frozen old arm at `f3a6d07`, seven cases including two repeats.
- [`results/jev-router-live-protocol.json`](results/jev-router-live-protocol.json):
  separate protocol smoke, not included in benchmark totals.

Both were inspected before copying: only fixed public synthetic inputs/results,
no apparent secrets, credentials, private task data, or raw responses. These
artifacts preserve the observed run, not a guarantee of identical future answers
or timings. No live call or worker launch was performed during finalization.

| Workload / metric | Old | New |
|---|---:|---:|
| All seven: calls | 6 | 4 |
| All seven: questions | 12 | 5 |
| All seven: returned input tokens | 2,972 | 1,730 |
| All seven: estimated Jev cost | $0.000124824 | $0.00007266 |
| All seven: summed transport latency | 2,290.87 ms | 1,514.51 ms |
| Five unique cases: input tokens | 1,981 | 1,730 |
| Five unique cases: summed transport latency | 1,480.84 ms | 1,514.51 ms |
| Two repeats: calls / input tokens | 2 / 991 | 0 / 0 |

Input-token and estimated-cost reduction is **41.8% on this seven-case workload
only**, including repeat reuse. Unique tokens are computed directly from rows:
old `493 + 493 + 498 + 497 + 0 = 1,981`; new
`349 + 349 + 484 + 548 + 0 = 1,730`. That saves 251 tokens on unique cases;
repeat caching avoids another 991 tokens and two calls. The both-fields-missing
`read` case increased from 497 to 548 tokens due to the safety prompt. Unique
summed transport latency was **33.67 ms slower**; total latency benefits here
come from repeats, not a universal speedup. Zero-call repeat latency is zero
transport time, not a measurement of local cache/hook runtime.

Quality: old **7 correct** expected fill sets; new **5 correct, 2 abstain**.
Both abstentions are the same `docs` input, initially and on its cached repeat.
There were **no incorrect positive fills**. Existing explicit/configured inputs
were preserved and no worker models were set; no worker was launched. These
are router fill assessments, not downstream task-quality measurements.

The separate guard-off protocol report is **PASS**: sparse question count 1,
free repeat cache, explicit-field preservation, inherited model, and free
router-disabled bypass. It records **1 call / 484 input tokens / 363 ms mean**.
At $0.042 per million input tokens, that is **~$0.000020328**; the original
status counter in JSON is rounded to `$0.00002` and is retained unchanged.

These results measure **Jev overhead only**. Worker/frontier tokens, costs,
latency, task quality, success, and rework are excluded. No net money savings
or production accuracy claim follows. Task-bearing router logging remains
deprecated; older audit files may contain task data and are not rewritten.
No feature/toggle behavior, installed user configuration, or model maps were
changed in this documentation finalization.

## Verification provenance

The foreman previously verified 77 offline tests; the benchmark agent then
reported **84 offline tests**, the latest known result. No tests, builds, or
live benchmarks were rerun for this documentation-only update. Finalization
validates JSON parsing/copy fidelity, row arithmetic, and `git diff --check`;
these checks are not a new test-suite result.
