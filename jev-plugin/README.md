# jev — calibrated decision layer for Synaps CLI

Release **0.9.0**: six tools, supplied-candidate diagnosis, an explicit economy
preset, optional API budgets, local explanations, and advisory context-boundary
reports under host context pressure. No net-savings claim.

Puts [TypeSafe Jev](https://docs.typesafe.ai) — a fast, calibrated *System One*
decision model that never writes, only picks — into the agent harness as a
plugin. Decision policy stays plugin-only, using the existing extension hooks;
output replacement also depends on host runtime handling (see measurement limits).

| Feature | Hook | Default | Fails |
|---|---|---|---|
| **Guard** — risk / secrets / workspace-escape gate on `bash` `write` `edit` `read` `multi_edit` (per target file); body secrets check on `send_events` | `before_tool_call` → `continue` / `confirm` / `block` | on | **closed** (`guard_confirm = auto`, the default: block, or continue once the deterministic rules passed; `prompt`: confirm) |
| **Router** — fill omitted `role`, `write_policy` (→ `read_only` only), `model` (tier map) on `subagent_start` | `before_tool_call` → `modify` | on | open |
| **Compress** — reversible identical-line runs for repetitive `bash` output | `after_tool_call` → `replace` | **off** | open |
| **Triage** — preserve failures and append advisory diagnostic IDs | `after_tool_call` → `continue` / `replace` | on | open (abstain) |
| **Reports** — append unverified worker-claim flags without lifecycle changes | `subagent_collect` → `continue` / `replace` | **off** | open |
| **Discovery** — supplied search-result ID advice, not activation | `search_tools` / `search_skills` → `continue` / `replace` | **off** | open (abstain) |
| **Context** — advisory task-boundary report only under host context pressure at a tool-free turn end | `on_message_complete` → `continue` / `context_phase` | on | open (continue) |
| **`jev_diagnose`** — prioritize supplied hypotheses/checks; no fixes or execution | tool (no hook) | advice **off** | review |
| **`jev_evidence`** — supplied descriptor relevance; no fetch or trust certification | tool (no hook) | advice **off** | review |
| **`jev_verify`** — explicit optional verification priority; preserves caller-required IDs | tool (no hook) | advice **off** | review |
| **`jev_select`** — batch choices among supplied candidate IDs | tool | on | abstain / tool error |
| **`jev_decide`** — up to 64 typed questions about one `state` in one ~0.4 s call | tool | on | tool error |
| **`jev_status`** — accounting, budgets, compression mode, local explanations | tool | on | — |

Measured on 2026-09-20 (`jev-1.13.0`): 350–480 ms per request, ~$0.00003 per
guarded tool call, 10 000 calls ≈ $0.27.

Compared with a regex guard (`"rm -rf" in command`), this one catches
`d=/; r='rm'; $r -rf "$d"*`, `curl … | sh`, `git push --force`,
`read ~/.synaps-cli/auth.json`, and writes into `~/.ssh` — each with a
probability and a confidence attached — and it *asks* when it is unsure
instead of guessing. Fresh worker runtimes inherit the host session approval
latch, but the host's default worker hook bus is empty: this does **not** mean
Jev reviews worker tool calls. Worker reviews require host hook wiring.

## Offline workflow comparison

[Workflow comparison protocol and harness](docs/workflow-comparison.md) replays
public toy tasks through an **external adapter protocol**. The default is a
no-execution offline plan; synthetic adapter fixtures exercise the protocol.
The opt-in `scripts/workflow_synaps.py` adapter drives bounded Synaps RPC v1
with a fresh isolated plugin copy and same-instance local accounting. It is not a
sandbox, a strict spend budget, or evidence of real savings. No paid full-workflow
experiment has been run; these toy tasks do not exercise routing, and the six
tools are not all fully benchmarked. Main billed cost and HTTP attempts remain
unknown, so dollar comparisons are explicitly unavailable.

## Install

Install the published snapshot through the Synaps marketplace:

```text
/plugins → refresh marketplace → jev → install
```

Installed plugins are git-snapshot copies, **not symlinks to a working tree**.
After a release, refresh the marketplace, then explicitly update Jev with
`/plugins → jev → u`. Refreshing availability alone does not update the installed
snapshot or its frozen commit. Do not symlink this repository into the plugin
directory; development symlinks bypass reproducible snapshot installation.

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
**inert**: no model guard (the local shell-safety rule and the rule-1 guard
still run; see "Shell-safety rule" and "Rule-1 guard"), but `jev_status` still
answers and tells the model how to
get configured, and `/jev` still works.

Get a key at https://typesafe.ai.

## All-on versus economy (explicit presets)

- **`/jev on [--save]`** enables every feature, **including guard** and opt-in
  discovery, verification, evidence, reports, diagnosis and context. It leaves the chosen compression
  mode alone. A key is required for all-on.
- **`/jev economy [--save]`** leaves guard **unchanged**, configures router,
  triage and context on, enables **deterministic** compression, and turns discovery,
  verification, evidence, reports and diagnosis off. Economy is a preset, not a feature flag
  or a claim of savings. No setup or defaults are changed automatically.
- **`/jev off [--save]`** disables every feature, including deterministic
  compression. Tools remain advertised. The local shell-safety rule is not a
  feature and keeps running (its switch is `guard_shell_rule`; see R-GATE).

`/jev compress mode jev|deterministic [--save]` chooses the mode immediately
without enabling compression. `jev` (the default) keeps the remote readability
choice; `deterministic` performs only the **same bounded lossless checks and exact
roundtrip** locally, with no API call or outbound redaction step. Both preserve
failure output, reject unsafe/truncated/structured candidates, and use the same
identical-line-run representation, not a lossy summary. Local folds increment
`compress.local` plus the shared fold/byte counters; byte reduction is not a
model-token or dollar-savings measurement.

Without a key, defaults remain inert. Local compression is allowed only with
explicit `compress=true` and `compress_mode=deterministic`, or after selecting
economy. Economy can be saved without a key: remote features remain inactive
until a key is supplied; the guard's inert behavior is unchanged. Session choices
survive key reactivation; only `--save` persists to a new session. Existing exact
session caches for routing, triage and reports are reused (no generic tool-call
cache); all advice caches clear on key/model activation and deactivation. Guard
reviews are never cached. `/jev status` shows mode and preset guidance.

## Turning the guard off (without losing the rest)

```
/jev guard off            # this session only — no more ~0.4 s review per tool call
/jev guard on             # back on
/jev guard off --save     # persist to plugins/jev/config
/jev router off           # same pattern for router / compress / triage / discovery
/jev triage off           # skip advisory failure classification; guard stays independent
/jev context off          # skip advisory context-boundary reports (one call per turn end under pressure)
/jev off                  # guard + router + compress + triage + discovery + verification + evidence + reports + diagnosis + context; all six tools stay
/jev guard                # show now / source / saved
```

Session toggles are never written to disk and survive a later `/jev key …`
re-activation. `/jev status` marks them `(session)`. `/jev guard off` and
`/jev off` stop the model guard only: the local shell-safety rule (no model
call) keeps blocking; its own switch is the config key `guard_shell_rule`.
Their reply says so ("The shell rule stays on: ... set `guard_shell_rule =
off` to stop it", or that it is off too when that key says so).
The rule-1 guard keeps running the same way (its switch is `guard_rule1`),
and the reply says that too ("The rule-1 guard keeps running: in fleet
sessions it blocks ... set `guard_rule1 = off` to stop it").
A new session starts from
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
| `transport` | `auto` | `relay`, `direct` or `auto` (relay when `~/.local/state/pria-desktop` exists, else direct); see [Pria desktop relay](#pria-desktop-relay-transport) |
| `model` | `jev-latest` | pin `jev-1.13.0` once thresholds are tuned |
| `timeout_ms` | `3000` | keep < 5000 — the runtime's hook timeout is fail-open |
| `audit_file` | `memory/jev/audit.jsonl` | relative to `SYNAPS_BASE_DIR`; contains command text; chmod 600; `""` disables |
| `log_routine` | `file` | where routine log lines go: `file` (`memory/jev/jev.log` only), `stderr` (stderr and jev.log, the routing before jev.log) or `off`; notices always go to both; anything else means `file`. See [Logs](#logs) |
| `guard` | `true` | `/jev guard on\|off [--save]` flips it live |
| `guard_tools` | `bash,write,edit,read,multi_edit,send_events` | runtime tool names |
| `guard_ask_at` | `1.5` | risk score (0–3) that triggers a confirmation |
| `guard_block_at` | `3.5` | risk score that hard-blocks; 3.5 = never |
| `guard_min_conf` | `0.6` | below this the guard always asks |
| `guard_secrets_at` | `0.5` | P(touches secrets) that always asks |
| `guard_escape_at` | `0.7` | P(writes outside cwd//tmp) that always asks |
| `guard_confirm` | `auto` | what a guard confirm does: `auto` (never prompts; see [guard confirms](#guard-confirms-guard_confirm)) or `prompt` (every confirm asks, the old behaviour); anything else, a missing key or a missing config dir means `auto` |
| `guard_shell_rule` | `block` | the [shell-safety rule](#shell-safety-rule-deterministic-block): `block`, `confirm` or `off`; anything else means `block` |
| `guard_rule1` | `block` | the [rule-1 guard](#rule-1-guard-deterministic-block-fleet-sessions): `block`, `warn` (log and count only) or `off`; anything else means `block`. Owner-only by convention |
| `guard_access` | `block` | the [access rule](#access-rule-owner-rules-27a27b-deterministic-block): `block`, `warn` (log and count only) or `off`; anything else means `block`. Owner-only by convention |
| `guard_access_scope` | `all` | which sessions the access rule covers: `all` or `fleet` (the rule-1 roster); anything else means `all` |
| `guard_rule1_scope` | `fleet` | which sessions the rule-1 guard covers: `fleet` (listed in the fleet roster; an unreadable roster means every session) or `all`; anything else means `fleet` |
| `router` | `true` | `/jev router on\|off [--save]` |
| `router_min_conf` | `0.8` | |
| `router_read_only_at` | `0.15` | P(needs_write) at/below which `write_policy` → `read_only` |
| `router_models` | `""` | `small=<id>,medium=<id>`; ids must already be worker-authorised; `frontier` always inherits |
| `discovery` | `false` | opt-in query/descriptor API calls; `/jev discovery on\|off [--save]`; independent of guard |
| `reports` | `false` | automatic worker-report claim triage; `/jev reports on\|off [--save]`; independent of guard |
| `evidence` | `false` | descriptor relevance advice; `/jev evidence on\|off [--save]`; independent of guard |
| `verification` | `false` | optional priority advice; `/jev verification on\|off [--save]`; independent of guard |
| `diagnosis` | `false` | supplied hypotheses/checks only; `/jev diagnosis on\|off [--save]`; independent of guard |
| `context` | `true` | advisory `context_phase` boundary reports only under host context `pressure` at a tool-free turn end; `/jev context on\|off [--save]`; independent of guard; inert on older hosts |
| `budget_*` | enforcement `false` | optional API budgets/circuit; see [defaults, limits and accounting](#optional-session-budgets-and-circuit-breaker) |
| `triage` | `true` | advisory failure classification; `/jev triage on\|off [--save]`; independent of guard |
| `compress_mode` | `jev` | Only `jev` or `deterministic`; mode alone does not enable compression |
| `compress` | `false` | opt-in; `/jev compress on\|off [--save]` |
| `compress_tools` | `bash` | intersected with hard allowlist `{bash}` |
| `compress_min_bytes` | `6000` | integer clamped to 6000..262144; invalid uses default |
| `compress_min_conf` | `0.85` | finite readability confidence 0.85..1; invalid uses default |
| `compress_head` / `compress_tail` | `1500` / `1000` | deprecated, ignored (even zero/malformed values) |

## Logs

The host forwards an extension's stderr to `synaps.log`, but only the first
**128 KiB per extension process** (SynapsCLI
`crates/agent-engine/src/extensions/runtime/process.rs`). Past that it only
counts the bytes and logs the count when the process exits (`Extension stderr
exceeded the forwarding budget … suppressed_bytes=N`). One guard line per
tool call (about 5.6 KB a minute) used that up about 23 minutes after each
start, after which none of jev's warnings reached `synaps.log`. So jev's log
has two kinds of lines:

- **Notices** go to stderr (and so `synaps.log`) **and** to jev.log. They are
  rare: once per process, once per change of state, or a call that was
  blocked or failed. A notice that can repeat on every call (an API outage,
  the same block retried, relay flapping, the same crash) is limited: the
  first reaches stderr, its repeats go to jev.log only (see *Repeated
  notices* below).
- **Routine** lines (a decision per call that continues or confirms, skips,
  fold notes) go to jev.log only. Config `log_routine = stderr` sends them to
  stderr too, as before jev.log; `log_routine = off` drops them. Notices go to
  both whatever `log_routine` says.

Every `log(` call site, and where its line goes (`[jev] ` prefix omitted):

| Line | Where from | Kind |
|---|---|---|
| `started`, `stopped` | `jev_ext.main` | notice |
| `framing error: …` (the loop stops) | `jev_ext.main` | notice |
| `handler crashed on <method>: <type>` + frames; a repeat of the same signature: `handler crashed on <method>: <type> at <file>:<line> in <function> (again; the first in full)` | `jev_ext._dispatch` | notice, limited (`crash:<signature>`, family `handler crashes`) |
| `active (…) key from <source>`, `active (…) through the Pria desktop relay` | activation | notice |
| `key found at <source> but unusable: …`, `key unusable: …`, `inert: no API key …` | key state | notice (`key found … but unusable` is re-checked every 5 s: limited by its text) |
| `guard inert: no API key` (once per process) | `jev_ext._hook` | notice |
| `config transport: unrecognised value …`, `config log_routine: unrecognised value …` | `initialize` | notice |
| `relay: ok (…)`, `relay: Jev is off (<code>)…` (once per change of relay state) | `relay.py` | notice, limited (`relay:<code>`, family `relay`) |
| `guard rule-1: fleet roster readable again`, `… no fleet on this host …`, `… WARN fleet roster unreadable …` (once per change of state) | `roster.py` | notice, limited by its text |
| `guard <tool>: block …`: the model, the shell-safety rule, shell text too large, malformed input, `multi_edit`, `send_events` (pattern or model), the rule-1 guard, the access rule (27a) | `guard.py` | notice, limited by its text |
| `guard <tool>: warn …` (rule-1 guard or access rule in `warn` mode) | `guard.py` | notice, limited by its text |
| `guard <tool>: error after N ms → confirm \| continue \| block (<category>)`: an evaluation failure (timeout, hook budget spent, transport or upstream error, invalid or malformed answer, deadline unavailable, …); the guard is exempt from the [optional budgets](#optional-session-budgets-and-circuit-breaker) and the circuit, so it is never budget-denied | `guard.py` | notice, limited (`guard.error:<category>:<outcome>`, family `guard: evaluation errors`) |
| `guard <tool>: the 27b auto record could not be written …` | `guard.py` | notice, limited (`guard.27b_record`) |
| `compress error: keep` | `compress.py` | notice, limited (`compress.error`); routine on a budget denial |
| `guard <tool>: continue …` / `confirm …`: the model, the shell-safety rule (`confirm` mode), shell text too large or malformed input (`prompt`), `multi_edit`, `send_events` | `guard.py` | routine |
| `guard <tool>: confirm→continue (auto) …` | `guard.py` | routine |
| `guard <tool>: redacted state is all placeholders → continue (no model call)` | `guard.py` | routine |
| `guard <tool>: unresolvable target → confirm \| continue …` | `guard.py` | routine |
| `guard <tool>: continue, access rule 27b auto mode …`, `… access rule 27a: JR allowed request <id> once …` | `guard.py` | routine |
| `compress fold: N -> M bytes` | `compress.py` | routine |

The router, triage, reports, discovery, context and the tools log nothing.
The audit file stays the record of every decision; neither log replaces it.

**Repeated notices.** The guard is exempt from budgets and the circuit, so
through an API outage its evaluation-error notice came on every call: at 50
calls a minute the host's budget was gone about 28 minutes in. Each jev
process now passes its notices through a small limiter (`logs.Limiter`):

- the **first** notice of a key reaches stderr and jev.log;
- its **repeats** within the key's window (10 min from the first) go to
  jev.log only, one line each, and are counted;
- when the window ends (checked after each frame's reply, and at shutdown
  before `stopped`), **one** summary line, to both, if there were repeats:
  `<label>: repeated N more times in the last M min (each in jev.log)`, with
  `; ok again` when the state recovered in between. A key that keeps
  repeating starts its next window at once (no new first line); a key quiet
  for a whole window is forgotten, so its next notice reaches stderr again;
- on a change of state (a line that clears the key: a model answer after
  guard evaluation errors, a written 27b record, a compress fold), **one**
  line, to both: `<label>: recovered after N errors`. Once an EPISODE: until
  the key is forgotten (a quiet window), a later recovery is only the
  summary's `; ok again`;
- keys of one **family** (a guard error per category, a crash per
  signature, a relay state per code) share one window: the first of each
  key still reaches stderr at once, but a window ends in ONE summary for
  the family, with the counts per key, the most first, within 200
  characters (`+N more` past that): `guard: evaluation errors: repeated N
  more times in the last 10 min (timeout → continue ×40, HTTP 503 →
  continue ×35) (each in jev.log)`, and the recovery line is the family's
  too. Every HTTP status is a category, so without this an outage over five
  categories wrote five summaries and five recoveries every 10 min.

| Key | Window | What reaches stderr |
|---|---|---|
| `guard.error:<category>:<outcome>` (e.g. `guard.error:timeout:continue`), whatever the tool or the timing; family `guard: evaluation errors` | 10 min, the family's | the first `guard <tool>: error after N ms → <outcome> (<category>)` of each category; the family's summary `guard: evaluation errors: repeated N more times … (<category> → <outcome> ×N, …)`; `… recovered after N errors (…)` at the next model answer, once an episode |
| `guard.27b_record` | 10 min | the first `the 27b auto record could not be written …`; the summary; `… recovered` when a record is written again |
| `compress.error` | 10 min | the first `compress error: keep`; the summary `compress: evaluation error → keep: repeated …`; `… recovered` at the next fold |
| `crash:<signature>` (signature: `handler crashed on <method>: <type> at <file>:<line> in <function>`, the last frame); family `handler crashes` | 10 min, the family's | the first crash of each signature in full, frames included; the family's summary `handler crashes: repeated N more times … (<method>: <type> at … ×N, …)`. A repeat writes one line to jev.log (`… (again; the first in full)`) and its frames are not formatted at all |
| `relay:<code>` (`relay: ok …`, `relay: Jev is off (<code>) …`, written on a change of state); family `relay` | 10 min, the family's | the first of each state; the family's summary `relay: repeated N more times … (off (deadline) ×N, ok ×N)` |
| anything else: the text, its timings (`N ms`) dropped. A block retried, a warn, roster state lines, `key found … but unusable` | 10 min | each different text once (so a different block, a new request id reaches stderr); an identical repeat only in its summary |
| never limited: `started`, `stopped`, `framing error`, activation (`active …`), `key unusable`, `inert …`, `guard inert`, the config lines | | every line |

At most 256 keys are followed at once (a family's keys count each); past
that the oldest window ends early (with its summary). If the limiter itself
fails, the notice is shown. Under any one sustained failure, or a family's
several (guard errors over five categories, down or 20% flaky; crashes of
four signatures; the relay over five states), a simulated 24 h at 50 calls
a minute writes 15 to 48 KB to stderr (`tests/test_log_limiter.py`, (h)),
under half the host's 128 KiB.

Known limits, not fixed here:

- a crash's signature is its innermost frame only, so two bugs that fail in
  the same frame (a stdlib call, say) share one key: the second is counted,
  not shown in full;
- jev.log escapes the C0 controls, DEL and the Unicode line breaks, not the
  C1 controls other than U+0085, nor bidi overrides: a display risk only,
  one entry is still one line;
- `tests/e2e_protocol.py` gives each child a temporary HOME
  (`jev-e2e-home-*` under the temp dir) and does not remove it.

**Reading jev.log.** It is `memory/jev/jev.log` under `SYNAPS_BASE_DIR`
(default `~/.synaps-cli`), next to the audit file; `jev_status` shows the
path as `log_file`. One line per entry:

```text
2026-10-27T16:21:03.123-0500 41822 [jev] guard bash: continue (412 ms) risk=0.10 conf=0.95 leak=0.02 escapes_cwd=0.03 — …
```

local time, then the pid: every synaps session runs its own jev process and
they all append to the same file, so filter on the pid to follow one
session (`grep ' 41822 \[jev\]' ~/.synaps-cli/memory/jev/jev.log`), or
`tail -f` it to watch them all. The lines are the ones stderr carried before
and can name files and rule findings, so the file is created mode 0600 (a
wider existing file is tightened) in a 0700 directory. At 2 MiB it rotates:
`jev.log` → `jev.log.1` (newest) → `jev.log.2` → `jev.log.3` (oldest,
dropped at the next rotation), so at most about 8 MiB is kept. Rotation takes
an exclusive lock on the full file; a process that finds it taken appends to
the file it has open, and one that finds the file already rotated opens the
new one, so sessions sharing the file lose no line to a rotation.

A line break or other control character in a message is escaped in jev.log
(`\n`, `\r`, `\xNN`, `\u2028`, `\u2029`), so every entry is one stamped
line that the pid grep finds, and a message cannot forge a line of its own.
stderr keeps a crash's frames on their own lines.

`O_NOFOLLOW` covers only the last path component: a symlink or FIFO *at*
`jev.log` is refused, but a symlinked `memory/jev` (or any parent) is
followed and jev.log is written in its target, as `audit.jsonl` is. Keep
the directory a real one where that matters.

Writing is best-effort and never delays a reply: each line is one `O_APPEND`
write (a symlink or anything but a regular file at the path is refused), done
after the frame's reply like the stderr lines. A line that cannot be written
(unwritable directory, full disk, anything) is dropped and counted.
`jev_status` reports, for this process: `log.file_lines` and
`log.file_dropped` (jev.log), `log.stderr_lines` (lines written to stderr;
the host may still suppress them past its budget), `log.dropped` (stderr
lines lost to a full pipe), `log.notices_limited` (repeats kept off
stderr) and `log.notice_summaries` (summary and recovered lines written),
plus `log_routine`. These `log.*` counts cover the whole process; the audit
counters next to them in `counters` restart at each `initialize` (a new
audit), so after a re-initialize the two cover different spans.

## Offline tests

From the repository root, run the hermetic suite sequentially (one worker):

```bash
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest -q jev-plugin/tests > /tmp/jev-tests.log 2>&1
# Inspect the exit code, then the summary:
tail -n 12 /tmp/jev-tests.log
```

This collects `test_*.py` only, with no xdist workers or third-party pytest plugin
autoload. Protocol tests use fake keys, offline transport stubs/socket blocks,
and temporary `SYNAPS_BASE_DIR` directories. No credentials or live API calls are
required. The suite does not test host UI approval handling or worker hook wiring.
`e2e_*.py`, `/jev test`, key validation, and benchmarks with `--live` are separate,
explicitly authorized live operations, **not part of this offline command**.

## Design notes

- **Fail-closed where it matters.** The runtime treats a hook that does not
  answer within its 5 s deadline, that fails at the RPC level, or that answers
  malformed, as `continue`. Under `guard_confirm = prompt` the guard returns
  `confirm` on *any* error or internal crash of its own; under the default
  `auto` it never prompts: an error after every deterministic rule passed
  continues (`guard.error_auto`), an error before that (or a crash) blocks
  (see [guard confirms](#guard-confirms-guard_confirm)). Either answer comes
  within a 4.0 s budget that starts when the hook
  frame arrives in the plugin (see the budget note below). That covers the
  plugin's side only. Getting the frame to the plugin and the reply back
  (transfer, the host's framing and queueing, a stalled stdin/stdout pipe) is
  outside it, and only the host's deadline bounds it, so the plugin alone
  does not guarantee a `confirm` within 5 s. Closing that gap needs the host:
  a per-hook `on_failure: "confirm"` manifest setting that turns a timeout, an
  RPC error or a malformed answer into a confirm (a SynapsCLI change in
  progress). The guard's hook entries declare it in the release that ships
  that host; an older host ignores the field and keeps `continue`. Router and
  compress are optimisations and fail open.
- **Bounded data leaves the machine.** Guard sends command/path/content previews.
  Compression sends the complete redacted line-run list and original UTF-8 byte
  count only (≤32 KiB serialized), not goals, commands, tool inputs or hashes.
  Redaction is best-effort; opt-in compression can send repetitive transcripts.
- **Router only adds.** It never overrides a field the foreground set, never
  sets `isolated_worktree`, and only changes `model` when you have mapped a
  tier to an exact authorised id. Hard or uncertain tasks inherit the
  foreground model — a cheap route that routes badly is the expensive one.
- **Compression is reversible at the plugin boundary.** No history rewrite,
  sampling, omitted middle, reread archive, or rerun instruction. Runtime context
  budgets can still truncate output; this is not a host delivery guarantee.
- **Question keys carry no meaning.** Everything the model sees is in
  `instructions` / `criteria`; keys are only for matching answers.
- **Key persistence uses the host's own store.** `/jev key` calls the host's
  `config.set` (permission `config.write`), which writes
  `<base>/plugins/jev/config` — the same file the runtime reads at
  `initialize`. If the RPC is unavailable the plugin writes the identical
  file itself. When the plugin dir is a dev symlink into a repo that file
  lands in the repo tree; it is git-ignored as `/config`.

### Guard confirms (`guard_confirm`)

A hook `confirm` becomes an interactive prompt on some hosts even under an
allow-all policy (Pria Desktop does this), so a guard that confirms about one
call in five stalls sessions and floods the owner with prompts. The config key
`guard_confirm` decides what a guard confirm does:

- **`auto` (default).** The guard never prompts. Anything other than
  `prompt`, a missing key or a missing plugin config dir means `auto`.
- **`prompt`.** The old behaviour, unchanged: every confirm below asks.

Under `auto` each confirm falls into one of three classes:

| Class | Sources | Under `auto` |
|---|---|---|
| (a) model-derived | `jev_decide` risk/confidence/secrets/escape thresholds; the `multi_edit` summary confirm (including a file whose answer failed); the `send_events` leak score | **continue**; counter `guard.confirm_auto`, audit action `confirm_auto` with a `why`, log `guard <tool>: confirm→continue (auto) <why>` |
| (b) evaluation failure | transport/timeout/rate limit/spent budget/malformed answer/policy refusal; an unresolvable path | **continue** (`guard.error_auto`, audit action `error_auto`) only if every deterministic rule for the call already ran and passed; otherwise **block** ("could not be checked; retry or split it"). A crash of the handler blocks |
| (c) deterministic finding | shell text too large to scan; `send_events` secret pattern; rule-1 "could not check"; malformed `multi_edit`/`send_events` input, or a `write`/`edit`/`read` `path` that is not a string | **block**, same reason text plus `blocked, not prompted (guard_confirm = auto)` |

Blocks stay blocks, and `allow_once` and the access rule are unchanged.
`guard_shell_rule = confirm` is an explicit opt-in and still confirms under
both policies. The deterministic rules run before anything slow: `multi_edit`
validates and runs the shell rule before it resolves paths, and `send_events`
scans for secret patterns before it builds previews, so a spent budget cannot
skip them (a `multi_edit` carrying `rm -rf /` blocks even when the path step
spends the budget). The counters show in `/jev status` and `jev_status` with
the others; `/jev explain` rows gloss `confirm_auto` and `error_auto`. The
host passes no approval signal in `before_tool_call`, so the key decides alone.

### Multi-file builtins (`multi_edit`, `send_events`)

New builtins are not a way around the guard. Each has its own
`before_tool_call` hook entry and is in the default `guard_tools`.
The confirms described in this section and the shell-rule and rule-1
sections below are what `guard_confirm = prompt` does; under the default
`auto` each resolves by its class in [guard confirms](#guard-confirms-guard_confirm)
(model-derived: continue; evaluation failure: continue only after the
deterministic rules passed, else block; deterministic finding: block).

- **`multi_edit`** gets edit's check per distinct target file in **one**
  request: `risk_i` / `leak_i` / `leaves_workspace_i` for
  `call.files[i]` (16 files × 3 = 48 questions). Files are grouped by
  `realpath` of the path exactly as the tool resolves it (`~`/`~/` from
  `HOME`, then a relative path joined to the session cwd the host sends as
  `HookEvent.cwd`). A host that sends no cwd gets a confirm, without a call,
  for any relative target: the guard never guesses with `project_root`. The
  state carries raw path and aliases, realpath, ops, edit count and 200-char
  anchor/text previews per edit, and `cwd` is the session cwd (also for
  `edit` once the host sends it). Today's `decide()` thresholds apply per file and the strictest file
  wins (block > confirm > continue); the message names the tripped files (and
  where a symlink lands). A file whose answers are missing or malformed is
  that file's confirm and the others still count, so a valid block is never
  downgraded; a batch failure before any answer confirms.
- **`send_events`** gets the secrets check on bodies only (risk and workspace
  escape do not apply): a deterministic full-body scan for credential shapes
  (private-key blocks, `sk-`, `ghp_`/`github_pat_`, `glpat-`, `xox?-`,
  `AKIA`/`ASIA`, `AIza`, `apikey_`, Stripe keys, JWTs, bearer tokens, URL
  credentials, and quoted or unquoted `api_key`/`password`/`token`/`secret`
  assignments, suffixed and compound names like `DB_PASSWORD=`,
  `accessToken:` or `clientSecret:` included). A placeholder stays quiet
  only as the whole value: `<NAME>`, `${NAME}`, `{{NAME}}`, `%(name)s` or
  `%NAME%` with a name of letters, digits and `_.-`; a mask of only `x`, `*`,
  `•`, `_` or `…`; or a stock word such as `changeme`. A quoted value is
  read by its quote layer, from the backslashes before its opening quote. An
  unescaped quote (no backslash, or an even run) ends at the next unescaped
  quote of its kind, so an escaped quote or a quote of another kind inside
  is part of the value (`"<NAME>\"rest"`, `"<NAME>'rest"` and
  `"<NAME>,rest"` are scanned). An escaped quote (an odd run: JSON text
  inside a string) ends only at the same run before the same quote; any
  unescaped quote inside is part of it. A placeholder is the whole value
  only when that closing quote follows it at once and is itself followed by
  whitespace, `, ; : ) ] }`, a quote that closes an enclosing string, or
  the end; a mismatched quote, another run or no closing quote leaves the
  value scanned. Anything else after the closing quote continues the value,
  as in shell, where `password="<NAME>"rest` assigns `<NAME>rest`: the value
  is then the whole concatenation, quoted and unquoted parts together, up to
  the next such boundary, judged as the bare word it becomes by the unquoted
  rules below (`"<NAME>"rest`, `'ab'"rest"` and `"<A>"x"y"rest` are
  scanned). An unquoted value runs on across a quote or
  backslash unless that quote (after any backslashes) closes the string the
  assignment sits in, i.e. is followed by whitespace, `, ; : ) ] }` or the
  end of the text: `password=<NAME>"rest` and `password=ab"rest"` are
  scanned, `"export PASSWORD=<NAME>"` is not. An unquoted placeholder is
  whole when whitespace, `, ; ) ] }`, such a closing quote or the end follows
  it. Anything else
  is scanned, so a placeholder with a real tail, `$VAR`, a path or an
  embedded `xxxx` counts. Under `password`, `token` and `secret`, names
  common in prose, an unquoted value needs 8+ characters and a digit or
  symbol within its first 64 characters (`token: expired` stays quiet).
  Only when that scan is clean is there one secrets question per message on
  a 400-char preview. A pattern hit confirms (blocks under `guard_confirm = auto`)
  without a model call, naming `messages[i]` and the pattern kind. The hook
  message, log and audit carry indices, kinds, scores and sizes only, never
  the matched text or a body excerpt.
- Input outside the frozen tool contract confirms without a Jev call
  (`extensions/jev/tool_schemas.py`): unknown fields, a required field absent
  or `null`, wrong types (a boolean is not an integer), values outside an
  enum, op/field combinations the tool refuses, more than 1 MiB per
  anchor/text/unless_present/value or 256 KiB per body, a blank session or
  body, no source (the message's or the call's) in the CLI format, a
  non-plain `record_name`, a repeated (session, body) pair, more than 16
  target files, a NUL in a path, an `append_jsonl` whose `timestamp_field`
  is already a key of `value`. An optional field may be absent or `null`,
  as the tool accepts. The message names the index and field, never a value.
  Any upstream error confirms, as for the other guarded tools.
- These input checks are meant to be at least as strict as the tool, so a
  difference can only cause a needless confirm, never a missed one. Some
  conventions go beyond the literal schema text: unknown fields are refused,
  `null` counts as absent (so a required field that is `null` is missing),
  an empty `unless_present` is refused, and anchor and `unless_present` are
  capped like text. Checked against the `multi_edit` parser (SynapsCLI
  `feat/multi-edit` at 2c2d3a7a): it also refuses unknown fields, reads
  `null` as absent, refuses an empty `unless_present`, caps anchor, text,
  `unless_present` and the serialized `value` at 1 MiB, and refuses a
  `timestamp_field` collision, so on these points the two agree. One known
  place where the guard is stricter: a path counts as blank when Python's
  `str.strip()` empties it, which also strips the separators U+001C–U+001F
  that Rust's `trim()` keeps.
- Scope: the guarantee covers the call's syntax and the semantic checks
  listed here. The guard does no filesystem checks of its own beyond
  resolving each target's realpath. Existence, regular-file, size
  (16 MiB per file, 64 MiB in total), placeholder expansion and write-scope
  overlap are the tool's checks at plan time, so a call the guard lets
  through can still be refused by the tool.
- For every guarded tool, an error is reported as a fixed category
  (`timeout`, `HTTP 503`, `rate limited`, `malformed answer`, `internal
  error`, ...), never as exception text, and the audit keeps only
  allowlisted response metadata (`model` only as a Jev model id such as
  `jev-latest` or `jev-1.13.0`,
  `usage.input_tokens`/`output_tokens` as integers).
- One wall-clock budget of 4.0 s covers the guard's work: input checks,
  realpath I/O, the body scan, the Jev call and the audit write. It starts
  once the hook frame has been read, decoded and JSON-parsed. The Jev call
  gets what is left minus 0.15 s; an answer
  after the budget, or local work that runs past it, confirms (`hook budget
  spent`, counter `guard.budget`). A SIGALRM timer interrupts a blocking
  realpath, scan or audit write. Where no such timer can be armed (off the
  main thread, no `setitimer`, or another timer already armed) every guarded
  call confirms at once, before any local work (`deadline unavailable`,
  counter `guard.budget`). A confirm's audit row gets 0.5 s
  past the budget, else it is only counted (`guard.audit_skipped`). A single
  uninterruptible system call can still outlast it.
- On a P-core, the body scan of the largest call (32 bodies of 256 KiB)
  takes about 0.05-0.4 s for the dense adversarial near misses in the test
  suite (`test_adversarial_near_misses_scan_fast`). The slowest is a short
  quoted word followed by more value under `api_key`, which is read twice:
  once as a quoted value, and again as the bare word the concatenation
  becomes. Next come short unquoted words with escaped quotes. On this
  host's E-cores (a hybrid i9-14900K) at load ~22, the slowest take about
  0.6-0.67 s, about 17% of the 4.0 s budget. A scan that runs into the
  budget confirms like any other local work; it never lets the call
  through.
- The test's bound is relative to the host's speed. Each unit's 32 scans
  must take less than R times 32 scans of a benign prose body of the same
  size. The prose is timed right before and right after the unit, all on
  the same CPU (pinned where the OS allows it, unpinned elsewhere), and the
  bound uses the faster of the two readings, so one contended reading
  can't loosen it. R is 0.5 s divided by the prose reference's steady time
  on a P-core (`REFERENCE_P_S`, a median of single readings measured with
  `taskset -c 2`; on a fresh set of readings, the median of the faster of
  two was within 3% of the median of a single one, so the constant
  stands). So on a P-core the bound is the old 0.5 s, and on a slower core
  it scales with the core, rather than depending on which core class the
  test lands on. A unit over the bound is re-timed up to twice, and fails
  only if all three tries are over.
  - Known property: the ratio tracks the core class within about 11% for
    the units that can reach the bound (ratio 0.4 R or more on a P-core).
    Some far units, all at about 40% of R or less on either core, differ
    by up to about 39% between P- and E-cores. That can't flip their
    verdict. ("About" because the near/far cut uses the P-core ratio, so a
    far unit's E-core ratio can sit slightly above 0.4 R; the highest
    measured was 42%.)
- The budget's boundary: it starts after the frame has been read, decoded
  and JSON-parsed, and ends when the guard has its answer. Time before that
  (transfer, the host's framing and queueing, reading and parsing the frame,
  a frame waiting in the pipe while the plugin handles an earlier one) and
  after it (writing the reply, which a full stdout pipe the host does not
  drain can hold up) is protected only by the host's deadline; see *Fail-closed
  where it matters* for the host setting that turns a missed deadline into a
  confirm. A frame read while the plugin waits on its own call to the host
  keeps its time of receipt, so its wait in the plugin's queue counts.
- Logging never delays a reply. A frame's log lines are written after its
  reply, one write per line of at most 4000 bytes, to a stderr that is set
  non-blocking when it is a pipe or socket, and to jev.log (see [Logs](#logs):
  stderr carries notices only). A line that would block, or any
  other write failure, is dropped and counted (`log.dropped` for stderr,
  `log.file_dropped` for jev.log); a frame holds at most 64 lines for each
  and the rest are dropped and counted the same way.
  `log.dropped` above zero means the stderr log is incomplete: a missing
  stderr line does not mean the guard did nothing. The audit rows are the
  separate record. On a pipe whose atomic write size (`PIPE_BUF`) is under
  4000 bytes (not Linux) or on a socket, a short write counts as a drop but
  can leave a partial line.

#### `send_events` body scan: deliberate confirms and limits

Friction, deliberate: these confirm, so a confirm on `password=$DB_PASSWORD`
is expected, not a surprise.

- `$VAR` and `$(cmd)` values, e.g. `password=$DB_PASSWORD` or
  `token=$(cat /run/secrets/x)` when 8+ characters. A bare `$WORD` stays
  scanned, since a real value can start with `$`; `${WORD}` stays quiet
  because the braces make it unambiguous.
- Paths (`/run/secrets/db`, `~/.config/gh/token`).
- `${{secrets.X}}` written without spaces. The usual `${{ secrets.X }}` with
  spaces stays quiet, because its first run is under 8 characters.
- Hyphenated x-groups (`xxxx-xxxx-xxxx`), masks over 256 characters,
  `your-api-key-here`.
- Inside quotes: a placeholder followed by anything before the closing quote.
- After a closing quote: anything but whitespace, `, ; : ) ] }`, an
  enclosing string's closing quote or the end makes the value a
  concatenation, judged as one bare word. So these can confirm: sentence
  punctuation right after a quoted placeholder (`Use api_key:
  "<YOUR_API_KEY>".`, `password="<NAME>"!`), a method call, index or `+` on
  a short literal (`machine_token: "t1".into(),`, `token = "abc"[0]`,
  `password = "abc"+"def"`), adjacent markdown code spans
  (`` `api_key=`/`token=`-style ``), and a JSON-escaped newline after the
  close (`"export PASSWORD=\"${DB_PASSWORD}\"\nnext"`, where `\n` is a
  backslash and a letter, not whitespace).
- Code and query strings that compute or reference a value:
  `?token=placeholder&x=1` (`&` does not end a value), `api_key =
  config.api_key` (under `api_key` any 12+ characters count) and
  `let password = format!("{}", input);`.

Limits, known misses:

- Quoted values whose first word is under 8 characters. A quoted value needs
  8 characters of its first word, which runs to whitespace or the value's
  closing quote (a quote of another kind does not end it), so
  `password="ab RealPass123!"` is not a hit, and neither is a passphrase
  whose first word is short. Lowering the run would make prose such as
  `password: "is required"` confirm. A short first word whose closing quote
  is followed by more value is read as a concatenation instead.
- An unquoted value or a concatenation under `password`, `token` or `secret`
  whose first digit or symbol comes after its 64th character: a long run of
  letters, or of backslashes, uses up the window
  (`password="<NAME>"RealPassword` is not a hit).
- The scanner is not language-aware at value boundaries: one boundary set
  serves every text. An unquoted placeholder followed by `, ; ) ] }` is
  whole, whatever the language makes of the rest, so
  `password=<NAME>;RealPass123!` stays quiet.
- A real credential with a placeholder's whole shape (`${AbcDef1234567890}`,
  `<AbcDef1234567890>`, an all-x value) stays quiet: the text alone cannot
  tell a template from a value.
- In an escaped layer (JSON text inside a string) a value ends only at the
  same escaped quote, so the first word of a value that ends in a backslash
  runs on past its close. That can only add a confirm.
- A preview-only model question and the patterns listed above are the whole
  check: a credential in a shape the scan does not know is seen only within
  the 400-char preview.

### Shell-safety rule (deterministic BLOCK)

After the 16:52 incident (a generated script nested one heredoc inside
another, the outer one closed early, and `rm -rf "$FS"/*` ran with `FS`
empty), the guard checks the whole shell text of a call itself, before the
model and without a model call (`extensions/jev/shell_rules.py`). Since
10-27 22:38, when a test binary called `kill(-1, SIGKILL)` and ended JR's
whole desktop session, it also finds a signal to every process
(`signal_all`, below): the harness review rule (refuse pid <= 1 on any
kill of a pid that was read, parsed or returned) as far as shell text
shows it.

- **What it checks.** The `bash` command, and the new text of a shell
  script given to `write` (`content`), `edit` (`new_string`) or
  `multi_edit` (each edit's text). A shell script is a path ending in
  `.sh`, `.bash`, `.zsh` or `.ksh` (any case), or a text starting with a
  shebang that names a shell (directly or through `env`). `read` and
  `send_events` are not checked. A non-string field keeps today's path to
  the model.
- **What it finds.**
  - `unguarded_variable`: an operand of `rm -r` (`-R`, `--recursive`, any
    short-option group holding `r`), of `find … -delete` (or `-exec rm`)
    or of `mv` that expands a variable without the `:?` check: `$X`,
    `${X}`, `${X:-}`, `${X?}`, `$1`, `$@`. The fix named in the reason:
    `"${X:?}"`, which stops the command when X is unset or empty, or a
    literal path. An array keeps its subscript: `${arr[@]:?}` (`:?` after
    the subscript) counts as guarded, and the fix for `"${arr[@]}"` is
    `"${arr[@]:?}"`, never `${arr:?}` (that is the first element). A
    subscript other than `@`, `*`, a number or a name is shown as `…`.
    Caveat: on an array, `:?` stops only when the whole expansion is empty
    (no elements, or one empty element); `d=("" "")` passes it (bash 5.3).
  - `root_operand`: `/`, `/*`, `//` or `/.` as an operand of a recursive
    rm or of find -delete.
  - `home_operand`: `~`, `~/`, `~/*`, `$HOME` or `"${HOME:?}"/*`. `:?`
    does not help there, so these are never reported as unguarded.
  - `nested_heredoc`: a heredoc opened inside another heredoc's body:
    `<<` or `<<-` on a body line, outside quotes, comments and arithmetic,
    then a word starting with a letter, an underscore or a quote, or a
    backslash (`<<\E`: bash quotes the word just as for `<<'E'`, so it is
    a heredoc like any other), whether or not the inner terminator follows
    in that body.
    An unterminated inner heredoc stays open in the script written out; one
    reusing the outer delimiter ends the outer body early; either way the
    rest runs as commands. `<<<` (a here-string) and a shift such as
    `1 << 3` or `x<<2` are not openers. The fix: write the script with the
    write tool, then run it.
  - `signal_all`: a signal to every process the user may signal, in
    literal shapes only (no model call, nothing is run):
    - `kill` (bash's builtin or util-linux's, any spelling below) with a
      pid operand of literal `-1`, quoted or not, leading zeros counted
      (`-01`): `kill -9 -1`, `kill -- -1`, `kill -s KILL -1`,
      `kill -n 9 -1`, `kill -KILL -1`, `kill 123 -1`, and `kill -1 -1` (the
      first `-1` names SIGHUP). Options as both read them: `-s`, `-n` and
      `--signal` take a value, one leading `-SIG` names the signal, `--`
      ends the options, `-l` / `-L` / `--list` only list. Not found:
      `kill -1 123` (SIGHUP to pid 123), `kill -1` (no pid), `kill 0`,
      `kill -9 -- -1234` (a process group), and a variable: `kill $p`,
      `kill -TERM -- -$G` (unset, it gives a usage error, not -1).
    - `killall5`, with any arguments: every process outside its own
      session.
    - `pkill` selecting by user alone (`-u`, `-U`, `--uid`, `--euid`, with
      no pattern) and `killall` with `-u` / `--user` and no process name:
      `pkill -u jr`, `pkill -9 -u jr`, `killall -u jr`. With a pattern or a
      name it is not found: `pkill -u jr worker`, `killall -u jr foo`.

    One finding per command. The reason is fixed text (never the input):
    for kill, "kill with pid -1 signals every process you own (it killed
    the desktop session on 10-27). Signal a specific pid or a process
    group > 1 instead."
- **Where it looks.** Any word `rm`, `find`, `mv`, `kill`, `pkill`,
  `killall` or `killall5` starts a command (also `/bin/rm`, `\rm`,
  `sudo rm`, `git rm`, `/usr/bin/kill`, `env kill`, `timeout 5 kill`,
  `builtin kill`); its arguments run to the next
  `; & | ( )`, a comment or the end of the enclosing quoted string. The
  same word spelled with quotes and backslashes counts when the quoting
  holds only literal characters: `'rm'`, `"rm"`, `r""m`, `r''m`, `r\m`,
  `$'rm'`, `$"rm"`, `'/bin/rm'`, `"/usr/bin/"rm`. As for a plain word, text
  glued after it at a quote starts its arguments (`'rm'"$X"` reads like
  `rm"$X"`, i.e. rm with the operand `"$X"`), unless the quote spells a
  longer command: `kill'all'5` is `killall5`. Code
  inside quoted strings (`bash -c "…"`, `trap '…'`), command and process
  substitutions, backticks and heredoc bodies is scanned too, down to 64
  levels of quoted code (`MAX_DEPTH`). The value of a substitution used as
  an operand is opaque (`rm -rf "$(dirname "$F")"` passes); the commands
  inside it are scanned.
- **Strings across lines.** Every logical line is read fresh, so a
  mis-tracked quote or heredoc can add a finding but never hide a line. A
  line that starts inside a string, `$'…'` or backticks left open by an
  earlier line is also read with that quoting carried in, as bash reads it:
  after `git commit -m "fix`, the line `Refs #12"; rm -rf $D` reads as a
  comment on its own. Both readings count, each fact once. A command
  substitution carries no quoting (its content is code, as at the top
  level), and neither does a heredoc body: a body starts at the first
  newline outside quotes and ends at its delimiter line. The second reading
  is skipped where it can't differ: a line inside one string that neither
  ends it nor holds an escape.
- **When it runs (R-GATE).** Whenever the jev extension is loaded and
  `guard_shell_rule` is not `off`, for the tools in `guard_tools`: also
  with no API key, with the model guard switched off (`/jev guard off`,
  `guard = false`, `/jev off`), with a spent budget and with the error
  circuit open. It needs no model and runs before any model call; the hook
  subscriptions are static (`.synaps-plugin/plugin.json`), so they never
  depend on a key. With the model guard off, a `multi_edit` is scanned
  without the contract check (nothing would confirm a malformed one), and
  a call with nothing found goes on as it would without the guard.
  Counter `guard.shell_only`: decisions made without the model guard.
- **Action.** `block` by default. The reason names each finding's line
  (for an edit also the field and path; an edit's line counts from the
  start of its fragment), the variables and the fix; it
  lists 6 findings, then "… and N more" ("N+" when the scan stopped at its
  cap). `guard_shell_rule = confirm` asks instead, with the same text;
  `off` skips the rule; anything else, a typo included, means `block`. The
  hook message, the log and the audit carry rule names, commands, line
  numbers and variable names only, never text. The audit row has `rule:
  shell_safety`, up to 32 `findings` (rule, command, line, field),
  `findings_total`, `findings_capped`, `stopped`, `ms` and `session`. A
  text with no finding goes on to the model as before.

#### Shell-safety rule: limits and friction

A limit never lets a call through unscanned. It confirms the call when
the scan found nothing before it (under `guard_confirm = auto` it blocks:
the call could not be checked); when the scan had already found
something, the call takes the finding action on those findings instead:
block by default, confirm when `guard_shell_rule = confirm`. That is the
action a complete scan with that finding would take; a stopped scan never
takes a weaker one (R-FINDINGS-WIN: host policy may approve a confirm,
under allow-all or the session latch, so in the default mode a known
finding must not end as one). The same holds when the scanner fails
inside after a finding (any exception, not only a limit). The reason adds
"the rest of the text could not be checked" with the limit's category.
The audit row's `stopped` field holds that category (null otherwise);
counter `guard.shell_stopped`.

- **Size.** All shell texts of one call together over 256 KiB (UTF-8
  bytes, `SHELL_SCAN_MAX_BYTES`) confirm without a scan ("too large to
  check", counter `guard.shell_too_large`; under `guard_confirm = auto` they
  block with the same text and "split it into smaller calls"). 256 KiB is the body size of
  the V1 scan bound; at 512 KiB the costliest shapes, read twice where
  strings run across lines, came to about 86% of the bound on an E-core
  under load. So texts of 256-512 KiB confirm rather than scan: a
  trade-off of recall for a bounded scan (app policy answers a confirm).
  This check runs before the scan, so it has no findings to act on.
- **Findings.** A scan stops at 256 findings (`FINDINGS_MAX`): the
  decision (the finding action) is already made, the text after the cap
  is not read, so nothing there can turn it into a weaker one, and the
  reason says "N+ more". The cap is a decision, not a limit: no "could
  not be checked".
- **Too complex to check** (counter `guard.shell_limit`): quoted code
  nested deeper than 64 levels, or deeper than Python's recursion limit
  allows (a `"$(` chain hundreds deep); quoted code read again beyond 1.5x
  the text plus 64 KiB (`RESCAN_FACTOR`, `RESCAN_SLACK`; reopening carried
  quoting on every line is charged here too). This budget bounds the cost
  of rescanning quoted code (nested quoted code holds the same bytes once
  per level); it was 2x until BLOCK r2, and at 1.5x a text that needs more
  rescanning confirms sooner: more friction on very long rescanned text,
  never a let-through. More than 64 KiB of lines read a second time also
  stops the scan (`REOPEN_MAX`; a text up to that size never reaches it).
- **Time.** The scan is local work inside the guard's 4.0 s budget; a scan
  that runs into it confirms (or takes the finding action on what it found
  before, as above).
- **Cost.** `test_the_largest_text_scans_fast` bounds every cost unit, at
  256 KiB, with the V1 relative bound (R x the prose reference, the faster
  of two readings, re-timed up to twice). Measured with `RESCAN_FACTOR`
  1.5 (BLOCK r2), three runs per core at load 21-37: on a P-core (CPU 2)
  the costliest unit, a deep stack of quoting carried over many short
  lines (stopped by the rescan budget), has a median ratio of 3.20 (48% of
  R; P-core readings at this load are noisy, 2.80-3.38, 0.19-0.35 s); the
  next is a string carried to `REOPEN_MAX` at 2.30 (34%). On an E-core
  (CPU 20) the same units come to 3.58 (54%; 0.38-0.41 s) and 3.29 (49%;
  0.36 s), and no unit takes more than 0.41 s. Known property: the shell
  scanner is Python-heavy, so its E-core ratio runs up to 100% above its
  P-core ratio, by unit (12% for the costliest), where the regex-heavy
  body scan tracks the core class within about 11%; every unit stays under
  R on both.

Friction, deliberate (these block):

- Quoted text is scanned as code: `echo 'rm -rf $X'`, a commit message or
  prose that shows such a command, and heredoc bodies (a body is often the
  script being written). A word is a command wherever it stands, so
  `grep mv "$F"` blocks, and so does `grep "mv" "$F"`.
- `rm -rf "$HOME/sub"` blocks (write `"${HOME:?}/sub"`); variable values
  and control flow are not evaluated, so `D=/tmp/x; rm -rf "$D"` and
  `[ -n "$D" ] && rm -rf "$D"` block too.
- In a heredoc body, `<<` followed by a letter, an underscore, a quote or
  a backslash is an opener, whatever language the body is: C++ `std::cout << "x"` or
  `<< endl`, Ruby `list << item`, Python `mask << shift` block (a shift
  by a number does not).
- `signal_all` reads quoted text as code too: `echo 'kill -9 -1'`, a
  commit message showing it, and `grep killall5 notes.txt` (killall5 with
  any arguments) block. `pkill -u jr` blocks even with another selector
  (`-t pts/1`, `-P 123`): only a pattern clears it. `systemctl kill`,
  `docker kill` and `tmux kill-session` are read as `kill` with their
  arguments, so they block only with a literal `-1` operand.

Known misses:

- Edits are scanned as fragments: an edit's `new_string`, and each
  multi_edit edit's `text`, is scanned on its own, not the file as it
  would be after the edit. A change whose danger depends on the text
  around it is missed: an operand swapped for a bare `$X` inside an
  existing `rm -rf` line (the fragment holds `$X` alone), or an inner
  heredoc opener added inside an existing outer body. Line numbers in the
  reason count from the start of the fragment, not of the file. Rebuilding
  the resulting file before the scan is on the V2 follow-ups.
- Edits are judged by their new text and the target's suffix or the
  text's shebang only: an edit to a script without a shell suffix whose
  new text does not start with a shebang is not checked.
- `shell_start` / `shell_send` (interactive shells) are not guarded, and
  `bash x.sh` does not scan the file it runs (deferred); a script is
  checked when it is written through write, edit or multi_edit.
- Other deleting tools: `rsync --delete`, `git clean`, `shutil.rmtree` in
  a heredoc.
- In an unquoted heredoc body, a string inside `$(…)` that runs across
  lines is read line by line (bash expands it).
- An inner heredoc whose word starts with a digit or `$` (`cat <<1`,
  `cat <<$X`) is not an opener by the rule's shape.
- A command name built with an expansion (`$RM`, `${R}m`, `r$(echo m)`,
  `"r$m"`) or an ANSI-C escape (`$'\x72m'`), or with more than 8 of
  `$ ' " \` in a row inside it, is not recognised.
- `signal_all` sees literal shapes only: a pid from a variable or a
  substitution (`kill -9 $ALL` with `ALL=-1`, `kill -9 $(echo -1)`), a pid
  passed through `xargs kill`, long options abbreviated (`pkill --eu jr`)
  or, for killall, written with one dash (`killall -user jr`), and an
  empty pattern (`pkill -u jr ''`) are not found. A program that calls
  `kill(-1, …)` itself, as the 10-27 test binary did, is no shell text:
  that is the harness review rule's part (refuse pid <= 1, and stop on a
  failed start), not this scan's.

### Rule-1 guard (deterministic BLOCK, fleet sessions)

Fleet safety rule 1: scripts and file content are written with the write or
edit tools, never generated inside a shell call (the 10-18 16:52 `rm -rf /*`
came from such a script). The rule-1 guard refuses, before it runs, a
**bash** command, a **shell_start** command or a **shell_send** input that
holds, at command level (outside quotes, comments, arithmetic and heredoc
bodies):

| Family | Matches | The refusal says |
|---|---|---|
| H1 heredoc | `<<WORD`, `<<-WORD` (any quoting of the word) | write the content with the write tool (a script as `f.sh`/`f.py` or with a `#!/bin/bash` line), then run or pass the file (`git commit -F msg.txt`, `python3 f.py </dev/null`) |
| H2 here-string | `<<<` | the same |
| E1 in-place edit | `sed`/`gsed` `-i`, `-i<suffix>`, a cluster holding `i`, `--in-place[=…]` (and its abbreviations); `perl` with an option cluster holding `i` (`-i`, `-pi`, `-i.bak`, `-0pi`) | change the file with the edit tool |
| S1 script on stdin | `python`/`python3[.N]` with `-` (or `/dev/stdin`) as the script, or with no script while its stdin is fed (a pipe, a heredoc, a here-string, a `<` file other than `/dev/null`); `sh`/`bash`/`dash`/`zsh`/`ksh`/`ash`/`mksh` with `-s` or `-`, or with no script while fed | write the script with the write tool (as `f.py`, or as `f.sh` / with a `#!/bin/bash` line), then run `python3 f.py </dev/null` / `bash f.sh` |
| S2 long inline python | `python -c` (`-B -c`, `-Bc`, `-I -S -c` …) whose code holds a newline or is over 200 characters; short one-liners pass | the same |

The shell script named in the fix is scanned by the shell-safety rule when it
is written (by name or shebang), so the retry is checked too.

- **Code it reads.** The top level, `$(…)`, backticks, `<(…)`/`>(…)` (also
  inside double quotes), `( … )` groups and `${…}` words. Wrappers are
  unwrapped (`sudo`, `env`, `timeout`, `nice`, `setsid`, `taskset`, `xargs`,
  `command`, `exec`, `nohup`, `stdbuf`, `ionice`, `chrt`, `flock`, `watch`,
  `heavy1`, `time`, `builtin`, `doas`, with their option arguments), and so
  are `find -exec`/`-execdir` commands. **Descent:** the `-c` string of a
  shell, `ssh`'s remote command, `eval`'s arguments and the command strings
  of `env -S`, `flock -c`, `watch`, `su`/`runuser -c` and `script -c` are
  read again as scripts of their own (up to 8 deep); a hit there names the
  outer command's line, "(in a nested script)".
- **Fed.** A stdin feed reaches an interpreter through `|`/`|&`, its own
  `<`/`<<`/`<<-`/`<<<`/`<>`/`<&` on fd 0 (the last one wins; `< /dev/null`
  and `<&-` are not feeds), and through a `( … )` group (a pipe into it, or
  a redirect after it). Not counted as "no script": `-m`, `-V`/`--version`,
  `-h`/`--help`, and a command run by `xargs` (xargs appends arguments and
  gives it `/dev/null`).
- **Texts.** bash `command`, shell_start `command`, each shell_send `input`
  on its own (Enter `\r` and the other control keys read as line ends).
  Never the content of write, edit or multi_edit (scripts legitimately hold
  heredocs). shell_start and shell_send are hooked for this rule only: the
  model guard and the shell-safety rule do not see them, and `guard_tools`
  does not narrow the rule-1 guard.
- **Order and gate (R-GATE).** It runs first, before the shell-safety rule
  and the model, and answers alone when it refuses (a retry then goes
  through both). It needs no model: no key, a spent budget, an open circuit,
  `/jev off` and `/jev guard off` leave it running; only `guard_rule1 = off`
  stops it. Its scan is timed by the same 4 s hook budget, from frame
  receipt, and done before the guard's own.
- **Scope** (`guard_rule1_scope`). `fleet` (default): the call's
  `session_id` is listed in `~/.pria/fleet/roster.toml` (`[master].session`,
  every `[[team]].foreman`) or in a `team.toml` anywhere under
  `~/.pria/fleet/projects/` (`foreman`, every `[[worker]].session`). Files
  are read again when their mtime, size or inode changes; the tree is
  searched again at most every 30 s, or every 2 s when a session is not
  found. The roster is read only when there is something to refuse. A
  roster that cannot be read or parsed puts **every** session in scope (one
  WARN log line per change of state; the refusal says "the fleet roster
  could not be read, so this rule applies to every session"). A missing or
  empty `session_id` is in scope. A host with no `~/.pria/fleet` at all has
  no fleet sessions: scope `fleet` matches none there (CI, other machines).
  `all`: every session (JR's own sessions only when he sets it).
- **Modes** (`guard_rule1`). `block` (default); `warn` logs, counts and
  writes the audit row, and lets the call run (a short soak, or one family
  while a real false positive is fixed); `off`. No in-band override, no
  allow-once (a later step, after peer identity).
- **Limits.** A text over 256 KiB (all texts of the call), code nested over
  64 deep, scripts nested over 8 deep, or descended text read again past
  1.5x the text + 64 KiB: **block**, saying it could not be checked and to
  write a script (the fix is always available). A spent hook budget, a timer
  that cannot be armed, or an internal error: **confirm** (they come from
  the host, not the text; **block** under `guard_confirm = auto`, counter
  `guard.rule1.block`). Hits found before a stop decide (block, naming
  them and that the rest was not checked). At most 256 hits are collected.
- **Audit, log, status.** One audit row per refusal (or warn, or confirm)
  with `rule: "rule1"`: family, fixed token (`<<`, `sed -i`, `python3 -`,
  `bash (stdin)` …), line, descent flag, where, the session id, scope and
  how it matched; never command text. No row for a clean call. Counters
  `guard.rule1.{H1,H2,E1,S1,S2}` (calls with that family),
  `guard.rule1.{block,warn,confirm}`, `out_of_scope`, `no_session`,
  `roster_unreadable`, `roster_unchecked`, `stopped`, `limit`; `/jev status`
  shows them in its "rule-1 guard" row.

#### Rule-1 guard: misses and friction

Documented misses (no tokenizer sees them; the lane's rule-1 control and the
reviewers' session scans stay the control for these):
- a shape split across several shell_send calls, and an interpreter started
  with no script (`shell_start` `python3`, or `python3` typed into a PTY)
  and then fed code by later shell_send inputs;
- quoted code handed to a custom remote runner (`ssmrun.sh '… python3 - <<"EOF"'`)
  or to any program that runs its argument as code, other than the shells,
  ssh, eval and the wrappers above;
- `printf … > f.sh`, `echo … >> f.py`, `tee`, `cp`, `dd` writing a script;
  awk, jq and other inline programs; `python3 <(printf …)` and other process
  substitutions used as the script;
- an interpreter named by a variable (`$PY -`), and stdin fed to the inner
  commands of a `{ …; }` group or a loop as a whole (`{ cd d; python3; } < f`;
  only the first command of a piped brace group is seen as fed);
- backtick bodies are read in place without undoing bash's backtick escapes;
- subagent tool calls, until the host's subagent hooks land (worker V); their
  frames are planned to carry the parent's session id, so the scope holds.

Friction by design (true positives that look harmless): `git commit -m
"$(cat <<'EOF' …)"` (use `-F msg.txt`), `cat <<EOF > file` (use the write
tool), `python3 - </dev/null`, `bash < f.sh` / `python3 < f.py` (run the file
by name), and shell_send into a non-shell PTY (a REPL) whose input happens to
read as one of the shapes (`1 << 3`).

### Access rule (owner rules 27a/27b, deterministic BLOCK)

Owner rule 27a (JR, 2026-10-20): before any command that changes who can
read, write or run something, or what the system lets an agent do, the
agent does not run it; it ends its turn and asks for JR's yes (a worker asks
its foreman). The model guard rates chmod "hard to reverse" and asks to
confirm, but fleet auto-accept passes a confirm, so this rule **blocks**,
decided locally (`extensions/jev/access.py`), with the text "Owner rule
27a: this changes access. Don't run it or work around it. End your turn and
ask for JR's yes (a worker asks its foreman). This task waits."

| Kind | Refused |
|---|---|
| command | users and groups (`usermod`, `useradd`, `gpasswd`, `groupadd` …), `sudo`/`sudoedit`/`doas`/`pkexec`/`su`/`runuser`/`visudo`, `newgrp`/`sg`, firewall tools (`ufw`, `nft`, `iptables`, `firewall-cmd` …), `setcap`/`chcon`/`setsebool`/`semanage`, `ssh-keygen` (not `-l -F -B -y`), `ssh-copy-id`, `ssh-add` (not `-l -L`), `systemctl set-property\|edit\|revert`, `systemd-run` in any form but the 27c(5) memory-cap scope (below); and `chmod`/`chown`/`chgrp`/`setfacl`/`chattr`/`chacl`, `install`/`mkdir` with `-m`/`-o`/`-g`, `rsync --chmod/--chown/--usermap/--groupmap` unless every target is in the session's own area |
| write | a redirect, `tee`, `cp`/`mv`/`install`/`ln`/`rsync`/`scp`, `dd of=`, `curl -o`, `wget -O`, `sed`/`perl -i`, `touch`, `truncate`, `rm` … naming a protected path (`~/.ssh`, `/etc/ssh`, sudoers, polkit, passwd/group/shadow/subuid/subgid, `/etc/security`, `pam.d`, the firewall configs, the jev config and `~/.synaps-cli/memory/jev`), or a gated path whose new text sets a gated key: systemd unit/slice/drop-in dirs and `Slice=`, `Memory*=`, `CPU*=`, `IO*=`, `TasksMax=`, `UMask=`, `User=`, `Group=`, `DynamicUser=`, `SupplementaryGroups=`, `ReadWritePaths=`, `ReadOnlyPaths=`, `InaccessiblePaths=`, `ProtectHome=`, `ProtectSystem=`, `PrivateTmp=`, `NoNewPrivileges=`, `CapabilityBoundingSet=`, `AmbientCapabilities=`, `Delegate=`; shell rc and environment files and `umask`; `~/.synaps-cli/config` and `umask`/`sandbox`/`landlock` keys. A copy's source is read (256 KiB); an unreadable source counts as setting a key |
| code | `python -c`, `perl -e/-E`, `node -e/--eval/-p`, `ruby -e` code naming an access change (`os.chmod`, `chownSync`, `sudo`, `authorized_keys` …) or a protected path (`.ssh`, sudoers, polkit, `/etc/passwd` …, `.synaps-cli/sandbox`, the jev config and state, `/systemd/`); a read is not told apart from a write |
| shell umask | `umask` in the call with a mode that leaves group or other write on (`umask 002`, `umask 000`, `umask g+w`, `umask $M`); `umask`, `umask -S`, `022`, `077` pass |
| sandbox (27b) | anything under `~/.synaps-cli/sandbox`, by the switch below |

The same targets are checked for the **write**, **edit** and **multi_edit**
tools (the new text is the content, `new_string` or the edit's text).

- **Spellings.** A target is checked as written (`..` folded), through
  realpath (a symlink, or `link/..`, which the kernel resolves after the
  link) and, when it holds a glob (`* ? [`) or a brace list (`{a,b}`; a
  `{1..3}` sequence counts as `*` from there on), against every path it
  matches now and every protected or gated base it could match.
- **Removing a holder.** `rm`/`rmdir`/`unlink`/`shred`, `mv` (its sources)
  and `rsync --delete`/`--remove-source-files` block on a directory that
  holds a protected dir, the sandbox or a systemd unit dir (`rm -rf
  ~/.synaps-cli`, `rm -rf ~/.config/systemd`), or that is a gated dir
  itself. `rsync -n`/`--dry-run` changes nothing, and an `rsync --exclude`
  keeps what it names (not with `--delete-excluded`), so the jev install's
  `rsync -a --delete --exclude=/config …` passes.
- **What a gated file sets now.** A change that alters or drops a line of
  a gated file that sets a gated key blocks even when the new text names no
  key: a value-only edit (`MemoryMax=1G` to `8G` through `edit`,
  `multi_edit` or `sed -i`), a truncating redirect, `cp`/`mv` over it, `mv`
  away or `rm` of it. Appending (`>>`, `tee -a`), `touch` and edits of other
  lines pass. The `edit` tool's `old_string` and a file's `multi_edit`
  edits (in order; exact anchors) are followed on the file's current text;
  an edit that cannot be followed there (a `line_prefix`/`line_regex`
  anchor) blocks on a file that sets a key. An unreadable gated file that
  exists counts as setting one.

- **Own area** (the only exception: files the agent made in its own
  worktree or scratch). A mode command passes only at the top level (not
  nested, not over ssh, not through `xargs` or `find -exec`, no `-L`/`-H`,
  no `setfacl --restore`), with literal targets (no variables, command
  substitution or `{}`; `$HOME` is resolved), each realpath (globs expanded)
  strictly below `/var/tmp/<dir>/` or `/tmp/<dir>/` (or a file, never a
  directory, right in `/var/tmp` or `/tmp`), strictly below a project's
  `tmp/<dir>/` (owner rule 16a's scratch, at least two levels below HOME)
  or a `.worktrees/<name>/`, or strictly below the session cwd when that
  cwd is at least three levels below HOME, and not a protected or gated
  path. A top-level `cd`/`pushd` to a literal directory that exists moves
  where later relative targets resolve (never the own-area bases); any
  other move (`popd`, `cd -`, `cd $X`, a `cd` in a subshell, a nested
  script or a pipeline) makes relative targets unknown, so they block.
  `chmod g-w ~/Projects ~/Projects/Praxis` blocks from any cwd. The guard
  cannot prove which scratch dir or worktree is this session's, so any of
  them counts (Master ruling, 10-20; JR asked for best effort). When every
  hit is such a mode command, the refusal adds how to name own files by
  literal path in a call of their own (checked again).
- **No change.** `mkdir -m` with a numeric mode that grants no group or
  other write and no special bit passes (mkdir never changes a directory
  that exists); so does `install -m` with such a mode and no `-o`/`-g` when
  each target is new or already has that mode. The read-only forms of
  `ssh-keygen` (`-l -F -B -y`), `ssh-add` (`-l -L`), `ufw status|show|app
  list`, `nft list`, `iptables -L/-S` and `firewall-cmd --list-*/--get-*/
  --query-*/--state` pass; `sed`/`perl` without `-i` only read.
- **systemd-run** (owner rule 27c(5)). Without `--scope` a systemd manager
  runs the job as a service, outside the session's process tree and its
  sandbox, so it asks; so does a scope with anything but `--user`,
  `--scope`, `-q`, `--same-dir`, `--collect`, `-E`/`--setenv` (an
  environment variable is no access item) and `-p`/`--property`
  `MemoryMax=`/`MemoryHigh=`/`MemorySwapMax=`: no `--user` or a
  `--system`; `--slice`, `--slice-inherit`, `--uid`, `--gid`,
  `-M`/`--machine`, `-H`/`--host`; `--unit`/`--description`; any other
  property or option; an option word the scan can't see (`$OPTS`, `-p
  "$P"`); a `-p` or `-E` value whose expansion can split into more words,
  and so into more options (unquoted `-p MemoryMax=$M`, a `$(…)` or
  backtick anywhere, `"$@"`, `"${M:-8G}"`). A plain `$NAME`, `${NAME}` or
  positional inside double quotes (`-p "MemoryMax=$M"`, `-p
  MemoryMax="${H}G"`) stays one word and gets no hit, as before. One hit
  per `systemd-run`, a fixed reason. Options are read as systemd-run reads
  them (an unambiguous long-option prefix, short clusters, options end at
  the first other word or `--`); `--help` and `--version` run nothing.
  This check only adds asks: the 27c(5) form gets no hit from it, as
  before, and whether its caps tighten stays the agent's duty. The command
  it runs is scanned like any other (`systemd-run --user --scope -p
  MemoryMax=1G -- chmod 777 ~/x` still asks for the chmod), and the
  scripts that command runs are read as after a rule-1 wrapper (`timeout`,
  `nohup` …): a shell's `-c` string, ssh's remote command, `eval`'s
  arguments, `su`/`runuser`/`script -c`, and the `env -S`, `flock -c` and
  `watch` strings, each as a nested script. So `systemd-run --user --scope
  -p MemoryMax=8G -- bash -c 'chmod -R g-w ~/Projects'` asks "inside a
  nested script", as `timeout 600 bash -c '…'` does. Only this scan reads
  them: the rule-1 scan still doesn't unwrap systemd-run. Not modelled:
  brace and glob expansion (`{…}`, `*`) where an option or a value can be.
- **27b sandbox switch.** `~/.synaps-cli/memory/jev/sandbox-mode` holds one
  word; exactly `auto` (whitespace ignored) is auto, anything else, missing
  or unreadable is **manual**. The file is protected: JR writes it from his
  own terminal. Manual passes only creating a NEW `sessions/<name>.conf`
  directly in `sessions/` (the write tool, or `cp`/`mv`/`install` onto a
  missing target); everything else under `sandbox/` blocks, adding "(27b:
  this can widen a sandbox; JR's yes)". Auto passes any create, edit,
  replace or delete strictly below `sessions/`, auditing a change to an
  existing file as rule `access_auto`; `sandbox/OFF` and the rest outside
  `sessions/` stay blocked.
- **Order and gate.** It runs first, before the rule-1 guard, the
  shell-safety rule and the model, and answers alone. No key, a spent
  budget, an open circuit, `/jev off` and `/jev guard off` leave it running;
  only `guard_access = off` stops it. `guard_access_scope` is `all` by
  default.
- **Fail closed.** A text over 256 KiB, a shape limit, a spent hook budget
  or an internal error blocks when the call's text or paths hold an access
  word (`chmod`, `sudo`, `systemd-run`, `.ssh/`, `/systemd/`, `.synaps-cli/sandbox`, …),
  and lets it go on otherwise.
- **Audit.** One row per block (or warn) with `rule: "access"`: kind, fixed
  token, fixed reason, line, descent flag, where and the session id; one
  row per 27b auto pass with `rule: "access_auto"`; never the command
  text. Block and auto rows name their `request`; block rows add `answer`
  (`new`, `deny_only`, `waiting`, `deny`, `unrecorded`, `error`). Counters
  `guard.access.{command,write,code,sandbox,block,warn,auto,stopped,
  stopped_clear,out_of_scope,allowed_once}`.
- **Allow once** (`extensions/jev/allow_once.py`; format agreed with Pria
  Desktop, 10-20). Each block writes a request record
  `~/.synaps-cli/memory/jev/access/requests/<id>.json` (dirs 0700, created
  without chmod, an existing non-private dir is refused; files 0600, temp +
  rename) holding the call (command, or files + change, at most 4 KiB),
  its hits, the refusal text and a fingerprint: sha256 of canonical JSON
  `{v, session, tool, cwd, tool_input}`, plus `subagent_id` for a
  builder's call. A builder's call (a worker's hook event: its lead's
  session id and its own `subagent_id`, `sa_N`) records that
  `subagent_id`, so the card names the builder; a session's own call has
  no such key, and its record and fingerprint are byte-equal to the format
  before the field. A `subagent_id` that isn't a plain short word is
  recorded as `unrecognized` and the call is Deny only. The refusal ends with "Request
  <id>". JR answers in Pria Desktop (Permission change); the app's native
  click alone writes `answers/<id>.json`, exactly `{v, id, fingerprint,
  decision: allow_once|deny, answered_at, by: "owner_ui"}`, at most 4 KiB.
  An allow passes the SAME caller's unchanged retry of that exact call
  (same session and builder, tool, input, cwd and hits) once: a lead can't
  spend its builder's Allow once, nor a builder its lead's or another
  builder's. It passes when the answer came within 24 h
  of the request and the retry within 30 min of the answer: the answer is
  renamed to `used/` (a failed rename = still blocked), the row is
  `rule: "access_allowed_once"`, and only the access rule is skipped (rule
  1, the shell-safety rule and the model still run). A retry before the
  answer reuses the request ("already waiting"); a deny keeps blocking
  ("JR said no"). A call holding a credential (its text, or its paths and
  change, are withheld), cut at 4 KiB, or not scanned to the end is Deny
  only, and so is every `shell_send` (it is typed into a live shell whose
  directory and state the fingerprint can't bind). No record is written
  with a credential anywhere in it: a last scan of the whole record drops
  the preview fields, and if one is still found the call blocks with
  "Request not recorded". A store that can't be
  written or read blocks with "Request not recorded". Auto passes write an
  FYI record (`kind: auto`, files only). Records over 7 days are pruned (at
  most hourly). Fixtures: `tests/fixtures/access-ask/`.
- **Allow once: limits.** The store sits under `~/.synaps-cli/memory/jev`,
  which the write rule protects, so a visible tool call can't write an
  answer; but a script run from a file isn't read, so an agent running as
  this user could forge one. For sandboxed sessions the sandbox rule 27c(3)
  refuses those paths as a second layer; unsandboxed sessions and
  subagents have only the guard. A builder is told apart only by the
  host's `subagent_id` (`sa_N`): if the host gave the same id to a later
  worker of the same session within the answer's 30 minutes, that worker
  could spend the Allow once.
- **Misses.** Variables and control flow are not evaluated; a script run
  from a file (`bash f.sh`, `python3 f.py`) is not read; other interpreters'
  code is not read; a target reached through a variable is not an own-area
  target, so it blocks (`chmod +x "$F"`). A gated key split across two
  `sed` expressions or two shell writes is not put back together. The jev
  plugin's code dir (`~/.synaps-cli/plugins/jev/` apart from `config`) is
  not protected: installs write it.

## Pria desktop relay (`transport`)

With `transport` = `relay` (or `auto` on a host where
`~/.local/state/pria-desktop` exists) every Jev call goes to the Pria
desktop app over `fleet.sock` in that dir, one JSON object per line: a
`hello` (the plugin reads `fleet.token` only to send it there, after
connecting; it is never logged or stored), then one `jev.decide` request
whose line is built by `json.dumps` of the parsed `state` and `questions`
(no caller JSON text is spliced in; a string `state` stays a JSON string)
plus the hook's `session_id`. The line must fit 65 536 bytes, checked before
sending. The reply is parsed, never compared as bytes. No local key is read,
validated or saved: `/jev key` refuses, `/jev status` shows the transport
and the last relay code.

Any failure means Jev is off for that call, exactly as with no key: no
retry, no key fallback, 3 s for the whole call. The guard continues
(`guard.relay_off`; its deterministic rules still run first), the hook
features count a `.skip`, `jev_verify` / `jev_evidence` / `jev_diagnose`
return their `relay_off` fallback, and `jev_decide` / `jev_select` return a
tool error. Codes: the app's (`not_signed_in`, `needs_sign_in`, `busy`,
`secret_in_state`, `invalid_request`, `unavailable`, `unauthorized`,
`line_too_long`, `bad_request`, `unknown_verb`, `not_available`, `internal`,
`restarting`) and local ones (`no_socket`, `no_token`, `no_relay` (the
welcome lists no `jev.decide`), `too_large`, `deadline`, `malformed`,
`closed`, `unknown_code`, `error`). After some codes the plugin does not
reconnect for a while: 60 s for `no_socket`, `no_relay`, `unknown_verb`,
`not_available`; 30 s for `unauthorized` and the sign-in codes; 10 s for
`restarting`; 2 s for `busy`; 5 s for `deadline`, `unavailable`, `internal`,
`closed`, `malformed` and `error` (so a down app does not cost every guarded
tool call the full 3 s). An unrecognised `transport` value means `auto` and
logs one fixed line. A code change is logged once (`relay: …`);
counters are `relay.<code>` and `relay.cached`. `direct` is the TypeSafe key
path, unchanged.

The app refuses a whole request (`secret_in_state`) when pria_redact's rules
find a credential in it, and ordinary text such as `"max_tokens": 4096` or
`--auth x` is one. So every request is redacted first, on both transports
(relay and direct), by one redactor: `relay_redact` mirrors those rules
(pria-apps `crates/pria-redact/src/lib.rs`) and replaces each matched value
with exactly `<redacted>` (`<redacted private key>` for a PEM block), which
the app takes as no finding. The guard's state (and its audit row) goes
through `redact_state`; every other op (router, triage, discovery, reports,
compress, context, `jev_decide`, `jev_select`, `jev_verify`, `jev_evidence`,
`jev_diagnose`) through `redact_request`: every state string and key, and the
caller's questions for `jev_decide` / `jev_select`. A value the rules still
find in the JSON body (`"max_tokens":4096`) is sent as `"<redacted>"`. The
ops' own question keys and templates are fixed and clean (opaque keys such as
`q0`, `h0`); a caller question key with a finding is sent as `q<n>` and
answered under the caller's key. What cannot be made clean (a finding in a
criteria key, a candidate ID or any other key) is Jev-off for that call, as
with no key: nothing is sent, no retry, `<op>.skip` and `<op>.unclean` are
counted and `unclean` explained; `jev_decide` / `jev_select` return a tool
error, `jev_verify` / `jev_evidence` / `jev_diagnose` their `unclean`
fallback. Text is redacted before it is cut (guard previews, the context
report's texts): a cut never lands inside a placeholder and never leaves a
credential fragment too short for a rule. Only the limit plus 4096
characters are read; where the text runs on inside a run of non-space
characters, the read goes on to that run's end (at most 16 KiB more), else
back to the last space, and a read window that is all one run is sent as
`<redacted>`. One read budget per guard call, `GUARD_READ_CHARS` (1792 K
characters), bounds the redaction: every pass is charged what it scans
before it scans, the decoded text and each escaped view it builds (an emoji
is 12 characters in the ASCII view, a CJK or control character 6), and so is
every body check. The previews (a `multi_edit`'s 128 anchors and texts, a
`send_events` call's bodies) read from a `PREVIEW_READ_CHARS` share of it
(1280 K), the state (paths, aliases, realpaths, cwd, the previews again, the
body checks) from the rest. Past it a preview or a state string is
`<redacted>`; where the body checks have no room, every state string is,
and a state left all placeholders is not sent: no model call, the call
continues on its deterministic rules as for a state too large for the
relay (`guard.state_wiped_skip`). An
ordinary 64-edit `multi_edit` with 6000-character ASCII anchors and texts
keeps all its previews. Measured on a 32-core host at load ~3.5, calls that
spend the whole budget (64 emoji, CJK or control-character edits, 32 such
bodies, emoji previews with 64 dense 4 KiB paths) took 0.19–0.45 s; a
slower host takes proportionally longer, and the hook budget still bounds
it. A
cut with a notice after it (the context report's) is cut back until text
plus notice is clean in the decoded text and both escaped views. Beyond the
app's rules, plugin-only rules redact (with the
same `<redacted>`) hyphenated key names (`api-key:`, `access-key=`,
`private-key=`, any case) and a name's value on the next line: after
`token:` or `PASSWORD=` (the names of the assignment rule, suffixed and
compound ones too) and a line break (`\n`, `\r`, VT, FF, NEL, U+2028 or
U+2029, blank lines included), the first value of the next line, indented
by spaces, tabs, NBSP or other Unicode spaces. The key line may end in a
block-scalar indicator (`|`, `>-`), a comment or a `\` continuation; up to
three comment lines and a list marker (`- `) may come before the value:
a quoted value is redacted to its closing quote (or the end of its line);
an
unquoted value ends at the next whitespace, whatever its length or
character classes. Only code-shaped values stay: a YAML key (`name:`,
`"name":`); a call (an identifier, dotted or with `::` or `->`, with at most
two digit runs, or `$`, directly followed by `(`, with no `)` then a word
character after it); or one of these words, alone or before one `;`: `if
elif else fi then case esac for while do done def return raise pass assert
yield async await print echo rm cd sudo export local unset exit import from
class try with let const var fn function pub use impl match curl wget git
ssh cat scp rsync nc`. So `if
token:` then `return compute(x)` below stays, and `token:` then any other
word below is redacted. Not covered: list items after the first, block-scalar
lines after the first, a value after more than three comment lines, the
words after the first space or tab in an unquoted value (`correct horse
battery`: only `correct`), a secret that is itself code-shaped (`print`, `name:`,
`f00(bar`), and names outside the assignment rule (`auth:`, `pwd:`). When a
caller's whole state or context is replaced by `<redacted>`, the
`jev_decide` result has `state_redacted: true` and the `jev_select` result
`context_redacted: true`.
In `jev` mode compress skips an output over 128 KiB before redacting it
(`compress.skip`, explained like any non-candidate). The guard redacts inside its hook
budget (a slow redaction is `hook budget spent`, an evaluation failure after
the deterministic rules passed: it confirms under `guard_confirm = prompt` and
continues under `auto`), and the JWT rule
runs as a linear rewrite (Python's backtracking made the verbatim one
quadratic). The deterministic rules still read the raw input. Above 50 guard asks in a session's last 60 s (the app answers 60) the
guard asks nothing and continues on those rules (`guard.sampled_out`), so
`busy` and its 2 s hold stay rare.

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
or abstaining. The command and user goal are not included; the output is
redacted by `relay_redact` (the Pria app's rules, both transports; see relay
mode). Redaction is best-effort, not a guarantee against every secret format. Triage writes no
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
Router sparsity/cache changes in 0.3.1 now have a pinned synthetic live smoke
(see below), measuring Jev overhead only, not net savings. Existing user model
mapping remains required; compaction integration is deferred.

**No host/core policy changes:** the new decision policy stays plugin-only.
An independent host runtime fix is needed for an `after_tool_call` `Replace` to
override old streamed text; otherwise opt-in compression may not reach the model.
The protocol smoke does not establish that this host fix is installed or active.

Transport deadlines include the existing single rate-limit retry within a maximum
four-second budget (below the host's five seconds). A scoped POSIX main-thread
timer bounds blocking DNS/response reads as well as socket operations; unavailable
or already-owned timers fail without making a request. This process extension's
supported execution path is the POSIX main-thread stdio loop.

## Experimental discovery recommendations (0.3)

Underlying `search_tools` and `search_skills` discovery is **pure local**. The
`discovery` experiment defaults to **false** and is **not recommended as a
savings technique yet**. `/jev discovery on|off [--save]`
controls it independently of guard; without `--save` the override is session-only.
`/jev on` enables **all ten** features, including this opt-in API cost/privacy
contract (and compression); `/jev off` disables them. Explicit Jev tools remain
available, including their no-key setup guidance.

**Privacy and cost opt-in:** when enabled with a key, eligible discovery sends
only the substring query and bounded candidate names/summaries/descriptions/tags
to Jev. Recognizable credential patterns are redacted by `relay_redact`;
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
ID. Confidence 0.8 does **not certify truth**: the gate can recommend a
mistaken result, but grants no permissions and causes no activation. All
validation, privacy and scope boundaries remain unchanged. The original machine-readable JSON and every descriptor remain intact;
only bounded `jev_advisory` metadata is added, with `recommended_id`,
`advisory: true`, and a **not activation/permission** note. No filtering,
reranking, activation, permission change or automatic follow-up occurs.
Errors and abstentions return exact Continue, without rewriting output.

A process-local LRU of 128 entries caches recommendations and valid
abstentions (including confidence below 0.8), keyed by a digest of session, query, runtime tool, entire original
output and client model. No session means no cache. Cache values are opaque
options, never raw catalogs; metadata is reapplied to the current original
payload. Valid low-confidence answers are cached as abstentions, not advice.
Malformed/unknown/nonfinite answers (including invalid probabilities) and errors
are not cached and may be retried. Discovery
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
Supplied live results are recorded below; no live requests were made while
implementing this revision.

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
and were not used to tune it.

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

Supplied held-out live measurement at **0.8** (`jev-1.13.0`), retained as
[`reports/discovery-heldout-live.json`](reports/discovery-heldout-live.json):
**8 calls**, **4,421 input tokens**, estimated **$0.000185682**, **375 ms** mean
API latency. One correct recommendation / eight eligible cases (**12.5% coverage**),
zero wrong confident results, and seven abstentions: two expected, five missed
recommendations under the weak labels. All evidence was preserved; the cached
PDF repeat added zero calls/tokens/cost. Reversed PDF abstained even with the
correct candidate first, unlike the original PDF case. This flags order
sensitivity (not a controlled causal finding); limited keyword intent and tiny
synthetic samples preclude improved-accuracy or net-savings claims. The repeat
measures recommendation caching, not the new low-confidence regression.

### Plugin-only follow-up priorities (not implemented)

1. Prefer richer, **user-authorized task-aware batch selection** through
   `jev_select` over the keyword-only hook. Evidence needed: matched no-hint and
   foreground baselines, held-out task outcomes, order permutations, coverage,
   wrong selections, and end-to-end cost/latency including retries.
2. Evaluate **opt-in worker-tier maps** using only already authorized model IDs;
   preserve explicit choices and inheritance. Evidence needed: a matched
   inherited-model quality/cost baseline, task success and rework rates, total
   tokens/latency/cost, and fallback behavior before recommending cheaper tiers.

These are evaluation priorities, not new tools, automatic routing authority, or
proven savings. The six registered tools are `jev_decide`, `jev_select`,
`jev_status`, `jev_verify`, `jev_evidence`, and `jev_diagnose`.

## Sparse worker routing (0.3.1)

The existing `/jev router on|off [--save]` toggle controls routing. Each request
asks only about absent keys: role, read-only suitability, and (only with an
existing user tier map) model tier. Explicit values are never repaired or
replaced, including null/empty/invalid values; invalid explicit inputs continue
to host validation without an API call. Unknown/frontier tiers inherit. A model
fill is exactly the configured provider/model ID, never a new authorization.
Only `read_only` can be inferred; paths and broader write access are never added.

A per-extension 128-entry LRU caches validated fills and abstentions by session,
full canonical input, tool, decision model, thresholds, map, and question set.
No session means no cache; malformed answers and transport errors are not cached.
Valid sibling decisions can still fill when another answer is malformed.
Task and optional system prompt must each fit both character and UTF-8 byte
limits (4000 and 600); oversized text is skipped, never truncated. Full canonical
input is capped at 32 KiB locally. Only bounded task/system prompt go outbound,
redacted by `relay_redact`; unknown fields and saved conversation goals do
not. Redaction is best-effort: routing still shares task text with Jev and incurs
API cost on misses. Router logs/audit contain no task, fills, models, answers or
exceptions; status exposes counters and existing per-operation cost accounting.
Task-bearing router logging is deprecated; older audit files are not rewritten
by this release and may still contain previously logged task data. Discovery remains off by
default. No changes to worker calls, activation, scopes or host authorization.

Offline benchmark seams: `Router.handle(params, client, cfg, audit, log)` uses
`client.decide(state, questions, op="router")`; production transport can be stubbed
at `DecisionClient._post` (see protocol tests). `questions(input, cfg)` exposes
sparse request construction and `plan_fill` remains a pure compatibility seam.
Use one Router per extension and repeated session IDs to measure cache behavior;
the pinned live comparison below uses the frozen baseline at `f3a6d07`.

### Pinned synthetic live evidence

The supplied `jev-1.13.0` live run covers seven fixed synthetic cases, including
two repeats. [Evidence and methodology](scripts/router-benchmark/README.md)
include the original JSON reports; no worker was launched.

| Jev overhead on this workload | Old | New |
|---|---:|---:|
| Calls / questions | 6 / 12 | 4 / 5 |
| Returned input tokens | 2,972 | 1,730 |
| Estimated input-token cost | $0.000124824 | $0.00007266 |
| Summed transport latency | 2,290.87 ms | 1,514.51 ms |

This is a **41.8% reduction in Jev input tokens and estimated Jev cost only**.
Unique cases used 1,981 → 1,730 tokens (251 saved); the two repeats avoided
991 tokens and two calls. The both-fields-missing case grew from 497 to 548
tokens with the safety prompt. Unique-case summed transport latency was
**33.67 ms slower**, so this is not evidence of a universal speedup.

The old arm matched all seven expected fill sets; the new arm had five correct
and two abstentions (the same docs case and its repeat), with no incorrect
positive fills. Existing explicit/configured inputs were preserved; no worker
models were set. The separate guard-off protocol smoke passed sparse-question,
free repeat-cache, and router-disable bypass checks: one call, 484 input tokens,
~$0.000020328 at the stated rate, and 363 ms mean transport latency (its JSON
cost counter is rounded to $0.00002).

These measurements exclude worker/frontier costs and downstream task quality;
they establish neither cheaper worker execution nor net money savings. The
historical routing checkpoint reported 84 offline tests, followed by a
foreman-supplied 105-test checkpoint; these are historical counts, not the
current full-suite total. No live measurements were rerun for the 0.8.0 release.

## Explicit verification priority (0.4.0)

All six tools (`jev_decide`, `jev_select`, `jev_status`, `jev_verify`, `jev_evidence`, `jev_diagnose`) are always
advertised. `/jev verification on|off [--save]` controls optional verification
advice, **default off**, independently of guard. `/jev off` and `/jev on` toggle
**all ten features**, including discovery, verification, evidence, reports, diagnosis and context (and their opt-in API
calls); they do not hide tools. Use the same `/jev key <apikey_…>` setup as above.

Call `jev_verify` with this public synthetic input (optional advice requires
`/jev verification on`; the default-off call instead returns optionals for review):

```json
{
  "task": "Fix parser whitespace",
  "changes": ["Trim edge whitespace while preserving whitespace inside tokens."],
  "checks": [
    {"id": "parser-unit", "description": "Mandatory parser unit checks", "required": true},
    {"id": "parser-edge", "description": "Leading/trailing whitespace and empty-input edge cases", "required": false},
    {"id": "http", "description": "HTTP transport behavior unrelated to parser whitespace", "required": false}
  ]
}
```

| Result group | Meaning |
|---|---|
| `required_ids` | Caller-required list, preserved in input order without AI classification. |
| `recommended_optional_ids` | Confident priority advice: consider these optional checks earlier. |
| `lower_priority_optional_ids` | Confident lower priority, **not permission to skip**. |
| `review_optional_ids` | Unknown, low-confidence, malformed, unavailable or disabled advice; caller review needed. |

This does not force a full-suite waiver, preserves the caller-required list but
can't discover missing mandates. Honor project/user/CI requirements outside this
input too: structural preservation is **not proof that all required checks were
included**. No result group certifies coverage or execution.

`jev_verify` accepts only `{task, changes, checks}`:
- `task`: nonblank string, at most 4000 characters **and UTF-8 bytes**.
- `changes`: 1–16 nonblank strings, each at most 500 characters/bytes.
- `checks`: 1–32 `{id, description, required}` objects, no extra fields.
  IDs are globally unique, 1–80 ASCII letters/digits or `._:/-`; descriptions are
  nonblank, at most 500 characters/bytes; `required` must be a JSON boolean.
- No extra top-level fields; full serialized input at most 24 KiB.

Caller-required checks are immutable caller policy: their IDs are always returned
in input order and their descriptors are never sent for AI decisions. **Caller
flags are not host-authoritative and are not an exhaustive mandatory-check list.
Honor all project/user/CI mandatory checks regardless of supplied candidates.**
The tool provides priority advice, never skip authority, test execution, coverage
certification, commands, or activation. **deferred != safe to skip**.

Optional checks get one `prioritize`/`defer`/`unknown` question each in one batch;
confidence ≥0.8 is needed for recommendations or lower priority. Each optional ID
appears exactly once in `recommended_optional_ids`, `lower_priority_optional_ids`,
or `review_optional_ids`, in input order within groups. Missing/malformed/uncertain
answers review only the affected candidate; global/transport failures review all.
No key or disabled advice validates input first, preserves `required_ids`, and
reviews all optionals with `/jev key` or `/jev verification on` guidance.
Required-only requests are free even when enabled.

The JSON content also includes `advisory:true`, `executed:false`,
`coverage_certified:false`, optional `decisions` (local priority and status or
fallback reason), a global fallback reason when appropriate, and a constant safety
note. Output is local and ≤16 KiB; no model prose is returned. Invalid input produces
a static tool error. Inputs are not mutated. State text is best-effort redacted
by `relay_redact` without truncating expanded text; do not supply secrets.
If serialized redacted state exceeds 32 KiB (UTF-8), all optionals receive review
with `redacted_state_too_large`, no API call, and required IDs intact. Counters are
`verification.call/questions/skip/recommend/defer/review/error`; estimated API
accounting uses Stats operation `verification`. No content, IDs, answers, or
exceptions are written to verification audit records.

No cache: host `hosttool.call` (`process.rs`) sends only tool name/input, not
trusted session identity.
No model-supplied session ID is accepted or inferred from hooks. This tool reads no
files/diffs, runs no shell commands, and never fires automatically from hooks.

### Synthetic verification benchmark

[`scripts/benchmark_verification.py`](scripts/benchmark_verification.py) defaults to
an offline structural report: no key discovery, client, or network; Jev measurements
are `null`. Run `python3 jev-plugin/scripts/benchmark_verification.py` from the repo
root. Explicit `--live --model jev-1.13.0` uses existing key discovery for four fixed
public cases, one batch each, maximum four wire calls with retries disabled and a
3-second deadline per call. No fixture check or real tool is executed.

Weak, explicit fixture priorities compare first-optional input order against Jev's
optional partition, reporting recall, false priorities and review separately.
Required preservation is a structural invariant, **not** evidence all mandatory
checks were enumerated; the injection case is not a safety proof. No-hint overhead
is defined as zero, not measured. Reports include actual input usage (unknown usage
and cost stay `null`), estimated input cost, network/hook latency and p50/p95, and
output bytes. This is neither a frontier baseline nor evidence of fewer tests,
reasoning turns, end-to-end savings, or net money saved. Offline regression tests:
`python3 -m unittest discover -s jev-plugin/tests -p 'test_*.py'` (sequential).

### Supplied live verification evidence

Public synthetic reports are retained in readable JSON with a
[concise evidence report](scripts/verification-benchmark/README.md). These are
supplied measurements, not live calls rerun during documentation finalization.

| Measurement | Result |
|---|---|
| Cases / optional decisions / API calls | 4 / 12 / 4 |
| Input tokens / estimated Jev input cost | 2,777 / $0.000116634 |
| Network p50 / p95 | 382.09 / 416.07 ms |
| Correct / false priorities (weak labels) | 4 / 0; all 4 weak-labelled relevant checks found |
| Review / lower priority | 8 / 0; 5 expected unknowns plus 3 not confidently deferred |
| Caller-required preservation | All 4 cases and all 12 free variants |

Preservation is structural, **not proof of coverage or that all required checks
were included**. No actual checks or workers were launched. The first-optional
comparator does not establish tests avoided, test-cost reduction, whole-bill
savings, or end-to-end task quality.

The separate supplied protocol smoke reports **4 registered tools**, default-disabled
verification free, required-only free, and toggle-off free; guard-off independence
and session-only toggles with **no configuration writes**. Its one verification
API call used **690 input tokens**, estimated **$0.00002898**, mean **393 ms**.
The JSON's cost counter rounds this to `$0.000029`; the precise estimate uses
690 × $0.042 / 1,000,000. Discovery and verification remain **off by default**.

## Explicit evidence relevance (0.5.0)

`jev_evidence` was introduced as the fifth tool in 0.5.0 (six tools now). `/jev evidence on|off [--save]` controls its
optional API advice, **off by default**, independently of guard. `/jev on` and
`/jev off` include evidence. No key/off returns all optionals for review with
setup guidance, without key discovery or file access. All-required requests are
free. There is no cache, session argument, automatic hook, or source access.

```json
{"task":"Understand parser edge cases","candidates":[
  {"id":"policy","kind":"document","source":"caller-supplied policy label","summary":"Mandatory parser requirements","required":true},
  {"id":"parser-test","kind":"file","source":"tests/parser.py","summary":"Parser boundary tests","required":false}
]}
```

Input is exactly `task` (nonblank, <=4000 characters and UTF-8 bytes) and
`candidates` (1–32). Each candidate has exactly `id` (unique, nonblank, <=160),
`kind` (`file|document|memory|other`), `source` (nonblank, <=300), `summary`
(nonblank, <=800), and a strict boolean `required`. String limits apply to both
characters and UTF-8 bytes; invalid Unicode is rejected. IDs/sources prohibit
ASCII controls; task/summary permit only LF/CR/TAB among C0 controls. No extras.
Serialized input is <=32 KiB. Before any API, a conservative worst-case local
response is constructed and measured against **64 KiB**, including JSON escaping;
unrepresentable inputs are statically rejected, never metadata-truncated.

Output has `advisory:true`, `fetched:false`, `trust_certified:false`, input-order
`required_ids`, and optional partitions `inspect_first_ids`, `review_ids`,
`later_ids`. Every optional occurs exactly once. `ordered_ids` concatenates
required, inspect-first, review, later, preserving input order inside each group.
`references` preserves every supplied ID, kind, source and required flag exactly,
with a local priority. Summaries are not echoed. Source labels remain unverified.

Only completely redacted task and optional `{kind,summary}` descriptors reach
Jev, under opaque question tokens; required descriptors and raw ID/source fields
are excluded. Redaction never clips constraints. A redacted state exceeding
40 KiB returns all-review without an API call. One choice per optional uses
`inspect_first|later|unknown`; only valid finite confidence >=0.8 accepts a
priority. Malformed siblings review individually; global/transport failures
review all. Model prose is never returned.

**Relevance is not truth or source authority. Lower priority is not discard
permission.** Caller-required evidence is not exhaustive; all host/user/project
mandatory instructions still apply. This is not fetch authorization: honor the
original tool scope, provenance and freshness. No fetch/read/delete, tool
activation or automation occurs. Counters are
`evidence.call/questions/skip/inspect_first/later/review/error`; Stats uses operation
`evidence`. No evidence payload audit records.

### Synthetic evidence benchmark

[Supplied live evidence and sanitized results](scripts/evidence-benchmark/README.md)
document four batches / twelve optional questions with pinned and returned
`jev-1.13.0`: 2,872 input tokens, estimated $0.000120624 at $0.042/M input tokens,
390.17 ms median hook latency. Weak-label inspect-first recall was 3/5 (60%) and
precision 3/3 (100%); 8/12 remained review and only 4/12 were decisive. Missed
parser-edge and keyboard priorities, tiny synthetic labels and a deliberately
weak first-optional comparator limit this to advisory evidence, not savings or
truth certification. Default-off and the >=0.8 gate are unchanged.

[`scripts/benchmark_evidence.py`](scripts/benchmark_evidence.py) runs offline by
default: no key discovery, client construction or network; live measurements are
`null`. Run `python3 -B jev-plugin/scripts/benchmark_evidence.py` from the repo root.
It uses production `evidence.call_evidence`, four fixed public synthetic cases
(parser whitespace, contradictory auth descriptors, keyboard/injection, vague),
and twelve optional relevance questions. Every case also exercises all-required,
off and no-key variants at zero API cost. No source contents are read or fetched.

For a separately authorized live run, append `--live --model jev-1.13.0` (the pinned
default and only accepted model). This explicitly discovers a configured key;
production `DecisionClient.decide` and deadlines remain in use, with at most four
wire attempts, no retries. The supplied live run is documented above; it was not
rerun for documentation. `fixtures()` returns the
exact reusable API fixtures: foreman protocol runs should submit each `data` to
`jev_evidence` with evidence enabled, retaining `expected` locally, never sending
labels. Sources/IDs are synthetic path, `mem-FAKE` and `example.invalid` labels,
not repository observations or source-authority claims. Auth docs and contradicting
historic memory are both relevant; current truth remains unresolved.

Reports compare first-optional input order (a cheap descriptor starting order,
not a frontier baseline) against required/inspect-first/review/later bucket order.
Optional recall, precision, wrong inspect-first priorities, non-review coverage
and unknown counts are separate from exact required/reference preservation.
Weak fixed labels do not tune the unchanged >=0.8 gate; unknowns are not successes.
Live reports include actual input usage and estimated Jev cost (missing usage is
`null`), hook/network total/p50/p95 milliseconds and total serialized output
bytes. Model metadata is allowlisted; arbitrary upstream text is not printed.
No cache results: session context is unknown. **No savings claim**: main-model
tool-turn cost and downstream output growth costs are not measured. Output bytes
are total response size, not incremental bytes, incremental cost or saved work.
The benchmark writes no large artifact itself; the supplied public synthetic
report is retained at the link above. Offline tests:

```bash
python3 -B -m unittest discover -s jev-plugin/tests -p 'test_benchmark_evidence.py' -v
```


## Automatic worker-report triage (0.6.0)

Opt in with `/jev reports on|off [--save]` (default **off**, independent of guard).
`/jev on` and `/jev off` include reports; all **six** tools remain
advertised. There is no new tool or host change. Status exposes
`reports.call/questions/cache/skip/advice/abstain/error` and actual `reports`
operation cost, tokens and latency. The [supplied synthetic live report](scripts/reports-benchmark/README.md)
records limited flag-quality measurements, not end-to-end savings.

Only exact runtime `subagent_collect` results qualify (runtime name takes
precedence over display name). Running, expired, malformed, oversized,
truncation-marked or already-annotated reports pass through unchanged, as do
all reports when disabled or without a client. Valid failed/timed-out/cancelled
terminal results receive only a fixed local worker-status flag, with **no API
call**, even when the worker prose claims success.

Completed nonblank reports send **redacted full worker prose**, not artifacts,
tool input, foreground goals, model labels, authorization or terminal diagnostics.
This opt-in disclosure has API cost; pattern redaction is not a guarantee that
arbitrary sensitive prose is removed. One batch asks two bounded choice
questions about reported verification gaps and concerns. Claims that checks ran
are **not verification** that they did. Confident positive flags alone add a
`jev_advisory` JSON field; no flags means no replacement. Model prose and
confidence are never presented as authority. The local note denies success
certification, skip authorization, execution, retry/merge/collect/reconcile
permission. Existing lifecycle behavior and caller reconciliation stay untouched.

The original report stays complete and all original JSON values/metadata survive
annotation; formatting may change (no byte-perfect promise). Bounds are 32 KiB
raw JSON and 8 KiB report in both characters and UTF-8 bytes, with 64 KiB maximum
serialized replacement. No clipping. Duplicate keys, nonfinite values, invalid
Unicode, ambiguous inputs and explicit truncation are rejected conservatively.
The session-local LRU holds at most 128 digests and flag sets/abstentions, never
report text or handles. Cache scope includes a valid trusted session ID, exact
raw payload, handle and client model; activation clears it. Invalid sessions
bypass caching, global errors are not cached. No report payload or upstream
exception is written to audit logs. This is advisory claim triage, not independent
inspection of repository state or proof of worker success.

### Synthetic reports benchmark

[`scripts/benchmark_reports.py`](scripts/benchmark_reports.py) exercises production
`Reports.handle` with four fixed public synthetic collect envelopes; `fixtures()`
is reusable. Run `python3 -B jev-plugin/scripts/benchmark_reports.py` for the
no-key-discovery offline report (live measurements are `null`). It writes only
stdout. Off/no-key/running/malformed and terminal-status variants are free.
Explicit `--live` discovers a key and permits at most four attempts / eight
questions, pinned to `jev-1.13.0`, with no retries. Same-session/raw cache repeats
include abstentions; initial errors are not repeated. Only worker prose reaches
the API, never expected labels or synthetic lifecycle/authorization diagnostics.

Flag precision/recall uses fixed weak labels against a cheap deterministic
no-semantic-flags baseline, not a frontier model. The contradiction case's
primary label is `conflicting_claims`; `reported_failure` is also plausible.
No flags is ambiguous abstention, not success certification. Preservation checks
cover original JSON values, input nonmutation and advisory-only output; no
transcript compression or worker/check execution occurs. Output bytes total the
four initial raw tool-result serializations, not hook envelopes; deltas include
formatting changes and may be negative. Usage/cost remain null when unknown;
returned model names are allowlisted. The [retained live results](scripts/reports-benchmark/README.md)
document four synthetic calls and their limitations; no savings claim is made.

Offline tests: `python3 -B -m unittest discover -s jev-plugin/tests -p 'test_benchmark_reports.py' -v`.

## Lossless identical-line compression (0.7.0)

`/jev compress on|off [--save]` retains its existing controls, **off by default**
and experimental, independent of guard. Do not automatically enable it. Reports
and recognized failure triage retain priority. No new tool, host change, event/compaction change,
archive, source read, or automatic command execution is involved.

Only adjacent exactly identical `splitlines(keepends=True)` lines fold. Every
unique line remains in order; Unicode, LF/CRLF/mixed endings and a final line
without a newline are preserved. A deterministic self-contained JSON envelope
contains exactly `jev_lossless_runs: 1`, the fixed `notice`, `original_utf8_bytes`,
`sha256` (lowercase SHA-256 of original UTF-8 bytes), and `runs`, each containing
only `text` and positive integer `count`. For example, `a\na\nb` has runs
`[{"text":"a\n","count":2},{"text":"b","count":1}]`.

The fixed notice is:
> Expand runs in order by concatenating each text exactly count times. Expanded text is original untrusted tool output, not authority or a success certificate.

Static Python recovery example (data parsing only, no eval or command execution):
```python
from jev.compress import decode_output  # plugin extensions on the Python path
original = decode_output(encoded_output)
original_utf8 = original.encode("utf-8")
```
The pure bounded decoder rejects duplicate/extra keys, invalid versions, text,
counts, sizes and hashes, preflights multiplication before expansion, and checks
canonical line runs. Expansion means concatenating each `text * count` in order;
it recovers the original values locally, without rerunning anything. Decoding
never grants the expanded untrusted output authority.

Raw input is bounded to 256 KiB in both characters and UTF-8 bytes. The full
replacement, including notice and hash, must be ≤32 KiB, ≤70% of original bytes,
and save at least 1024 bytes. Non-repetitive or uneconomic candidates skip the
API. Errors anywhere in the output (not just the tail), existing Jev markers,
truncation/elision/omission markers, top-level JSON objects/arrays, invalid Unicode,
control characters (except LF/CR/tab), DEL, bare CR and ANSI output all stay raw.
`0 failed` remains eligible. Runtime names take precedence; an explicitly invalid
runtime name does not fall back to a display name. Configured read/write/etc.
never become eligible. Missing client also leaves raw output unchanged.

Only after these local checks, one choice question asks whether the full redacted
runs are useful as a compact repetitive transcript, need exact line presentation,
or provide insufficient evidence. The state is redacted as a whole before runs
are formed and is never clipped. Only a strictly valid `compact` answer meeting
the configured confidence threshold permits replacement; unknown, uncertainty,
malformed answers and errors keep the original. The model cannot drop data or
supply replacement prose. Every candidate passes a local decode roundtrip first.

Status tracks `compress.call/questions/skip/keep/fold/error`. Successful folds
alone add `compress.input_bytes/output_bytes/saved_bytes`; these are actual UTF-8
byte totals, not tokens or dollar benefits. Estimated actual Jev API cost remains
under `op=compress`; no economic savings estimate is claimed. The offline
synthetic benchmark below measures payload bytes, not end-to-end savings.
Compression audit records contain local numeric byte counts only, never output,
model responses, commands or goals; logs contain fixed text/numeric counts only.

### Synthetic lossless compression benchmark

[`scripts/benchmark_compress.py`](scripts/benchmark_compress.py) reuses production
`compress.handle`, encoder and strict decoder. Run offline (stdlib only):

```bash
python3 -B jev-plugin/scripts/benchmark_compress.py
python3 -B -m unittest discover -s jev-plugin/tests -p 'test_benchmark_compress.py' -v
```

The script prints metadata-only JSON and writes no files. Its public `fixtures()`
API returns four fresh synthetic bash envelopes: 2,000 progress lines, 1,000
status lines, repeated blocks with a unique middle observation and Unicode final
line without newline, and CRLF/Unicode runs with a unique middle observation.
All are 6–64 KiB and meet production's pre-API gate (at least 1 KiB reduction and
encoded size at most 70% of original). No fixture commands or workers execute.
Every fold must decode to the original UTF-8 bytes; every keep is unchanged.

Baselines are raw/no fold and a **forced compact readability decision** passed
through the same production safety/profit checks, not a separate encoder or API
call. Deterministic RLE may be sufficient: Jev adds a readability veto, not unique
savings or demonstrated accuracy. `expected=None` deliberately avoids treating
fixed readability preferences as ground truth. Free small, nonrepetitive,
failure-at-beginning/middle/tail, JSON, truncated, existing-envelope,
missing-client and wrong-tool variants must make zero decisions; extension
feature-off dispatch is also tested.

Default execution discovers no key, constructs no API client and performs no
network I/O; `jev` and offline hook latencies are `null`. An explicit `--live`
opt-in uses production `DecisionClient.decide`, bounded deadline and transport,
pinned to `jev-1.13.0`: four eligible cases, one question each, at most four wire
attempts, no retries, cache or repeats even after errors. The supplied
[negative live result and separate diagnostic](scripts/compress-benchmark/README.md)
are retained without additional live calls or benchmark reruns. Returned model
metadata is allowlisted; missing usage remains `null`. Usage is recorded separately without altering the response passed to
production validation: its current strict schema accepts standard token fields
but conservatively keeps output on extra usage fields or malformed answers.
Broader API metadata compatibility is not established by these offline mocks.

Reports include actual fold/keep counts, raw and transmitted-output UTF-8 bytes,
and signed delta (output minus raw). These are payload bytes **within the
host/downstream boundary**, not end-to-end traffic, token or dollar savings.
Estimated Jev input-token cost is separate, and unknown when usage is absent.
Live hook and network medians/p95 use linear interpolation at `(n-1)*p`; four
samples are descriptive, not a latency SLA. No upstream exception text, fixture
bodies or tool-input traces are printed.

The supplied four-case run kept all 100,984 bytes (four calls, zero folds), while
forced local compact reduced the same payload to 1,736 bytes without an API.
There is no evidence Jev did better here: it added latency and estimated cost
without byte reduction. **Do not make a Jev call when deterministic processing
suffices.** This result does not enable a new mode or request new configuration;
the current opt-in mode remains experimental and off by default. Downstream host
handling may truncate output, so exact local reconstruction is not an end-to-end
savings or delivery guarantee. See the linked report for the separate low-confidence
diagnostic; its cause cannot be assigned to the four uncaptured responses.

### Optional session budgets and circuit breaker

Budget enforcement is **off by default**. Configure it without restarting:

```text
/jev budget                          # settings, aggregate, unscoped + overflow usage
/jev budget on|off [--save]
/jev budget calls N [--save]          # default 100 wire attempts, including retries
/jev budget cost USD [--save]         # default .02 estimated input-token cost
/jev budget latency MS [--save]       # default 30000 cumulative API batch wall time
/jev budget errors N [--save]         # default 3 consecutive failed attempts
/jev budget cooldown SECONDS [--save] # default 60 monotonic seconds
/jev budget reset                    # explicitly clear optional session ledgers
```

Settings are session-only unless saved through the existing host configuration
helper. Settings, key changes and client reactivation never reset budget usage;
`reset` does not reset accounting, disable guard, or flush advice caches. Local
operations and cache hits need no API reservation and still work at the limit.

Optional API operations share a ledger per trusted hook `session_id` (nonblank,
control-free, at most 256 characters), stored only as a digest. Explicit tools
and commands have no trusted session context: they share **one unscoped ledger**,
ignoring any model-supplied session ID. Status aggregates ledgers without exposing
IDs. At most 128 ledgers exist, including unscoped and a shared overflow ledger;
new sessions at capacity share overflow rather than evicting old usage and
receiving fresh budgets. Missing/invalid hook context also uses unscoped.

Calls are reserved before every wire attempt, including retries. Remaining
cumulative latency limits the request deadline and retry delay; latency includes
retry waits. These are **not a wall-time SLA or a strict dollar cap**: estimated
cost uses reported input tokens only, and one in-flight request can overshoot the
cost threshold. Missing or malformed usage, including a failed retry attempt,
is unknown—not free—and stops subsequent optional calls while budgets are on.
The circuit blocks after the configured failure streak until monotonic cooldown,
then permits one half-open attempt; success clears the streak. Unknown usage is
an independent stop even after cooldown, requiring explicit reset (or disabling
optional enforcement). Denials use fixed reasons: `budget_calls`, `budget_cost`,
`budget_latency`, `budget_unknown_usage`, `circuit_open`; they create no wire
attempt or circuit failure. Existing advisory fallbacks retain original data.

**Guard is always exempt from optional budgets and circuits**, but all guard API
calls remain in accounting. Guard failures still require confirmation; exhausting
a budget never auto-allows a guarded action. User-authorized `/jev test` and key
setup `probe` are explicitly exempt too; the standalone key-validation client is
outside session budget accounting. `/jev test` is counted in active client stats.

Stats distinguish logical `calls`, `wire_attempts`, and `retries`. Public
`input_tokens` and `cost_usd` become JSON null when any relevant usage is unknown;
`known_input_tokens`, `known_cost_usd`, `unknown_usage_calls` and
`unknown_usage_attempts` retain partial evidence, also per operation. Cost is only
an estimate of Jev input-token cost, not savings. CLI status prints unknown costs
gracefully, and `jev_status` includes budget state even without an API key.

Configuration keys are `budget_enabled`, `budget_calls`, `budget_cost_usd`,
`budget_latency_ms`, `budget_error_streak`, `budget_cooldown_s`. Numeric settings
must be finite: calls 1–1,000,000; cost .000001–1000; latency 1–86,400,000 ms;
errors 1–1000; cooldown .001–86,400 seconds. Calls, latency and errors are integers.

### Local explanations

Use `/jev explain` to see the last **64 plugin-process** diagnostic entries,
shared across sessions handled by that process. `/jev explain clear` clears only
this in-memory ring—not counters, usage accounting, budgets, circuit state, or
lifecycle caches. `jev_status` exposes the same rows in `explanations`, alongside
budget state and compression mode. No additional tool is advertised.

Each row contains only a monotonic `sequence`, a fixed operation name, and a fixed
reason code. The command supplies fixed local glosses: `lowconfidence` means a
valid answer below the local threshold; `modelabstention` means a supplied
abstention option; `invalidresponse` means failed schema validation;
`transporterror` means transport failure. Budget denials retain their specific
`budget_*` or `circuit_open` reason. Other local reasons distinguish `cache`,
`local`, `disabled`, `nokey`, `explicitfields`, and `noeconomiccandidate`.
`review` deliberately leaves ambiguous outcomes unresolved. Batched calls can
produce multiple rows (including valid and invalid siblings); a cached outcome
is reported as `cache`, not as a fresh model decision. Guard rows describe only
local `continue`, `confirm`, or `block` actions; guard remains budget-exempt.

These diagnostics contain no payloads, candidate/session/model IDs, model prose,
exception strings, or timing. They are not written to files, logs, or traces and
do not change the existing audit configuration. Clearing them is not an
accounting reset. They do not certify truth, source authority, execution, or
permission to fetch/read/delete anything; they never authorize an action.

## Advisory context boundaries (0.9.0)

Hosts with automatic context management emit `on_message_complete` with
`data.context_management = {enabled, band, phase}`. When the feature is on and
the host reports band **`pressure`** at a turn end with **no tool use**, Jev asks
one bounded `choice` question (completed / paused / partial / unclear) about the
redacted final assistant text (≤ 6000 chars, redacted then cut, explicit truncation marker) and the
latest user request (≤ 1500 chars). Only `completed` at confidence ≥ 0.85
(`context.BOUNDARY_THRESHOLD`, fixed, not tuned) returns
`{"action": "context_phase", "phase": "new_task"}`; everything else returns
`continue`. Tool outputs, keys and session ids are never sent; nothing from the
state is written to the audit trail.

The report is **advisory**, identical to the model's own
`context_checkpoint(phase)` without a note. It carries no authority to roll
context over, replaces no checkpoint discipline, and never fires under
`normal`, `rollover` or `hard_limit`, so the host cannot enter a loop on it.
Cost is about one ~0.4 s call per turn end **while under pressure only**; no
savings claim is made. Requires a host version with `context_phase` support;
older hosts omit `context_management` and the feature is inert (continue, zero
calls). No cache: each turn end is unique. Counters: `context.call`,
`context.questions`, `context.skip`, `context.report`, `context.abstain`,
`context.error`; explanations include `notpressure`. `/jev context on|off
[--save]`; on by default and in `/jev economy`.

The extension also answers the optional `info.get` RPC (feature inventory as
`capabilities`, the decision model as `models`; no secrets). Hosts that see
extension tools probe it once at boot, and the unknown-method error older
versions returned was treated as a transport failure — costing one process
restart per session start.

## Explicit diagnosis priority: `jev_diagnose`

The sixth tool is always advertised but **off by default**. Enable with
`/jev diagnosis on|off [--save]`; without `--save` the toggle is session-only.
It is independent of the guard. `/jev on` and `/jev off` include diagnosis;
`/jev economy` explicitly turns it off. No metadata version bump accompanies
this slice.

Supply hypotheses and checks yourself; the tool does not invent explanations,
fixes, commands, or replacement prose:

```json
{
  "task": "Prioritize investigation of a synthetic parser failure",
  "evidence": "The supplied test rejects an empty field. No actual system was inspected.",
  "hypotheses": [
    {"id": "empty-field", "description": "The parser rejects empty fields"},
    {"id": "encoding", "description": "The input encoding differs"}
  ],
  "checks": [
    {"id": "project-suite", "description": "Run the mandatory project suite", "required": true},
    {"id": "assertion", "description": "Inspect the supplied failing assertion", "required": false}
  ]
}
```

The exact input keys are `task` (1–2000), `evidence` (1–8000), `hypotheses`
(1–8 `{id, description}` objects), and `checks` (1–16
`{id, description, required}` objects). IDs are nonblank strings up to 80;
descriptions up to 500; `required` is strictly boolean. IDs must be unique
**across both lists**. Limits apply to characters and UTF-8 bytes. Valid Unicode
is required; IDs forbid ASCII controls including DEL; other text forbids C0
except LF/CR/TAB. Serialized input is limited to 24 KiB and output is locally
preflighted at 32 KiB. Redacted state exceeding 24 KiB is rejected for remote
advice, never clipped; all candidates remain for review.

Only redacted task/evidence and descriptors keyed by opaque `h0`, `c0`, etc.
are sent in one batch. IDs and source-authority metadata remain local; required
check descriptions are **never sent**. There is **no cache**: the explicit tool
has no trusted lifecycle context. Existing unscoped budgets/circuit and client
accounting apply automatically under operation `diagnose`.

Each supplied hypothesis receives `plausible|contradicted|unknown` priority
classification, not probability of truth. Optional checks receive
`inspect|later|unknown`. Fixed confidence gates are **0.85 for hypotheses** and
**0.80 for checks**: a misleading hypothesis disposition is more costly than
an optional-check ordering error. These are conservative asymmetric error
choices, not benchmark-tuned thresholds. Invalid/missing answers affect only
their sibling; extra answer keys or malformed batch envelopes put all optional
items in review. No key, off, budget denial and upstream errors preserve every
reference and every required check without advice.

Output contains only local fields: `advisory`, `executed`,
`required_check_ids`, `hypotheses` partitions (`investigate`, `contradicted`,
`review`), `optional_checks` partitions (`inspect`, `later`, `review`),
`references` (`id`, `required`, `kind`, `priority`), and a fixed `note` (plus
`fallback_reason` when applicable). Original IDs are preserved exactly;
there are no model labels, confidence values or model-written prose.

**Hypotheses are unverified against the actual system. Contradicted does not
mean ruled out; later does not mean skip. All mandatory project/user/CI checks
still apply. No execution, retry, tool activation, fetch or approval is granted.**

`/jev explain` uses operation `diagnose` with local accepted, low-confidence,
abstention, invalid-response, disabled, no-key and budget/error reasons.
`jev_status` records `diagnose.call/questions/skip/investigate/contradicted/inspect/
later/review/error` counters and per-operation usage. There is no diagnosis
payload audit or savings claim. `tests/diagnosis_fixture.py::diagnosis_fixture`
is a callable public synthetic fixture for future held-out testing, **not a
benchmark or efficacy evidence**.

Frozen split tooling: [evaluation protocol](scripts/evaluation/README.md).

### Development-only live decision evidence

The foreground's [sanitized development report](scripts/evaluation/dev-live-v1.json)
records 12 fixed `jev-1.13.0` calls, 8,734 input tokens, estimated input cost
$0.000366828, and zero errors. Accepted weak-label priorities: evidence 3 true / 0
false; verification 3 / 0; reports 1 / 0 with 1 miss; diagnosis 0 / 0 with 4 misses
and 11/12 abstentions. This is tiny public development evidence, not heldout
calibration, source authority, production quality, or savings evidence. No
thresholds, prompts, datasets, or heldout artifacts were changed, and this was
not a paid full-workflow comparison.
