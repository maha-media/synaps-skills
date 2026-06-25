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

## C-O5
- **#5 Self-play to a trustworthy verdict.** O5 runs the full flywheel
  (`tools/oracle/selfplay_run.js`): frozen contract → commit-reveal → Designer
  (adversary, sibling) + Builder twins → Tester (public in worktree + hidden in
  sandbox, verdict-only) + properties + mutation + differential → Judge → done.
  Ship gate = `survived_cleanly && reveal_verified && score ≥ 0.8` within budget.
  Final verdict: **ship** (score 1.0, 0 outstanding finds, reveal verified).
- **PRE-WORK triage (3 adversary findings, graded vs the FROZEN contract):**
  1. `store-caps` (cap-exceeded ×2) — **REAL BUILD BUG** → Builder fixed `lib/store.js`
     to enforce the declared `store_limits.maxBodyBytes` (defense in depth; reconcile
     and direct store callers bypass the HTTP transport guard). Message "too large"
     maps to HTTP 413.
  2. `validId-traversal` (path-escape) — **OVER-STRICT ORACLE** → Designer realigned
     `.oracle/properties/validid-traversal.prop.js`: the frozen `id_pattern`
     (`^[A-Za-z0-9][A-Za-z0-9_.-]*$`) PERMITS `..`; traversal is defended at the write
     boundary (write-confinement), not by validId. Forbidden set narrowed to `/`,`\`,NUL.
  3. `cli-exit-codes` (missing-behavior) — **OVER-STRICT + HARNESS-HOSTILE** → Designer
     dropped the serving-`new` success probe: `new`/`open`/`serve` call
     startServer()->listen() and never exit, so a captured exit code is meaningless and
     leaked orphaned servers. Success exit-0 is validated on TERMINATING commands
     (`list`); usage-error→2 retained (preserves the exit-code-2-to-0 catch).
- **#6 Equivalent-mutant exclusion (proven).** `write-confine-drop` is a TRUE
  equivalent mutant: `isInside(plansDir, safeRealpath(...))` is a tautology —
  `safeRealpath` (lib/paths.js) returns an inside-root path or THROWS, so the guard at
  `lib/store.js` is unreachable-false; a symlink/traversal escape is rejected upstream
  inside safeRealpath. No behavioral suite can kill it. Marked `equivalent:true` in
  `tools/oracle/mutate.js` and excluded from the kill-rate denominator (recorded in the
  gate report's `excluded[]`). Net gate: 9/9 killed, 1 excluded with justification.
  (Independently verified: 0/5 valid filenames trigger the guard.)
- **Harness hardening (orchestrator infra, `tools/oracle/sut.js`):** `runCli` now (a)
  prepends a no-op `xdg-open`/`open`/`start` shim to PATH so the product CLI's
  openBrowser() can never hijack the human's real browser during grading, and (b)
  bounds serving commands with a 5s timeout + SIGKILL so grading can never hang or leak
  server processes. Net: self-play rounds dropped from ~90s to sub-second.
