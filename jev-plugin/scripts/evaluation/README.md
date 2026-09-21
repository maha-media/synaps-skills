# Frozen split evaluation v1

`../evaluate_heldout.py` evaluates **public synthetic weak labels**, not actual
repository evidence. This is separate from the earlier development benchmarks.
There are 24 fixed cases: 12 dev and 12 heldout, three per feature per split
(evidence, verification, reports, diagnosis). Required items are preserved but
excluded from quality scoring. Router evaluation is unsupported here.

## Operation

From the repository root:

```sh
python3 jev-plugin/scripts/evaluate_heldout.py
python3 jev-plugin/scripts/evaluate_heldout.py --split heldout
# Only after explicit authorization and an externally supplied TYPESAFE_API_KEY:
python3 jev-plugin/scripts/evaluate_heldout.py --live --split heldout --max-calls 4 --model jev-1.13.0
# Optional exclusive-create sanitized summary; never overwrites:
python3 jev-plugin/scripts/evaluate_heldout.py --output /path/to/new-summary.json
```

Default execution validates frozen bytes, canonical payload hashes, split
counts, and production input bounds, then exercises disabled, no-key and
deterministic structural clients. It constructs no DecisionClient, discovers
no credentials, reads no descriptors/sources, fetches nothing, and writes no
artifacts by default. Offline `measurement` is null: mock agreement is **not**
classifier quality or calibration. Structural choices depend only on production
question criteria, never expected labels. Reports use two genuine choice
questions; diagnosis uses the production hypothesis/check choice maps.

Live requires explicit `--live`. Only then, after validation, the script checks
the environment variable; it does not discover config files. The only model is
`jev-1.13.0`. Budget defaults to four, allowed range 1–12: one production batch
per case, no retries, three-second hard production transport deadline and a
wire-attempt cap. Cases are selected in frozen order (interleaved features).
Every report hook instance is fresh; no cache or retry loop. A smaller budget
produces `complete: false` and explicit unexecuted IDs. Unexecuted cases never
enter metrics. No automatic full-dataset run, tuning loop or threshold override.
Fixed snapshots: evidence/verification/reports .80; diagnosis hypotheses .85,
checks .80. Production thresholds and prompts are unchanged.

## Frozen provenance and retirement

`manifest.json` pins SHA256 of exact dataset file bytes. Each `input_sha256`
hashes only the production hook payload using UTF-8, sorted keys, compact JSON,
`ensure_ascii=False`, `allow_nan=False`. IDs and canonical payload hashes are
unique across both splits. Labels and metadata are separate local fields and
never enter model state. Reports' payload is the exact collect-hook envelope.
The manifest is a reproducibility check, not a signature against malicious
changes to both files.

Use dev for tooling development; reserve heldout for a predeclared one-shot
comparison. Record budget, version and selected IDs before a live run. Reviewing
heldout results repeatedly **retires v1 for future tuning**. Any data modification
requires a newly frozen version, new manifest and independently authored split;
do not silently refresh v1's digest. Public synthetic heldout is relative to
previous local fixtures, not proof the provider never trained on or saw it.

## Interpretation

Accepted native production priorities yield TP/FP/FN, precision, recall,
coverage/abstention and Wilson 95% intervals. Positive priorities are evidence
inspect-first, verification prioritize, diagnosis investigate/inspect. Contradicted
hypotheses are negative *investigation priorities*, not disproven hypotheses.
Expected review labels are unknown, not certified negatives. Abstained positive
labels count as FN; unknown-label rows do not enter precision/recall. Reports
score native flag sets; a no-flag output is not automatically a known negative:
valid high-confidence raw answers are needed to disambiguate silence. Mixed
unknown report labels conservatively exclude that case's flag truth labels.
Fixed FP cost weight is one (descriptive, not an optimized utility model).

Raw class agreement is separate from accepted priorities. Only associable,
valid typed choices with finite, in-range confidence/probabilities enter raw
agreement bins `[0,.5)`, `[.5,.8)`, `[.8,1]`. These are **confidence-bin decision
agreement**, not probability calibration. Unknown choices are counted explicitly;
missing/invalid choices do not become successes. Brier is deliberately null:
confidence is never treated as P(correct). Three cases per feature cannot
establish calibration or robust population accuracy. Wilson intervals are
simple descriptive binomial intervals; correlated synthetic descriptors are
not independent population samples.

Summaries contain case IDs/payload digests, counts and bounded numeric metrics,
not dataset text, descriptors, raw answers, model prose or arbitrary model names.
Token usage and input-token cost are null when unknown, including errors; cost
is Jev input only, not net savings. Transport errors differ from valid abstention.
No statistics here certify source authority, safety, truth, mandatory coverage,
provider non-exposure, or savings. This tooling does not authorize source fetch,
tool activation, skipping checks, execution, approval, or deployment.

## Hermetic verification

Run the complete Jev pytest suite (`python3 -m pytest jev-plugin/tests`) sequentially (no xdist), with temporary HOME,
SYNAPS_BASE_DIR and pytest base temp under the worktree, no real credentials.
Tests use fake keys and mocked wire calls only. Include plugin-maker offline doctor
and `git diff --check`; do not run setup's live key probe.
