# Implementation Plan: Adversarial Test Oracle & Test-Authorship Integrity

**Derived from:** `engineering-plugin/specs/adversarial-test-oracle.md`
**Parent spec:** `engineering-plugin/specs/html-plan-ecosystem.md`
**Parent impl plan (conventions):** `engineering-plugin/specs/html-plan-ecosystem.impl-plan.md`
**Schema:** `engplan/1` (plan/feedback artifacts) + `oracle/1` (contract + verdict artifacts, new)
**Status:** Planning (read-only; no source code written yet)
**Plan owner:** engineering plugin

> This is a planning document only. It contains **no source code**. It decomposes
> the spec into dependency-ordered, individually verifiable tasks grouped by the
> spec's phases (**O0–O5**), with checkpoints, a headless-harness mapping, a
> security-hardening task set traceable to spec §8, and a Definition-of-Done
> cross-check against spec §11. The central invariant — *the Builder lineage can
> never author or edit the oracle* — is treated as a first-class, test-first
> control in O0 and re-verified at every checkpoint.

---

## Assumptions

These are working assumptions made to produce a concrete plan. Each is flagged so
it can be confirmed or corrected before code begins. They inherit the parent
impl-plan's runtime assumptions where applicable.

1. **Runtime/language:** the oracle tooling (orchestrator hooks, sandbox runner,
   mutation/property/fuzz engines, verdict emitters) is implemented in **Node.js
   stdlib-only** (`child_process`, `fs`, `path`, `crypto`, `http`), consistent
   with the parent's "no network install" mandate. No third-party packages.
   (If a different runtime is chosen for the parent, task structure is unchanged;
   only language-specific files move. See open decisions.)
2. **Composition point:** this oracle layer plugs into the parent's
   `convergence-loop` + tmux-fleet + Plan Inbox. Behavioral feedback and verdicts
   flow through the existing `.plans/` inbox as `actor: orchestrator`/`agent`
   events (spec §6 note); **raw hidden test source never flows through the inbox.**
3. **Lineage primitive:** "lineage" = the subagent-dispatch ancestry recorded at
   dispatch time. Designer and Builder are dispatched as **separate sibling
   subagents under one neutral orchestrator** (spec §3 rule 1), each carrying an
   explicit `agent`/`system_prompt` (parent §9.1) and `model = explicit ?? session`
   (parent §9.2). Lineage is recorded in an auditable dispatch ledger.
4. **Write-segregation enforcement mechanism:** enforced at the orchestrator/merge
   boundary as a **diff gate** (pre-merge hook) — *not* a kernel/FS ACL — because
   the threat model (spec §1.3) is "an agent optimizing for tests pass," not root.
   Any Builder-lineage diff touching `.oracle/**` is **rejected** before merge.
   A git-level guard (pre-commit/server-side check) is added as defense-in-depth.
5. **Sandbox substrate (spec §9 #1):** default to **container** when a container
   runtime is available; fall back to a **separate OS user** (zero-dep). Both
   present the *same* verdict-only interface so the rest of the plan is substrate-
   agnostic. Confirmed at the O1 gate.
6. **Verdict-only egress contract:** the sandbox returns a typed `oracle/1` verdict
   object — pass/fail counts + failure *category* codes + audit ids — and **never**
   test source, asserted values, inputs, or stack frames that reveal expectations.
   This is a hard schema boundary, validated on both ends.
7. **Mutation tooling (spec §9 #2):** a **small custom operator set tied to the
   contract** (e.g. flip comparisons, drop a guard, off-by-one, swap status code),
   not a heavyweight language-native mutator — keeps it dependency-free and
   contract-relevant. Confirmed at O2 gate.
8. **Property/generative framework (spec §9 #3):** a **vendored tiny generator**
   (seeded PRNG + shrinker) lives under `.oracle/properties/`; authored only by the
   Designer lineage. No external QuickCheck dependency.
9. **Test runner / headless:** everything runs under `node --test` plus a scenario
   runner (mirrors the parent's Addendum A harness), so the whole oracle builds and
   verifies **headless** with `npm run oracle:e2e`. No human in the loop.
10. **Commit-reveal hash:** SHA-256 over a canonicalized tarball of the hidden
    suite + mutants + generators, salted with a per-round nonce, recorded in
    `.oracle/reveal/` before the Builder freezes. Reveal re-hashes and verifies.
11. **One vertical slice per phase minimum:** each O-phase delivers an end-to-end
    runnable increment (consistent with parent §16 / Addendum A).
12. **Working repo:** the engineering plugin repo; `.oracle/**` and `.plans/**`
    fixtures are created in temp repos during tests, not committed from tests.

---

## Spec ambiguities / open decisions

Addresses the spec's **§9 Open Decisions** with a planning resolution and the gate
where each must be confirmed. None fully block planning.

| # (spec §9) | Open decision | Planning resolution | Confirm at gate |
|---|---|---|---|
| 1 | **Sandbox substrate** (user / container / remote) | Container default if runtime present; separate-OS-user zero-dep fallback. Both expose identical verdict-only API → rest of plan is substrate-agnostic. | **C-O1** |
| 2 | **Mutation tooling** (native mutator vs custom operators) | Custom contract-tied operator set (Assumption 7); dependency-free, mutants live in `.oracle/mutants/`. | **C-O2** |
| 3 | **Property/generative framework** (vendored vs hand-rolled) | Vendored tiny seeded generator + shrinker (Assumption 8). | **C-O2** |
| 4 | **Differential twins** (always-on vs disagreement-prone only) | **On-demand by default** (cost), with a config flag to force always-on for designated risk areas. Twins spawned via the tmux fleet (nearly free). | **C-O4** |
| 5 | **Adversary budget** (time/iters/coverage = "exhausted") | Composite budget: `max_fuzz_inputs`, `max_mutants`, `max_property_cases`, `max_wall_seconds`, AND a stagnation rule (N rounds with no new kill/crash). Governed by `convergence-loop` bounds. Defaults proposed in O5-1. | **C-O5** |
| 6 | **Where the contract lives / who re-freezes** | `.oracle/contract/` owned by the **Architect** lineage; re-freeze is a controlled event (re-commit-reveal), never an ad-hoc Designer/Builder edit (spec §4.1). | **C-O0** |
| 7 | **Designer reward function + Judge feed** | Reward = weighted sum of `mutant_kills + fuzz_crashes + hidden_failures_provoked + twin_divergences_surfaced`; **never** rewards Builder passing (spec §3 rule 3). Feeds Judge as the adversary-strength signal. Formula fixed in O5-1. | **C-O5** |

Additional planning-level ambiguities surfaced during decomposition:

| # | Ambiguity | Resolution |
|---|---|---|
| A | "Lineage" enforcement granularity (process vs git author vs dispatch ledger) | Use the **dispatch ledger** (Assumption 3) as source of truth + git author as corroboration; diff-gate is the hard control. |
| B | Scope of "scenario *names* of hidden cases" the Builder may see (spec §3 Builder row) | Builder receives **category labels only** (e.g. "malformed-input safety", "append-only events"), never inputs or asserts. Defined in O1-3. |
| C | Re-open policy for a "survived" mutant that later regresses | A survived mutant that escapes becomes a new permanent public/hidden test (spec §4.7); regressions re-open the round. Encoded in O5-2. |
| D | Where verdicts surface to humans | Through the Plan Inbox as `oracle-status` sections/events (spec §6 note); raw hidden source excluded by the egress contract. |

---

## Engineering ground rules (apply to every task)

- **Read-only planning first; worktree isolation before code.** Each phase runs in
  a dedicated worktree (`feat/oracle-O<n>` per `worktrees-by-default`); slug shared
  across branch/worktree/artifacts.
- **Siblings, not nested (spec §3 rule 1).** Designer and Builder are dispatched as
  separate sibling subagents under a neutral orchestrator; the planner/orchestrator
  **never grades its own work**.
- **Authorship segregation is sacred (spec §3 rule 2).** The Builder lineage may
  never create/modify any `.oracle/**` path. This is enforced *and* tested.
- **Test-first, especially for controls.** Write the failing test before the
  control (per `test-driven-development`, parent §13 / Addendum A.3 red→green).
- **Verdict-only discipline.** No task may cause hidden test source, asserted
  values, or raw inputs to cross the sandbox boundary.
- **Headless mandate.** Every phase is runnable + verifiable with no human
  (`npm run oracle:e2e`), mirroring the parent Addendum A.
- **Subagent dispatch invariant (parent §9.1):** every dispatch carries `agent` or
  `system_prompt` — never neither; `model = explicit ?? session` (§9.2).
- **Scope sizing:** XS ≈ <1h; S ≈ half-day; M ≈ ~1–2 days. Anything larger was
  split. No task is L+.

---

## Artifact layout (spec §6) — target end state

```
.oracle/
  contract/      # frozen contract: schemas, signatures, exit codes, event shapes (Architect-owned)
  public/        # public suite — Builder may READ, may NOT edit
  hidden/        # hidden suite — NEVER in the Builder's reach (sandbox-only)
  properties/    # invariants + seeded generators
  mutants/       # mutation operators / planted-fault catalog
  fuzz/          # adversarial fuzz harness
  reveal/        # commit-reveal hashes + reveal records (audit)
  verdicts/      # verdict-only outputs from the sandbox runner
test/oracle-harness/   # headless scenario runner, sims, fault catalog (mirrors parent Addendum A)
tools/oracle/          # orchestrator hooks: diff-gate, lineage ledger, sandbox launcher
```

---

## Phase O0 — Frozen contract + Architect role + write-segregation

**Goal (spec §10 O0):** Frozen contract format + Architect role; write-segregation
enforcement of `.oracle/**`. **Proves:** Builder cannot author/edit the oracle;
tests can target a contract.

### O0-0 — Oracle skeleton + headless harness foundation (tests first)
- **Description:** Create the `.oracle/**` directory skeleton, `tools/oracle/`,
  `test/oracle-harness/` scenario runner with ephemeral temp-repo fixtures,
  injectable clock/ids, and a `--prove` red→green mode. No feature logic.
- **Acceptance criteria:**
  - `npm run oracle:e2e -- --list` lists scenarios; empty suite reports 0 failures.
  - No third-party package fetched (offline verified).
  - Layout matches spec §6 (`contract/public/hidden/properties/mutants/fuzz/reveal/verdicts`).
- **Verification:** `node --test test/oracle-harness/foundation.test.js ; echo exit=$?` ; `ls .oracle/contract .oracle/hidden .oracle/verdicts`
- **Dependencies:** None
- **Files likely touched:** `.oracle/**/.gitkeep`, `tools/oracle/`, `test/oracle-harness/*`, `package.json` (script)
- **Scope:** S

### O0-1 — `oracle/1` contract schema + validator (tests first)
- **Description:** Define the machine-readable contract format (spec §4.1): data
  schemas (e.g. `engplan/1`), endpoint signatures + status codes, CLI exit codes,
  event shapes, error taxonomy. Implement a boundary validator `parseContract`.
- **Acceptance criteria:**
  - A valid contract parses into a typed shape; missing required groups rejected.
  - Endpoint signatures, status codes, exit codes, event shapes, error taxonomy
    are all representable and validated.
  - Malformed contract yields a safe, categorized error — never a crash.
  - Contract carries a `version`/`frozen_at` and is content-addressable (hashable).
- **Verification:** `node --test test/oracle-harness/contract_schema.test.js`
- **Dependencies:** O0-0
- **Files likely touched:** `tools/oracle/contract.js`, `.oracle/contract/contract.schema.json`, `test/oracle-harness/contract_schema.test.js`
- **Scope:** M

### O0-2 — Architect role + contract freeze procedure (tests first)
- **Description:** Define the Architect lineage that freezes the contract and the
  controlled re-freeze event (spec §4.1, §9 #6). Freeze writes an immutable,
  hashed contract artifact + records the freeze in the audit trail; re-freeze
  requires a new commit-reveal cycle (wired in O3).
- **Acceptance criteria:**
  - Freeze produces an immutable contract artifact with a recorded content hash.
  - Re-freeze is rejected unless invoked through the controlled procedure (not an
    ad-hoc edit); each freeze is appended to the audit trail.
  - Architect lineage is recorded distinctly from Designer/Builder in the ledger.
- **Verification:** `node --test test/oracle-harness/freeze.test.js`
- **Dependencies:** O0-1
- **Files likely touched:** `tools/oracle/freeze.js`, `.oracle/reveal/` (freeze records), `test/oracle-harness/freeze.test.js`
- **Scope:** S

### O0-3 — Lineage dispatch ledger (siblings, not nested) (tests first)
- **Description:** Implement the dispatch ledger (Assumption 3, spec §3 rule 1):
  records every role dispatch with `role`, `lineage_id`, `parent_id`, `agent`/
  `system_prompt`, `model`, timestamp. Enforces Designer and Builder are **siblings
  under a neutral orchestrator** — neither is an ancestor of the other.
- **Acceptance criteria:**
  - A dispatch with neither `agent` nor `system_prompt` is **refused** (parent §9.1).
  - A dispatch with no `model` resolves to the session model, never a weaker default.
  - The ledger rejects a configuration where Builder is an ancestor/descendant of
    Designer (must be siblings); rejects a grader parenting its graded party.
  - Ledger is append-only and auditable.
- **Verification:** `node --test test/oracle-harness/lineage_ledger.test.js`
- **Dependencies:** O0-0
- **Files likely touched:** `tools/oracle/lineage.js`, `.oracle/reveal/lineage.log`, `test/oracle-harness/lineage_ledger.test.js`
- **Scope:** M

### O0-4 — Write-segregation diff gate: reject Builder edits to `.oracle/**` (tests first) **[CENTRAL CONTROL]**
- **Description:** Implement the orchestrator pre-merge diff gate (Assumption 4,
  spec §3 rule 2, §6, §8): given a diff and its authoring `lineage_id`, **reject any
  Builder-lineage diff that touches any `.oracle/**` path** (and any test/oracle
  path generally). Only Designer/Architect lineages may create/modify oracle files.
  Add a git pre-commit/server-side guard as defense-in-depth.
- **Acceptance criteria:**
  - A Builder-lineage diff adding/modifying/deleting any file under `.oracle/**` is
    **rejected** with a categorized reason (green-by-vandalism prevented).
  - A Builder diff touching only product code is **accepted**.
  - A Designer-lineage diff to `.oracle/**` is accepted; an Architect diff to
    `.oracle/contract/**` is accepted.
  - Rename/symlink/path-normalization tricks to smuggle an oracle edit are caught
    (canonicalize paths before matching).
  - The git-level guard independently blocks a committed Builder oracle edit.
- **Verification:** `node --test test/oracle-harness/write_segregation.test.js`
- **Dependencies:** O0-3
- **Files likely touched:** `tools/oracle/diff_gate.js`, `tools/oracle/git_guard.sh`, `test/oracle-harness/write_segregation.test.js`
- **Scope:** M

### ✅ Checkpoint C-O0 (gate before O1)
**Pass conditions (headless):**
- `oracle/1` contract validates; freeze produces an immutable, hashed artifact.
- Lineage ledger enforces siblings-not-nested and refuses dispatch missing
  `agent`/`system_prompt`; resolves missing `model` to session model.
- **Write-segregation diff gate rejects every Builder-lineage edit to `.oracle/**`**
  (incl. rename/symlink smuggling) and accepts Designer/Architect edits — proven
  red→green via `--prove`.
- Open decision **#6** (contract location/owner) recorded in the plan artifact.
- `npm run oracle:e2e` green for O0 scenarios; zero network installs.

---

## Phase O1 — Public/hidden split + sandbox runner (verdict-only)

**Goal (spec §10 O1):** Public/hidden split + sandbox runner (verdict-only).
**Proves:** Coder graded on tests it can't read.

### O1-0 — Sandbox substrate decision gate (spike) (spec §9 #1)
- **Description:** Resolve substrate (container vs OS-user vs remote). Produce a
  1-page decision record; confirm the chosen substrate runs with no network
  install and presents the identical verdict-only interface.
- **Acceptance criteria:**
  - Decision record committed in the plan artifact; substrate confirmed runnable.
  - The substrate cannot read the Builder's worktree oracle source and the Builder
    cannot read the sandbox's hidden source (path isolation documented).
- **Verification:** review decision record; `tools/oracle/sandbox/probe --selftest` reports isolation OK.
- **Dependencies:** C-O0
- **Files likely touched:** plan artifact (decision record), `tools/oracle/sandbox/`
- **Scope:** XS

### O1-1 — Public suite layout: readable-but-not-editable by Builder (tests first)
- **Description:** Establish `.oracle/public/` as the suite the Builder may **read**
  and develop against (spec §4.2), but never edit (enforced by O0-4 diff gate).
  Public suite runs in the worktree.
- **Acceptance criteria:**
  - Builder lineage can read/run `.oracle/public/**` but a diff editing it is rejected.
  - Public suite executes in the worktree and yields normal pass/fail output.
- **Verification:** `node --test test/oracle-harness/public_suite.test.js`
- **Dependencies:** O1-0, O0-4
- **Files likely touched:** `.oracle/public/`, `tools/oracle/run_public.js`, `test/oracle-harness/public_suite.test.js`
- **Scope:** S

### O1-2 — Verdict-only egress schema (`oracle/1` verdict) (tests first) **[EGRESS CONTRACT]**
- **Description:** Define the typed verdict object (Assumption 6, spec §4.2, §8
  "verdict minimization"): pass/fail counts + failure **category** codes + audit
  ids + nonce. Validator **rejects** any verdict carrying test source, asserted
  values, raw inputs, or revealing stack frames.
- **Acceptance criteria:**
  - A well-formed verdict (counts + categories + ids) validates.
  - A verdict containing test source / asserted values / raw input / file paths to
    hidden tests is **rejected** by the schema (leak prevention).
  - Categories come from a fixed taxonomy tied to the contract's error taxonomy.
- **Verification:** `node --test test/oracle-harness/verdict_schema.test.js`
- **Dependencies:** O0-1
- **Files likely touched:** `tools/oracle/verdict.js`, `.oracle/contract/verdict.schema.json`, `test/oracle-harness/verdict_schema.test.js`
- **Scope:** M

### O1-3 — Hidden suite + scenario-name catalog (Builder sees labels only) (tests first)
- **Description:** Author the hidden suite under `.oracle/hidden/` (Designer lineage
  only) and a **category-label catalog** the Builder may see (Ambiguity B, spec §3
  Builder row): names/labels of hidden scenarios, never inputs or asserts.
- **Acceptance criteria:**
  - Hidden suite is present only in the sandbox image/user, **absent/unreadable**
    from the Builder worktree.
  - Builder can fetch the label catalog (e.g. "malformed `engplan/1` safety") but
    not the underlying tests/inputs/asserts.
  - Attempting to read `.oracle/hidden/**` from the Builder context fails.
- **Verification:** `node --test test/oracle-harness/hidden_isolation.test.js`
- **Dependencies:** O1-0, O1-2
- **Files likely touched:** `.oracle/hidden/`, `.oracle/hidden/labels.json`, `test/oracle-harness/hidden_isolation.test.js`
- **Scope:** M

### O1-4 — Sandbox hidden-test runner (verdict-only egress) (tests first) **[SANDBOX RUNNER]**
- **Description:** Implement the sandbox runner (spec §4.2, §8): mount Builder
  artifact (read-only) into the isolated substrate, run the hidden suite, emit
  **only** an `oracle/1` verdict. No path back into oracle source from the Builder.
- **Acceptance criteria:**
  - Running the hidden suite against a Builder artifact returns a valid verdict
    (counts + categories), nothing else.
  - The runner's only output channel is the verdict file; no hidden source, inputs,
    or asserts are emitted on any channel (stdout/stderr/files).
  - Builder process has no read access to hidden suite source; egress is verdict-only.
  - Runner is resource-bounded (timeout/memory) — runaway hidden tests are killed.
- **Verification:** `node --test test/oracle-harness/sandbox_runner.test.js`
- **Dependencies:** O1-3, O1-2
- **Files likely touched:** `tools/oracle/sandbox/run_hidden.js`, `tools/oracle/sandbox/Dockerfile|user-setup.sh`, `test/oracle-harness/sandbox_runner.test.js`
- **Scope:** M

### O1-5 — "Seeing public doesn't help pass hidden" proof scenario (tests first)
- **Description:** Headless scenario (spec §4.2 success criterion, §1.2): a Builder
  that overfits to the *public* suite still fails the hidden suite unless the
  contract is genuinely satisfied.
- **Acceptance criteria:**
  - An overfit-to-public Builder artifact passes public but the hidden verdict
    reports failures in the relevant categories.
  - A genuinely contract-correct artifact passes both.
- **Verification:** `node --test test/oracle-harness/public_no_help.test.js`
- **Dependencies:** O1-4, O1-1
- **Files likely touched:** `test/oracle-harness/public_no_help.test.js`, fixtures
- **Scope:** S

### ✅ Checkpoint C-O1 (gate before O2)
**Pass conditions (headless):**
- Public suite readable-but-not-editable by Builder; hidden suite unreadable.
- Sandbox runner emits **verdict-only** output (schema-enforced); no hidden source/
  asserts/inputs leak on any channel — proven by the egress-leak test.
- Overfitting to public does not pass hidden (O1-5 red→green proof).
- Open decision **#1** (substrate) confirmed and recorded.
- `npm run oracle:e2e` green for O0–O1; zero network installs.

---

## Phase O2 — Property/generative + mutation testing (oracle self-validation)

**Goal (spec §10 O2):** Property/generative tests + mutation testing. **Proves:**
Overfitting and weak suites are caught.

### O2-0 — Property/generative framework decision gate (spike) (spec §9 #3)
- **Description:** Confirm the vendored tiny generator + shrinker design
  (Assumption 8); record decision.
- **Acceptance criteria:** decision recorded; generator is dependency-free + seedable.
- **Verification:** review decision record; `node -e "require('./tools/oracle/gen').version"`
- **Dependencies:** C-O1
- **Files likely touched:** plan artifact, `tools/oracle/gen.js`
- **Scope:** XS

### O2-1 — Property engine: invariants + seeded generator + shrinker (tests first)
- **Description:** Implement the property/generative engine (spec §4.3): Designer
  writes invariants (e.g. "no write outside `.plans/`", "every accepted note appears
  in a later GET", "events append-only", "malformed `engplan/1` → safe error, never
  crash"); a seeded generator fires thousands of randomized cases; failures shrink
  to a minimal counterexample.
- **Acceptance criteria:**
  - A known-violated invariant is caught and shrunk to a minimal counterexample.
  - A held invariant passes across N≥1000 generated cases deterministically (seed).
  - Properties live under `.oracle/properties/` (Designer-only; diff-gated by O0-4).
  - Counterexample reporting respects verdict minimization (category, not asserted
    values) when surfaced across the sandbox boundary.
- **Verification:** `node --test test/oracle-harness/properties.test.js`
- **Dependencies:** O2-0
- **Files likely touched:** `tools/oracle/properties.js`, `.oracle/properties/`, `test/oracle-harness/properties.test.js`
- **Scope:** M

### O2-2 — Anti-overfit proof: property over infinite space (tests first)
- **Description:** Scenario (spec §4.3): a Builder that hardcodes public examples
  fails a property because the generator explores an effectively infinite input
  space the Builder cannot enumerate.
- **Acceptance criteria:**
  - A lookup-table/overfit Builder fails ≥1 property with a generated counterexample.
  - A general, correct Builder passes the property suite.
- **Verification:** `node --test test/oracle-harness/antioverfit.test.js`
- **Dependencies:** O2-1
- **Files likely touched:** `test/oracle-harness/antioverfit.test.js`, fixtures
- **Scope:** S

### O2-3 — Mutation operators tied to the contract (tests first) (spec §9 #2)
- **Description:** Implement the custom mutation operator set (Assumption 7, spec
  §4.4): inject deliberate faults into the Builder's code (flip comparison, drop a
  guard, off-by-one, wrong status/exit code, swap event field). Catalog lives in
  `.oracle/mutants/` (Designer-only).
- **Acceptance criteria:**
  - Each operator produces a compilable/runnable mutant artifact.
  - Mutant catalog is reproducible (seeded) and enumerable.
  - Operators map to contract elements (status codes, exit codes, event shapes).
- **Verification:** `node --test test/oracle-harness/mutation_ops.test.js`
- **Dependencies:** O2-0
- **Files likely touched:** `tools/oracle/mutate.js`, `.oracle/mutants/`, `test/oracle-harness/mutation_ops.test.js`
- **Scope:** M

### O2-4 — Mutation gate: a suite that fails to kill mutants is REJECTED (tests first) **[ORACLE SELF-VALIDATION]**
- **Description:** Implement the mutation gate (spec §4.4, §1.2): run the suite
  (public + hidden + properties) against each mutant; require a **kill rate ≥
  threshold**. A suite that fails to catch planted bugs is **rejected before it is
  trusted** ("who tests the tester").
- **Acceptance criteria:**
  - A strong suite kills ≥ threshold of mutants → suite **accepted**.
  - A deliberately weak suite (low kill rate) is **rejected** with a report of
    surviving mutants (categories only across the boundary).
  - Surviving mutants are recorded as audit items and feed O5 self-play (become new
    tests).
  - The gate is itself produced by the Designer lineage (recursively diff-gated).
- **Verification:** `node --test test/oracle-harness/mutation_gate.test.js`
- **Dependencies:** O2-3, O2-1, O1-4
- **Files likely touched:** `tools/oracle/mutation_gate.js`, `test/oracle-harness/mutation_gate.test.js`
- **Scope:** M

### O2-5 — Fuzz harness (adversarial inputs) (tests first)
- **Description:** Implement `.oracle/fuzz/` adversarial fuzzing (spec §4.7 input
  source): feed malformed/extreme inputs; assert safe error, never crash; a crash
  becomes a new property (wired in O5).
- **Acceptance criteria:**
  - Fuzzer drives bounded randomized malformed inputs; crashes are captured + minimized.
  - A planted crash bug is found; a robust artifact survives the fuzz budget.
  - Fuzzer is resource-bounded (count/time/memory) per spec §8.
- **Verification:** `node --test test/oracle-harness/fuzz.test.js`
- **Dependencies:** O2-1
- **Files likely touched:** `tools/oracle/fuzz.js`, `.oracle/fuzz/`, `test/oracle-harness/fuzz.test.js`
- **Scope:** S

### ✅ Checkpoint C-O2 (gate before O3)
**Pass conditions (headless):**
- Property engine catches+shrinks a violated invariant; overfit Builder fails (O2-2).
- **Mutation gate rejects a deliberately weak suite** and accepts a strong one
  (O2-4 red→green proof) — the oracle self-validates.
- Fuzz harness finds a planted crash within budget; bounds enforced.
- Open decisions **#2** (mutation) and **#3** (properties) confirmed + recorded.
- `npm run oracle:e2e` green for O0–O2.

---

## Phase O3 — Commit-reveal protocol + audit trail

**Goal (spec §10 O3):** Commit-reveal protocol + audit trail. **Proves:** No
post-hoc adaptation by either side.

### O3-1 — Commit phase: hash hidden suite + mutants before Builder freeze (tests first)
- **Description:** Implement the commit step (Assumption 10, spec §4.5): Designer
  publishes a salted SHA-256 over a canonicalized bundle of the hidden suite +
  mutants + generators **before** the Builder freezes its implementation. Record in
  `.oracle/reveal/`.
- **Acceptance criteria:**
  - A commit record (hash + nonce + timestamp + lineage) is written before the
    Builder freeze marker exists.
  - The hash is canonical/deterministic over the bundle (stable across reorder).
  - The committed bundle content is **not** revealed at commit time (hash only).
- **Verification:** `node --test test/oracle-harness/commit.test.js`
- **Dependencies:** C-O2
- **Files likely touched:** `tools/oracle/commit_reveal.js`, `.oracle/reveal/`, `test/oracle-harness/commit.test.js`
- **Scope:** M

### O3-2 — Builder freeze marker + ordering enforcement (tests first)
- **Description:** Record the Builder's implementation freeze (content hash +
  timestamp). Enforce the temporal ordering: **commit precedes freeze precedes
  reveal** (spec §4.5).
- **Acceptance criteria:**
  - A freeze recorded before any commit is rejected (proves Builder could not peek).
  - A reveal attempted before the Builder freeze is rejected.
  - Ordering violations are categorized audit failures.
- **Verification:** `node --test test/oracle-harness/freeze_order.test.js`
- **Dependencies:** O3-1
- **Files likely touched:** `tools/oracle/commit_reveal.js`, `test/oracle-harness/freeze_order.test.js`
- **Scope:** S

### O3-3 — Reveal phase: verify hash matches committed bundle (tests first)
- **Description:** Implement reveal (spec §4.5): after Builder freeze, the Designer
  reveals the bundle; the orchestrator re-hashes and verifies it matches the prior
  commit — proving the Designer did not weaken tests after seeing code.
- **Acceptance criteria:**
  - Reveal of the exact committed bundle verifies OK.
  - A reveal of a **modified** bundle (test weakened post-freeze) is **rejected**
    (hash mismatch) — anti post-hoc adaptation proven.
  - Reveal record (verified/failed) appended to the audit trail.
- **Verification:** `node --test test/oracle-harness/reveal.test.js`
- **Dependencies:** O3-2
- **Files likely touched:** `tools/oracle/commit_reveal.js`, `.oracle/reveal/`, `test/oracle-harness/reveal.test.js`
- **Scope:** M

### O3-4 — Durable audit trail + Plan Inbox surfacing (tests first)
- **Description:** Make commit-reveal records, freeze markers, verdicts, mutation
  results, and lineage durable + auditable (spec §6, §8), and surface **status**
  (not hidden source) to the Plan Inbox as `oracle-status` events (Ambiguity D).
- **Acceptance criteria:**
  - Every freeze/commit/reveal/verdict is appended immutably with lineage + time.
  - Plan Inbox receives `oracle-status` events (counts/categories/verdict state);
    **no raw hidden test source** ever enters the inbox.
  - Audit trail is replayable to reconstruct a round's history.
- **Verification:** `node --test test/oracle-harness/audit_trail.test.js`
- **Dependencies:** O3-3, O1-2
- **Files likely touched:** `tools/oracle/audit.js`, `.plans/` event emitter, `test/oracle-harness/audit_trail.test.js`
- **Scope:** S

### ✅ Checkpoint C-O3 (gate before O4)
**Pass conditions (headless):**
- Commit recorded **before** freeze; ordering violations rejected.
- **Reveal verifies an unmodified bundle and rejects a post-freeze-weakened bundle**
  (O3-3 red→green proof).
- Audit trail durable + replayable; Plan Inbox shows oracle status with **no hidden
  source leakage**.
- `npm run oracle:e2e` green for O0–O3.

---

## Phase O4 — Differential twins via the fleet

**Goal (spec §10 O4):** Differential twins via the fleet. **Proves:** Cheap
independent oracle from disagreement.

### O4-0 — Twins policy decision gate (spike) (spec §9 #4)
- **Description:** Confirm on-demand-default + always-on-for-risk-areas flag
  (Open decision #4); record.
- **Acceptance criteria:** decision recorded; cost model noted.
- **Verification:** review decision record.
- **Dependencies:** C-O3
- **Files likely touched:** plan artifact, `tools/oracle/twins.config.json`
- **Scope:** XS

### O4-1 — Spawn two zero-contact Builders from one contract (tests first)
- **Description:** Implement twin spawning via the tmux fleet (spec §4.6, parent
  §4.6): two Builder siblings from the same contract, **zero contact** (never meet,
  separate worktrees/panes, separate lineages — cannot collude).
- **Acceptance criteria:**
  - Two Builder lineages are dispatched as siblings; neither can read the other's
    worktree or context (no shared ancestry, per spec §3 rule 1).
  - Both bind only to the frozen contract; dispatch carries `agent`/`system_prompt`
    and `model = explicit ?? session`.
- **Verification:** `node --test test/oracle-harness/twins_spawn.test.js`
- **Dependencies:** O4-0, O0-3
- **Files likely touched:** `tools/oracle/twins.js`, `test/oracle-harness/twins_spawn.test.js`
- **Scope:** M

### O4-2 — Differential comparator: surface disagreements to Judge (tests first)
- **Description:** Run both twins on generated inputs (reuse O2-1 generator);
  on any input where outputs **disagree**, at least one is wrong → surface a
  divergence record to the Judge (spec §4.6).
- **Acceptance criteria:**
  - On a generated input where twins disagree, a divergence record is produced and
    routed to the Judge (category + audit id; not raw asserted oracle values).
  - On inputs where twins agree, no divergence is raised.
  - Comparator is bounded (input budget) per spec §8.
- **Verification:** `node --test test/oracle-harness/twins_diff.test.js`
- **Dependencies:** O4-1, O2-1
- **Files likely touched:** `tools/oracle/twins_diff.js`, `test/oracle-harness/twins_diff.test.js`
- **Scope:** M

### O4-3 — Injected-divergence proof (DoD §11 item) (tests first)
- **Description:** Headless scenario proving twins surface **at least one injected
  divergence** (spec §11 DoD item): plant a difference in one twin; assert the
  comparator catches it.
- **Acceptance criteria:**
  - With one twin deliberately perturbed, the comparator surfaces ≥1 divergence.
  - With identical-correct twins, zero false divergences.
- **Verification:** `node --test test/oracle-harness/twins_injected.test.js`
- **Dependencies:** O4-2
- **Files likely touched:** `test/oracle-harness/twins_injected.test.js`, fixtures
- **Scope:** S

### ✅ Checkpoint C-O4 (gate before O5)
**Pass conditions (headless):**
- Two zero-contact Builder siblings spawn from one contract; cannot collude.
- Comparator surfaces injected divergence (O4-3 red→green proof); no false positives.
- Open decision **#4** (twins policy) confirmed + recorded.
- `npm run oracle:e2e` green for O0–O4.

---

## Phase O5 — Adversarial self-play loop + "survived budget" done-condition + Judge

**Goal (spec §10 O5):** Adversarial self-play loop + "survived budget" done-
condition; Judge integration. **Proves:** Trustworthy autonomous green.

### O5-0 — Behavioral-feedback channel (no test-source leakage) (tests first)
- **Description:** Implement fix-loop feedback to the Builder describing **behavior
  gaps** only (spec §5 note, §8): failure categories, not test internals or asserted
  values. Routed through the Plan Inbox.
- **Acceptance criteria:**
  - Feedback messages contain only behavioral categories + which contract element
    failed; **never** hidden test source, inputs, or asserted values.
  - A leakage attempt (feedback embedding asserted values) is rejected by the
    egress validator (reuse O1-2).
- **Verification:** `node --test test/oracle-harness/feedback_minimization.test.js`
- **Dependencies:** C-O4, O1-2
- **Files likely touched:** `tools/oracle/feedback.js`, `test/oracle-harness/feedback_minimization.test.js`
- **Scope:** S

### O5-1 — Adversary budget + Designer reward function (tests first) (spec §9 #5, #7)
- **Description:** Define the composite adversary budget (Open decision #5) and the
  Designer reward function (Open decision #7, spec §3 rule 3): reward = weighted
  `mutant_kills + fuzz_crashes + hidden_failures_provoked + twin_divergences`;
  **never** rewards the Builder passing. Governed by `convergence-loop` bounds
  (threshold, max_fix_iterations, max_total_calls, stagnation).
- **Acceptance criteria:**
  - Budget exhaustion is computable: `max_fuzz_inputs`/`max_mutants`/
    `max_property_cases`/`max_wall_seconds` AND stagnation (N rounds, no new find).
  - Reward increases only with bugs caught; a Designer that lets the Builder pass
    scores **zero** marginal reward (collusion is irrational).
  - The reward feeds the Judge as the adversary-strength signal.
- **Verification:** `node --test test/oracle-harness/budget_reward.test.js`
- **Dependencies:** O5-0
- **Files likely touched:** `tools/oracle/budget.js`, `tools/oracle/reward.js`, `test/oracle-harness/budget_reward.test.js`
- **Scope:** M

### O5-2 — Self-play loop: each survived round strengthens the oracle (tests first)
- **Description:** Implement the adversarial flywheel (spec §4.7): the Designer
  continuously searches for contract violations (new properties, mutants, fuzz
  inputs); a **survived mutant → a new test**, a **fuzz crash → a new property**.
  Oracle and Builder co-evolve over the frozen contract (AlphaZero-style). Encode
  re-open on regression (Ambiguity C).
- **Acceptance criteria:**
  - A surviving mutant is converted into a new permanent public/hidden test.
  - A fuzz crash is converted into a new property; both persist to `.oracle/**`
    (Designer lineage; diff-gated).
  - A later regression of a previously-survived case re-opens the round.
  - Each round records its strengthening artifacts to the audit trail.
- **Verification:** `node --test test/oracle-harness/selfplay.test.js`
- **Dependencies:** O5-1, O2-4, O2-5
- **Files likely touched:** `tools/oracle/selfplay.js`, `test/oracle-harness/selfplay.test.js`
- **Scope:** M

### O5-3 — Judge integration: score vs contract + behavioral feedback (tests first)
- **Description:** Implement the Judge (spec §3, §5): consumes contract + verdicts
  (+ code only in `informed` mode), produces a **score + structured behavioral
  feedback**. In `holdout` mode the Judge does **not** see the code.
- **Acceptance criteria:**
  - Judge produces a score and behavioral feedback from verdicts + adversary signal.
  - In `holdout` mode, the Judge has no access to Builder code (asserted).
  - Judge feedback is behavior-only (reuses O5-0 minimization).
- **Verification:** `node --test test/oracle-harness/judge.test.js`
- **Dependencies:** O5-1, O5-0
- **Files likely touched:** `tools/oracle/judge.js`, `test/oracle-harness/judge.test.js`
- **Scope:** M

### O5-4 — "Survived budget" done-condition (tests first) **[DONE CONDITION]**
- **Description:** Implement the machine-checkable done verdict (spec §4.7, §1.2,
  §11): **Done = adversary exhausted its budget AND score ≥ threshold**, with a full
  audit trail, produced **headless**. Not "a fixed list passed."
- **Acceptance criteria:**
  - When the adversary still finds a violation within budget → **NOT done** (loop).
  - When the adversary is exhausted **and** score ≥ threshold → **SHIP** (trustworthy
    green) with a complete, replayable audit trail.
  - Score ≥ threshold but adversary **not** exhausted → NOT done.
  - The verdict is emitted headless and surfaced to the Plan Inbox as oracle status.
- **Verification:** `node --test test/oracle-harness/done_condition.test.js`
- **Dependencies:** O5-2, O5-3
- **Files likely touched:** `tools/oracle/done.js`, `test/oracle-harness/done_condition.test.js`
- **Scope:** M

### O5-5 — Convergence-loop + tmux-fleet + subagent-doctrine integration (spec §7)
- **Description:** Wire the oracle into `convergence-loop` (this *is* the hardened
  holdout loop), the tmux fleet (Designer/Builder-twins/Tester-sandbox/Judge as
  separate pane lineages), and the subagent doctrine (parent §9.1/§9.2). Update
  skill prose to reference the oracle layer; no CDN, no `0.0.0.0`.
- **Acceptance criteria:**
  - `convergence-loop` references the write-protected oracle, hidden grading,
    mutation validation, and the survived-budget done-condition; its bounds govern.
  - Designer and Builder dispatched as **separate sibling lineages** (grep-verifiable).
  - Every dispatch carries `agent`/`system_prompt`; `model = explicit ?? session`.
- **Verification:** `grep -rn "adversarial\|hidden suite\|survived budget\|write-segregation" engineering-plugin/skills/convergence-loop` ; `node --test test/oracle-harness/integration_dispatch.test.js`
- **Dependencies:** O5-4, O0-3
- **Files likely touched:** `skills/convergence-loop/*`, `skills/security-review/*`, `skills/worktrees-by-default/*`, `test/oracle-harness/integration_dispatch.test.js`
- **Scope:** M

### O5-6 — Full adversarial self-play e2e + CI gate (`npm run oracle:e2e`)
- **Description:** End-to-end headless scenario: Architect freezes contract →
  commit-reveal → Designer (adversary) + Builder twins (siblings) → Tester (public
  in worktree + hidden in sandbox, verdict-only) + properties + mutation +
  differential → Judge → self-play until **survived budget + score ≥ threshold** →
  SHIP, with full audit trail. Single command, exits non-zero on any failure.
- **Acceptance criteria:**
  - `npm run oracle:e2e` runs the whole loop headless and exits 0 only on a
    trustworthy-green verdict; non-zero on any gate failure.
  - The run records: lineage (siblings), write-segregation enforced, hidden verdict-
    only, mutation gate active, commit-reveal verified, ≥1 twin divergence in test,
    survived-budget done-condition met — all in the audit trail.
  - Red→green provable for the central controls (write-segregation, mutation gate,
    reveal mismatch rejection, public-no-help, injected divergence).
- **Verification:** `npm run oracle:e2e`
- **Dependencies:** O5-4, O5-5, all prior phases
- **Files likely touched:** `test/oracle-harness/selfplay_e2e.test.js`, `package.json`, CI config
- **Scope:** M

### ✅ Checkpoint C-O5 (final gate / release)
**Pass conditions (headless):**
- Self-play loop strengthens the oracle (survived mutant→test, crash→property).
- Judge scores vs contract; `holdout` Judge has no code access.
- **Done-condition = survived budget AND score ≥ threshold**, with full audit trail,
  produced headless (O5-4 proof: not-done when violation found; ship when exhausted+passing).
- Open decisions **#5** (budget) and **#7** (reward) confirmed + recorded.
- `npm run oracle:e2e` is the merge gate and passes unattended; zero network installs.

---

## Special-treatment cross-reference (spec mechanisms → tasks)

| Spec mechanism | Primary tasks | Proof checkpoint |
|---|---|---|
| **Write-segregation of `.oracle/**` (Builder cannot author/edit)** (§3 rule 2, §6, §8) | **O0-4** (diff gate + git guard), O0-3 (lineage) | C-O0 (+ re-verified every checkpoint) |
| **Public/hidden split + sandbox runner (verdict-only egress)** (§4.2, §8) | O1-1, O1-2, O1-3, **O1-4**, O1-5 | C-O1 |
| **Property/generative + mutation testing** (§4.3, §4.4) | O2-1, O2-2, **O2-4** (mutation gate), O2-5 | C-O2 |
| **Commit-reveal protocol** (§4.5) | O3-1, O3-2, **O3-3** (reveal verify) | C-O3 |
| **Differential twins** (§4.6) | O4-1, O4-2, **O4-3** (injected divergence) | C-O4 |
| **Adversarial self-play "survived budget" done-condition** (§4.7) | O5-1, O5-2, O5-3, **O5-4**, O5-6 | C-O5 |

---

## Security-hardening task set (traceable to spec §8)

> All are **test-first** (parent §13 / Addendum A.3). Each row is traceable to a
> specific §8 control. Threat model: an agent optimizing for "tests pass" + ordinary
> local-IO risk (spec §1.3, §8).

| Spec §8 control | Task(s) | Verification |
|---|---|---|
| **Authorship/write segregation of `.oracle/**` (central control)** | **O0-4** (+ O0-3 lineage) | `node --test test/oracle-harness/write_segregation.test.js` |
| **Sandbox isolation; no path back to oracle source; verdict-only egress** | O1-4 (runner), O1-3 (hidden isolation), **O1-2** (egress schema) | `node --test test/oracle-harness/{sandbox_runner,hidden_isolation,verdict_schema}.test.js` |
| **Commit-reveal integrity (hashes before freeze; reveals verified)** | O3-1, O3-2, O3-3 | `node --test test/oracle-harness/{commit,freeze_order,reveal}.test.js` |
| **Verdict minimization (categories only; never asserted values/source)** | O1-2, **O5-0** (feedback minimization) | `node --test test/oracle-harness/feedback_minimization.test.js` |
| **Resource bounds on generators/mutants/fuzz/twins (DoS/runaway)** | O1-4 (runner timeout), O2-5 (fuzz bounds), O4-2 (twin input budget), O5-1 (budget) | `node --test test/oracle-harness/bounds.test.js` (SEC aggregate) |
| **Pane-output/feedback is data, not instructions** | SEC-INJ (below), aligns `systematic-debugging` | `node --test test/oracle-harness/instruction_injection.test.js` |
| **Inherit parent §7 controls (loopback, path confinement, sanitization)** | SEC-PARENT (below) — reuse parent P4-SEC-1..6 | parent `tests/security/*` green |

### SEC-INJ — Instruction-injection resistance (control §8 bullet 6) (tests first)
- **Description:** A verdict/feedback/pane-output/error containing "run this
  command" is treated as **data, never executed** (mirrors `systematic-debugging`).
- **Acceptance criteria:** injected-instruction payloads in verdicts/feedback/labels
  are never executed; treated as inert data; categorized if suspicious.
- **Verification:** `node --test test/oracle-harness/instruction_injection.test.js`
- **Dependencies:** O1-2, O5-0 · **Scope:** S

### SEC-BOUNDS — Aggregate resource-bound regression suite (control §8 bullet 5) (tests first)
- **Description:** Single suite asserting generator/mutant/fuzz/twin/runner bounds
  hold under stress; runaway is killed, not hung.
- **Acceptance criteria:** each engine stops at its bound on a synthetic huge input;
  no unbounded handles/processes; sandbox runner timeout enforced.
- **Verification:** `node --test test/oracle-harness/bounds.test.js`
- **Dependencies:** O1-4, O2-5, O4-2, O5-1 · **Scope:** M

### SEC-PARENT — Inherit parent §7 controls (control §8 bullet 7)
- **Description:** Confirm loopback-only binding, path confinement, sanitization
  from the parent ecosystem still hold for any oracle-status surfaced via the Plan
  Inbox/portal.
- **Acceptance criteria:** parent `tests/security/*` remain green with oracle-status
  events flowing; no new non-loopback bind, no out-of-`.plans/`/`.oracle/` write.
- **Verification:** parent `node --test tests/security/` + `node --test test/oracle-harness/audit_trail.test.js`
- **Dependencies:** O3-4 · **Scope:** S

---

## Headless / test-driven mapping (consistent with parent Addendum A)

This plan is itself test-driven and headless. Each feature task ships with a
failing test first; each phase has a `--prove` red→green obligation; the whole
oracle is exercised by a scenario runner with **no human in the loop**.

| Harness component (mirrors parent A.2) | Oracle role | Drives |
|---|---|---|
| **Scenario runner** (O0-0) | Spins SUT in temp repo on ephemeral resources; named scenarios; teardown | all |
| **ArchitectSim** | Freezes contract, runs commit/reveal | O0-2, O3-* |
| **DesignerSim (adversary)** | Authors public/hidden/properties/mutants/fuzz; scored on bugs caught only | O1-3, O2-*, O5-1/2 |
| **BuilderSim (twins)** | Codes to contract; sees public + labels only; never reads hidden/oracle | O1-1/5, O4-1, O5 |
| **SandboxRunner probe** | Verdict-only egress under isolation | O1-4 |
| **JudgeSim** | Scores vs contract; holdout/informed modes | O5-3 |
| **FaultInj** | Builder-edits-oracle, traversal/symlink smuggle, egress-leak, reveal-tamper, instruction-injection, bound-busting | O0-4, O1-2/4, O3-3, SEC-* |
| **Clock/IDs** | Deterministic timestamps/nonces for stable assertions | all |

**Red→green obligations (must be observed failing before passing):**
write-segregation gate (O0-4), public-no-help (O1-5), mutation gate rejects weak
suite (O2-4), reveal rejects tampered bundle (O3-3), injected twin divergence
(O4-3), done-condition transitions (O5-4). All gated by `npm run oracle:e2e`.

---

## Definition of Done — cross-check against spec §11

| Spec §11 DoD item | Satisfied by | Verified at |
|---|---|---|
| Builder lineage demonstrably cannot author or edit `.oracle/**` (enforced + tested) | **O0-3, O0-4**, SEC (smuggle tests) | C-O0 (re-verified C-O1…C-O5) |
| Hidden suite runs in a sandbox; Builder cannot read it; verdict-only egress | O1-2, O1-3, **O1-4**, O1-5 | C-O1 |
| Property + mutation gates active; a deliberately weak suite is rejected | O2-1, **O2-4** | C-O2 |
| Commit-reveal recorded before freeze and verified on reveal | O3-1, O3-2, **O3-3** | C-O3 |
| Differential twins surface at least one injected divergence in test | O4-1, O4-2, **O4-3** | C-O4 |
| "Done" is the adversarial verdict (survived budget + score ≥ threshold), full audit trail, headless | O5-2, O5-3, **O5-4**, O3-4 (audit), O5-6 (e2e) | C-O5 |
| Designer and Builder dispatched as separate sibling lineages (no shared ancestry) | **O0-3**, O4-1, O5-5 | C-O0, C-O4, C-O5 |

**DoD gate:** v1 is "done" only when every row is checked at **C-O5** with fresh,
passing verification evidence and `npm run oracle:e2e` green, headless, with zero
network installs and a complete, replayable audit trail.

---

## Dependency summary (topological order)

```
O0-0 → O0-1 → O0-2
O0-0 → O0-3 → O0-4 ───────────────────────────────────────→ (C-O0)
(C-O0) → O1-0 → O1-1
                O1-2 → O1-3 → O1-4 → O1-5 ──────────────────→ (C-O1)
(C-O1) → O2-0 → O2-1 → O2-2
                O2-1 → O2-5
                O2-0 → O2-3 → O2-4 (uses O2-1, O1-4) ────────→ (C-O2)
(C-O2) → O3-1 → O3-2 → O3-3 → O3-4 ─────────────────────────→ (C-O3)
(C-O3) → O4-0 → O4-1 → O4-2 → O4-3 ─────────────────────────→ (C-O4)
(C-O4) → O5-0 → O5-1 → O5-2 ┐
                O5-1 → O5-3 ┼→ O5-4 → O5-5 → O5-6 ──────────→ (C-O5)
SEC-INJ, SEC-BOUNDS, SEC-PARENT  (depend on their feature tasks; gate C-O5)
```

---

## Future / explicitly deferred (out of v1 scope)

- Remote-runner sandbox substrate (beyond container/OS-user) — Open decision #1 tail.
- Formally-verified correctness (spec §1.3 non-goal); always-on twins for all areas.
- Defeating a malicious human with root (spec §1.3 non-goal).
- Language-native mutation tooling if the custom operator set proves insufficient
  (revisit at O2 retro).
- Cross-repo / multi-build oracle sharing (this v1 targets the parent build).
