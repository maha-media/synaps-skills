# jev — calibrated decision layer for Synaps CLI

Puts [TypeSafe Jev](https://docs.typesafe.ai) — a fast, calibrated *System One*
decision model that never writes, only picks — into the agent harness as a
plugin. Decision policy stays plugin-only, using the existing extension hooks;
output replacement also depends on host runtime handling (see measurement limits).

| Feature | Hook | Default | Fails |
|---|---|---|---|
| **Guard** — risk / secrets / workspace-escape gate on `bash` `write` `edit` `read` | `before_tool_call` → `continue` / `confirm` / `block` | on | **closed** (confirm) |
| **Router** — fill omitted `role`, `write_policy` (→ `read_only` only), `model` (tier map) on `subagent_start` | `before_tool_call` → `modify` | on | open |
| **Compress** — elide the middle of large routine `bash` outputs at ingestion | `after_tool_call` → `replace` | **off** | open |
| **Triage** — preserve failures and append advisory diagnostic IDs | `after_tool_call` → `continue` / `replace` | on | open (abstain) |
| **`jev_select`** — batch choices among supplied candidate IDs | tool | on | abstain / tool error |
| **`jev_decide`** — up to 64 typed questions about one `state` in one ~0.4 s call | tool | on | tool error |
| **`jev_status`** — calls, tokens, cost, verdict counters | tool | on | — |

Measured on 2026-09-20 (`jev-1.13.0`): 350–480 ms per request, ~$0.00003 per
guarded tool call, 10 000 calls ≈ $0.27.

Compared with a regex guard (`"rm -rf" in command`), this one catches
`d=/; r='rm'; $r -rf "$d"*`, `curl … | sh`, `git push --force`,
`read ~/.synaps-cli/auth.json`, and writes into `~/.ssh` — each with a
probability and a confidence attached — and it *asks* when it is unsure
instead of guessing. Fresh worker runtimes inherit the host session approval
latch, but the host's default worker hook bus is empty: this does **not** mean
Jev reviews worker tool calls. Worker reviews require host hook wiring.

## Install

```bash
# from the marketplace (once merged to main)
synaps → /plugins → jev → install

# or straight from the working tree
ln -s ~/Projects/Maha-Media/synaps-skills/jev-plugin ~/.synaps-cli/plugins/jev
```

Then, **inside synaps**:

```
/jev key apikey_…
```

That validates the key with a live call, saves it to
`~/.synaps-cli/plugins/jev/config` (mode 600), and activates the guard and
tools in the running session — no restart. `/jev status` and `/jev test` show
what's going on.

From a shell instead:

```bash
~/.synaps-cli/plugins/jev/scripts/setup.sh --key apikey_…   # validate + save
~/.synaps-cli/plugins/jev/scripts/setup.sh --check          # where is the key, does it work
```

A running session picks a saved key up within 5 s. `TYPESAFE_API_KEY` in the
environment that launches synaps also works. Without any key the plugin loads
**inert**: no guard, but `jev_status` still answers and tells the model how to
get configured, and `/jev` still works.

Get a key at https://typesafe.ai.

## Turning the guard off (without losing the rest)

```
/jev guard off            # this session only — no more ~0.4 s review per tool call
/jev guard on             # back on
/jev guard off --save     # persist to plugins/jev/config
/jev router off           # same pattern for router / compress / triage / discovery
/jev triage off           # skip advisory failure classification; guard stays independent
/jev off                  # guard + router + compress + triage + discovery; all three tools stay
/jev guard                # show now / source / saved
```

Session toggles are never written to disk and survive a later `/jev key …`
re-activation. `/jev status` marks them `(session)`. A new session starts from
the configured defaults again; only `--save` persists the toggle. Saving also
clears the corresponding session override.

When the guard **does** ask, the Confirm dialog has three buttons:

```
[ Allow (y) ]   [ Allow all this session (a) ]   [ Deny (n) ]
```

**Allow all this session** answers this call and latches the host session so
later extension **Confirm** results are auto-approved without a prompt. It
applies only to extension Confirm: explicit **Block** results are still
enforced, and activation approvals and sudo prompts are unaffected. The latch
resets in a new session. Fresh workers inherit it, but their default hook bus
is empty, so inheritance alone does not cause worker reviews to run.

Where hooks are wired, the guard keeps scoring and auditing — it just stops
asking for Confirm results. Use `/jev guard off` instead if you also want to
skip the review (and its API calls); router, compression, and explicit
`jev_decide` calls remain independent. **Deny is initially focused**; Enter
confirms the **current selection**, so it denies only while Deny is selected.

## Configuration

All keys live under `extension.jev.*` in `~/.synaps-cli/config`, or as
`SYNAPS_EXTENSION_JEV_<KEY>` env vars. Defaults in
`.synaps-plugin/plugin.json`.

| Key | Default | Notes |
|---|---|---|
| `api_key` | — | set with `/jev key …` or `scripts/setup.sh --key …`; also `TYPESAFE_API_KEY` env or `extension.jev.api_key` in `~/.synaps-cli/config` |
| `model` | `jev-latest` | pin `jev-1.13.0` once thresholds are tuned |
| `timeout_ms` | `3000` | keep < 5000 — the runtime's hook timeout is fail-open |
| `audit_file` | `memory/jev/audit.jsonl` | relative to `SYNAPS_BASE_DIR`; contains command text; chmod 600; `""` disables |
| `guard` | `true` | `/jev guard on\|off [--save]` flips it live |
| `guard_tools` | `bash,write,edit,read` | runtime tool names |
| `guard_ask_at` | `1.5` | risk score (0–3) that triggers a confirmation |
| `guard_block_at` | `3.5` | risk score that hard-blocks; 3.5 = never |
| `guard_min_conf` | `0.6` | below this the guard always asks |
| `guard_secrets_at` | `0.5` | P(touches secrets) that always asks |
| `guard_escape_at` | `0.7` | P(writes outside cwd//tmp) that always asks |
| `router` | `true` | `/jev router on\|off [--save]` |
| `router_min_conf` | `0.8` | |
| `router_read_only_at` | `0.15` | P(needs_write) at/below which `write_policy` → `read_only` |
| `router_models` | `""` | `small=<id>,medium=<id>`; ids must already be worker-authorised; `frontier` always inherits |
| `discovery` | `false` | opt-in query/descriptor API calls; `/jev discovery on\|off [--save]`; independent of guard |
| `triage` | `true` | advisory failure classification; `/jev triage on\|off [--save]`; independent of guard |
| `compress` | `false` | opt-in; `/jev compress on\|off [--save]` |
| `compress_tools` | `bash` | |
| `compress_min_bytes` | `6000` | |
| `compress_min_conf` | `0.85` | P(outcome-only ∪ head+tail-suffice) required to elide |
| `compress_head` / `compress_tail` | `1500` / `1000` | bytes kept |

## Test

```bash
python3 -B tests/test_policy.py                     # pure policy, no network
python3 -B -m unittest discover -s tests -p 'test_features_protocol.py' -v
                                                    # real extension protocol, offline transport stub
TYPESAFE_API_KEY=… python3 tests/e2e_protocol.py      # real process, real protocol, real API
TYPESAFE_API_KEY=… python3 tests/e2e_keys.py          # inert start → /jev key → activation → lazy pickup
```

Run the commands from the plugin directory. The offline protocol suite uses a
fake key, blocks socket access in the child process, and confines fallback
persistence to a temporary `SYNAPS_BASE_DIR`. It covers zero-call guard bypass,
independent features/tools, command events, session reset, and saved toggles
reloaded by a fake host. It does not test host UI approval handling or worker
hook wiring. The two `e2e_*.py` scripts above are **live API tests**, not part of
the offline suite; they require credentials and incur calls.

## Design notes

- **Fail-closed where it matters.** The runtime treats a hook timeout (5 s) as
  `continue`. The guard keeps its HTTP timeout at 3 s (one bounded retry on
  429/529) and returns `confirm` on *any* error or internal crash, so it fails
  closed from its own side. Router and compress are optimisations and fail
  open. A runtime-level `fail_closed` manifest flag would make this
  unnecessary — tracked in SynapsCLI `docs/research/2026-09-20-jev-decision-layer.md`.
- **Only previews leave the machine.** Commands (≤2000 chars), paths, a
  ≤400-char content preview for `write`, ≤200-char old/new for `edit`, and
  head/tail slices for compression. Never full file bodies, never transcripts.
- **Router only adds.** It never overrides a field the foreground set, never
  sets `isolated_worktree`, and only changes `model` when you have mapped a
  tier to an exact authorised id. Hard or uncertain tasks inherit the
  foreground model — a cheap route that routes badly is the expensive one.
- **Compression is cache-safe.** It happens at ingestion, before the output
  enters history, so the prompt-cache prefix is never invalidated and the
  reasoning trail is intact; the marker says exactly what was elided. Anything
  that looks like a failure (`FAILED`, `panicked`, `error`, non-zero exit) is
  never touched.
- **Confidence is collapsed where outcomes coincide.** Jev's `confidence`
  measures spread across *all* levels; where two levels lead to the same
  action the plugin sums their probability mass instead (e.g. compression:
  P(level 0) + P(level 1)).
- **Question keys carry no meaning.** Everything the model sees is in
  `instructions` / `criteria`; keys are only for matching answers.
- **Key persistence uses the host's own store.** `/jev key` calls the host's
  `config.set` (permission `config.write`), which writes
  `<base>/plugins/jev/config` — the same file the runtime reads at
  `initialize`. If the RPC is unavailable the plugin writes the identical
  file itself. When the plugin dir is a dev symlink into a repo that file
  lands in the repo tree; it is git-ignored as `/config`.

## Threat model

This is defence in depth, not a sandbox. `bash` still runs with full user
privileges; a tool input can try to talk the classifier into a low score
(`echo "harmless" && rm -rf /`). The audit log (`JEV_GUARD_LOG` /
`audit_file`) is there so thresholds can be tuned against real sessions and
misses can be studied.

## Advisory failure triage and candidate selection (0.2)

**Triage is ON by default when a key is available**, independently of guard.
`/jev triage off` skips its API calls; `/jev triage on|off --save` persists
through the existing host feature system. Without a key it is inert.
Only anchored bash host error envelopes (nonzero exit or timeout, optionally
`Tool execution failed:`) and a small allowlist of anchored build/test summaries
qualify. Ordinary prose mentioning failures does not. Recognition is deliberately
conservative: this is not a general log parser.

Triage preserves the **entire original output** and can append a locally rendered,
non-authoritative advisory (under 350 characters): a category and diagnostic
next-step ID. It never executes, retries, authorizes work, or certifies success.
Unknown, low-confidence, malformed/non-finite answers and upstream errors produce
exact Continue. Outputs over 5000 characters or bearing truncation markers are
not sent. Recognized failures never enter compression, even with triage disabled
or abstaining. The command and user goal are not included; obvious API keys,
bearer credentials, assignments and private-key blocks are redacted. Redaction
is best-effort, not a guarantee against every secret format. Triage writes no
output, command, answer text, or upstream exception text to the audit trail.
Guard's existing audit behavior is unchanged.

A 128-entry LRU keyed by session ID and output fingerprint caches advice **and
abstentions**, avoiding repeat costs. Missing session ID disables caching; no
anonymous cross-session advice. Entries are process-local and do not survive
restart. Huge/off/truncated skips do not need cache entries because they cost zero.

### `jev_select`: one batch, supplied IDs only

Use for uncertain test targets, files to inspect, diagnostic tools, or routes.
Skip deterministic choices (e.g. a filename already present in a traceback).
For example:

```json
{
  "context": "Synthetic parser change; whitespace regression reported.",
  "decisions": [
    {"instruction": "Which test target is most relevant?", "candidates": [
      {"id": "parser_unit", "description": "Parser whitespace unit fixtures"},
      {"id": "http_unit", "description": "HTTP transport unit fixtures"}
    ]},
    {"instruction": "Which file should be inspected first?", "candidates": [
      {"id": "parser.py", "description": "Tokenization and whitespace handling"},
      {"id": "transport.py", "description": "HTTP transport"}
    ]}
  ]
}
```

Returns decisions in input order, each `{id, fallback_reason}`: the exact supplied
ID or null. No model-generated commands or prose. Confidence must be finite and
at least 0.8; a reserved `__jev_abstain__` choice is always added. IDs must be unique
within each decision and cannot use that reserved ID. Up to 32 decisions, 2–32
candidates each; context 5000 chars, instruction 500, ID 80, description 300,
total JSON 50000 chars. This explicit tool transmits the supplied context and
candidates: **do not supply secrets**. Selection does not run tests, activate tools,
or grant model/worker authorization.

`jev_decide` retains its schema: **choice criteria are an object mapping IDs to
descriptions; score criteria are a list of 2–10 ordered levels**. Batch related
questions in one round rather than delegating detailed reasoning.

### Measurement and limits

`jev_status` and `/jev status` expose operation-level calls, input tokens,
estimated Jev input-token cost, total/mean latency and errors, plus triage
skip/cache/abstain counters. Legacy snapshot fields remain present; calls now
include failed batches. A retry is part of one batch; unknown billed usage on
failed requests cannot be counted. Pricing is the existing static estimate,
not an invoice. No frontier-token savings, cache savings, or net savings are
inferred. Compare end-to-end task cost/latency and correctness against a matched
baseline before claiming savings. Stable discovery guidance is injected only
at session start, independent of guard, not each turn.

Offline regressions (sequential):

```sh
python3 -B -m unittest discover -s jev-plugin/tests -p 'test_*.py' -v
```

Optional **LIVE** synthetic benchmark (not part of offline verification):

```sh
python3 -B jev-plugin/scripts/benchmark_synthetic.py --live > /tmp/jev-synthetic-benchmark.json
```

It discovers the already configured key without printing it, runs at most eight
fixed public synthetic cases, and reports per-case expected/predicted labels,
abstention and timing, plus correct/abstain counts, input tokens, estimated cost
and nearest-rank p50/p95 latency. Raw outputs and transport errors are not printed. It never sends project files and never sets a key.

Measured synthetic smoke (`jev-1.13.0`, captured in
`/tmp/jev-synthetic-benchmark.json`):

| Measurement | Result |
|---|---|
| Cases / API calls | 8 / 7 |
| Expected outcomes, including abstentions | 7/8 |
| Confident correct classifications | 5: dependency, syntax, assertion, permission, timeout |
| Other outcomes | SDK mismatch abstained instead of expected `environment`; unexplained failure abstained; successful output skipped (no API call) |
| Input tokens | 3036 |
| Estimated Jev input-token cost | $0.000127512 (~$0.000128) |
| Mean API-call latency | 462 ms |
| All-case latency, nearest-rank p50 / p95 | 458.176 / 500.692 ms |

The three null outcomes include two API abstentions and one local success skip;
7/8 is therefore not seven confident classifications. To reproduce this
measurement, run the optional live command above from the repository root with
an already configured key, then compare the JSON's per-case results and
`stats.op_stats.triage`. The cost there is more precise than the rounded aggregate
cost. API-call mean excludes the local skip; all-case percentiles include it.
Calls incur charges, and timings and decisions may vary between runs.

A separate live framed-plugin protocol smoke also passed two supplied candidate
choices, preserved the original failure output, confirmed zero additional cost
on a repeat cache hit, and checked the triage toggle and guard independence.
It used 2 API calls, 890 input tokens, an estimated ~$0.000037, and a mean API-call
latency of 357 ms. For a comparable protocol measurement, batch the two supplied
choices through `jev_select`, submit a recognized failure through
`after_tool_call`, repeat it in the same session to check the cache, and compare
status counter deltas while toggling triage independently of guard. These are
protocol-process observations, not proof that an installed host session has
reloaded this plugin or delivered replacement text to the model.

These small synthetic smokes are not production accuracy or calibration
measurements and provide no evidence of net savings. Wall time includes network
variance; estimated Jev input-token costs exclude frontier-model and other costs.
Worker-tier optimization remains future work (existing optional router mapping
is unchanged); compaction integration is deferred.

**No host/core policy changes:** the new decision policy stays plugin-only.
An independent host runtime fix is needed for an `after_tool_call` `Replace` to
override old streamed text; otherwise opt-in compression may not reach the model.
The protocol smoke does not establish that this host fix is installed or active.

Transport deadlines include the existing single rate-limit retry within a maximum
four-second budget (below the host's five seconds). A scoped POSIX main-thread
timer bounds blocking DNS/response reads as well as socket operations; unavailable
or already-owned timers fail without making a request. This process extension's
supported execution path is the POSIX main-thread stdio loop.

## Optional discovery recommendations (0.3)

Underlying `search_tools` and `search_skills` discovery is **pure local**. The
`discovery` feature defaults to **false**. `/jev discovery on|off [--save]`
controls it independently of guard; without `--save` the override is session-only.
`/jev on` enables **all five** hooks, including this opt-in API cost/privacy
contract (and compression); `/jev off` disables them. Explicit Jev tools remain
available, including their no-key setup guidance.

**Privacy and cost opt-in:** when enabled with a key, eligible discovery sends
only the substring query and bounded candidate names/summaries/descriptions/tags
to Jev. Recognizable credential patterns are redacted using the triage redactor;
this is not a guarantee that all sensitive text is detected. No prior user goal,
transcript, tool schema, schema digest, or unknown host field is sent. Each cache
miss can incur one decision request (the existing client may retry within its
budget). Default-off, no-key and rejected inputs make zero discovery API calls.

The hook accepts 2–16 unique candidates, nontruncated strict JSON and a query of
at most 512 UTF-8 bytes/chars. Tool summaries are at most 256 bytes; skill
descriptions 160 bytes. IDs/names are bounded to 256 bytes, tags to 16 × 64 bytes,
and original output to 32 KiB. Invalid shapes, duplicate JSON keys/IDs,
nonfinite numbers, preexisting `jev_advisory`, oversized evidence, control
characters, and exact ID/name queries are skipped rather than truncated.
Unknown host fields remain unchanged semantically and local.

Jev must abstain for generic keywords such as `memory`, `test`, or `search`,
equally plausible matches, and any ambiguity. Candidate order is not intent.
Only a supplied opaque option at confidence ≥0.8 (`discovery.MIN_CONFIDENCE`) can map locally to a supplied
ID. Confidence 0.8 does **not certify truth**: the lower gate can recommend a
mistaken result, but grants no permissions and causes no activation. All
validation, privacy and scope boundaries remain unchanged. The original machine-readable JSON and every descriptor remain intact;
only bounded `jev_advisory` metadata is added, with `recommended_id`,
`advisory: true`, and a **not activation/permission** note. No filtering,
reranking, activation, permission change or automatic follow-up occurs.
Errors and abstentions return exact Continue, without rewriting output.

A process-local LRU of 128 entries caches recommendations and explicit
abstentions, keyed by a digest of session, query, runtime tool, entire original
output and client model. No session means no cache. Cache values are opaque
options, never raw catalogs; metadata is reapplied to the current original
payload. Malformed answers, low confidence and errors are not cached. Discovery
never writes payloads or exception text to audit/logs. Status exposes
`discovery.skip/call/cache/recommend/abstain/error` counters and `op=discovery`
estimated Jev costs/tokens/latency. These are advisory measurements, not savings.

### Discovery benchmark (offline by default)

From the repository root:

```sh
python3 jev-plugin/scripts/benchmark_discovery.py
python3 jev-plugin/scripts/benchmark_discovery.py --suite heldout
python3 -m unittest discover -s jev-plugin/tests -p 'test_benchmark_discovery.py' -v
# Optional: explicitly consent to public synthetic requests using an already configured key:
python3 jev-plugin/scripts/benchmark_discovery.py --live
# Separate invocation and independent budget (not combined with default):
python3 jev-plugin/scripts/benchmark_discovery.py --suite heldout --live
```

Default mode does **not** discover keys, read configuration, or access the network.
It validates fixed public synthetic fixtures and emits deterministic no-hint
(zero incremental overhead) and explicit-order first-candidate baselines. Jev
fields are `not_executed`/null, not fabricated measurements. `--live` resolves
an existing key through `keys.discover`; it never prints the key or its source.
The initial live result supplied by the foreman is recorded below; no new live
measurement was performed for this revision.

The fixture shapes follow the host's `tools/catalog.rs` discovery entries and
`skills/tool.rs` search results: every candidate contains the query in searchable
fields. Digests and descriptors are synthetic. The two contrast pairs reverse
candidate order deliberately (an order-sensitivity experiment, **not** a claim
that the host normally reverses its deterministic ordering). They distinguish
receipt storage from image resizing and course listings from Python diagnosis.
Memory, equal descriptions, and irrelevant capabilities with a descriptor
injection are labeled abstain. Exact-name, singleton, truncated and disabled
cases are skips, never Jev successes.

There are seven eligible decisions, at most eight permitted; the benchmark's
client disables transport retries to keep the wire-request bound honest without
changing production policy. The first eligible case is repeated in-session only
if production cached its response: its repeat must show zero calls/tokens/cost.
Malformed/error responses are not cached, so a repeat is reported not executed
rather than spending another request. `measure(client)` supports offline stubs.

Reports separate expected labels from predicted IDs, include per-case deltas,
wall latency, net UTF-8 output-byte growth, JSON evidence preservation, supplied-ID
boundary, confident right/wrong recommendations and eligible-case coverage.
Production's confidence gate determines “confident”; this is not a calibration
study. Skips and repeats are excluded from quality denominators. JSON evidence
preservation means all original parsed fields survive, not identical whitespace.
Cost uses the client's input-token price estimate; missing usage and failures can
undercount billed cost. No-hint overhead is zero by construction, not a timed host
measurement. These tiny, hand-labeled synthetic cases and the first-candidate
comparator are **not frontier-model accuracy, real-world accuracy, or savings**.

#### Gate alignment and held-out evaluation

The existing initial live default smoke at **0.85** produced **0/7
recommendations** (all seven abstained), reported cost **$0.000162204**,
**3,862 tokens**, and **~2.773 seconds**. A separate diagnostic selected the
intended image option with confidence **0.83** and chosen-option probability
**0.89**. Probability is not confidence and does not bypass the gate. These are
foreman-supplied historical observations, not measurements rerun here.

`extensions/jev/discovery.py` now defines `MIN_CONFIDENCE = 0.8`, aligned with
the existing `jev_select` validation gate. The change is an advisory-policy
alignment motivated by those observations, not evidence of improved coverage,
accuracy or savings. Held-out cases were added **after** choosing this threshold
and were not used to tune it. No positive live result at 0.8 is claimed.

`--suite heldout` loads the separate public fixture file
`scripts/fixtures/discovery_heldout.json`: PDF merge versus receipt listing,
SQL explain execution-plan diagnosis versus tutorial indexing, video subtitles
extraction versus style catalogues, and git conflict diagnosis versus bookkeeping.
Two additional cases cover equal capabilities and irrelevant capabilities with
an injection; PDF and SQL also have reversed-order variants. Each candidate
matches its fixed query substring. Eight eligible cases mean at most **eight
wire calls per independent invocation**, with no retries and only cached repeats.
The default suite's cases and ordering are unchanged.

Reports identify `suite` and `min_confidence`, and publish label assumptions.
Both suites have **weak hand labels**: operational intent is assumed from terse
substring queries, which can also denote browsing or bookkeeping. In particular,
the default first-candidate baseline is not ground-truth task accuracy;
conservative abstention may be reasonable. Held-out means separate from the
threshold decision, not a statistically representative or permanently unseen set.
Printed measured statistics include skips separately, abstentions, repeats, all
six discovery audit counters (including zeros), and the client statistics snapshot.
Offline counters remain null rather than implying an executed run.
