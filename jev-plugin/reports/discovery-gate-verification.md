# Discovery advisory gate revision: historical offline verification

Scope: existing discovery worktree only. No runtime/core changes, live requests,
builds, credential discovery, or user configuration changes were performed.
Unit tests use mocks/temporary fixtures for transport and persistence.

- `discovery.MIN_CONFIDENCE = 0.8`, aligned with existing `jev_select`.
- Regression: 0.799 rejected, 0.8 accepted, outside ID at confidence 1 rejected.
  Existing malformed-answer, invalid-catalog, redaction, cache and scope tests pass.
- Default fixture definitions/order unchanged: 11 cases, 7 eligible, 4 skips.
- Separate heldout JSON: 8 eligible cases; four domain contrasts, equal-capability
  ambiguity, irrelevant/injection case, and two order reversals. Substring and
  host-shape validation passes for every candidate. Labels expose assumptions;
  neither suite establishes task truth from substring queries.
- Measured report contract includes separate skips, abstentions, repeats, all six
  audit counters including zeros, and the client's statistics snapshot.

Sequential commands and outcomes:

1. `python3 -B -m unittest discover -s jev-plugin/tests -p test_discovery.py -v`
   — 9 passed.
2. `python3 -B -m unittest discover -s jev-plugin/tests -p test_benchmark_discovery.py -v`
   — 7 passed.
3. `python3 -B -m unittest discover -s jev-plugin/tests -p 'test_*.py' -v`
   — 64 passed (0.562 s reported by unittest).
4. `python3 -B jev-plugin/scripts/benchmark_discovery.py`
   — saved as `discovery-default-offline.json`.
5. `python3 -B jev-plugin/scripts/benchmark_discovery.py --suite heldout`
   — saved as `discovery-heldout-offline.json`.
6. `git diff --check` — passed.

Both saved reports are offline: Jev not executed, measurements null, baselines
synthetic only. Stub tests verify eight calls maximum for the heldout invocation,
including malformed/error responses; cache repeats add no calls. Transport retry
suppression is tested with mocked transport, not a live service.

Historical evidence supplied by the foreman: initial live default run at 0.85
returned 0/7 recommendations (all abstained), $0.000162204, 3,862 tokens, ~2.773 s.
A separate diagnostic chose the intended image option at confidence 0.83 with
chosen-option probability 0.89. This motivated gate alignment, not a claim of
calibration. Heldout cases were not used to tune the gate. Coverage/accuracy at
0.8 were unmeasured in that revision; the later supplied synthetic held-out
measurement is now recorded in `discovery-heldout-live.json` and README.
Neither report establishes savings. A lower
gate may recommend a mistaken result but grants nothing and activates nothing.

## Low-confidence cache follow-up

Validation now uses `valid_choice(..., threshold=0)` before the unchanged 0.8
recommendation gate. Valid low confidence is cached as a session abstention;
malformed/unknown/nonfinite/probability errors and transport errors retry.
Regressions cover repeated 0.4 answers, session isolation, no-session retries,
invalid-answer retries, and benchmark repeat accounting. Metadata and the three
registered tools are unchanged (offline protocol contract passed).

Sequential final verification: full `test_*.py` suite **66 passed** (0.601 s),
then default and heldout offline benchmark invocations passed; `git diff --check`
passed. No live requests, credential discovery, user configuration edits, or
Rust builds. The new live JSON is only the supplied public synthetic report,
not an execution or savings claim from this revision.
