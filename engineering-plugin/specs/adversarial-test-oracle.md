# Spec: Adversarial Test Oracle & Test-Authorship Integrity

**Status:** Draft (pre-implementation)
**Owner:** engineering plugin
**Parent spec:** `html-plan-ecosystem.md` (this is the oracle layer that grades that build, and any future self-improving build)
**Related skills:** `convergence-loop`, `test-driven-development`, `verification-before-completion`, `security-review`, `worktrees-by-default`

---

## 0. TL;DR

A self-improvement harness is only as trustworthy as its **oracle** — the thing
that decides "done." If the agent that writes the code also writes the tests, the
oracle is the wolf guarding the henhouse: green-by-construction, not
green-by-correctness.

Two horns make this hard:

1. **Tests-before-code:** a test must bind to *something* that exists.
2. **The porous wall:** on one machine/repo, the coder can read, edit, or overfit
   to any test it can reach. Information walls between same-box processes are
   theater.

This spec resolves both without pretending walls work:

- **Dissolve horn 1 with a frozen *contract*.** The oracle tests **observable
  behavior against a contract** (schemas, endpoint signatures, exit codes, event
  shapes), authored by *neither* coder nor test-author. Behavioral/contract tests
  predate code; tests of internals are neither possible before code nor a valid
  oracle.
- **Dissolve horn 2 by making cheating *pointless*, not *blocked*.** Borrow the
  programming-contest judge + ML-holdout model: the coder may freely see a
  **public** suite, but is **graded** on a **hidden** suite it can never read
  (separate sandbox, verdict-only), reinforced by **property/generative** tests it
  can't overfit, **mutation testing** that validates the oracle itself,
  **commit-reveal** that stops post-hoc adaptation, and **differential twins**.

The result is **adversarial self-play**: the test-author is an *adversary*
rewarded only for breaking the Builder. "Done" stops meaning "passed a fixed
list" and becomes **"survived an adversarial search within budget."** Nobody
guards their own henhouse, because the test-author wins only when the coder loses.

---

## 1. Objective

### 1.1 What we are building

An oracle and test-authorship architecture that any build (starting with the HTML
Plan Ecosystem) plugs into, such that a build can complete **autonomously and
trustworthily** — the final green means correctness, not collusion.

### 1.2 Success criteria

- The agent that writes product code **never authors or can edit the grading
  oracle**.
- The grade is **immune to the coder reading the public tests** (seeing them
  doesn't help pass the hidden/generative/mutation gates).
- The oracle is **self-validated**: a weak test suite is detected and rejected
  (mutation kills), not trusted.
- "Done" is a **machine-checkable adversarial verdict** with an audit trail, not
  a human vibe or a single passing run.
- The whole thing runs **headless** (consistent with the parent's harness
  mandate) and composes with the **tmux fleet** and **convergence-loop**.

### 1.3 Non-goals (v1)

- Perfect, formally-verified correctness. The target is high-confidence
  adversarial coverage, not proof.
- Defeating a malicious *human* with root on the box. The threat model is an
  *agent* optimizing for "tests pass," not an adversary with kernel access.
- Replacing the parent build's domain tests; this layer governs *who writes them*
  and *how they grade*.

---

## 2. The Dilemma, Stated Precisely

| Horn | Why it bites | Resolution |
|---|---|---|
| **Tests before code** | A test binds to names/interfaces. Blind tests fail on wiring, not behavior; the Designer ends up guessing the Builder's API. | **Contract-first.** Freeze the interface (schema/endpoints/exit codes/event shapes) before either role runs. Tests target the contract + observable behavior, which exist before code. |
| **Porous wall** | Same box, same repo → the coder can read/edit/overfit any reachable test. | **Make cheating pointless.** Public tests are visible; the *grade* comes from hidden + generative + mutation + commit-revealed oracles the coder cannot game. Move the wall from the filesystem to the grade. |

The core inversion: **don't hide the tests — make seeing them not help.**

---

## 3. Roles & Lineage Rules

Roles map onto `convergence-loop`, with stricter authorship/lineage constraints.

| Role | Input it may see | Output | Must NOT |
|---|---|---|---|
| **Architect** | Spec | The **frozen contract** (schemas, signatures, exit codes, event shapes) + the public/hidden test *plan* | write product code or grading tests |
| **Designer (Adversary)** | Spec + contract | The **oracle**: public suite, **hidden** suite, properties/generators, mutants, fuzz harness | see Builder's implementation; be rewarded for agreement |
| **Builder (Coder)** | Spec + contract + **public** suite + scenario *names* of hidden cases | Implementation that satisfies the contract | author or edit any test/oracle file; read the hidden suite |
| **Tester** | Contract + Builder code + Designer oracle | Verdicts (verdict-only for hidden) | interpret/score; leak hidden test source |
| **Judge** | Spec + contract + verdicts (+ code only in `informed`) | Score + structured behavioral feedback | (holdout) see the code |
| **Orchestrator** | Everything | Enforces lineage, write-protection, commit-reveal, budgets | grade its own work |

**Lineage rules (these make separation real, not nominal):**

1. **Siblings, not nested.** Designer and Builder are **siblings under a neutral
   orchestrator** — neither parents the other. A graded party must never control
   its grader.
2. **Authorship segregation.** Only the Designer lineage may create/modify oracle
   files. The orchestrator **rejects any Builder diff that touches test/oracle
   paths** (green-by-vandalism is the failure this prevents).
3. **Adversarial incentive.** The Designer is scored on **bugs caught** (mutant
   kills, fuzz crashes, hidden failures it provoked), never on the Builder
   passing. Collusion becomes irrational.

---

## 4. Mechanisms

### 4.1 Contract-first (resolves Horn 1)

The Architect freezes a machine-readable contract before Designer/Builder run:

- Data schemas (e.g. `engplan/1`), endpoint signatures + status codes, CLI exit
  codes, event shapes, error taxonomy.
- The contract is the **shared ground truth**; both Designer and Builder bind to
  it without seeing each other's artifacts.
- Contract changes are a controlled event (re-freeze + re-commit-reveal), not an
  ad-hoc edit by either party.

### 4.2 Public / hidden split (resolves Horn 2, primary)

- **Public suite:** the Builder sees and develops against it (like contest sample
  cases). Lives in the worktree, read-only to the Builder.
- **Hidden suite:** the Builder **never reads it**. It runs in a **separate
  sandbox** (different OS user / container / remote runner) that returns
  **verdict-only** output: pass counts + behavioral failure *categories*, never
  test source or asserted values.
- Reading the public suite cannot help pass the hidden suite unless the contract
  is genuinely satisfied.

### 4.3 Property / generative testing (anti-overfit)

- Designer writes **invariants/properties**, not just examples:
  e.g. "no write ever lands outside `.plans/`", "every accepted note appears in a
  later GET", "events are append-only", "any malformed `engplan/1` yields a safe
  error, never a crash".
- A generator fires thousands of randomized cases; the coder cannot overfit a
  property over an effectively infinite input space.

### 4.4 Mutation testing (validates the oracle — watches the test-writer)

- Inject deliberate faults into the Builder's code; the suite must **kill** them.
- A suite that fails to catch planted bugs is **rejected** before it is trusted.
- This gives the red→green proof teeth: the oracle must demonstrate bug-catching
  power, not merely pass once. Solves the second henhouse (who tests the tester).

### 4.5 Commit-reveal (anti post-hoc adaptation)

- Designer publishes a **hash** of the hidden suite (and mutants) **before** the
  Builder freezes its implementation; reveals after freeze.
- Prevents the Designer from weakening tests after seeing code, and proves the
  Builder could not have peeked. Borrowed from cryptographic commit-reveal.

### 4.6 Differential twins (cheap with the fleet)

- Spawn **two Builders** from the same contract, zero contact.
- On any generated input where their outputs disagree, at least one is wrong →
  surface to Judge. They cannot collude (never meet); the tmux fleet makes N
  twins nearly free.

### 4.7 Adversarial self-play (the done condition)

- The Designer/adversary continuously searches for contract violations (new
  properties, mutants, fuzz inputs). Each survived round **strengthens** the
  oracle (a survived mutant → a new test; a fuzz crash → a new property).
- **Done = "the adversary cannot find a contract violation within its budget,"**
  not "a fixed list passed." This is the self-improving flywheel: oracle and
  Builder co-evolve, AlphaZero-style, opposed objectives over a fixed contract.

---

## 5. The Loop

```
            Spec
              │
              ▼
        ┌───────────┐
        │ Architect │  freeze CONTRACT  →  commit-reveal hash of hidden oracle
        └─────┬─────┘
              │ contract (+ public test plan)
       ┌──────┴───────────────────────────────┐
       ▼ (sibling)                             ▼ (sibling)
 ┌────────────┐                          ┌────────────┐
 │ Designer   │  writes public + HIDDEN  │ Builder(s) │  code to contract,
 │ (adversary)│  + properties + mutants  │  (twins)   │  sees PUBLIC only
 └─────┬──────┘  + fuzz harness          └─────┬──────┘
       │ oracle (hidden in sandbox)             │ implementation
       └───────────────┬────────────────────────┘
                        ▼
                 ┌────────────┐
                 │  Tester    │ run public (worktree) + hidden (sandbox, verdict-only)
                 │            │ + properties + mutation + differential
                 └─────┬──────┘
                       │ verdicts
                       ▼
                 ┌────────────┐
                 │   Judge    │ score vs spec/contract; behavioral feedback
                 └─────┬──────┘
                       │
            adversary exhausted budget AND score ≥ threshold?
              │                                   │
             NO ── strengthen oracle / fix ──┐    YES ──▶ SHIP (trustworthy green)
              └───────────────────────────────┘   (feedback = behavior, not test source)
```

Fix-loop feedback to the Builder describes **behavior gaps**, never test
internals (leaking hidden-test source defeats the holdout).

---

## 6. Artifacts & Layout

```
.oracle/
  contract/                 # frozen contract (schemas, signatures, exit codes)
  public/                   # public suite — Builder may read, may NOT edit
  hidden/                   # hidden suite — NEVER in the Builder's reach
  properties/               # invariants + generators
  mutants/                  # mutation operators / planted-fault catalog
  fuzz/                     # adversarial fuzz harness
  reveal/                   # commit-reveal hashes + reveal records (audit)
  verdicts/                 # verdict-only outputs from the sandbox runner
```

- `hidden/` is served/run only by the **sandbox runner**; it is not present in
  (or is unreadable from) the Builder's worktree.
- The orchestrator enforces: Builder diffs touching `.oracle/**` are **rejected**.
- Commit-reveal records and verdicts are durable **audit trail**.

> Where this overlaps the parent's `.plans/` Plan Inbox: behavioral feedback and
> verdicts flow through the inbox (`actor: orchestrator`/`agent` events) so the
> portal can show oracle status live; raw hidden test source never does.

## 7. Integration

| With | How |
|---|---|
| `convergence-loop` | This *is* the holdout convergence loop, hardened: Designer=adversary, write-protected oracle, hidden grading, mutation-validated. The skill's bounds (threshold, max_fix_iterations, max_total_calls, stagnation) still govern. |
| Parent harness (`html-plan-ecosystem` Addendum A) | The e2e harness (S1–S21, FleetSim) is authored by the **Designer lineage** under these rules; `npm run e2e` is the public face, the hidden suite is the real gate. |
| tmux fleet (§4.6 parent) | Designer, Builder twins, Tester sandbox, Judge run as separate pane agents / lineages; the orchestrator enforces walls and write-protection across the fleet. |
| Subagent doctrine (§9.1/§9.2 parent) | Every role dispatch carries `agent`/`system_prompt`; model = `explicit ?? session`. Designer and Builder are dispatched as **separate sibling lineages**. |

## 8. Security

Threat model: an **agent optimizing for "tests pass,"** plus ordinary local-IO
risk. Controls:

- **Authorship/write segregation** of `.oracle/**` (the central control).
- **Sandbox isolation** for the hidden runner: separate user/container, no path
  back into oracle source from the Builder; verdict-only egress.
- **Commit-reveal integrity:** hashes recorded before freeze; reveals verified.
- **Verdict minimization:** failure *categories* only; never leak asserted values
  or test source (prevents reconstructing the hidden suite from feedback).
- **Resource bounds** on generators, mutants, fuzz, and twins (DoS/runaway).
- **Pane-output/feedback is data, not instructions** (mirrors `systematic-debugging`).
- Inherit all parent §7 controls (loopback, path confinement, sanitization).

## 9. Open Decisions

1. **Sandbox substrate** for the hidden runner: separate OS user vs. container
   vs. remote runner. (Container is the clean default if available; user-split is
   the zero-dep fallback.)
2. **Mutation tooling:** language-native mutator vs. a small custom operator set
   tied to the contract.
3. **Property/generative framework:** vendored tiny generator vs. hand-rolled.
4. **Differential twins:** always-on vs. only on disagreement-prone areas (cost).
5. **Adversary budget**: time/iterations/coverage target that defines "exhausted."
6. **Where the contract lives** and who may re-freeze it (Architect role vs. spec).
7. **Reward function** for the Designer/adversary (mutant kills + fuzz crashes +
   hidden-fail provocations) and how it feeds the Judge.

## 10. Phasing

| Phase | Deliverable | Proves |
|---|---|---|
| **O0** | Frozen contract format + Architect role; write-segregation enforcement of `.oracle/**` | Builder cannot author/edit the oracle; tests can target a contract |
| **O1** | Public/hidden split + sandbox runner (verdict-only) | Coder graded on tests it can't read |
| **O2** | Property/generative tests + mutation testing (oracle self-validation) | Overfitting and weak suites are caught |
| **O3** | Commit-reveal protocol + audit trail | No post-hoc adaptation by either side |
| **O4** | Differential twins via the fleet | Cheap independent oracle from disagreement |
| **O5** | Adversarial self-play loop + "survived budget" done-condition; Judge integration | Trustworthy autonomous green |

Each phase is itself built under the parent's harness mandate and these
authorship rules (the oracle that grades the oracle-builder is, recursively,
authored by a separate lineage — turtles, but bounded by O0 write-segregation +
O2 mutation validation as the base case).

## 11. Definition of Done (v1)

- [ ] Builder lineage demonstrably cannot author or edit `.oracle/**` (enforced + tested).
- [ ] Hidden suite runs in a sandbox; Builder cannot read it; verdict-only egress.
- [ ] Property + mutation gates active; a deliberately weak suite is rejected.
- [ ] Commit-reveal recorded before freeze and verified on reveal.
- [ ] Differential twins surface at least one injected divergence in test.
- [ ] "Done" is the adversarial verdict (survived budget + score ≥ threshold),
      with a full audit trail, produced headless.
- [ ] Designer and Builder were dispatched as separate sibling lineages
      (no shared ancestry), per the lineage rules.
