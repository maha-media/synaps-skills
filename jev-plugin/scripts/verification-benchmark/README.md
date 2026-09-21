# Supplied verification evidence

These public synthetic reports were supplied for documentation finalization;
no live requests, tests, checks, or workers were launched here. JSON is formatted
for readability without changing supplied values.

- [Priority benchmark](results/jev-verification-live.json): 4 cases, 12 optional
  decisions, 4 API calls, 2,777 input tokens, estimated Jev input cost
  $0.000116634; network p50 382.09 ms, p95 416.07 ms.
- [Protocol smoke](results/jev-verification-protocol-live.json): PASS, 4 tools;
  default-off, required-only and toggle-off paths free; guard independent;
  session-only toggles without config writes. One call, 690 input tokens,
  mean 393 ms. At $0.042 per million input tokens the estimate is $0.00002898;
  the supplied aggregate counter rounds to $0.000029.

## Outcomes and limits

The benchmark found all 4 weak-labelled relevant optional checks: 4 correct
priorities, 0 false priorities, 8 reviews, 0 lower-priority results. Reviews
comprise 5 expected unknowns and 3 checks not confidently deferred. Caller-required
IDs survived all 4 cases and all 12 zero-call variants (required-only, no-key,
disabled for each case). Optional partitions and supplied-ID boundaries survived.

Required preservation is structural, not proof that all required checks were
included or that coverage is complete. Labels are weak synthetic expectations,
not calibrated ground truth; the injection fixture is not a safety proof.
The first-optional comparator has 0 correct and 4 false priorities under these
labels, but is not a frontier or task-quality baseline. No-hint overhead is
zero by construction, not a measured task run. No tests avoided, test-cost
reduction, whole-bill savings, or end-to-end savings can be inferred. Input-token
cost estimates are not invoices and exclude frontier/worker costs.

Verification has no cache: host `hosttool.call` supplies no trusted session ID.
Discovery and verification remain default-off. Latest offline verification is
105 tests as supplied by the foreman, who will rerun; this finalization only
validates JSON, static arithmetic, and the documentation diff.
