# jev — calibrated decision layer for Synaps CLI

Puts [TypeSafe Jev](https://docs.typesafe.ai) — a fast, calibrated *System One*
decision model that never writes, only picks — into the agent harness as a
plugin. The Synaps runtime is untouched; everything rides on the existing
extension hooks.

| Feature | Hook | Default | Fails |
|---|---|---|---|
| **Guard** — risk / secrets / workspace-escape gate on `bash` `write` `edit` `read` | `before_tool_call` → `continue` / `confirm` / `block` | on | **closed** (confirm) |
| **Router** — fill omitted `role`, `write_policy` (→ `read_only` only), `model` (tier map) on `subagent_start` | `before_tool_call` → `modify` | on | open |
| **Compress** — elide the middle of large routine `bash` outputs at ingestion | `after_tool_call` → `replace` | **off** | open |
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
/jev router off           # same pattern for router / compress
/jev off                  # guard + router + compress; jev_decide / jev_status stay
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
python3 -B -m unittest discover -s jev-plugin/tests -p 'test*.py' -v
```

Optional **LIVE** synthetic benchmark (not part of offline verification):

```sh
python3 -B jev-plugin/scripts/benchmark_synthetic.py --live
```

It discovers the already configured key without printing it, runs at most eight
fixed public synthetic cases, and reports correct/abstain counts, input tokens,
estimated cost and latency. It never sends project files and never sets a key.
Synthetic correctness is not production calibration; wall time includes network
variance. Worker-tier optimization remains future work (existing optional router
mapping is unchanged); compaction integration is deferred. No host/core changes.

Transport deadlines include the existing single rate-limit retry within a maximum
four-second budget (below the host's five seconds). A scoped POSIX main-thread
timer bounds blocking DNS/response reads as well as socket operations; unavailable
or already-owned timers fail without making a request. This process extension's
supported execution path is the POSIX main-thread stdio loop.
