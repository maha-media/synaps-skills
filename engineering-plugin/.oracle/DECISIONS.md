# Oracle Decision Records

Audit of open-decision resolutions confirmed at each checkpoint (spec §9).

## C-O0
- **#6 Contract location / owner:** `.oracle/contract/` is owned by the **Architect**
  lineage. The frozen artifact is `.oracle/contract/frozen.json` (immutable, hashed).
  Re-freeze is a controlled event via `ContractFreezer.freeze({refreeze:true})` paired
  with a new commit-reveal cycle (O3). Never an ad-hoc Designer/Builder edit. The
  source contract `.oracle/contract/contract.json` was frozen from the observable
  behavior of the P0–P5 build + parent spec.
- **Write-segregation (central control):** enforced at the orchestrator/merge boundary
  by `tools/oracle/diff_gate.js` (path-canonicalizing diff gate) + defense-in-depth git
  hook `tools/oracle/git_guard.sh`. Builder-lineage diffs touching `.oracle/**`,
  `tools/oracle/**`, or `test/oracle-harness/**` are rejected. Rename/symlink/traversal
  smuggling is canonicalized away before matching.
- **Lineage (siblings, not nested):** `tools/oracle/lineage.js` dispatch ledger refuses a
  dispatch missing both `agent` and `system_prompt`, resolves an absent `model` to the
  session model (`claude-opus-4-8`), and rejects any configuration where Designer is an
  ancestor/descendant of Builder.

## C-O1
- **#1 Sandbox substrate:** default = **zero-dep separate-process + isolated sandbox
  root** (`tools/oracle/sandbox/run_hidden.js`). The hidden suite is copied into a temp
  sandbox dir OUTSIDE the Builder worktree; a fresh child `node` runs it with stdio
  discarded; the ONLY egress is a single schema-validated `oracle/1` verdict file; a
  wall-clock timeout kills runaway suites. Docker substrate (`ORACLE_SANDBOX=container`)
  presents the identical verdict-only interface and is available (docker present) but not
  required by the threat model (agent optimizing for "tests pass", not root).
- **Verdict-only egress (`oracle/1` verdict):** `tools/oracle/verdict.js` rejects any
  verdict carrying test source, asserted values, raw inputs, hidden file paths, forbidden
  keys, or out-of-taxonomy categories. Builder sees `.oracle/hidden/labels.json` (labels
  only). Overfitting to public does not pass hidden (proven O1-5).

## C-O2
- **#3 Property/generative framework:** vendored tiny seeded generator + shrinker
  (`tools/oracle/gen.js`) — dependency-free, deterministic by seed. Property engine
  `tools/oracle/properties.js` fires N≥1000 cases, shrinks to a minimal counterexample,
  and emits category-only signals across the boundary.
- **#2 Mutation tooling:** custom contract-tied operator set (`tools/oracle/mutate.js`,
  10 operators mapping to status codes / exit codes / lifecycle / caps / loopback /
  confinement). Mutation gate `tools/oracle/mutation_gate.js` runs the grading suite
  against each mutant; kill-rate ≥ 0.8 required. A strong suite is ACCEPTED (10/10
  killed); a deliberately weak suite is REJECTED (0/10) — the oracle self-validates.
  Fuzz harness `tools/oracle/fuzz.js` is bounded and finds planted crashes.

## C-O4
- **#4 Differential twins policy:** ON-DEMAND by default; `alwaysOn` flag forces
  always-on for designated risk areas (`tools/oracle/twins.js`). Twins are two
  zero-contact Builder siblings (separate lineages under a neutral orchestrator,
  asserted not-nested). Comparator `tools/oracle/twins_diff.js` runs contract-derived
  probes over bounded generated inputs; a perturbed twin surfaces ≥1 divergence;
  identical twins yield zero false positives. Divergence records carry probe+category+
  audit_id only (no raw oracle values).
- Note: during O4 the contract was re-frozen (controlled) to correct an observable
  param (`/api/stream` + `/api/notes` use `?plan=`, not `?slug=`) — proves contract is
  ground-truth and re-freeze is a controlled event, not an ad-hoc edit.
