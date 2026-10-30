# Lossless compression: negative live result

## Provenance and scope

[results.json](results.json) is the supplied
`/tmp/jev-compress-lossless-live.json`; [diagnostic.json](diagnostic.json) is the
separate `/tmp/jev-compress-response-diagnostic.json`. Both are preserved byte for
byte, reviewed as safe allowlisted synthetic measurements. No credentials,
private tool transcripts or commands are included. This closeout made no further
live calls and did not rerun the live or deterministic benchmark. Production
baseline: `893e036`; model: `jev-1.13.0`.

The [benchmark source](../benchmark_compress.py) supplies four public synthetic
fixtures (progress, status, blocks, CRLF/Unicode), raw/no-fold and forced-local
compact baselines, and eleven free variants. Forced compact uses the production
safety/profit gates and encoder with a local readability answer, **not an API**.
Its per-case `calls: 1` / `questions: 1` fields count the local stub's hook
invocation, not wire requests. No synthetic commands or workers execute.
`expected: null` means there is no ground-truth readability/accuracy claim.

## Original four-case result (unchanged)

| Measurement | Raw baseline | Forced local compact | Live Jev hook |
|---|---:|---:|---:|
| Raw UTF-8 payload bytes | 100,984 | 100,984 | 100,984 |
| Output UTF-8 payload bytes | 100,984 | 1,736 | 100,984 |
| Bytes reduced | 0 | 99,248 (98.28%) | 0 |
| Folds / keeps | 0 / 4 | 4 / 0 | 0 / 4 |
| API calls / questions | 0 / 0 | 0 / 0 | 4 / 4 |
| Jev input tokens | — | — | 1,914 |
| Estimated Jev cost (USD) | 0 | 0 | $0.000080388 |
| Median hook latency | — | — | 446.584 ms |

All deterministic folds roundtripped exactly; all four live outputs were retained
unchanged. All eleven free variants recorded zero calls and zero questions.
“Keep” is the hook outcome, not evidence of a model `keep` choice. The original
four responses were not captured, so their individual causes cannot be assigned.
In particular, neither low confidence nor schema incompatibility is established
as the explanation for those four keeps.

## Separate response diagnostic (not a fifth benchmark case)

One separate progress diagnostic recorded one call/question, 440 input tokens,
$0.00001848 estimated cost and 331.102 ms hook latency. The captured safe schema
fields reconstruct a valid typed `choice` answer: `compact`, confidence `0.37`,
probabilities `{compact: 0.57, keep: 0.37, unknown: 0.06}`. Standard model and usage
fields were present. The hook correctly retained the 44,000-byte output because
confidence was below the unchanged `0.85` gate. The compact probability is not
substituted for confidence. The offline regression reconstructs these fields and
checks keep/accounting; changing only confidence to the gate validates that the
captured metadata is otherwise acceptable. No prompt or threshold was tuned.

Combined supplied usage, including this separate diagnostic: **5 calls, 5
questions, 2,354 input tokens, approximately $0.000098868**. The original four-case
results and median above exclude the diagnostic.

## Conclusion and limits

**Negative result: no evidence Jev is better than deterministic compression here;
the observed result is the opposite—additional cost and latency with no byte
reduction. Do not make a Jev call when deterministic processing suffices.**
The current opt-in compression mode remains experimental and off by default;
this closeout does not automatically enable it, add a mode, or request new config.

Data and reconstruction are preserved. Measurements are exact UTF-8 tool-output
payload bytes within the host/downstream boundary, not tokens or USD saved.
Downstream host handling may truncate output; local lossless roundtrips do not
establish end-to-end delivery or savings. Jev cost is a separate input-token
estimate, not an economic benefit. Four fixed synthetic cases and one separate
diagnostic establish neither general accuracy nor a latency SLA.

The accompanying conservative regex regression covers fail/fails/FAIL,
failures/exceptions and positive exit code/status at beginning, middle and tail,
while keeping `0 failed` and zero exit summaries eligible. The existing live
`e2e_protocol.py` fixture tries to replace an absent module line; an offline test
now explicitly proves that its appended `failures:` alone skips compression and
makes zero calls. The live script was not run or edited.

## Offline closeout verification

Sequential, one-worker verification: `python3 -B -m pytest -q jev-plugin/tests`
passed **342 tests and 158 subtests**. Targeted compression regressions first
reproduced 16 failures, then passed all 109 tests after the regex-only fix.
`bash plugin-maker-plugin/bin/plugin-maker doctor jev-plugin` passed. JSON parsing,
byte-for-byte comparison with the supplied captures, recorded totals/roundtrip
flags, and `git diff --check` passed. No additional live or standalone baseline
benchmark run was performed; the suite uses offline stubs.
