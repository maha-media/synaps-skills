# Axel Continuous Memory — Implementation Plan

- **Status:** Proposed — awaiting approval to begin Task 0
- **Plan ID:** `axel-continuous-memory-plan/1`
- **Implements:** `axel-continuous-memory/1`
  (`docs/continuous-memory-chat-history-spec.md`)
- **Last updated:** 2026-07-20

## 1. Convergence declaration

This program touches durable user memory, secrets, cross-project isolation,
authorization leases, and prompt-injection surfaces. Author/tester bias is
unacceptable.

- `convergence: holdout`
- `threshold: 0.80` (weighted), spec-fidelity gate `0.70`
- `axis_weights: security/privacy 0.35, correctness 0.30, spec fidelity 0.20,
  code quality 0.10, docs 0.05`
- `max_fix_iterations: 2` per holdout (a third iteration requires explicit
  human approval, as in the lifecycle program)
- `max_total_calls: 10` per holdout loop

These parameters are fixed now and must not change after the first score.
Intermediate phase gates (CP-A … CP-E) use informed review; the final program
gate (CP-F) uses a wall-separated holdout with durable verdict artifacts.

## 2. Repositories, branches, worktrees

Three repos change. Implementation happens in new stacked worktrees; the
completed lifecycle/T32–T36 branches remain untouched as bases.

| Repo | Base commit | New branch | New worktree |
|---|---|---|---|
| SynapsCLI | `048cb5c0` (`feat/request-lifecycle-hardening`) | `feat/continuous-memory-host` | `/home/jr/Projects/Maha-Media/.worktrees/SynapsCLI-continuous-memory` |
| Axel | `562e6508` (`feat/project-memory-t32-t36`) | `feat/continuous-memory-axel` | `/home/jr/Projects/Maha-Media/.worktrees/axel-continuous-memory` |
| synaps-skills (plugin) | `0790b195` (`feat/axel-memory-t32-t36`) | `feat/continuous-memory-plugin` | `/home/jr/Projects/Maha-Media/.worktrees/synaps-skills-continuous-memory` |

Rules:

- The primary checkouts and the existing lifecycle/T32–T36 worktrees are never
  modified by this program (except committing this plan + spec, Task 0).
- Branches stay local; no push or PR without explicit instruction.
- The lifecycle worktree's intentional dirt (`M docs/request-lifecycle-hardening-spec.md`,
  `?? synaps`) is never staged, reverted, or copied.
- The plugin continues to resolve Axel via local `--config patch.…path=…`
  entries pointing at the Axel worktree until the pinned revision is published
  (spec §17.3; "Ask first" applies to pushing Axel).

## 3. Build and test constraints (mandatory, all tasks)

- `CARGO_BUILD_JOBS=8`, `cargo … --jobs 8`, `-- --test-threads=8` maximum.
- No heavy suites run concurrently across the three repos.
- Serial (`--test-threads=1`) only where the shared `synaps_base_dir` lock or
  benchmark isolation requires it.
- Exact commands per repo: spec §17.

## 4. Dependency graph

```
A1 lease/mode/action types ──┬── A4 memory_context tool ── A5 /memory commands
A2 settings                  │        │
A3 context-provider cap ─────┴── A6 lease lifecycle ── A7 ContextSegment::Memory
                                                            │
B1 wire protocol ── B2 Axel retrieval ── B3 plugin recall ──┤
                                                            B4 per-prompt flow ── B5 render+why ── B6 gate
                                                            │
C1 capture builder ── C2 episodic store ── C3 capture worker ── C4 compaction link ── C5 crash tests
                                                            │
D1 preview/consent ── D2 session streaming ── D3 checkpoints ── D4 import tests
                                                            │
E1 supersession ── E2 diversity ── E3 embeddings(opt) ── E4 consolidation ── E5 quality corpus
                                                            │
F1 e2e harness ── F2 adversarial oracles ── F3 benchmarks ── F4 full gates ── F5 holdout
```

Risk-first ordering: lease forgery/authorization (A) and host-side contribution
validation (B1) are the highest-blast-radius pieces and land first. Capture (C)
precedes import (D) because import reuses capture's record classes and
idempotency keys. Quality/consolidation (E) is deliberately late — it tunes an
already-safe pipeline.

---

## Phase 0 — Foundations

### Task 0: Commit spec and plan; create worktrees

**Description:** Commit `continuous-memory-chat-history-spec.md` and this plan
to `feat/axel-memory-t32-t36` as focused doc commits, then create the three
stacked worktrees/branches from the base commits in §2.

**Acceptance criteria:**
- [ ] Spec and plan committed (docs-only, `git diff --check` clean).
- [ ] `git worktree list` shows all three new worktrees at the exact base SHAs.
- [ ] Existing worktrees' status unchanged (lifecycle dirt untouched).

**Verification:** `git log --oneline -2`, `git worktree list`, `git status`
in all five worktrees.

**Dependencies:** None. **Files:** docs only. **Scope:** XS

---

## Phase A — Host lease and context-provider protocol (SynapsCLI)

### Task A1: Typed memory-context domain model

**Description:** Add `crates/agent-engine/src/runtime/memory_context.rs`:
`MemoryContextMode` (Off/RecallOnce/RecallEachPrompt/CaptureOnly/
CaptureAndRecall), `MemoryContextLease` (host-private constructor, no
Deserialize), `UserIntentProof`, `AuthorizedMemoryAction`,
`MemoryContextStatus`, `MemoryContextError`, `SessionMemoryState` with
exhaustive transitions per spec §6.1–§6.3, §19.

**Acceptance criteria:**
- [ ] Lease constructor is `pub(crate)`-or-tighter; a compile-fail or
      visibility test proves plugin/model code cannot mint one.
- [ ] Every mode×action transition is exhaustively matched and unit-tested,
      including one-shot install/consume/revoke.
- [ ] No `bool` mode flags, no `serde_json::Value` past the boundary.

**Verification:** `cargo test -p synaps-engine memory_context --jobs 8 --
--test-threads=8`; workspace check.

**Dependencies:** Task 0. **Files:** `runtime/memory_context.rs`, `runtime/mod.rs`.
**Scope:** M

### Task A2: Settings surface

**Description:** Add `memory.*` settings (spec §12) to config with fail-closed
defaults (`default_mode = "off"`, timeouts, record/token caps, GLiNER and
embeddings off). Durable non-off default requires explicit operator consent and
binds to its exact project.

**Acceptance criteria:**
- [ ] All spec §12 keys parse; unknown values fail closed to `off`.
- [ ] Secret/retention/project rules are not configurable to fail open.
- [ ] Non-off durable default without recorded consent is rejected.

**Verification:** config unit tests; workspace check.

**Dependencies:** A1. **Files:** `agent-core/src/core/config.rs`. **Scope:** S

### Task A3: Context-provider extension capability

**Description:** Add an additive, typed `context_provider` capability to the
extension manifest/protocol (spec §7.1): `ContextProviderId`, manifest
declaration, dormant registration alongside existing deferred-tool leases.
Discovery, schema export, and `status` spawn zero processes.

**Acceptance criteria:**
- [ ] Manifest with a context-provider block parses; unknown/ambiguous forms
      fail closed (consistent with `dd93079e` alias behavior).
- [ ] Discovery + status produce zero spawns (asserted by test, not inspection).
- [ ] Existing manifests without the block are byte-compatible.

**Verification:** `cargo test -p synaps-engine --test extension_manifest`-class
suites; deferred_host_context serial test.

**Dependencies:** A1. **Files:** `extensions/manifest.rs`,
`extensions/context_provider.rs` (new), `extensions/lease.rs`. **Scope:** M

### Task A4: `memory_context` control tool

**Description:** Add the exact `memory_context` tool (spec §7.2): boundary
parse of raw args into typed actions; model calls are proposals; only host
policy commits lease state via `UserIntentProof`. `ExactCurrentRequest`
requires the host to prove the current user message names the exact
transition; otherwise the frontend confirms. `disable`/`status` are always
locally allowed and metadata-only.

**Acceptance criteria:**
- [ ] Forged enable (model call without proof) is denied before any spawn.
- [ ] `additionalProperties:false` schema; malformed input fails closed with a
      content-free error.
- [ ] `status` never spawns a dormant provider.

**Verification:** unit + engine integration tests for all five actions.

**Dependencies:** A1, A3. **Files:** `tools/memory_context.rs` (new), tool
registry. **Scope:** M

### Task A5: `/memory` frontend commands

**Description:** One engine API (`apply_memory_context_action`) consumed by
TUI, headless chat, RPC, server, watcher, and agent modes; commands per spec
§7.3 (`on/recall/capture/once/status/off/index-history/why`). No frontend
duplicates lease or budget logic.

**Acceptance criteria:**
- [ ] All frontends route through the single engine transition (grep-proof: no
      second lease mutation site).
- [ ] `/memory status` renders mode, project digest, lease expiry, counters.
- [ ] `/memory off` takes effect before the next provider request.

**Verification:** frontend integration tests; RPC/server round-trip test.

**Dependencies:** A4. **Files:** `src/cmd/chat.rs`, `src/cmd/rpc.rs`,
`src/cmd/server.rs`, `agent-tui/src/tui/`. **Scope:** M

### Task A6: Lease lifecycle and non-inheritance

**Description:** Wire lease state into the runtime: exact activation acquires
the dormant provider once per session/provider; session end and disable revoke
and reap; new sessions and subagents start with no lease (extend the existing
subagent policy-surface exclusion used for `subagent_model_authorize`);
one-shot lease install/consume plumbing.

**Acceptance criteria:**
- [ ] Exact enable spawns the provider at most once; sibling providers stay
      dormant.
- [ ] Subagent runtime construction provably drops the lease and the
      `memory_context` enable path.
- [ ] Revocation is effective before the next provider request; no leaked
      child after session end (reaped in test).

**Verification:** engine integration tests incl. crash-of-provider case.

**Dependencies:** A4. **Files:** `runtime/memory_context.rs`, runtime session
wiring, `extensions/lifecycle.rs`. **Scope:** M

### Task A7: `ContextSegment::Memory` and budget reserve

**Description:** Add the typed segment (spec §10.1) to context assembly and the
T29 budget: reserve `min(4096 tokens, 10% effective input)`, minimum useful
512 or skip, never touching output/thinking/tool-result/safety reserves.
Provider adapters translate the segment as lower-authority data — never system
or user text. Segment content is empty until Phase B; this task lands the type,
budgeting, and adapter translation with a stub contribution.

**Acceptance criteria:**
- [ ] Budget tests prove protected reserves are untouched under exhaustion and
      the <512-token skip triggers.
- [ ] All provider adapters (Anthropic, OpenAI-compatible, Gemini, broker)
      place the segment outside system/user authority positions.
- [ ] Compaction and persistence treat the segment as non-durable per-turn
      data (not written into session history as user text).

**Verification:** context-budget unit tests; adapter translation tests.

**Dependencies:** A6. **Files:** `runtime/context.rs`, provider adapters.
**Scope:** M

### Checkpoint CP-A (after A1–A7) — Phase A gate

- [ ] Forged-call, no-spawn, exact-activation, non-inheritance, and
      cross-frontend single-transition tests pass (spec §22 Phase A gate).
- [ ] `CARGO_BUILD_JOBS=8 cargo test --workspace --jobs 8 -- --test-threads=8`
      passes in the host worktree; zero regressions vs the 115-summary
      baseline.
- [ ] Durable artifact: commits + informed review note in `docs/reviews/`.

---

## Phase B — Axel recall provider

### Task B1: Recall wire protocol and host validator

**Description:** Define versioned `RecallRequest` / `MemoryContextContribution`
/ `MemoryContributionRecord` (spec §6.4–§6.5) shared by host and plugin. Host
validator rejects wrong project, unknown schema, oversized records/total,
invalid disclosure class, duplicate IDs — before acceptance. Plugin parses at
its boundary into closed types.

**Acceptance criteria:**
- [ ] Validator rejection matrix unit-tested (each rejection class).
- [ ] Request contains no credentials, paths outside project scope, or
      unbounded transcript (constructor makes this unrepresentable).
- [ ] Schema version mismatch fails closed with metadata-only diagnostics.

**Verification:** host unit tests + plugin parse tests.

**Dependencies:** A7. **Files:** host `runtime/memory_context.rs` +
`extensions/context_provider.rs`; plugin `src/context.rs` (new). **Scope:** M

### Task B2: Axel bounded retrieval with rank reasons

**Description:** In Axel core, add `chat_history.rs`/`retrieval.rs` recall:
candidate generation (lexical FTS, tag/entity exact match, recency window,
session affinity, decisions/preferences/unresolved-task boosts), bounded to
≤128 candidates, ranked selection ≤8 with typed `RankReason`s, recency
fallback that never injects arbitrary large history (spec §9.1–§9.2, §9.5).

**Acceptance criteria:**
- [ ] Candidate and selection bounds hold under a 100K-record corpus test.
- [ ] Every selected record carries ≥1 machine-readable rank reason.
- [ ] Secret/`local_only`/`persist_never_transmit` bodies excluded before
      snippeting (reuses T34 sensitivity gates; sentinel-tested).

**Verification:** `cargo test --workspace` in Axel worktree; targeted
retrieval tests.

**Dependencies:** B1. **Files:** `crates/axel/src/chat_history.rs`,
`retrieval.rs`. **Scope:** M

### Task B3: Plugin recall provider handler

**Description:** Implement the context-provider capability in the plugin:
handle recall requests over the framed JSON-RPC wire, call Axel retrieval,
apply plugin-side project/disclosure/sensitivity checks (defense in depth with
B1's host checks), render each record ≤2 KiB, respect the host-provided hard
byte/token limit.

**Acceptance criteria:**
- [ ] Wire test: recall returns a bounded contribution; wrong project fails
      closed without existence leakage.
- [ ] Plugin never exceeds the host limit even when Axel returns more.
- [ ] Initialize/discovery still contains no memory body; manifest declares
      the provider passively.

**Verification:** plugin wire tests with local Cargo patches (spec §17.3).

**Dependencies:** B1, B2. **Files:** plugin `src/context.rs`, `main.rs`,
`tools.rs`, `.synaps-plugin/plugin.json`, `tests/context_wire.rs`. **Scope:** M

### Task B4: Per-prompt recall flow

**Description:** Engine-side eligible-prompt recall (spec §7.4): lease check →
budget reserve → `RecallRequest` → 150 ms hard timeout → validate → insert
segment. Fail-open without memory on timeout/crash/malformed data; retries of
one logical request reuse the accepted contribution; tool-loop continuations do
not rerun recall; one-shot leases consume exactly once per logical request;
repeated failures may disable the lease with a visible warning.

**Acceptance criteria:**
- [ ] Timeout test: prompt proceeds without memory; no stale contribution from
      another turn is ever reused.
- [ ] Retry and tool-loop tests prove exactly one recall per eligible user
      turn; one-shot consumption is exact across retries.
- [ ] Disabled mode performs zero provider process activity (spawn counter).

**Verification:** engine integration tests with a scripted fake provider and
with the real plugin.

**Dependencies:** A7, B3. **Files:** runtime request pipeline,
`runtime/memory_context.rs`. **Scope:** M

### Task B5: Rendering, injection escaping, `/memory why`

**Description:** Lower-authority rendering (spec §10.2) with escaping of role
markers, wrappers, control characters, and tool-call JSON; per-turn
explainability metadata retention (spec §10.4); `/memory why` across all
frontends showing IDs, classes, rank reasons, accounting, and withheld counts
without secret bodies.

**Acceptance criteria:**
- [ ] Stored `</system>`, fake roles, and forged tool JSON render inert
      (fixture-tested at the adapter output level).
- [ ] `/memory why` shows dropped/truncated/withheld counts matching
      accounting exactly.
- [ ] Trace/observability events are metadata-only (spec §15 event set).

**Verification:** renderer unit tests; frontend `why` integration test.

**Dependencies:** B4. **Files:** renderer, explainability store, frontends.
**Scope:** M

### Task B6: Phase B harness

**Description:** Real provider-turn harness: scripted provider + real plugin,
proving bounded per-prompt injection with no user/system-role confusion, across
TUI-headless, chat, and RPC paths.

**Acceptance criteria:**
- [ ] Harness runs headlessly (simulated confirmation for enable).
- [ ] Asserts segment position/authority in the actual serialized provider
      request for each adapter.
- [ ] Red→green documented for at least the forged-enable and oversized-
      contribution cases.

**Verification:** `tests/memory_context_e2e.rs` (host) green.

**Dependencies:** B5. **Files:** host `tests/memory_context_e2e.rs`. **Scope:** M

### Checkpoint CP-B (after B1–B6) — Phase B gate

- [ ] Spec §22 Phase B gate green; host workspace + plugin + Axel suites pass
      at the eight-job caps, sequentially.
- [ ] Informed review of lease/validator/renderer code paths; findings fixed
      or ticketed with severity.
- [ ] Durable artifact: commits + review note.

---

## Phase C — Structured chat capture

### Task C1: Typed turn-capture builder

**Description:** Host-side `ChatTurnCapture` (spec §6.6, §8.2) built only from
canonical completed history after a typed terminal outcome: user + final
assistant segments, bounded tool summaries, typed outcome, provenance,
compaction linkage, sensitivity/retention, source `MessageRangeDigest`
idempotency key. Forbidden classes (system/developer prompts, CoT, secrets,
`never_persist`, raw binaries, unbounded tool output, foreign-project content)
filtered by construction.

**Acceptance criteria:**
- [ ] Builder cannot be invoked on partial streaming state (type-enforced).
- [ ] Forbidden-class sentinels absent from built captures (unit fixtures).
- [ ] Interrupted non-idempotent outcomes are marked, never clean-success.

**Verification:** host unit tests.

**Dependencies:** B4. **Files:** capture module in `runtime/`. **Scope:** M

### Task C2: Axel episodic storage classes

**Description:** Axel core record classes (spec §8.1): `EpisodicTurn`,
`ConversationSummary`, `Decision`, `Preference`, `UnresolvedTask`,
`EntityFact`, `ToolOutcome`, `Correction`; durable-before-ack commit; stable
IDs; tombstone compatibility; heuristic (model-free) enrichment for
title/tags/entities (spec §11.2).

**Acceptance criteria:**
- [ ] Kill-after-store reopen recovers every acknowledged capture.
- [ ] Records claim no stronger provenance than host-supplied.
- [ ] Existing `.r8` files open and migrate safely (fixture from the T32–T36
      suite).

**Verification:** Axel workspace tests incl. kill/reopen harness.

**Dependencies:** C1 (protocol shape). **Files:**
`crates/axel/src/project_memory.rs`, `chat_history.rs`. **Scope:** M

### Task C3: Capture flow and bounded worker

**Description:** Engine capture path (spec §7.5): capture-capable lease check →
disclosure/persistence gates → send to exact leased provider through a bounded
worker (≤50 ms p95 synchronous delay, fixed queue capacity, exact overflow
accounting). Capture failure never invalidates the completed turn; retry queue
only for idempotent capture IDs; plugin-side idempotent store.

**Acceptance criteria:**
- [ ] Duplicate capture ID stores exactly one record (wire-tested).
- [ ] Queue overflow drops with exact accounting, never blocks turn
      completion or grows unbounded.
- [ ] Failure diagnostics are metadata-only.

**Verification:** engine + plugin wire tests; latency assertion in harness.

**Dependencies:** C1, C2. **Files:** runtime capture worker, plugin
`src/capture.rs` (new). **Scope:** M

### Task C4: Compaction-summary capture

**Description:** On the unified compaction transition, emit a
`ConversationSummary` capture with source session/turn-range digest,
provider/local-only marker, prompt-stack digest, redaction policy, classes,
timestamps (spec §8.4) — reusing the lifecycle program's typed compaction
provenance.

**Acceptance criteria:**
- [ ] Summary links to source range; never replaces source provenance.
- [ ] Local-only compaction marks the local marker (no fabricated provider).
- [ ] Capture-disabled leases produce no summary capture.

**Verification:** compaction integration test.

**Dependencies:** C3. **Files:** compaction transition hook. **Scope:** S

### Task C5: Capture crash/retry/cancellation tests

**Description:** Adversarial capture suite: kill-after-commit reopen,
cancellation closes forwarding tasks and releases leases with no blocked
producer, possibly-committed capture queried by idempotency key rather than
blindly retried, 1 GiB synthetic capture bounded by retention.

**Acceptance criteria:**
- [ ] All spec §13.2/§13.4 behaviors covered red→green.
- [ ] Cross-session recall works after kill/reopen (Phase C gate).
- [ ] No duplicate records across any crash/retry scenario.

**Verification:** dedicated serial harness runs.

**Dependencies:** C3, C4. **Files:** host + plugin test suites. **Scope:** M

### Checkpoint CP-C (after C1–C5) — Phase C gate

- [ ] Spec §22 Phase C gate green (cross-session recall post-kill, no
      duplicate capture).
- [ ] All three repos' suites pass sequentially at the eight caps.
- [ ] Durable artifact: commits + informed review note.

---

## Phase D — Existing-history import

### Task D1: Disclosure preview and consent

**Description:** `/memory index-history` and `memory_context(action=
"index_history")` produce a host-computed preview (project ID/root, session
count, approx bytes, date range, included/excluded classes,
retention/redaction, destination `.r8` path) and require explicit confirmation
before any content read (spec §8.3).

**Acceptance criteria:**
- [ ] Declined consent ⇒ zero reads beyond metadata scan, zero Axel writes
      (asserted with I/O accounting).
- [ ] Preview is identical across frontends (single engine implementation).
- [ ] Model cannot self-confirm (proof/confirmation required).

**Verification:** host integration tests.

**Dependencies:** C3. **Files:** engine import module, frontends. **Scope:** M

### Task D2: Host-mediated session streaming

**Description:** Stream historical sessions through the canonical
backward-compatible session API (legacy JSON and journal-backed), apply
disclosure/retention/redaction, build bounded import batches of C1-shaped
records, send to the leased provider. The plugin never crawls session storage.

**Acceptance criteria:**
- [ ] Old JSON and journal sessions import through one API (both fixtures).
- [ ] Cross-project sessions excluded; exclusion sentinel-tested.
- [ ] Batches and queues bounded; no network construction (local-only oracle).

**Verification:** import integration tests with mixed-format fixtures.

**Dependencies:** D1. **Files:** engine import module,
`agent-core/src/core/session.rs` read path. **Scope:** M

### Task D3: Resumable checkpoints and dedupe

**Description:** Incremental, resumable, cancellation-safe import: committed
checkpoints, source-range digests preventing duplicates, resume-after-kill,
metadata-only progress events (`memory_import.progress`).

**Acceptance criteria:**
- [ ] Forced kill mid-import resumes from last checkpoint with zero
      duplicates (digest-verified).
- [ ] Cancellation leaves a consistent checkpoint and no blocked worker.
- [ ] Progress/errors contain no content.

**Verification:** kill/resume harness (serial).

**Dependencies:** D2. **Files:** import checkpoint store, plugin idempotent
ingest. **Scope:** M

### Task D4: Import test battery and scale

**Description:** Complete spec §20.4: prompt/system/secret exclusion
sentinels, cross-project exclusion, consent-decline I/O proof, and a bounded
1M-turn ignored resource-capped benchmark.

**Acceptance criteria:**
- [ ] Every §20.4 bullet has a named test.
- [ ] 1M-turn benchmark runs `--ignored` within fixed memory bounds and
      reports batch/throughput metrics.

**Verification:** `tests/memory_history_import.rs` green; benchmark log
captured.

**Dependencies:** D3. **Files:** `tests/memory_history_import.rs`. **Scope:** M

### Checkpoint CP-D (after D1–D4) — Phase D gate

- [ ] Spec §22 Phase D gate green (historical search without plugin crawling
      or cross-project leakage).
- [ ] Suites pass; durable artifact: commits + informed review note.

---

## Phase E — Advanced retrieval and consolidation

### Task E1: Supersession and contradiction graph

**Description:** Axel record links `supersedes` / `contradicts` /
`confirmed_by` / `invalidated_at`; ranking penalizes known-stale claims;
contribution either includes only current records or labels conflicts (spec
§9.4). `Correction` records drive supersession.

**Acceptance criteria:**
- [ ] Superseded fact never presented as current without a conflict label.
- [ ] Tombstoned/forgotten IDs never resurface via the graph after rebuild.
- [ ] Stale-rate fixture measurable (feeds E5).

**Verification:** Axel retrieval tests.

**Dependencies:** C2, B2. **Files:** `retrieval.rs`, `project_memory.rs`.
**Scope:** M

### Task E2: Diversity pass

**Description:** Bounded MMR-style diversity over the selected set with class
mixing (decisions, preferences, recent episodes, unresolved tasks, facts) and
duplicate penalties (spec §9.3).

**Acceptance criteria:**
- [ ] Near-duplicate fixture yields ≤1 representative in the selection.
- [ ] Diversity never violates the ≤8 selection or byte bounds.

**Verification:** ranking unit tests.

**Dependencies:** E1. **Files:** `retrieval.rs`. **Scope:** S

### Task E3: Optional local embeddings

**Description:** Explicit opt-in local embeddings (spec §5.6, §16.2): separate
enable + explicit download step, 250 ms p95 target, automatic lexical fallback
on missing model/timeout. GLiNER remains off by default. No implicit download
on enable/capture/recall/search — network-oracle enforced.

**Acceptance criteria:**
- [ ] Default path creates no model cache and constructs no network request
      (oracle test).
- [ ] Embedding failure/timeout falls back to lexical with metadata note.
- [ ] Hybrid ranking improves fixture recall@5 or the feature stays off by
      default with documented results.

**Verification:** Axel tests + network oracle; ignored model-dependent tests.

**Dependencies:** E2. **Files:** velocirag/embedding glue. **Scope:** M

### Task E4: Bounded consolidation

**Description:** Background bounded maintenance (spec §11.3): merge redundant
episodics, promote repeated preferences, update decisions/unresolved tasks,
mark superseded, strengthen useful memories, prune per retention, rebuild
derived indexes. Never widens project scope or disclosure. Off by default
(`memory.auto_consolidate = "off"`).

**Acceptance criteria:**
- [ ] Consolidation output scope ⊆ input scope (property test).
- [ ] Tombstones survive consolidation and index rebuild.
- [ ] Runs are bounded in time/memory and cancellation-safe.

**Verification:** Axel consolidation tests.

**Dependencies:** E1. **Files:** `crates/axel/src/consolidate/`. **Scope:** M

### Task E5: Retrieval-quality corpus and metrics

**Description:** Checked-in labeled multi-session fixture corpus; harness
reporting recall@1/5/8, MRR, duplicate rate, stale rate, secret/cross-project
leakage counts, budget violations, latency p50/p95 (spec §20.6). Thresholds:
recall@5 ≥ 0.85, stale ≤ 0.05, duplicates ≤ 0.10, leakage = 0.

**Acceptance criteria:**
- [ ] Harness emits a machine-readable report; thresholds asserted in-test.
- [ ] Corpus includes injection, secret-sentinel, superseded, and
      cross-project traps.

**Verification:** `crates/axel/tests/recall_quality.rs` green.

**Dependencies:** E2, E3, E4. **Files:** fixtures + `recall_quality.rs`.
**Scope:** M

### Checkpoint CP-E (after E1–E5) — Phase E gate

- [ ] Spec §22 Phase E gate green (quality + performance thresholds, zero
      leakage).
- [ ] Suites pass; durable artifact: commits + quality report + review note.

---

## Phase F — Program harness, gates, holdout

### Task F1: Headless `continuous_memory_e2e` harness

**Description:** End-to-end harness driving the real host binary + real plugin
through: simulated user consent, `/memory on`, multi-turn conversation with
per-prompt recall, capture, session restart, cross-session recall, `/memory
why`, `/memory off`, and history import — fully unattended, all
human-in-the-loop steps simulated programmatically.

**Acceptance criteria:**
- [ ] Runs green with no human input on a clean environment.
- [ ] Asserts spec §21 activation/recall/capture checklists end-to-end.
- [ ] Proves red→green for at least one seeded regression per phase.

**Verification:** `tests/memory_context_e2e.rs` + harness runner script.

**Dependencies:** CP-E. **Files:** host tests + runner. **Scope:** M

### Task F2: Adversarial oracle suite

**Description:** Complete spec §20.5: stored-injection inertness, foreign-
project probing without existence leakage, secret sentinel absent from search/
fetch/context/logs/traces/index/export/errors, symlink + `umask 000` attacks,
slow-consumer and 1 GiB capture bounds, cancel-after-possible-commit, crash
loops without lease/process leaks, denied model-initiated durable default.

**Acceptance criteria:**
- [ ] Every §20.5 bullet has a named, passing test.
- [ ] No adversarial test weakened or serialized to pass (reviewed).

**Verification:** dedicated adversarial suites in host, plugin, Axel.

**Dependencies:** F1. **Files:** test suites across repos. **Scope:** M

### Task F3: Benchmarks

**Description:** 1K/10K/100K recall benchmarks plus ignored 1M where runtime
permits (spec §16.4), reporting ingest time, p50/p95, scanned/retained/
selected counts, bytes, and peak state. Verify 100K warm-lexical p95 ≤ 100 ms
or document an explicitly approved budget update.

**Acceptance criteria:**
- [ ] Benchmark logs captured to `/tmp` and summarized in docs.
- [ ] 100 ms p95 target met or an approved deviation is recorded in the spec.

**Verification:** release-mode ignored benchmarks, serial.

**Dependencies:** F1. **Files:** Axel bench tests. **Scope:** S

### Task F4: Full gates, dependency resolution, docs

**Description:** Run exact parallel workspace/plugin/Axel suites sequentially
at the eight caps; resolve the pinned-Axel build issue (publish the Axel
revision or land a self-contained path strategy — **ask first** before any
push); update plugin README, manifest version, and spec cross-references;
rebuild release binaries.

**Acceptance criteria:**
- [ ] All three repos: 0 failed at the exact caps; logs captured.
- [ ] Plugin builds without manual `--config` patches, or the interim strategy
      is documented and approved.
- [ ] `git diff --check` clean; docs updated; no lifecycle-worktree dirt
      included anywhere.

**Verification:** fresh-clone-style rebuild of the plugin; suite logs.

**Dependencies:** F1–F3. **Files:** docs, manifests, Cargo metadata. **Scope:** M

### Task F5: Independent security/privacy holdout

**Description:** Wall-separated holdout review per §1 parameters against spec
`axel-continuous-memory/1` and the §21/§25 checklists. Up to 2 fix iterations;
FAIL artifacts remain durable in history; a third iteration requires explicit
human approval.

**Acceptance criteria:**
- [ ] Weighted score ≥ 0.80; spec fidelity ≥ 0.70.
- [ ] Zero Critical or Important findings at the final iteration.
- [ ] Durable verdict artifact committed under `docs/reviews/`.

**Verification:** holdout verdict document at an exact reviewed SHA.

**Dependencies:** F4. **Files:** `docs/reviews/continuous-memory-holdout.md`.
**Scope:** M

### Checkpoint CP-F (after F1–F5) — Program gate

- [ ] Spec §25 global definition of done: all 14 items checked with evidence
      links (logs, SHAs, verdicts).
- [ ] Durable artifacts: final commits, holdout verdict, benchmark summaries.

---

## 5. Checkpoints array

```
checkpoints:
  - id: CP-0   after: [T0]                 artifact: spec+plan commits, worktrees
  - id: CP-A   after: [A1..A7]             artifact: Phase A gate + review note
  - id: CP-B   after: [B1..B6]             artifact: Phase B gate + review note
  - id: CP-C   after: [C1..C5]             artifact: Phase C gate + review note
  - id: CP-D   after: [D1..D4]             artifact: Phase D gate + review note
  - id: CP-E   after: [E1..E5]             artifact: Phase E gate + quality report
  - id: CP-F   after: [F1..F5]             artifact: holdout verdict + DoD evidence
```

Checkpoints are the compaction schedule; every checkpoint lands commits and a
durable review/verdict artifact before proceeding.

## 6. Coder dispatch doctrine

- Subagents are the coders; the orchestrator plans, reviews, steers, and
  verifies, and does not write ship code.
- Every dispatch includes an explicit `system_prompt` (no named agent files
  are assumed) — never neither.
- `model = explicit ?? session`. Fable is preferred; Kimi K3, Opus, and
  `openai-codex/gpt-5.6-sol` are recorded fallbacks for refusals, rate limits,
  or context exhaustion, with the fallback reason noted per dispatch.
- Poll-and-steer; no long blocking sleeps. Heavy suites never overlap across
  the three worktrees.
- Holdout reviewers receive only the spec, the diff, and the acceptance
  checklists — never the builder's conversation (information wall).

## 7. Parallelization

- Safe in parallel: B2 (Axel) alongside A5/A6 (host) once B1's protocol shape
  is committed (contract-first); E5 fixture authoring alongside E3/E4;
  documentation tasks.
- Strictly sequential: A1→A4→A6 (lease authority chain), C1→C3 (capture
  authority chain), D2→D3 (checkpoint semantics), all of F.
- Shared-contract coordination: B1 and C1 define wire shapes before any
  parallel consumer starts.

## 8. Top risks in execution order

| Order | Risk | Task that retires it |
|---|---|---|
| 1 | Model forges lease / self-authorizes | A1, A4, A6 (+F2 oracle) |
| 2 | Memory gains user/system authority | A7, B5 (+F2 injection fixtures) |
| 3 | Cross-project or secret leakage | B1–B3 dual validation (+F2 sentinels) |
| 4 | Unbounded capture/import queues | C3, D3 (+F2 1 GiB/slow-consumer) |
| 5 | Duplicate/stale memory corruption | C3 idempotency, E1 supersession |
| 6 | Latency regression on every prompt | B4 timeout, F3 benchmarks |
| 7 | Build not self-contained (pinned Axel rev) | F4 (ask-first resolution) |
