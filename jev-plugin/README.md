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
