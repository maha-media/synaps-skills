# Public toy workflow comparison

`jev-plugin/scripts/workflow_compare.py` is an offline-first replay protocol, **not evidence
of production savings or an LLM benchmark**. It compares the same three public
synthetic tasks in `off`, `selected`, and `deterministic` modes. It contains no
provider integration itself, key discovery, repository copying, or generated-code execution.
The separate opt-in Synaps RPC adapter below supplies a real harness integration.

## Safe default

Run the commands below from the repository root.

```console
python3 jev-plugin/scripts/workflow_compare.py
python3 jev-plugin/scripts/workflow_compare.py --output /absolute/new-report.json
```

The default only emits JSON: protocol, embedded fixtures and starter-file contents,
mode configurations, result templates and nine planned runs. Every measurement is
`null`, correctness is unknown, and comparison is explicitly incomparable. No
subprocess, network, environment/key lookup, temporary workspace, or installed
plugin is used. Only an explicit `--output` stores a report; it must not already
exist. Otherwise the sanitized report goes to stdout. There is no input-file or
report-driven execution facility.

## Explicit trusted adapter opt-in

```console
python3 jev-plugin/scripts/workflow_compare.py --execute \
  --runner /absolute/trusted-adapter \
  --runner-arg=--adapter-option --runner-arg=public-value \
  --model provider/public-model-id --timeout 30 --repeats 1
```

The executable must be an absolute executable file. Arguments are passed verbatim
as an argv list with `shell=False`; nothing is interpolated or resolved from task
or result content. For a trusted Python adapter, use an absolute Python executable
with `--runner-arg=-I --runner-arg=/absolute/adapter.py`. The harness does not import
adapter modules. The only executions performed during development tests are local
synthetic fixture scripts, not model jobs.

Runner flags appended by the harness:

```text
--task /temporary/bundle/task.json
--workspace /temporary/bundle/workspace
--result /temporary/bundle/result.json
--mode off|selected|deterministic
```

The request contains `schema`, `task` (instructions and vectors, **no expected
answers**), `mode_config`, and `result_template`. The workspace starts with exactly
`request.json` and `solution.json`; the latter is `{"outputs":[]}`. The adapter
reads the task, performs its workflow, writes the output list to `solution.json`,
and fills the result template. It must not substitute its own task or model.
This is a data-answer contract rather than a source-code repair benchmark.

There are three tasks, each with four fixed vectors:

* Parser: trim surrounding whitespace while preserving internal whitespace.
* Account-cache: preserve both public toy account and resource in cache keys;
  no real account data, authentication, or credentials are involved.
* Keyboard focus: apply Tab, ShiftTab, Escape and no-op transitions over three positions.

The independent local grader compares exact JSON with fixed labels in the harness,
not the runner's pass claim. It never executes code from the workspace. Coverage
is intentionally tiny; publicly inspectable labels are not a blind evaluation.

### Modes and resets

| Mode | Enabled optional features | `compress_mode` |
|---|---|---|
| `off` | none | `jev` |
| `selected` | router, triage | `jev` |
| `deterministic` | compress only | `deterministic` |

`mode_config` uses actual plugin configuration keys: guard, router, triage,
reports, evidence, verification, discovery, diagnosis, compress, and compress_mode.
Adapters must accept only the exact `CONFIGS[mode]` constant, not arbitrary mode
configurations. All feature toggles not listed as enabled are false. Guard=false
is for this isolated benchmark only, never a recommendation to change host-global
guard settings. Tools are always available in the plugin; there are no `tools`,
`decisions`, or `remote_decisions` config toggles. The selected mode needs a client
for router/triage activation; deterministic compression can operate without one.
These settings apply only to the adapter's isolated plugin instance.
The local grader runs regardless of the optional verification-assistance setting.
The adapter is responsible for implementing the settings faithfully; the harness
cannot independently verify its internal feature use or model calls. The main LLM
remains the adapter's responsibility and must use the same `--model` in all modes.
Without a model identifier, results cannot support a cost comparison.

Runs are sequential, one worker, in repeat/task/mode order: nine per repeat.
`--repeats` accepts 1..3 (at most 27); repeats above one require execution opt-in.
`--timeout` accepts integer seconds 1..120, default 30, per runner. Each run has a
fresh temporary bundle, workspace, HOME and SYNAPS_BASE_DIR. No production files,
binaries, external fixture paths or user configuration are copied. `task_sha` is
SHA-256 of canonical task JSON; `input_sha` is SHA-256 of the canonical map of all
starter filenames to exact UTF-8 contents. Canonical JSON sorts keys, uses compact
separators, preserves Unicode and rejects nonfinite numbers. Mode-specific control
metadata is outside those digests. The same task and full reset digests must match
across modes. Temporary bundles are deleted, including raw result files.

### Credentials, disclosure and trust boundary

By default only inherited `PATH` and `LANG` are forwarded, plus fresh HOME and
SYNAPS_BASE_DIR. No credentials are discovered. Optional repeated `--pass-env NAME`
forwards only explicitly named existing process-environment values. Names must
match `[A-Z][A-Z0-9_]{0,63}`, at most 16; HOME and SYNAPS_BASE_DIR cannot be
overridden. Values are only transported in the child environment, never included
in reports or printed. Do not place secrets in runner arguments, model IDs or
output paths. Those are public command-line metadata, not a credential channel.

Forwarding a credential authorizes the trusted adapter to use it, potentially
sending these public tasks to a remote provider and incurring charges. Environment
variables can also alter executable behavior (for example loader variables).
Review every forwarded name and the adapter before opting in. The harness does
not automatically select an adapter, and cannot enforce provider
budgets, prohibit adapter networking, or prevent an adapter from reading the host
filesystem. **Temporary directories and environment reduction are not a sandbox.**
An adapter can escape its process group; ordinary descendants are killed on
completion/timeout, but malicious daemon isolation requires an external sandbox.

stdin/stdout/stderr of the runner are discarded, not captured or retained. Reports
contain only fixed labels, validated metrics and public metadata; arbitrary error
messages and extra adapter fields are never included. The adapter identity is a
hash of the fixed CLI executable/arguments, not attestation of executable contents.
This hash does not identify a plugin revision or detect changed runner/script bytes.
For real measurements, record the plugin revision and runner revision separately
in the experiment record; neither is attested by this protocol.
No adapter assertion grants source authority or certifies provenance.

## Result contract and accounting

Copy `result_template` from the request and fill its nullable fields. Exact keys:

```json
{
  "schema": 1,
  "task_id": "parser",
  "mode": "off",
  "model": null,
  "task_sha": "copy exact request template value",
  "input_sha": "copy exact request template value",
  "main_model": {"input_tokens": null, "output_tokens": null, "cost_usd": null, "requests": null, "retries": null},
  "jev": {"input_tokens": null, "output_tokens": null, "cost_usd": null, "requests": null, "retries": null, "wire_attempts": null},
  "verification": {"claimed_passed": null}
}
```

Identifiers, model and digests must match the request template exactly. Counts
are integers (not booleans); cost is a finite number; all are nullable and bounded
0..1,000,000,000. Claim is boolean or null. Unknown means null, not zero. An adapter
may report zero for known absent calls, but it remains adapter-asserted. Requests
are logical calls; retries are additional attempts; Jev wire_attempts includes
initial and retried transport attempts. The harness does not invent token counts,
prices, invoices, or usage based on elapsed time.

Result and solution must each be regular, single-link, non-symlink files, at most
8 KiB, strict JSON with no duplicate keys or NaN/Infinity. Fixed parent directories
are opened without following symlinks. Paths from result or task data are never
followed. Wrong or invalid solutions fail the local grader, independently of the
claim. Timeout, nonzero exit, missing or invalid result fails the run and leaves
usage unknown. Actual runner wall time is still measured with a monotonic clock;
it excludes workspace setup and local grading and is **not provider-only latency**.

Summaries retain all runs: completed counts, grader passed/failed/unknown, summed
wall time, per-component usage/retries and main+Jev cost. Any missing operand makes
that total null. A valid runner can report costs even when its answer is wrong;
those costs are retained but cannot support a savings claim. Cost deltas are
emitted only when every run completes, is locally correct, has all usage known,
and has matching fixed model/task/reset identities under the same adapter invocation.
Delta is mode cost minus off cost, not a percent or an invoice saving. Any failed
or unknown run makes the whole comparison explicitly incomparable. No failures
are discarded, and no synthetic fixture metrics should be described as LLM jobs
or actual LLM costs. Exit status is 1 for any execution/result/grader failure;
valid-but-incomplete usage may exit 0 while remaining incomparable.

## Offline verification

```console
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest -q jev-plugin/tests/test_workflow_compare.py
```

Tests create a temporary trusted adapter, invoked via the known Python executable
with `-I`. Its constant usage values are **synthetic accounting test data only**.
They exercise nine-run resets, 27-run cap, mode matching, environment reduction,
local claim contradictions, null accounting, malformed/oversized JSON, symlinks,
timeout/nonzero failures, and secret-output suppression. No live API is needed.

## Built-in opt-in Synaps RPC adapter

From the repository root (replace all absolute paths and the public model ID):

```console
python3 jev-plugin/scripts/workflow_compare.py --execute \
  --runner /absolute/python3 \
  --runner-arg=-I \
  --runner-arg=/absolute/checkout/jev-plugin/scripts/workflow_synaps.py \
  --runner-arg=--execute \
  --runner-arg=--synaps-bin --runner-arg=/absolute/synaps \
  --model provider/public-model-id --timeout 95 \
  --pass-env OPENROUTER_API_KEY --pass-env TYPESAFE_API_KEY \
  --output /absolute/new-workflow-report.json
```

Running `workflow_synaps.py` without `--execute` prints help only: no process,
configuration, credential lookup or network. Execution requires the exact public
harness task, mode configuration, non-null bounded model, template, conventional
bundle paths and byte-for-byte full starter reset. HOME and SYNAPS_BASE_DIR must
be existing empty directories in that same bundle. Invalid data fails before
launch. Use a real absolute executable path, not a symlink. The adapter copies
only its script-relative manifest and Python extension sources, excluding caches,
symlinks and config. It never copies host auth or discovers production keys.
The only credential environment names passed to Synaps are `TYPESAFE_API_KEY`,
`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY`; the outer harness
must explicitly forward them. Selected mode requires a TypeSafe key. Off and
keyless deterministic mode may run without one. All modes still advertise tools.

Only the isolated base config changes: exact feature flags including guard=false,
compress_mode, blank audit_file, budget_enabled=false, and events.auto_turn=false.
Common runtime/numerical thread counts are pinned to one. Synaps is launched with
`[synaps, rpc, --model, model, --system, fixed_instruction]`, workspace cwd,
`shell=False`, piped binary stdin/stdout and discarded stderr. The prompt includes
only fixed instructions and public task JSON, never mode metadata or grader labels.
The adapter never changes the model's solution; the outer grader is authoritative.
These toy tasks deliberately avoid unnecessary delegation and do **not** test
router efficacy.

Ready must advertise protocol v1 and the exact model. `tools_list` must confirm
all six Jev tools (host loader readiness is best-effort with a two-second grace).
The adapter requires one agent_end with nonnegative counters plus the matching
successful prompt response; cancelled=true fails. The current host omits
cancelled on success; absent or explicit false is accepted. Errors, malformed or
oversized frames, unexpected turns, nonzero exit and timeout fail with a fixed
label and no raw output. Reads use select/binary os.read, with 1 MiB frames,
16 MiB total, 100,000 frames and an 85-second default hard wall deadline (maximum
90 via adapter `--timeout`). Shutdown must also finish within that deadline.
The child stays in the outer harness process group so outer timeout reaches it;
ordinary Linux descendants are killed/waited on completion or failure. No
malicious-daemon containment is claimed. Temporary directories are **not a
sandbox** and time/output bounds are **not a strict spend budget**.

The isolated manifest substitutes a benchmark-only wrapper entrypoint. The host
scrubs `SYNAPS_BASE_DIR` on extension spawn: the wrapper recovers the isolated
base from `Path(__file__).resolve().parents[3]` (the installed
`base/plugins/jev/extensions/` layout), validates the expected directories and
files, and sets that variable before importing the unchanged plugin. It never
falls back to host configuration. Source-only `--help` exits without importing
or running the plugin. Selected-mode credentials still arrive through the host's
secret-env initialize configuration, not a copied credential file. It then
subclasses initialize/hook/tool_call, and snapshots the same instance's `stats.snapshot()`, features and compression mode after calls
and dispatch, including shutdown. Only that bounded private local file is used
for Jev accounting, never model status text. Observed features must exactly match
the requested mode before the prompt and after shutdown. Snapshots are replaced
atomically with exclusive nofollow temporary files; results are bounded exclusive
nofollow files. Runtime/model-accessible local stats are **observability, not
attestation or source authority**.

Main input/output counts are reported only when positive host counters exist;
zero/default counters become null. RPC cost defaults do not prove billed cost,
so main cost stays null. response_start/reset are not HTTP attempts: main
requests/retries stay null. Jev input cost is the plugin's input-token estimate
only when all usage is known; output tokens are unknown unless a completed
snapshot verifies zero wire attempts and all zero accounting. No calls is
verified, never inferred from mode. `verification.claimed_passed` remains null.
Consequently this adapter cannot support dollar comparisons: host wire-attempt
and billed-usage instrumentation is still needed. No paid workflow experiment
was performed during this implementation.

Offline verification (sequential, one worker):

```console
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest -q \
  jev-plugin/tests/test_workflow_synaps.py jev-plugin/tests/test_workflow_compare.py
```

Fake executable tests exercise actual wrapper initialization/hooks/shutdown using
the real plugin without a provider call, all three modes, a scrubbed
`SYNAPS_BASE_DIR`, synthetic selected-mode `api_key` supplied via initialize,
invalid wrapper installations, source-only help, strict resets, reduced
environment, null accounting, errors, timeouts, secret-output suppression and
host protocol/tool/model validation. Fake-host success is not live-host evidence.

Latest offline verification: 633 tests and 158 subtests passed sequentially.
Real-host boot verification remains a separate foreground check; this result
does not claim a successful live boot or a paid workflow comparison.
